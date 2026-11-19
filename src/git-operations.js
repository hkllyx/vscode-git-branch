'use strict';
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

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
        // Safe-delete classification relies on Git's diagnostic text. Keep it
        // deterministic without changing the user's environment or Git config.
        env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
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
      '--format=%(refname)%09%(objectname)%09%(symref)%09%(committerdate:iso8601-strict)%09%(upstream)%09%(upstream:track,nobracket)%09%(authorname)',
      'refs/heads/', 'refs/remotes/'
    ]);
    let current;
    try { current = (await this.exec(['symbolic-ref', '--quiet', 'HEAD'])).trim(); } catch (error) {
      if (error.code !== 1) throw error;
      current = undefined;
    }
    const records = output.trim().split(/\r?\n/).filter(Boolean).map(line => {
      const [ref, hash, symbolic, commitDate = '', upstream = '', track = '', ...authorParts] = line.split('\t');
      const commitAuthor = authorParts.join('\t');
      const remote = ref.startsWith('refs/remotes/');
      const trackingMissing = !!upstream && track === 'gone';
      const tracked = !remote && !!upstream && !trackingMissing;
      const ahead = tracked ? Number(/ahead (\d+)/.exec(track)?.[1] || 0) : undefined;
      const behind = tracked ? Number(/behind (\d+)/.exec(track)?.[1] || 0) : undefined;
      return { ref, hash, symbolic, commitDate, commitAuthor, upstream, remote, ahead, behind, trackingMissing,
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
    const source = (await this.exec(['rev-parse', '--symbolic-full-name', '--verify', '--end-of-options', start])).trim();
    const inherit = source.startsWith('refs/heads/') && !source.includes('\n');
    const direct = source.startsWith('refs/remotes/') && !source.includes('\n');
    // Local sources inherit their upstream; remote sources are themselves the upstream.
    // Explicit modes prevent branch.autoSetupMerge from silently changing this behavior.
    await this.exec(['branch', inherit ? '--track=inherit' : direct ? '--track=direct' : '--no-track',
      '--', name, inherit || direct ? source : hash]);
  }

  /** Change upstream configuration only; never move a branch or check out files. */
  async setTracking(name, upstream) {
    if (typeof name !== 'string' || !name || name.startsWith('-') || name.includes('@{')) {
      throw new Error('Select a valid local branch.');
    }
    await this.exec(['check-ref-format', '--branch', name]);
    await this.exec(['show-ref', '--verify', `refs/heads/${name}`]);
    if (upstream === null) {
      // Clearing an already untracked branch is a harmless no-op.
      try { await this.exec(['config', '--get', `branch.${name}.remote`]); } catch (error) {
        if (error.code === 1) return;
        throw error;
      }
      await this.exec(['branch', '--unset-upstream', '--', name]);
      return;
    }
    if (typeof upstream !== 'string' || !/^refs\/(heads|remotes)\/.+/.test(upstream) || upstream.includes('@{')) {
      throw new Error('Select a valid tracking branch.');
    }
    if (upstream === `refs/heads/${name}`) throw new Error('A branch cannot track itself.');
    await this.exec(['show-ref', '--verify', upstream]);
    const symbolic = (await this.exec(['for-each-ref', '--format=%(refname)%09%(symref)', upstream]))
      .split(/\r?\n/).map(line => line.split('\t')).find(([ref]) => ref === upstream)?.[1];
    if (symbolic) throw new Error('Select a branch, not a symbolic reference.');
    await this.exec(['branch', `--set-upstream-to=${upstream}`, '--', name]);
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

  /** Resolve one explicit push destination; never rely on push.default or wildcard refspecs. */
  async pushTarget(branch, publishRemote) {
    if (branch?.kind !== 'branch' || typeof branch.ref !== 'string' || !branch.ref ||
        branch.remote !== false || branch.diffSession) throw new Error('Select one local branch to push.');
    const source = `refs/heads/${branch.ref}`;
    await this.exec(['check-ref-format', source]);
    await this.resolve(source);
    const values = async key => {
      try { return (await this.exec(['config', '--get-all', key])).trim().split(/\r?\n/).filter(Boolean); }
      catch (error) { if (error.code === 1) return []; throw error; }
    };
    const [remotesOutput, remoteConfig, mergeConfig] = await Promise.all([
      this.exec(['remote']), values(`branch.${branch.ref}.remote`), values(`branch.${branch.ref}.merge`)
    ]);
    const remotes = remotesOutput.trim().split(/\r?\n/).filter(Boolean);
    if (!remotes.length) throw new Error('No remote configured. Add a Git remote first.');
    const tracked = remoteConfig.length || mergeConfig.length;
    let remote, destination;
    if (tracked) {
      if (publishRemote) throw new Error('Tracking configuration changed. Run Push again.');
      if (remoteConfig.length !== 1 || mergeConfig.length !== 1) throw new Error('Invalid or multiple tracking destinations. Use Set Tracking first.');
      remote = remoteConfig[0]; destination = mergeConfig[0];
      if (remote === '.') throw new Error('This branch tracks a local branch. Set a remote tracking branch before pushing.');
    } else {
      if (!publishRemote) return { source, remotes, publish: true };
      remote = publishRemote; destination = source;
    }
    if (!remotes.includes(remote)) throw new Error('The push remote is no longer configured.');
    if (!destination.startsWith('refs/heads/')) throw new Error('Push destination must be a remote branch.');
    await this.exec(['check-ref-format', destination]);
    return { source, remote, destination, publish: !tracked };
  }

  async push(branch, publishRemote) {
    const target = await this.pushTarget(branch, publishRemote);
    if (!target.remote) throw new Error('Select a remote to publish this branch.');
    // Mirror remotes may affect all refs even with an explicit refspec; refuse them.
    try {
      if ((await this.exec(['config', '--bool', '--get', `remote.${target.remote}.mirror`])).trim() === 'true') {
        throw new Error('Mirror remotes are not supported for single-branch Push.');
      }
    } catch (error) { if (error.code !== 1) throw error; }
    await this.exec(['push', '--no-force', '--no-follow-tags', '--recurse-submodules=no',
      ...(target.publish ? ['--set-upstream'] : []), '--', target.remote, `${target.source}:${target.destination}`]);
    return `${branch.ref} → ${target.remote}/${target.destination.slice('refs/heads/'.length)}`;
  }

  /** Fetch the selected upstream, then fast-forward without checking out other branches. */
  async update(branch, hasUnsavedChanges = false) {
    if (branch?.kind !== 'branch' || typeof branch.ref !== 'string' || !branch.ref ||
        typeof branch.remote !== 'boolean' || branch.diffSession) throw new Error('Select a branch to update.');
    const ref = `${branch.remote ? 'refs/remotes/' : 'refs/heads/'}${branch.ref}`;
    await this.exec(['check-ref-format', ref]);
    await this.resolve(ref);
    let upstream, remote, merge;
    if (branch.remote) {
      const names = (await this.exec(['remote'])).trim().split(/\r?\n/).filter(Boolean).sort((a, b) => b.length - a.length);
      remote = names.find(name => branch.ref.startsWith(`${name}/`));
      if (!remote) throw new Error('Remote is not configured.');
      merge = `refs/heads/${branch.ref.slice(remote.length + 1)}`;
      upstream = ref;
    } else {
      const record = (await this.branches()).branches.find(item => item.ref === ref);
      if (!record?.upstream) throw new Error('No tracking branch configured. Use Set Tracking first.');
      upstream = record.upstream;
      remote = (await this.exec(['config', '--get', `branch.${branch.ref}.remote`])).trim();
      merge = (await this.exec(['config', '--get', `branch.${branch.ref}.merge`])).trim();
    }
    await this.exec(['check-ref-format', merge]);
    if (remote !== '.') {
      if (!upstream.startsWith('refs/remotes/')) throw new Error('Unsupported upstream destination; no refs changed.');
      await this.exec(['fetch', '--no-tags', '--', remote, `+${merge}:${upstream}`]);
    }
    if (branch.remote) return 'Fetched';
    const target = await this.resolve(upstream);
    const original = await this.resolve(ref);
    // Preserve ahead-only history. Divergence is never resolved by reset, merge or rebase.
    if (Number((await this.exec(['rev-list', '--count', `${original}..${target}`, '--'])).trim()) === 0) return 'Already up to date';
    if (Number((await this.exec(['rev-list', '--count', `${target}..${original}`, '--'])).trim()) > 0) {
      throw new Error('Local and tracking branches have diverged. Update only allows fast-forward; local commits were preserved.');
    }
    if (await this.current() === branch.ref) {
      if (hasUnsavedChanges || (await this.exec(['status', '--porcelain'])).trim()) {
        throw new Error('Save and commit or stash working tree changes before updating the current branch.');
      }
      for (const state of ['MERGE_HEAD', 'rebase-merge', 'rebase-apply']) {
        const location = (await this.exec(['rev-parse', '--git-path', state])).trim();
        try { await fs.access(path.resolve(this.cwd, location)); }
        catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        throw new Error('A merge or rebase is in progress. Finish or abort it before updating.');
      }
      if (await this.current() !== branch.ref || await this.resolve(ref) !== original) throw new Error('Branch changed during Update; retry.');
      await this.exec(['merge', '--ff-only', '--no-edit', '--', target]);
    } else {
      // Non-forcing fetch into a local ref checks fast-forward and refuses branches
      // checked out in any worktree. It leaves this worktree, index and HEAD intact.
      await this.exec(['fetch', '--no-tags', '--no-write-fetch-head', '--', '.', `${target}:${ref}`]);
    }
    return 'Updated (fast-forward)';
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
  async compare(ref, target = 'HEAD') {
    const [left, right] = await Promise.all([
      this.resolve(ref),
      this.resolve(target)
    ]);
    const files = parseDiff(await this.exec([
      'diff', '--name-status', '-z', '--find-renames', left, right, '--'
    ]));
    const stats = parseNumstat(await this.exec([
      'diff', '--numstat', '-z', '--find-renames', '--no-ext-diff', '--no-textconv', left, right, '--'
    ]));
    return { left, right, ref, files, stats };
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

  /** Git stores a symlink's target text, not the contents of the target file. */
  async readWorktreeFile(file) {
    const location = this.worktreePath(file);
    const stat = await fs.lstat(location);
    return stat.isSymbolicLink() ? Buffer.from(await fs.readlink(location), 'utf8') : fs.readFile(location);
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
        const disk = await this.readWorktreeFile(name);
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
        const disk = await this.readWorktreeFile(file);
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
    const files = [...byPath.values()].sort((a, b) => (a.newPath || a.oldPath).localeCompare(b.newPath || b.oldPath));
    const stats = await this.worktreeStats(left, files, dirtyDocuments);
    return { left, right: null, ref, worktree: true, currentLabel: 'Working Tree', files, stats };
  }

  /** Compare the same file pairs as the list, including untracked and unsaved text.
   * Temporary snapshots never touch the repository's index or working files. */
  async worktreeStats(left, files, dirtyDocuments) {
    if (!files.length) return { insertions: 0, deletions: 0, binaryFiles: 0 };
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'git-branch-stats-'));
    try {
      const before = path.join(temporary, 'before'), after = path.join(temporary, 'after');
      await fs.mkdir(before); await fs.mkdir(after);
      const dirty = new Map(dirtyDocuments.filter(doc => typeof doc.text === 'string').map(doc => [doc.file, doc.text]));
      const tree = await this.exec(['ls-tree', '-r', '-z', left, '--']);
      const submodules = new Set(tree.split('\0').filter(entry => entry.startsWith('160000 ')).map(entry => entry.slice(entry.indexOf('\t') + 1)));
      let unsupportedFiles = 0;
      for (const [index, file] of files.entries()) {
        const name = String(index);
        const currentPath = file.newPath && this.worktreePath(file.newPath);
        const currentStat = currentPath && !dirty.has(file.newPath) ? await fs.lstat(currentPath) : undefined;
        if (submodules.has(file.oldPath) || currentStat?.isDirectory()) { unsupportedFiles++; continue; }
        if (file.oldPath) await fs.writeFile(path.join(before, name), await this.exec(['show', `${left}:${file.oldPath}`], 'buffer'));
        if (file.newPath) {
          const data = dirty.has(file.newPath) ? Buffer.from(dirty.get(file.newPath), 'utf8')
            : currentStat.isSymbolicLink() ? Buffer.from(await fs.readlink(currentPath), 'utf8') : await fs.readFile(currentPath);
          await fs.writeFile(path.join(after, name), data);
        }
      }
      let output;
      try { output = await this.exec(['diff', '--no-index', '--numstat', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', '--', before, after]); }
      catch (error) {
        if (error.code !== 1 || typeof error.stdout !== 'string') throw error;
        output = error.stdout;
      }
      return { ...parseNumstat(output), ...(unsupportedFiles ? { unsupportedFiles } : {}) };
    } finally {
      await fs.rm(temporary, { recursive: true, force: true });
    }
  }

  /** Commits reachable only from include, with bounded, paginated output. */
  async uniqueCommits(include, exclude, skip = 0) {
    if (![include, exclude].every(hash => /^[a-f0-9]{40,64}$/.test(hash)) ||
        !Number.isSafeInteger(skip) || skip < 0) throw new Error('Invalid comparison range');
    return this.commitPage(`${exclude}..${include}`, skip);
  }

  /** Full reachable branch history, pinned to one immutable tip for pagination. */
  async branchHistory(hash, skip = 0) {
    if (!/^[a-f0-9]{40,64}$/.test(hash) || !Number.isSafeInteger(skip) || skip < 0) {
      throw new Error('Invalid branch history snapshot');
    }
    return this.commitPage(hash, skip);
  }

  async commitPage(range, skip) {
    const [output, count] = await Promise.all([
      this.exec(['log', '--topo-order', '--no-decorate', '--no-show-signature', '-z',
        '--format=%H%x00%an%x00%aI%x00%s%x00%P', '--max-count=200', `--skip=${skip}`, range, '--']),
      this.exec(['rev-list', '--count', range, '--'])
    ]);
    const tokens = output.split('\0');
    const commits = [];
    for (let i = 0; i + 4 < tokens.length; i += 5) {
      const parents = tokens[i + 4] ? tokens[i + 4].split(' ') : [];
      commits.push({ hash: tokens[i], author: tokens[i + 1], date: tokens[i + 2], subject: tokens[i + 3],
        parents, merge: parents.length > 1 });
    }
    return { commits, total: Number(count.trim()) };
  }

  /** Immutable branch tips plus both directions of unique history. */
  async branchComparison(ref, target = 'HEAD') {
    const result = await this.compare(ref, target);
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
    const stats = parseNumstat(await this.exec(parent
      ? ['diff', '--numstat', '-z', '--find-renames', '--no-ext-diff', '--no-textconv', parent, commit, '--']
      : ['diff-tree', '--root', '--no-commit-id', '-r', '--numstat', '-z', '--find-renames', '--no-ext-diff', '--no-textconv', commit, '--']));
    return { hash: commit, parents: parents ? parents.split(' ') : [], author, email, date,
      message: message.trimEnd(), left: parent, right: commit, files, stats };
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
    try { await this.exec(['check-ref-format', '--branch', name]); }
    catch (error) {
      if (error.code === 1 || error.code === 128) return 'Invalid Git branch name.';
      throw error; // Missing executable, permissions or timeout is not an invalid name.
    }
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

/** Sum Git's NUL-delimited numstat, consuming rename path pairs separately. */
function parseNumstat(output) {
  const stats = { insertions: 0, deletions: 0, binaryFiles: 0 };
  const tokens = output.split('\0');
  for (let index = 0; index < tokens.length && tokens[index]; index++) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(tokens[index]);
    if (!match) throw new Error('Malformed Git numstat output');
    if (!match[3]) {
      if (tokens[index + 1] === undefined || tokens[index + 2] === undefined) throw new Error('Malformed Git numstat rename');
      index += 2;
    }
    if (match[1] === '-' || match[2] === '-') stats.binaryFiles++;
    else { stats.insertions += Number(match[1]); stats.deletions += Number(match[2]); }
  }
  return stats;
}

module.exports = { GitOperations, parseDiff, parseNumstat };
