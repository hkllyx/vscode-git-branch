'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { t } = require('../i18n');
const { BranchError, errorText, isOid, shortOid } = require('../util/format');
const { pathsOverlap, UpdateStash } = require('./updateChanges');

const TAGS = 'refs/tags/';
const RESET_MODES = ['soft', 'mixed', 'keep', 'hard'];
const LOCAL_WRITE = { write: true, offline: true, noEditor: true };
const PATCH = ['--binary', '--full-index', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--no-relative',
  '--ignore-submodules=none', '--src-prefix=a/', '--dst-prefix=b/', '--unified=3'];
const APPLY_OPTIONS = ['--whitespace=nowarn', '--no-ignore-whitespace', '--no-reject', '--no-3way'];
const SAFE_CHECKOUT = ['-c', 'submodule.recurse=false'];
const SEQUENCER = [...SAFE_CHECKOUT, '-c', 'rerere.enabled=false', '-c', 'merge.directoryRenames=false'];
const fail = (key, values) => new BranchError(t(key, values));
const sameHead = (a, b) => a.ref === b.ref && a.oid === b.oid;

class HistoryActions {
  constructor(branches) {
    this.branches = branches;
    this.client = branches.client;
    this.reads = branches.reads;
  }

  async assertCommit(oid) {
    if (!isOid(oid) || await this.reads.resolveCommit(oid) !== oid) throw fail('git.historyCommitUnavailable');
  }

  async assertTagName(name) {
    if (!name || name.startsWith('-') || name.includes('\0') ||
      (await this.client.query(['check-ref-format', TAGS + name])).code !== 0) throw fail('git.historyInvalidTag');
    await this.branches.assertFreeRef(TAGS, name, 'git.historyTagExists', 'git.historyTagConflict');
  }

  async newRef(kind, oid, name, guard) {
    if (kind === 'branch') await this.branches.assertFree(name);
    else await this.assertTagName(name);
    await this.assertCommit(oid);
    guard?.();
    if (kind === 'branch') {
      await this.branches.makeBranch(name, oid);
      return { message: t('git.created', { name }) };
    }
    await this.client.text(['tag', '--no-sign', '--', name, oid], LOCAL_WRITE);
    return { message: t('git.historyTagCreated', { name, oid: shortOid(oid) }) };
  }

  async containsRemote(oid, opts) {
    return Boolean(await this.client.text(['for-each-ref', '--count=1', `--contains=${oid}`,
      '--format=%(refname)', '--', 'refs/remotes/'], opts));
  }

  async hasMerge(oid, head, opts) {
    return Boolean(await this.client.text(['rev-list', '--max-count=1', '--min-parents=2', `${oid}..${head}`, '--'], opts));
  }

  // A menu reports known eligibility; the working state and refs are always checked
  // again by prepare/execute. Never infer ancestry from the displayed row order.
  async eligibility(rows, head, signal) {
    if (!head?.ref || !head.oid || !rows.length || !isOid(head.oid)) return {};
    const opts = { signal };
    const plain = rows.every(row => row.parents.length < 2 && !row.shallowBoundary);
    const included = plain ? await Promise.all(rows.map(({ oid }) => this.reads.isAncestor(oid, head.oid, opts))) : [];
    const result = { cherryPick: plain && included.every(value => !value), revert: plain && included.every(Boolean) };
    if (rows.length === 1) {
      const [{ oid, parents }] = rows;
      result.rewrite = Boolean(plain && included[0] && !(await this.containsRemote(oid, opts)) &&
        (oid === head.oid || !(await this.hasMerge(oid, head.oid, opts))));
      result.undo = result.rewrite && oid === head.oid && parents.length === 1;
      result.drop = result.rewrite && parents.length === 1;
    }
    return result;
  }

  async ensureRewritable(oid, commit, head, kind) {
    if (kind === 'undo' && oid !== head.oid) throw fail('git.historyUndoHead');
    if ((kind === 'undo' || kind === 'drop') && !commit.parents.length) throw fail('git.historyNeedsParent');
    if (commit.parents.length > 1 || !(await this.reads.isAncestor(oid, head.oid)) ||
      (oid !== head.oid && await this.hasMerge(oid, head.oid))) throw fail('git.historyLinearOnly');
    if (await this.containsRemote(oid)) throw fail('git.historyPublished');
  }

  async checkCommitParent(commit) {
    const [parent] = commit.parents;
    if (parent && await this.reads.resolveCommit(parent) !== parent) throw fail('git.missingParent', { oid: shortOid(parent) });
  }

  async checkWorktreePaths(work, touched) {
    if (!touched.length) return;
    const paths = [...work.untrackedPaths, ...await this.reads.ignoredPaths()];
    if (paths.length && pathsOverlap(paths, touched, await this.branches.ignoresCase())) throw fail('git.historyUnsafePaths');
  }

  async prepare(kind, oids, expectedHead) {
    if (!oids.length || oids.some(oid => !isOid(oid))) throw fail('git.historyCommitUnavailable');
    const work = await this.branches.working();
    const { head } = work;
    if (expectedHead && !sameHead(head, expectedHead)) throw fail('history.staleAction');
    if (kind === 'checkoutRevision') {
      await this.assertCommit(oids[0]);
      return { kind, work, oids };
    }
    if (!head.ref || !head.oid) throw fail('git.historyLocalRequired');
    const branch = { ref: head.ref, name: head.ref.slice('refs/heads/'.length) };
    await this.branches.assertBranchEditable(branch, true);
    if (kind === 'reset') {
      if (oids[0] === head.oid) throw fail('git.historyResetCurrent');
      await this.assertCommit(oids[0]);
      // Snapshot the diff before the user chooses a reset mode. Porcelain alone
      // cannot detect a second edit to a file already marked modified.
      const fingerprint = work.unstaged ? await this.worktreeFingerprint() : undefined;
      return { kind, work, oids, branch, fingerprint };
    }
    if (kind === 'cherryPick' || kind === 'revert') {
      if (work.trackedPaths.length) throw fail('git.historyCleanRequired');
      const paths = new Set();
      for (const oid of oids) {
        const commit = await this.reads.commit(oid);
        if (commit.parents.length > 1) throw fail('git.historyMergeUnsupported');
        const included = await this.reads.isAncestor(oid, head.oid);
        if (included !== (kind === 'revert')) throw fail(kind === 'revert' ? 'git.historyNotIncluded' : 'git.historyAlreadyIncluded');
        for (const file of await this.reads.commitFiles(oid, commit)) {
          if (file.old) paths.add(Buffer.from(file.old.pathKey, 'base64').toString('utf8'));
          if (file.new) paths.add(Buffer.from(file.new.pathKey, 'base64').toString('utf8'));
        }
      }
      const touched = [...paths];
      await this.checkWorktreePaths(work, touched);
      return { kind, work, oids, branch, touched };
    }
    if (!['undo', 'editMessage', 'squash', 'drop'].includes(kind)) throw fail('history.staleAction');
    const oid = oids[0];
    const commit = await this.reads.commit(oid);
    await this.checkCommitParent(commit);
    await this.ensureRewritable(oid, commit, head, kind);
    if (kind === 'squash' && (!work.staged || work.intentToAdd || work.changedGitlink)) throw fail('git.historyStageRequired');
    if (((kind === 'editMessage' || kind === 'squash') && oid !== head.oid && work.unstaged) ||
      ((kind === 'drop' || (kind === 'editMessage' && oid !== head.oid)) && work.trackedPaths.length)) {
      throw fail(kind === 'squash' ? 'git.historyStagedOnly' : 'git.historyCleanRequired');
    }
    return { kind, work, oids, commit, branch };
  }

  async worktreeFingerprint() {
    const patch = await this.client.buffer(['diff', ...PATCH, '--']);
    return createHash('sha256').update(patch).digest('hex');
  }

  async reset(plan, oid, mode, check) {
    if (!RESET_MODES.includes(mode)) throw fail('history.staleAction');
    const { work, branch } = plan;
    if (mode === 'keep' || mode === 'hard') {
      const changed = await this.reads.changedPaths(work.head.oid, oid);
      await this.checkWorktreePaths(work, [...changed, ...work.trackedPaths]);
    }
    if (mode === 'hard') {
      const flags = (await this.client.text(['ls-files', '-v', '-z'])).split('\0');
      if (work.changedGitlink || flags.some(flag => /^[a-zS] /.test(flag))) throw fail('git.historyUnsafeIndex');
      if (work.unstaged && await this.worktreeFingerprint() !== plan.fingerprint) throw fail('history.staleAction');
    }
    await this.branches.assertBranchEditable(branch, true);
    await this.branches.verifyWork(work);
    check?.();
    await this.client.text([...SAFE_CHECKOUT, 'reset', `--${mode}`, '--no-recurse-submodules', oid, '--'], LOCAL_WRITE);
    if (!sameHead(await this.reads.head(), { ref: branch.ref, oid })) throw fail('history.staleAction');
  }

  async execute(plan, { mode, message, check } = {}) {
    const { kind, work, oids, commit, branch } = plan;
    const oid = oids[0];
    if (branch) await this.branches.assertBranchEditable(branch, true);
    await this.branches.verifyWork(work);
    check?.();
    if (kind === 'checkoutRevision') {
      if (work.head.ref || work.head.oid !== oid) {
        await this.client.text([...SAFE_CHECKOUT, 'switch', '--detach', '--no-guess', '--no-overwrite-ignore', '--no-recurse-submodules', '--', oid], LOCAL_WRITE);
        if (!sameHead(await this.reads.head(), { ref: undefined, oid })) throw fail('history.staleAction');
      }
      return { message: t('git.historyCheckedOut', { oid: shortOid(oid) }) };
    }
    if (kind === 'reset') {
      await this.reset(plan, oid, mode, check);
      return { message: t('git.historyResetDone', { name: branch.name, oid: shortOid(oid) }) };
    }
    if (kind === 'cherryPick' || kind === 'revert') {
      await this.checkWorktreePaths(work, plan.touched);
      await this.branches.verifyWork(work);
      check?.();
      try {
        // Explicit OIDs preserve the caller's ordering; do not turn them into a revision walk.
        await this.client.text([...SEQUENCER, kind === 'revert' ? 'revert' : 'cherry-pick', '--no-edit', '--', ...oids], LOCAL_WRITE);
      } catch (error) { return this.paused(error, kind === 'revert' ? 'git.historyRevertPaused' : 'git.historyPickPaused'); }
      return { message: t(kind === 'revert' ? 'git.historyReverted' : 'git.historyPicked', { count: oids.length }) };
    }
    const verifyRewrite = async () => {
      await this.ensureRewritable(oid, commit, work.head, kind);
      await this.branches.assertBranchEditable(branch, true);
      await this.branches.verifyWork(work);
      check?.();
    };
    await verifyRewrite();
    if (kind === 'undo' || (kind === 'drop' && oid === work.head.oid)) {
      await this.reset(plan, commit.parents[0], kind === 'undo' ? 'soft' : 'keep', check);
      return { message: t(kind === 'undo' ? 'git.historyUndone' : 'git.historyDropped', { oid: shortOid(oid) }),
        draft: kind === 'undo' ? commit.message : undefined };
    }
    if (kind === 'editMessage' && (typeof message !== 'string' || !message.trim() || message.includes('\0') || Buffer.byteLength(message) > 128 * 1024)) {
      throw fail('git.historyMessageInvalid');
    }
    if (kind === 'editMessage' && message === commit.message) return { message: t('git.historyMessageUnchanged') };
    const done = kind === 'editMessage' ? 'git.historyMessageEdited' : kind === 'squash' ? 'git.historySquashed' : 'git.historyDropped';
    if (oid === work.head.oid) {
      const args = kind === 'editMessage' ? ['--only', '--cleanup=verbatim', '-F', '-'] : ['--no-edit'];
      await this.client.text(['commit', '--amend', '--allow-empty', ...args], { ...LOCAL_WRITE, input: message });
      return { message: t(done, { oid: shortOid(oid) }) };
    }
    return this.rewriteEarlier(plan, message, done, verifyRewrite);
  }

  async paused(error, key) {
    const state = await this.reads.workingState(this.branches.dirs.gitDir);
    if (state.conflicted || state.operation) return { warning: true, message: t(key, { detail: errorText(error) }) };
    throw error;
  }

  async stagedTree(oid, head) {
    const patch = await this.client.buffer(['diff', '--cached', ...PATCH, head, '--']);
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'git-branch-index-'));
    const indexFile = path.join(directory, 'index');
    const options = { ...LOCAL_WRITE, indexFile };
    const config = ['-c', 'core.splitIndex=false', '-c', 'core.sparseCheckout=false', '-c', 'index.sparse=false'];
    try {
      await this.client.text([...config, 'read-tree', oid], options);
      try { await this.client.text([...config, 'apply', '--cached', ...APPLY_OPTIONS, '-'], { ...options, input: patch }); }
      catch (error) { throw fail('git.historySquashDoesNotApply', { detail: errorText(error) }); }
      const tree = (await this.client.text([...config, 'write-tree'], options)).trim();
      if (!isOid(tree)) throw fail('git.invalidObjectId');
      return tree;
    } finally {
      await fs.unlink(indexFile).catch(error => { if (error.code !== 'ENOENT') throw error; });
      await fs.unlink(`${indexFile}.lock`).catch(error => { if (error.code !== 'ENOENT') throw error; });
      await fs.rmdir(directory);
    }
  }

  async replacementCommit(oid, tree, commit, message) {
    const authorInfo = await this.client.text(['show', '-s', '--no-show-signature', '--no-notes', '--format=%an%x00%ae%x00%aI', oid, '--']);
    const [name, email, date] = authorInfo.trimEnd().split('\0');
    if (email === undefined || !date) throw fail('git.invalidCommitDetails');
    const sign = (await this.branches.configValues('commit.gpgSign', { bool: true })).at(-1) === 'true';
    const replacement = (await this.client.text(['-c', 'i18n.commitEncoding=UTF-8', 'commit-tree', tree,
      ...commit.parents.flatMap(parent => ['-p', parent]), ...(sign ? ['-S'] : []), '-F', '-'],
    { ...LOCAL_WRITE, input: message, author: { name, email, date } })).trim();
    if (!isOid(replacement)) throw fail('git.invalidObjectId');
    return replacement;
  }

  async rewriteEarlier(plan, message, done, verify) {
    const { kind, work, commit, branch, oids: [oid] } = plan;
    let target = commit.parents[0];
    if (kind !== 'drop') {
      const squash = kind === 'squash';
      const tree = squash ? await this.stagedTree(oid, work.head.oid) :
        (await this.client.text(['rev-parse', '--verify', `${oid}^{tree}`])).trim();
      if (!isOid(tree)) throw fail('git.invalidObjectId');
      target = await this.replacementCommit(oid, tree, commit, squash ? `${commit.message}\n` : message);
    }
    const paths = [...await this.reads.replayPaths(oid, work.head.oid), ...await this.reads.changedPaths(work.head.oid, target), ...work.trackedPaths];
    await this.checkWorktreePaths(work, paths);
    await verify();
    let stash;
    if (kind === 'squash') {
      stash = new UpdateStash(this.client, this.reads, work.head.oid, 'Squash');
      await stash.save();
    }
    let result;
    try {
      const current = await this.branches.working();
      if (!sameHead(current.head, work.head) || current.trackedPaths.length) throw fail('history.staleAction');
      await this.checkWorktreePaths(current, paths);
      await this.client.text([...SEQUENCER, 'rebase', '--merge', '--no-autostash', '--no-update-refs', '--no-autosquash',
        '--no-rebase-merges', '--no-fork-point', '--reapply-cherry-picks', '--keep-empty', '--empty=keep', '--onto', target, oid], LOCAL_WRITE);
      const after = await this.reads.head();
      if (after.ref !== branch.ref || !after.oid || !(await this.reads.isAncestor(target, after.oid))) throw fail('history.staleAction');
      result = { message: t(done, { oid: shortOid(oid) }) };
    } catch (error) {
      try { result = await this.paused(error, 'git.historyRewritePaused'); }
      catch (failure) {
        if (!stash) throw failure;
        result = { warning: true, message: t('git.historySquashUnconfirmed', { detail: errorText(failure) }) };
      }
    }
    if (stash) result.message += `\n${stash.backupMessage()}`;
    return result;
  }
}

module.exports = { HistoryActions, RESET_MODES, PATCH, APPLY_OPTIONS };
