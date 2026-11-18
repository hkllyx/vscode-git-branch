'use strict';
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const fs = require('node:fs/promises');
const path = require('node:path');

class GitOperations {
  constructor(cwd, executable = 'git') {
    this.cwd = cwd;
    this.executable = executable;
  }

  async exec(args, encoding = 'utf8') {
    await this.ready;
    try {
      const { stdout } = await run(this.executable, args, {
        cwd: this.cwd,
        encoding,
        maxBuffer: 32 * 1024 * 1024,
        timeout: 30000,
        windowsHide: true
      });
      return stdout;
    } catch (error) {
      // Git merge writes conflict details to stdout, not necessarily stderr.
      const output = error.stdout?.toString().trim();
      if (output) error.message += `\n${output.slice(0, 4000)}`;
      throw error;
    }
  }

  /** List local + remote branches with full ref, hash, current flag. */
  async branches() {
    const output = await this.exec([
      'for-each-ref',
      '--format=%(refname)%09%(objectname)%09%(symref)',
      'refs/heads/', 'refs/remotes/'
    ]);
    let current;
    try { current = (await this.exec(['symbolic-ref', '--quiet', 'HEAD'])).trim(); } catch (error) {
      if (error.code !== 1) throw error;
      current = undefined;
    }
    const branches = output.trim().split(/\r?\n/).filter(Boolean).map(line => {
      const [ref, hash, symbolic] = line.split('\t');
      const remote = ref.startsWith('refs/remotes/');
      return { ref, hash, symbolic, remote, current: ref === current, name: ref.slice(remote ? 13 : 11) };
    }).filter(b => !b.symbolic);
    return { current, branches };
  }

  /** List tags. */
  async tags() {
    const output = await this.exec(['for-each-ref', '--format=%(refname)%09%(objectname)', 'refs/tags/']);
    return output.trim().split(/\r?\n/).filter(Boolean).map(line => {
      const [ref, hash] = line.split('\t');
      return { name: ref.slice('refs/tags/'.length), hash };
    });
  }

  /** Get current branch name (or undefined when detached). */
  async current() {
    try {
      const out = (await this.exec(['symbolic-ref', '--quiet', 'HEAD'])).trim();
      return out.replace(/^refs\/heads\//, '');
    } catch (error) {
      if (error.code !== 1) throw error;
      return undefined;
    }
  }

  /** Create a branch at start point. */
  async create(name, start = 'HEAD') {
    const invalid = await this.validateName(name);
    if (invalid) throw new Error(invalid);
    const hash = await this.resolve(start);
    await this.exec(['branch', '--', name, hash]);
  }

  /** Checkout accepts tree nodes (ref) and repository branch records (ref/name). */
  async checkout(branch) {
    const ref = branch?.ref || branch?.name;
    if (typeof ref !== 'string' || !ref.trim() || ref.startsWith('-')) {
      throw new Error('Select a valid branch to check out.');
    }
    if (branch.remote) {
      const qualified = ref.startsWith('refs/remotes/') ? ref : `refs/remotes/${ref}`;
      await this.exec(['show-ref', '--verify', qualified]);
      const locals = await this.exec(['for-each-ref', '--format=%(refname)%09%(upstream)', 'refs/heads/']);
      const tracking = locals.split(/\r?\n/).filter(Boolean).map(line => line.split('\t'))
        .filter(([, upstream]) => upstream === qualified);
      if (tracking.length > 1) throw new Error('Multiple local branches track this remote. Check out the desired Local branch.');
      if (tracking.length === 1) {
        await this.exec(['switch', '--', tracking[0][0].slice('refs/heads/'.length)]);
      } else {
        await this.exec(['switch', '--track', '--', qualified]);
      }
    } else {
      const name = ref.replace(/^refs\/heads\//, '');
      await this.exec(['show-ref', '--verify', `refs/heads/${name}`]);
      await this.exec(['switch', '--', name]);
    }
  }

  /** Rename a local branch. */
  async rename(oldName, newName) {
    const invalid = await this.validateName(newName);
    if (invalid) throw new Error(invalid);
    await this.exec(['show-ref', '--verify', `refs/heads/${oldName}`]);
    await this.exec(['branch', '-m', '--', oldName, newName]);
  }

  /** Safe deletion by default; force must be explicitly confirmed by the caller. */
  async remove(name, force = false) {
    try {
      await this.exec(['branch', force === true ? '-D' : '-d', '--', name]);
    } catch (error) {
      // Only an unmerged refusal may offer Force Delete, never arbitrary Git failures.
      error.unmergedBranch = force !== true && /not fully merged/i.test(error.stderr?.toString() || error.message);
      throw error;
    }
  }

  /** Merge or rebase ref into current. */
  async integrate(operation, ref) {
    if (!['merge', 'rebase'].includes(operation)) throw new Error('Unsupported operation');
    if (!(await this.current())) throw new Error('Check out a local branch before merging or rebasing (HEAD is detached).');
    for (const state of ['MERGE_HEAD', 'rebase-merge', 'rebase-apply']) {
      const statePath = (await this.exec(['rev-parse', '--git-path', state])).trim();
      try {
        await fs.access(path.resolve(this.cwd, statePath));
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      throw new Error('A merge or rebase is already in progress. Resolve/continue or abort it first.');
    }
    if ((await this.exec(['status', '--porcelain'])).trim()) {
      throw new Error('Commit or stash working-tree changes before merging or rebasing.');
    }
    const hash = await this.resolve(ref);
    if (operation === 'merge') {
      await this.exec(['merge', '--no-edit', '--', hash]);
    } else {
      await this.exec(['rebase', '--', hash]);
    }
  }

  /** Resolve ref to full commit hash. */
  async resolve(ref) {
    return (await this.exec(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])).trim();
  }

  /** Compare ref with HEAD: returns { left, right, ref, files }. */
  async compare(ref) {
    const [left, right] = await Promise.all([
      this.resolve(ref),
      this.resolve('HEAD')
    ]);
    const files = parseDiff(await this.exec([
      'diff', '--name-status', '-z', '--find-renames', left, right, '--'
    ]));
    return { left, right, ref, files };
  }

  /** Commits reachable only from include, with bounded, paginated output. */
  async uniqueCommits(include, exclude, skip = 0) {
    if (![include, exclude].every(hash => /^[a-f0-9]{40,64}$/.test(hash)) ||
        !Number.isSafeInteger(skip) || skip < 0) throw new Error('Invalid comparison range');
    const range = `${exclude}..${include}`;
    const [output, count] = await Promise.all([
      this.exec(['log', '--topo-order', '--no-decorate', '--no-show-signature', '-z',
        '--format=%H%x00%an%x00%aI%x00%s', '--max-count=200', `--skip=${skip}`, range, '--']),
      this.exec(['rev-list', '--count', range, '--'])
    ]);
    const tokens = output.split('\0');
    const commits = [];
    for (let i = 0; i + 3 < tokens.length; i += 4) {
      commits.push({ hash: tokens[i], author: tokens[i + 1], date: tokens[i + 2], subject: tokens[i + 3] });
    }
    return { commits, total: Number(count.trim()) };
  }

  /** Immutable branch tips plus both directions of unique history. */
  async branchComparison(ref) {
    const result = await this.compare(ref);
    const [selected, current] = await Promise.all([
      this.uniqueCommits(result.left, result.right),
      this.uniqueCommits(result.right, result.left)
    ]);
    return { ...result, selected, current };
  }

  /** A commit's changes against its first parent (root commits against empty tree). */
  async commitDetails(hash) {
    if (!/^[a-f0-9]{40,64}$/.test(hash)) throw new Error('Invalid commit');
    const output = await this.exec(['show', '-s', '--no-show-signature',
      '--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%B', hash, '--']);
    const [commit, parents, author, email, date, message] = output.split('\0');
    const parent = parents.split(' ')[0] || null;
    const files = parseDiff(await this.exec(parent
      ? ['diff', '--name-status', '-z', '--find-renames', parent, commit, '--']
      : ['diff-tree', '--root', '--no-commit-id', '-r', '--name-status', '-z', '--find-renames', commit, '--']));
    return { hash: commit, parents: parents ? parents.split(' ') : [], author, email, date,
      message: message.trimEnd(), left: parent, right: commit, files };
  }

  /** Get file content at a commit (empty string if path is null). */
  async content(hash, path) {
    if (!path) return '';
    if (!/^[a-f0-9]{40,64}$/.test(hash)) throw new Error('Invalid snapshot commit');
    const data = await this.exec(['show', `${hash}:${path}`], 'buffer');
    if (data.includes(0)) return '[Binary file: textual comparison is not available]';
    return data.toString('utf8');
  }

  /** Validate a branch name; returns error message or undefined. */
  async validateName(name) {
    if (!name || name !== name.trim()) return 'Enter a branch name without leading/trailing spaces.';
    try { await this.exec(['check-ref-format', '--branch', name]); } catch { return 'Invalid Git branch name.'; }
    if (name.startsWith('-') || name.includes('@{')) return 'Use a literal branch name.';
    const existing = await this.exec(['for-each-ref', '--format=%(refname)', 'refs/heads/']);
    if (existing.split(/\r?\n/).includes(`refs/heads/${name}`)) return 'A local branch with this name already exists.';
    return undefined;
  }
}

/** Parse NUL-delimited git diff --name-status -z output. */
function parseDiff(output) {
  const tokens = output.split('\0');
  const files = [];
  for (let i = 0; i < tokens.length && tokens[i];) {
    const status = tokens[i++];
    const oldPath = tokens[i++];
    if (oldPath === undefined) throw new Error('Malformed Git diff output');
    const renamed = /^[RC]/.test(status);
    const newPath = renamed ? tokens[i++] : oldPath;
    if (newPath === undefined) throw new Error('Malformed Git rename output');
    files.push({
      status,
      oldPath: status === 'A' ? null : oldPath,
      newPath: status === 'D' ? null : newPath
    });
  }
  return files;
}

module.exports = { GitOperations, parseDiff };
