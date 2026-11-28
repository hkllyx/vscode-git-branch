'use strict';

const fs = require('node:fs/promises');
const { O_NOFOLLOW, O_RDONLY } = require('node:fs').constants;
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { t } = require('../i18n');
const { BranchError, errorText, isOid, shortOid } = require('../util/format');
const { HEADS, sameHead } = require('./refs');
const { pathsOverlap } = require('./updateChanges');
const { regularMode, safeWorktreeFile, pathParts } = require('./worktreePaths');

const MAX_WORKTREE_FILES = 200;
const LOCAL = { write: true, offline: true, noEditor: true };
const LITERAL = ['--literal-pathspecs', '-c', 'submodule.recurse=false'];
const PATH_INPUT = ['--pathspec-from-file=-', '--pathspec-file-nul'];
const PRIVATE_INDEX = ['-c', 'core.splitIndex=false', '-c', 'core.sparseCheckout=false', '-c', 'index.sparse=false'];
const fail = (key, values) => new BranchError(t(key, values));
const encode = file => Buffer.from(file).toString('base64');
const names = change => change.rename ? [change.source, change.file] : [change.file];
const isRegular = change => change.untracked || (change.xy !== '.A' && change.xy[1] !== 'R' &&
  [change.headMode, change.indexMode, change.worktreeMode].every(mode => mode === '000000' || regularMode(mode)));

class WorktreeActions {
  constructor(branches) {
    this.branches = branches;
    this.client = branches.client;
    this.reads = branches.reads;
  }

  async choices(head) {
    const work = await this.branches.working();
    if (!sameHead(work.head, head) || !head?.ref?.startsWith(HEADS) || !isOid(head.oid)) throw fail('history.staleAction');
    // Do not round-trip an undecodable path through a string and target a different file.
    if (!Buffer.from(work.status.toString('utf8')).equals(work.status)) throw fail('git.worktreeSelectionUnsupported');
    const branch = { ref: head.ref, name: head.ref.slice(HEADS.length) };
    return { work, branch, files: work.changes.filter(change => {
      if (!isRegular(change)) return false;
      try { names(change).forEach(file => pathParts(encode(file))); return true; }
      catch { return false; }
    }) };
  }

  async plan(kind, choices, selected) {
    if (!['commit', 'rollback', 'stash'].includes(kind) || !selected.length || new Set(selected).size !== selected.length ||
      selected.some(change => !choices.files.includes(change))) throw fail('history.staleAction');
    if (selected.length > MAX_WORKTREE_FILES) throw fail('git.worktreeSelectionLimit', { count: MAX_WORKTREE_FILES });
    const work = await this.branches.verifyWork(choices.work);
    const base = work.head.oid;
    const ignoreCase = await this.branches.ignoresCase();
    const chosen = new Set(selected);
    const entries = selected.flatMap(change => names(change).map(file => ({ file, key: encode(file), untracked: Boolean(change.untracked),
      exists: change.untracked || (file === change.file && change.worktreeMode !== '000000'),
      mode: file === change.file ? change.indexMode : '000000', oid: change.indexOid })));
    const paths = entries.map(entry => entry.file);
    if (paths.some((file, index) => pathsOverlap([file], paths.slice(0, index), ignoreCase)) ||
      pathsOverlap(paths, choices.work.changes.filter(change => !chosen.has(change)).flatMap(names), ignoreCase)) {
      throw fail('git.worktreeSelectionOverlap');
    }
    const plan = { kind, work, base, branch: choices.branch, entries, paths, ignoreCase };
    plan.before = await this.inspect(plan);
    return plan;
  }

  async disk(entry) {
    const { absolute, stat } = await safeWorktreeFile(this.client.root, entry.key, { allowMissing: true });
    if (Boolean(stat) !== Boolean(entry.exists)) throw fail('git.worktreeSelectionChanged');
    if (!stat) return { absolute, hash: '-' };
    const handle = await fs.open(absolute, O_RDONLY | (O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) throw fail('git.worktreeSelectionChanged');
      const hash = createHash('sha256');
      for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
      const after = await handle.stat();
      if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs || after.mode !== stat.mode) {
        throw fail('git.worktreeSelectionChanged');
      }
      return { absolute, hash: `${stat.dev}:${stat.ino}:${stat.mode}:${hash.digest('hex')}` };
    } finally { await handle.close(); }
  }

  async inspect(plan) {
    await this.branches.verifyWork(plan.work);
    const [ignored, rawFlags] = await Promise.all([this.reads.ignoredPaths(), this.client.text(['ls-files', '-v', '-z'])]);
    const hidden = rawFlags.split('\0').filter(record => /^[a-zS] /.test(record)).map(record => record.slice(2));
    if (pathsOverlap(plan.paths, [...ignored, ...hidden], plan.ignoreCase)) throw fail('git.worktreeSelectionOverlap');
    const snapshot = [];
    for (const entry of plan.entries) snapshot.push(await this.disk(entry));
    await this.branches.verifyWork(plan.work);
    return snapshot;
  }

  async verify(plan, check) {
    const current = await this.inspect(plan);
    if (current.some((file, index) => file.hash !== plan.before[index].hash)) throw fail('git.worktreeSelectionChanged');
    check?.();
  }

  pathCommand(args, files, opts = LOCAL) {
    return this.client.text([...LITERAL, ...args, ...PATH_INPUT], { ...opts, input: files.map(file => `${file}\0`).join('') });
  }

  async amendable(plan) {
    if (await this.branches.history.containsRemote(plan.base)) return undefined;
    const commit = await this.reads.commit(plan.base);
    const [parent] = commit.parents;
    if (commit.parents.length > 1 || (parent && await this.reads.resolveCommit(parent) !== parent)) return undefined;
    return commit;
  }

  async commit(plan, message, amend, check) {
    if (typeof message !== 'string' || !message.trim() || message.includes('\0') || Buffer.byteLength(message) > 128 * 1024) {
      throw fail('git.historyMessageInvalid');
    }
    if (amend && !await this.amendable(plan)) throw fail('git.worktreeAmendUnavailable');
    const newFiles = plan.entries.filter(entry => entry.untracked).map(entry => entry.file);
    // commit --only keeps unrelated staged entries intact and uses Git's own
    // index transaction and hooks. New files must first be known to the index.
    const input = plan.paths.map(file => `${file}\0`).join('');
    // The commit message and pathspec cannot both read stdin.
    return this.temporary('message', async file => {
      await fs.writeFile(file, message, { mode: 0o600, flag: 'wx' });
      await this.verify(plan, check);
      try {
        if (newFiles.length) {
          await this.pathCommand(['add', '--intent-to-add'], newFiles);
          const current = await this.branches.working();
          if (!sameHead(current.head, plan.work.head) || newFiles.some(file => !current.changes.some(change => change.file === file && change.xy === '.A'))) {
            throw fail('git.worktreeSelectionChanged');
          }
          check?.();
        }
        await this.client.text([...LITERAL, 'commit', '--only', ...(amend ? ['--amend'] : []), '--cleanup=verbatim', '-F', file,
          ...PATH_INPUT], { ...LOCAL, input });
      } catch (error) {
        if (newFiles.length) {
          try {
            const work = await this.branches.working();
            if (sameHead(work.head, plan.work.head)) {
              const pending = work.changes.filter(change => change.xy === '.A' && newFiles.includes(change.file)).map(change => change.file);
              if (pending.length) await this.pathCommand(['restore', `--source=${plan.base}`, '--staged'], pending);
            }
          } catch (cleanup) {
            throw fail('git.worktreeCommitCleanupFailed', { detail: errorText(error), cleanup: errorText(cleanup) });
          }
        }
        throw error;
      }
      return { message: t(amend ? 'git.worktreeAmended' : 'git.worktreeCommitted', { count: plan.entries.length }) };
    });
  }

  async discard(plan) {
    const tracked = plan.entries.filter(entry => !entry.untracked).map(entry => entry.file);
    if (tracked.length) await this.pathCommand(['restore', `--source=${plan.base}`, '--staged', '--worktree', '--no-recurse-submodules'], tracked);
    for (const [i, entry] of plan.entries.entries()) {
      if (!entry.untracked) continue;
      const file = await this.disk(entry);
      if (file.hash !== plan.before[i].hash) throw fail('git.worktreeSelectionChanged');
      await fs.unlink(file.absolute);
    }
  }

  async temporary(name, task) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'git-branch-local-'));
    const file = path.join(directory, name);
    try { return await task(file); }
    finally {
      for (const target of [file, `${file}.lock`]) await fs.unlink(target).catch(error => { if (error.code !== 'ENOENT') throw error; });
      await fs.rmdir(directory);
    }
  }

  async stashObject(plan, label) {
    return this.temporary('index', async indexFile => {
      const opts = { ...LOCAL, indexFile };
      const git = (args, input) => this.client.text([...PRIVATE_INDEX, ...args], { ...opts, input });
      const tree = async () => this.object(await git(['write-tree']));
      const commit = async (treeOid, parents, message) => this.object(await git(['commit-tree', '--no-gpg-sign', treeOid,
        ...parents.flatMap(oid => ['-p', oid]), '-F', '-'], message));
      const tracked = plan.entries.filter(entry => !entry.untracked);
      const untracked = plan.entries.filter(entry => entry.untracked);
      await git(['read-tree', plan.base]);
      // Native path-limited stash push can record unrelated staged entries in
      // the stash's index parent. Assemble both snapshots with a private index.
      const indexInfo = tracked.map(({ file, mode, oid }) => `${mode === '000000' ? `0 ${'0'.repeat(plan.base.length)}` : `${mode} ${oid}`}\t${file}\0`).join('');
      if (tracked.length) await git(['update-index', '-z', '--index-info'], indexInfo);
      const indexCommit = await commit(await tree(), [plan.base], `index on ${label}\n`);
      const toAdd = tracked.filter(entry => entry.exists || entry.mode !== '000000').map(entry => entry.file);
      if (toAdd.length) await this.pathCommand([...PRIVATE_INDEX, 'add'], toAdd, opts);
      const worktree = await tree();
      const parents = [plan.base, indexCommit];
      if (untracked.length) {
        await git(['read-tree', '--empty']);
        await this.pathCommand([...PRIVATE_INDEX, 'add'], untracked.map(entry => entry.file), opts);
        parents.push(await commit(await tree(), [], `untracked files on ${label}\n`));
      }
      return commit(worktree, parents, `${label}\n`);
    });
  }

  object(text) {
    const oid = text.trim();
    if (!isOid(oid)) throw fail('git.invalidObjectId');
    return oid;
  }

  async execute(plan, { message, amend = false, check } = {}) {
    if (plan.kind === 'commit') return this.commit(plan, message, amend, check);
    if (plan.kind === 'rollback') {
      await this.verify(plan, check);
      await this.discard(plan);
      return { message: t('git.worktreeRolledBack', { count: plan.entries.length }) };
    }
    if (plan.kind !== 'stash' || (message !== undefined && (typeof message !== 'string' || /[\0\r\n]/.test(message) || Buffer.byteLength(message) > 4096))) {
      throw fail('history.staleAction');
    }
    const label = `On ${plan.branch.name}: ${message?.trim() || t('git.worktreeStashDefault')}`;
    await this.verify(plan, check);
    const oid = await this.stashObject(plan, label);
    await this.verify(plan, check);
    await this.client.text(['stash', 'store', '-m', label, oid], LOCAL);
    try {
      await this.verify(plan, check);
      await this.discard(plan);
    } catch (error) {
      return { warning: true, message: t('git.worktreeStashPartial', { oid: shortOid(oid), detail: errorText(error) }) };
    }
    return { message: t('git.worktreeStashed', { count: plan.entries.length, oid: shortOid(oid) }) };
  }
}

module.exports = { WorktreeActions, MAX_WORKTREE_FILES };
