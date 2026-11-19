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
      '--format=%(refname)%09%(objectname)%09%(symref)%09%(committerdate:iso8601-strict)%09%(upstream)%09%(upstream:track,nobracket)',
      'refs/heads/', 'refs/remotes/'
    ]);
    let current;
    try { current = (await this.exec(['symbolic-ref', '--quiet', 'HEAD'])).trim(); } catch (error) {
      if (error.code !== 1) throw error;
      current = undefined;
    }
    const records = output.trim().split(/\r?\n/).filter(Boolean).map(line => {
      const [ref, hash, symbolic, commitDate = '', upstream = '', track = ''] = line.split('\t');
      const remote = ref.startsWith('refs/remotes/');
      const trackingMissing = !!upstream && track === 'gone';
      const tracked = !remote && !!upstream && !trackingMissing;
      const ahead = tracked ? Number(/ahead (\d+)/.exec(track)?.[1] || 0) : undefined;
      const behind = tracked ? Number(/behind (\d+)/.exec(track)?.[1] || 0) : undefined;
      return { ref, hash, symbolic, commitDate, upstream, remote, ahead, behind, trackingMissing,
        current: ref === current, name: ref.slice(remote ? 13 : 11) };
    });
    const branches = records.filter(b => !b.symbolic);
    const remoteDefaults = new Map();
    for (const record of records) {
      if (record.remote && record.symbolic && record.name.endsWith('/HEAD') && branches.some(b => b.ref === record.symbolic)) {
        remoteDefaults.set(record.name.slice(0, -5), record.symbolic);
      }
    }
    const remoteNames = new Set(branches.filter(b => b.remote).map(b => b.name.split('/')[0]));
    for (const remote of remoteNames) {
      if (!remoteDefaults.has(remote)) {
        const fallback = ['main', 'master'].map(name => `refs/remotes/${remote}/${name}`).find(ref => branches.some(b => b.ref === ref));
        if (fallback) remoteDefaults.set(remote, fallback);
      }
    }
    // Local default branch: origin's default first; otherwise only an unambiguous remote default.
    const defaults = [...new Set([...remoteDefaults.values()].map(ref => ref.slice('refs/remotes/'.length).split('/').slice(1).join('/')))];
    const preferred = remoteDefaults.get('origin');
    const preferredName = preferred ? preferred.slice('refs/remotes/origin/'.length) : defaults.length === 1 ? defaults[0] : undefined;
    const locals = branches.filter(b => !b.remote);
    let primaryLocal = preferredName && locals.find(b => b.name === preferredName);
    if (!primaryLocal && preferred) {
      const tracking = locals.filter(b => b.upstream === preferred);
      if (tracking.length === 1) primaryLocal = tracking[0];
    }
    if (!primaryLocal && !preferredName) primaryLocal = ['main', 'master'].map(name => locals.find(b => b.name === name)).find(Boolean);
    for (const branch of branches) {
      branch.primary = branch.remote ? remoteDefaults.get(branch.name.split('/')[0]) === branch.ref : branch === primaryLocal;
    }
    return { current, branches };
  }

  /** List tags. */
  async tags() {
    const output = await this.exec(['for-each-ref',
      '--format=%(refname)%09%(if)%(*objectname)%(then)%(*objectname)%(else)%(objectname)%(end)%09%(if)%(*committerdate)%(then)%(*committerdate:iso8601-strict)%(else)%(committerdate:iso8601-strict)%(end)',
      'refs/tags/']);
    return output.trim().split(/\r?\n/).filter(Boolean).map(line => {
      const [ref, hash, commitDate = ''] = line.split('\t');
      return { name: ref.slice('refs/tags/'.length), hash, commitDate };
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
  async checkout(branch, confirmOverwrite) {
    const ref = branch?.ref || branch?.name;
    if (typeof ref !== 'string' || !ref.trim() || ref.startsWith('-')) {
      throw new Error('Select a valid branch to check out.');
    }
    if (branch.remote) {
      const qualified = ref.startsWith('refs/remotes/') ? ref : `refs/remotes/${ref}`;
        const remoteRef = qualified.slice('refs/remotes/'.length);
        const remotes = (await this.exec(['remote'])).trim().split(/\r?\n/).filter(Boolean)
          .sort((a, b) => b.length - a.length);
        const remote = remotes.find(name => remoteRef.startsWith(`${name}/`));
        if (!remote) throw new Error('The selected remote is not configured. Refresh the branch list.');
        const name = remoteRef.slice(remote.length + 1);
        if (!name || name.startsWith('-') || name.includes('@{')) throw new Error('Invalid remote branch name.');
        await this.exec(['check-ref-format', '--branch', name]);
        // Explicit refspec refreshes just this branch, including a rewritten remote history.
        // Fetch failure must never fall back to an old remote-tracking ref.
        await this.exec(['fetch', '--no-tags', '--', remote, `+refs/heads/${name}:${qualified}`]);
        const remoteHash = await this.resolve(qualified);
        const localRef = `refs/heads/${name}`;
        const localRecord = (await this.exec(['for-each-ref', '--format=%(refname)%09%(objectname)', localRef]))
          .split(/\r?\n/).map(line => line.split('\t')).find(([ref]) => ref === localRef);
        const localHash = localRecord?.[1];
        if (localHash) {
          const count = Number((await this.exec(['rev-list', '--count', `${remoteHash}..${localHash}`])).trim());
          if (count > 0 && await confirmOverwrite?.({ name, remote: remoteRef, count }) !== true) return false;
          // Revalidate after an asynchronous confirmation; never drop newly added commits.
          if (await this.resolve(localRef) !== localHash || await this.resolve(qualified) !== remoteHash) {
            throw new Error('Branch changed during checkout. Please try again.');
          }
        }
        // Dropping commits is not permission to discard uncommitted files.
        if ((await this.exec(['status', '--porcelain'])).trim()) {
          throw new Error('Commit or stash your working tree changes before checking out a remote branch.');
        }
        // Transactional switch: if another worktree owns this branch, Git refuses without resetting it.
        await this.exec(['switch', '-C', name, remoteHash]);
        await this.exec(['branch', `--set-upstream-to=${qualified}`, '--', name]);
        return name;
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

  /** Safe lexical path resolution for Git-provided worktree paths. */
  worktreePath(file) {
    if (typeof file !== 'string' || !file || path.isAbsolute(file)) throw new Error('Invalid worktree path');
    const absolute = path.resolve(this.cwd, file);
    const relative = path.relative(this.cwd, absolute);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('Worktree path is outside the repository');
    }
    return absolute;
  }

  /** Branch snapshot versus working files, not just the index. Dirty editor buffers can override disk. */
  async worktreeCompare(ref, dirtyDocuments = []) {
    const left = await this.resolve(ref);
    const [diff, others, baseNames, indexNames] = await Promise.all([
      this.exec(['diff', '--name-status', '-z', '--find-renames', left, '--']),
      this.exec(['ls-files', '--others', '--exclude-standard', '-z']),
      this.exec(['ls-tree', '-r', '--name-only', '-z', left, '--']),
      this.exec(['ls-files', '-z'])
    ]);
    const base = new Set(baseNames.split('\0').filter(Boolean));
    const untracked = new Set(others.split('\0').filter(Boolean));
    const known = new Set([...base, ...untracked, ...indexNames.split('\0').filter(Boolean)]);
    const byPath = new Map(parseDiff(diff).map(file => [file.newPath || file.oldPath, file]));
    // A staged index deletion need not mean the actual working file is gone (git rm --cached).
    for (const [name, file] of byPath) {
      if (file.status !== 'D') continue;
      try {
        const disk = await fs.readFile(this.worktreePath(name));
        const original = await this.exec(['show', `${left}:${name}`], 'buffer');
        byPath.delete(name);
        if (!disk.equals(original)) byPath.set(name, { status: 'M', oldPath: name, newPath: name });
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR', 'EISDIR'].includes(error.code)) throw error;
      }
    }
    for (const file of untracked) {
      this.worktreePath(file);
      // A file deleted from the index but still on disk is untracked; compare it with the base,
      // rather than duplicating Git's deletion/addition entries or pretending the left is empty.
      if (base.has(file)) {
        const disk = await fs.readFile(this.worktreePath(file));
        const original = await this.exec(['show', `${left}:${file}`], 'buffer');
        byPath.delete(file);
        if (!disk.equals(original)) byPath.set(file, { status: 'M', oldPath: file, newPath: file });
      } else if (!byPath.has(file)) {
        byPath.set(file, { status: 'A', oldPath: null, newPath: file, untracked: true });
      }
    }
    for (const doc of dirtyDocuments) {
      if (!known.has(doc.file) || typeof doc.text !== 'string') continue;
      this.worktreePath(doc.file);
      const existing = byPath.get(doc.file);
      const oldPath = existing?.oldPath || (base.has(doc.file) ? doc.file : null);
      const original = oldPath ? await this.content(left, oldPath) : '';
      if (oldPath && doc.text === original && !existing?.status.startsWith('R')) byPath.delete(doc.file);
      else byPath.set(doc.file, { status: existing?.status.startsWith('R') ? existing.status : oldPath ? 'M' : 'A',
        oldPath, newPath: doc.file, untracked: untracked.has(doc.file) });
    }
    return { left, right: null, ref, worktree: true, currentLabel: 'Working Tree',
      files: [...byPath.values()].sort((a, b) => (a.newPath || a.oldPath).localeCompare(b.newPath || b.oldPath)) };
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
