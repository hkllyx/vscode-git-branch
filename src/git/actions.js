'use strict';

const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fileURLToPath, pathToFileURL } = require('node:url');
const { t } = require('../i18n');
const { GitClient, GitError } = require('./gitClient');
const { GitReads, ensureResult } = require('./reads');
const { HistoryActions } = require('./historyActions');
const { parseFetchRules, mappedTracking, mappedSources } = require('./parse');
const { HEADS, REMOTES, sameHead } = require('./refs');
const { pathsOverlap, UpdateStash } = require('./updateChanges');
const { BranchError, errorText, shortOid, stripLineEnd } = require('../util/format');

const changed = key => new BranchError(t('git.changed', { what: t(key) }));
const sameUpstream = (a, b) => a?.tracking === b?.tracking && a?.remote === b?.remote && a?.source === b?.source;
const branchName = ref => ref.slice(HEADS.length);
const localRef = name => HEADS + name;
const localNameFor = (tip, { remote }) => tip.name.startsWith(`${remote}/`) ? tip.name.slice(remote.length + 1) : tip.name;
const WRITE = { write: true };
const NETWORK = { write: true, timeout: 120_000 };
const FETCH = ['fetch', '--atomic', '--no-all', '--no-update-head-ok', '--no-tags', '--no-prune', '--no-prune-tags',
  '--no-recurse-submodules', '--no-write-fetch-head', '--no-write-commit-graph', '--no-auto-maintenance', '--refmap='];
const SINGLE_PUSH = ['-c', 'push.autoSetupRemote=false', 'push', '--porcelain', '--no-follow-tags', '--recurse-submodules=no'];
const containsPath = (root, target) => {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

// Locks only extension-originated writes, including linked worktrees.
class WriteQueue {
  constructor() { this.pending = new Map(); }

  run(key, task) {
    const done = (this.pending.get(key) || Promise.resolve()).then(task);
    const tail = done.catch(() => {});
    this.pending.set(key, tail);
    tail.then(() => { if (this.pending.get(key) === tail) this.pending.delete(key); });
    return done;
  }
}

class GitActions {
  constructor(client, dirs) {
    this.client = client;
    this.dirs = dirs;
    this.reads = new GitReads(client);
    this.history = new HistoryActions(this);
  }

  async remotes() {
    const text = await this.client.text(['remote']);
    return text.split(/\r?\n/).filter(Boolean);
  }

  async configValues(key, { bool = false } = {}) {
    const result = await this.client.query(['config', '--null', ...(bool ? ['--bool'] : []), '--get-all', key]);
    ensureResult('config', result, [0, 1]);
    if (result.code === 1) return [];
    return result.out.toString('utf8').split('\0').slice(0, -1);
  }

  async remoteEndpoint(remote, push = false) {
    if (!(await this.remotes()).includes(remote)) throw new BranchError(t('git.remoteMissing'));
    const urls = (await this.client.text(['remote', 'get-url', ...(push ? ['--push'] : []), '--all', '--', remote]))
      .split(/\r?\n/).filter(Boolean);
    if (!urls.length) throw new BranchError(t('git.remoteUrlMissing'));
    if (push && (urls.length !== 1 || (await this.configValues(`remote.${remote}.mirror`, { bool: true })).at(-1) === 'true')) {
      throw new BranchError(t('git.pushMultipleUrls'));
    }
    return urls[0];
  }

  async named(ref) {
    if (ref === 'HEAD') {
      const head = await this.reads.head();
      if (!head.oid) throw new BranchError(t('branch.firstCommit'));
      return { ref, name: head.ref ? t('branch.headNamed', { name: branchName(head.ref) }) : t('branch.headDetached'), oid: head.oid, headRef: head.ref };
    }
    if (typeof ref !== 'string' || !(ref.startsWith(HEADS) || ref.startsWith(REMOTES))) throw new BranchError(t('git.explicitBranch'));
    const [item] = await this.reads.refs({ ref });
    if (!item?.oid) throw new BranchError(t('git.missingBranchCommit'));
    return item;
  }

  async verifyTip(expected) {
    const actual = await this.named(expected.ref);
    if (actual.oid !== expected.oid || actual.headRef !== expected.headRef) throw changed('git.changedBranchTip');
    return actual;
  }

  async validateName(name) {
    if (typeof name !== 'string' || !name || name.startsWith('-') || name.startsWith('@{-') || name.includes('\0')) {
      throw new BranchError(t('git.validBranchName'));
    }
    const result = await this.client.query(['check-ref-format', '--branch', name]);
    if (result.code !== 0 || stripLineEnd(result.out.toString('utf8')) !== name) throw new BranchError(t('git.invalidBranchName'));
    return name;
  }

  async assertFree(name) {
    await this.validateName(name);
    await this.assertFreeRef(HEADS, name, 'git.branchExists', 'git.branchConflict');
  }

  async assertFreeRef(prefix, name, exists, conflict) {
    const refs = await this.client.text(['for-each-ref', '--format=%(refname)', '--', prefix]);
    const ignoreCase = await this.ignoresCase();
    const key = value => ignoreCase ? value.toLowerCase() : value;
    const target = key(prefix + name);
    const collision = refs.split(/\r?\n/).find(ref => {
      const value = key(ref);
      return value && (value === target || value.startsWith(`${target}/`) || target.startsWith(`${value}/`));
    });
    if (collision) throw new BranchError(t(key(collision) === target ? exists : conflict, { name: collision.slice(prefix.length) }));
  }

  async ignoresCase() {
    return process.platform === 'win32' || (await this.configValues('core.ignorecase', { bool: true })).at(-1) === 'true';
  }

  async working() {
    const state = await this.reads.workingState(this.dirs.gitDir);
    if (state.operation || state.conflicted) throw new BranchError(t('git.operationInProgress'));
    return state;
  }

  async verifyWork(before) {
    const after = await this.working();
    if (!sameHead(before.head, after.head) || !before.status.equals(after.status)) throw changed('git.changedWork');
    return after;
  }

  async makeBranch(name, oid) {
    await this.client.text(['branch', '--no-track', '--', name, oid], WRITE);
  }

  async switchBranch(name, oid) {
    await this.client.text(['-c', 'submodule.recurse=false', 'switch', '--no-guess', '--no-overwrite-ignore', '--no-recurse-submodules', '--', name], WRITE);
    const head = await this.reads.head();
    if (!sameHead(head, { ref: localRef(name), oid })) throw changed('git.changedCheckoutHead');
  }

  async create({ name, tip }) {
    await this.assertFree(name);
    await this.verifyTip(tip);
    await this.makeBranch(name, tip.oid);
    return { message: t('git.created', { name }) };
  }

  async assertBranchEditable(tip, rename) {
    const { head } = await this.working();
    const current = head.ref === tip.ref;
    const occupied = await this.#checkedOutPaths(tip.ref);
    if (occupied.length > Number(current)) throw new BranchError(t('git.branchInAnotherWorktree', { name: tip.name }));
    if (current && !rename) throw new BranchError(t('git.cannotDeleteCurrent'));
    return current;
  }

  async branchToManage(ref, { rename = false } = {}) {
    const tip = await this.named(ref);
    if (tip.kind !== 'local') throw new BranchError(t('git.selectLocalBranch'));
    await this.assertBranchEditable(tip, rename);
    return tip;
  }

  async renameBranch(tip, name) {
    if (!tip.ref.startsWith(HEADS)) throw new BranchError(t('git.selectLocalBranch'));
    await this.assertFree(name);
    const current = await this.assertBranchEditable(tip, true);
    await this.verifyTip(tip);
    await this.client.text(['branch', '-m', '--', tip.name, name], WRITE);
    const [renamed] = await this.reads.refs({ ref: localRef(name) });
    if (renamed?.oid !== tip.oid || (current && !sameHead(await this.reads.head(), { ref: localRef(name), oid: tip.oid }))) {
      return { warning: true, message: t('git.renameUnconfirmed', { name }) };
    }
    return { message: t('git.renamed', { from: tip.name, name }) };
  }

  async deleteBranch(tip) {
    if (!tip.ref.startsWith(HEADS)) throw new BranchError(t('git.selectLocalBranch'));
    await this.assertBranchEditable(tip, false);
    await this.verifyTip(tip);
    await this.client.text(['branch', '-d', '--', tip.name], WRITE);
    return { message: t('git.deleted', { name: tip.name }) };
  }

  async remoteBranch(ref) {
    const tip = await this.named(ref);
    if (tip.kind !== 'remote') throw new BranchError(t('git.selectRemoteTrackingBranch'));
    return { tip, upstream: await this.mappingFor(ref) };
  }

  async deleteEndpoint(upstream) {
    const url = await this.remoteEndpoint(upstream.remote, true);
    // A push URL may address a different repository from the one shown in the tree.
    if (url !== await this.remoteEndpoint(upstream.remote)) throw new BranchError(t('git.remoteDeleteDifferentUrl'));
    await this.assertSeparateDeleteRepository(url);
    return url;
  }

  async assertSeparateDeleteRepository(url) {
    // A local-path remote can point back at this checkout or a linked worktree.
    // Compare common Git directories so a server delete cannot remove our local ref.
    let same = false;
    try {
      const endpoint = /^file:\/\//i.test(url) ? fileURLToPath(url)
        : path.isAbsolute(url) || !url.includes(':') || (process.platform === 'win32' && /^[A-Za-z]:/.test(url))
          ? path.resolve(this.client.root, url) : undefined;
      if (!endpoint) return;
      const peer = new GitReads(new GitClient(endpoint, this.client.executable));
      const [here, there] = await Promise.all([fs.realpath(this.dirs.commonDir), peer.directories().then(({ commonDir }) => fs.realpath(commonDir))]);
      same = path.relative(here, there) === '';
    } catch {
      throw new BranchError(t('git.remoteDeleteUnverifiedLocal'));
    }
    if (same) throw new BranchError(t('git.remoteDeleteSameRepository'));
  }

  async prepareRemoteDelete(ref) {
    const { tip, upstream } = await this.remoteBranch(ref);
    const name = branchName(upstream.source);
    await this.validateName(name);
    return { tip, upstream, name, url: await this.deleteEndpoint(upstream) };
  }

  async deleteRemote(plan) {
    const { tip, upstream, name } = plan;
    await this.verifyTip(tip);
    if (!sameUpstream(upstream, await this.mappingFor(tip.ref))) throw changed('git.changedRemoteMapping');
    if (await this.deleteEndpoint(upstream) !== plan.url) throw changed('git.changedPushUrl');
    await this.verifyTip(tip);
    // Exact lease: do not delete if the server branch gained (or lost) commits
    // since the confirmed snapshot. No unconditional force or mirror push.
    await this.#pushSingle(upstream.remote, `:${upstream.source}`, {
      lease: `${upstream.source}:${tip.oid}`, rejected: 'git.remoteDeleteRejected', unconfirmed: 'git.remoteDeleteUnconfirmed'
    });
    return { message: t('git.remoteDeleted', { remote: upstream.remote, name }) };
  }

  async remoteRules() {
    const remotes = await this.remotes();
    // Small batches keep the Git subprocess count bounded with many remotes.
    const configs = new Map();
    for (let i = 0; i < remotes.length; i += 4) {
      await Promise.all(remotes.slice(i, i + 4).map(async name => {
        configs.set(name, parseFetchRules(await this.configValues(`remote.${name}.fetch`)));
      }));
    }
    return configs;
  }

  async mappingFor(tracking, configs) {
    if (!tracking?.startsWith(REMOTES)) throw new BranchError(t('git.noTrackingRef'));
    configs ||= await this.remoteRules();
    const candidates = [...configs].flatMap(([remote, rules]) => mappedSources(rules, tracking).map(source => ({ tracking, remote, source })));
    if (candidates.length !== 1 || !candidates[0].source.startsWith(HEADS)) {
      throw new BranchError(t('git.ambiguousRemoteBranch', { name: tracking.slice(REMOTES.length) }));
    }
    return candidates[0];
  }

  async prepareRemoteCheckout(ref) {
    const { tip, upstream } = await this.remoteBranch(ref);
    // Keep the displayed name except for the exact, configured remote prefix.
    const name = localNameFor(tip, upstream);
    await this.assertFree(name);
    return { tip, upstream, name, work: await this.working() };
  }

  async prepareCheckout(ref) {
    const tip = await this.named(ref);
    if (tip.kind !== 'local') throw new BranchError(t('git.selectLocalBranch'));
    if ((await this.reads.head()).ref === tip.ref) return { already: true, name: tip.name };
    return { tip, name: tip.name, work: await this.working() };
  }

  async settingUpstream(name, tracking) {
    await this.client.text(['branch', `--set-upstream-to=${tracking}`, '--', name], WRITE);
  }

  async checkout(plan, checkEditors) {
    await this.verifyTip(plan.tip);
    await this.verifyWork(plan.work);
    checkEditors?.();
    if (!plan.upstream) {
      await this.switchBranch(plan.name, plan.tip.oid);
      return { message: t('git.checkedOut', { name: plan.name }) };
    }
    if (!sameUpstream(plan.upstream, await this.mappingFor(plan.tip.ref))) throw changed('git.changedRemoteMapping');
    await this.assertFree(plan.name);
    await this.makeBranch(plan.name, plan.tip.oid);
    let trackingSet = false;
    try {
      await this.verifyTip(plan.tip);
      await this.settingUpstream(plan.name, plan.upstream.tracking);
      trackingSet = true;
      await this.verifyWork(plan.work);
      checkEditors?.();
      await this.switchBranch(plan.name, plan.tip.oid);
      return { message: t('git.checkedOutTracking', { name: plan.name, remote: plan.tip.name }) };
    } catch (error) {
      const message = t(trackingSet ? 'git.remoteCheckoutTrackedPartial' : 'git.remoteCheckoutPartial', { name: plan.name, detail: errorText(error) });
      return { warning: true, message };
    }
  }

  async #checkedOutPaths(ref) {
    const list = await this.client.text(['worktree', 'list', '--porcelain', '-z']);
    const matches = [];
    for (const record of list.split('\0\0')) {
      const [worktree, ...fields] = record.split('\0');
      if (worktree.startsWith('worktree ') && fields.includes(`branch ${ref}`)) matches.push(worktree.slice('worktree '.length));
    }
    return matches;
  }

  async assertNotCheckedOut(tip) {
    const [directory] = await this.#checkedOutPaths(tip.ref);
    if (directory) throw new BranchError(t('git.branchCheckedOutAt', { name: tip.name, path: directory }));
  }

  async prepareWorktree(ref) {
    const tip = await this.named(ref);
    if (tip.kind === 'remote') {
      const upstream = await this.mappingFor(ref);
      return { tip, upstream, newBranch: true, suggestedName: localNameFor(tip, upstream) };
    }
    if (tip.kind !== 'local') throw new BranchError(t('git.explicitBranch'));
    const [occupied] = await this.#checkedOutPaths(ref);
    return { tip, newBranch: Boolean(occupied), suggestedName: tip.name };
  }

  async worktreePath(value) {
    if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) throw new BranchError(t('git.worktreeAbsolutePath'));
    const target = path.resolve(value);
    if (target === path.parse(target).root) throw new BranchError(t('git.worktreeEmptyPath'));
    let resolved;
    try {
      const parent = await fs.realpath(path.dirname(target));
      if (!(await fs.stat(parent)).isDirectory()) throw new BranchError(t('git.worktreeParentMissing'));
      resolved = path.join(parent, path.basename(target));
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw new BranchError(t('git.worktreeParentMissing'));
      throw error;
    }
    if ((await Promise.all([this.dirs.gitDir, this.dirs.commonDir].map(folder => fs.realpath(folder))))
      .some(folder => containsPath(folder, resolved))) throw new BranchError(t('git.worktreeEmptyPath'));
    try {
      const stat = await fs.lstat(resolved);
      if (!stat.isDirectory() || (await fs.readdir(resolved)).length) throw new BranchError(t('git.worktreeEmptyPath'));
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return resolved;
  }

  async createWorktree(plan, target, name) {
    if (await this.worktreePath(target) !== target) throw changed('git.changedWorktreePath');
    if (plan.newBranch) await this.assertFree(name);
    else await this.assertNotCheckedOut(plan.tip);
    if (plan.upstream && !sameUpstream(plan.upstream, await this.mappingFor(plan.tip.ref))) throw changed('git.changedRemoteMapping');
    await this.verifyTip(plan.tip);
    const branch = plan.newBranch ? name : plan.tip.name;
    try {
      await this.client.text(['-c', 'submodule.recurse=false', 'worktree', 'add', '--no-guess-remote', '--checkout',
        ...(plan.newBranch ? ['--no-track', '-b', name] : []), '--', target, plan.newBranch ? plan.tip.oid : branch], WRITE);
      const linked = new GitReads(new GitClient(target, this.client.executable));
      if (!sameHead(await linked.head(), { ref: localRef(branch), oid: plan.tip.oid })) throw changed('git.changedCheckoutHead');
    } catch (error) {
      return { warning: true, message: t('git.worktreeUnconfirmed', { path: target, detail: errorText(error) }) };
    }
    const message = t('git.worktreeCreated', { name: branch, path: target });
    if (!plan.upstream) return { message };
    try {
      if (!sameUpstream(plan.upstream, await this.mappingFor(plan.tip.ref))) throw changed('git.changedRemoteMapping');
      await this.verifyTip(plan.tip);
      await this.settingUpstream(branch, plan.upstream.tracking);
      return { message: `${message} ${t('git.upstreamSet')}` };
    } catch (error) {
      return { warning: true, message: `${message}\n${t('git.upstreamSetFailed', { detail: errorText(error) })}` };
    }
  }

  async preparePull(selectedRef) {
    const work = await this.working();
    if (!work.head.ref || !work.head.oid) throw new BranchError(t('git.pullNeedsLocalHead'));
    if (selectedRef && selectedRef !== work.head.ref) throw new BranchError(t('git.pullCurrentOnly'));
    const tip = await this.named(work.head.ref);
    if (tip.oid !== work.head.oid) throw changed('git.changedCurrentBranch');
    return { ...await this.updateSource(tip), work };
  }

  async updateSource(tip) {
    if (tip.kind !== 'local') throw new BranchError(t('git.selectLocalBranch'));
    if (!tip.upstream?.remote || tip.upstream.remote === '.' || !tip.upstream.source?.startsWith(HEADS)) {
      throw new BranchError(t('git.pullNeedsUpstream'));
    }
    const upstream = await this.mappingFor(tip.upstream.tracking);
    if (!sameUpstream(upstream, tip.upstream)) throw new BranchError(t('git.upstreamFetchMismatch'));
    return { tip, upstream, url: await this.remoteEndpoint(upstream.remote) };
  }

  async prepareUpdate(ref) {
    if (!ref || ref === (await this.reads.head()).ref) return this.preparePull(ref);
    const plan = await this.updateSource(await this.named(ref));
    await this.assertNotCheckedOut(plan.tip);
    return plan;
  }

  async verifyUpdateSource(plan) {
    const tip = await this.verifyTip(plan.tip);
    if (!sameUpstream(tip.upstream, plan.upstream) || !sameUpstream(plan.upstream, await this.mappingFor(plan.upstream.tracking))) throw changed('git.changedUpstream');
    if ((await this.remoteEndpoint(plan.upstream.remote)) !== plan.url) throw changed('git.changedRemoteUrl');
  }

  async verifyPull(plan, checkEditors) {
    await this.verifyUpdateSource(plan);
    await this.verifyWork(plan.work);
    checkEditors?.();
  }

  async prepareCheckoutUpdate(ref) {
    const checkout = await this.prepareCheckout(ref);
    if (checkout.already) throw new BranchError(t('git.checkoutUpdateNeedsOther'));
    await this.assertNotCheckedOut(checkout.tip);
    return { checkout, update: await this.updateSource(checkout.tip) };
  }

  async checkoutAndUpdate(plan, checkEditors, confirmStash) {
    await this.verifyUpdateSource(plan.update);
    await this.checkout(plan.checkout, checkEditors);
    const name = plan.checkout.name;
    try {
      const work = await this.working();
      if (!sameHead(work.head, plan.update.tip)) throw changed('git.changedCheckoutHead');
      const result = await this.pull({ ...plan.update, work }, checkEditors, confirmStash);
      return { ...result, message: `${t('git.checkedOut', { name })}\n${result.message}` };
    } catch (error) {
      throw new BranchError(t('git.checkoutUpdatePartial', { name, detail: errorText(error) }), { terminal: error.terminal });
    }
  }

  async fastForward(oid, options = WRITE) {
    await this.client.text(['-c', 'submodule.recurse=false', 'merge', '--ff-only', '--no-squash', '--commit',
      '--no-autostash', '--no-overwrite-ignore', '--no-edit', '--', oid], options);
  }

  async integratePull(plan, oid, checkEditors, confirmStash) {
    const { work, tip } = plan;
    let stash, saved = false, result;
    let ignoreCase = process.platform === 'win32';
    const target = { ref: tip.ref, oid };
    const overlapsUntracked = async state => pathsOverlap(work.trackedPaths,
      [...state.untrackedPaths, ...await this.reads.ignoredPaths()], ignoreCase);
    try {
      if (work.changedGitlink || work.intentToAdd) throw new BranchError(t(work.changedGitlink ? 'git.updateSubmoduleChanged' : 'git.updateIntentToAdd'));
      if (work.trackedPaths.length) ignoreCase ||= (await this.configValues('core.ignorecase', { bool: true })).at(-1) === 'true';
      const needsStash = work.staged || (work.trackedPaths.length > 0
        && pathsOverlap(work.trackedPaths, await this.reads.changedPaths(tip.oid, oid), ignoreCase));
      // After a staged deletion the same path can contain a new untracked or ignored file.
      // Git's stash can record that replacement and then fail to clean the worktree.
      if (needsStash && await overlapsUntracked(work)) throw new BranchError(t('git.updateSaveBlocked'));
      await this.verifyWork(work);
      checkEditors?.();
      if (needsStash) {
        if (!await confirmStash?.()) return { warning: true, message: t('git.updateStashCancelled') };
        // The modal can stay open while another Git process changes the checkout.
        await this.verifyPull(plan, checkEditors);
        if (await overlapsUntracked(work)) throw new BranchError(t('git.updateSaveBlocked'));
        stash = new UpdateStash(this.client, this.reads, tip.oid);
        await stash.save();
        saved = true;
        const state = await this.working();
        if (!sameHead(work.head, state.head) || state.trackedPaths.length) throw changed('git.changedWork');
        checkEditors?.();
      }
      await this.fastForward(oid);
      if (!sameHead(await this.reads.head(), target)) throw new BranchError(t('git.fastForwardStateUnexpected'));
      result = { message: t('git.pulled', { name: tip.name, oid: shortOid(oid) }) };
    } catch (error) {
      result = { warning: true, message: t('git.fastForwardUnconfirmed', { detail: errorText(error) }) };
    }
    if (!saved) return result;
    try {
      // Restore on the old checkout if integration was blocked, or on the
      // verified target if it moved. Never apply into an unrelated checkout.
      const after = await this.working();
      if ((!sameHead(after.head, target) && !sameHead(after.head, work.head)) || after.trackedPaths.length) throw changed('git.changedWork');
      if (await overlapsUntracked(after)) throw new BranchError(t('git.updateRestoreBlocked'));
      await this.verifyWork(after);
      checkEditors?.();
      await stash.apply();
      result.message += `\n${t('git.updateRestored')}`;
    } catch (error) {
      result.warning = true;
      result.message += `\n${t('git.updateRestoreFailed', { detail: errorText(error) })}`;
    }
    result.message += `\n${stash.backupMessage()}`;
    return result;
  }

  async withFetchedCommit(upstream, integrate, onIntegrationError) {
    const { remote, source, tracking } = upstream;
    const receipt = `refs/git-branch/fetch/${randomUUID()}`;
    let fetched = false, oid, result, failure;
    try {
      await this.client.text(['-c', `remote.${remote}.followRemoteHEAD=never`, ...FETCH,
        '--', remote, `+${source}:${tracking}`, `+${source}:${receipt}`], NETWORK);
      fetched = true;
      // Pin this fetch's commit even if another process moves the tracking ref.
      oid = await this.reads.resolveCommit(receipt);
      if (!oid) throw new BranchError(t('git.fetchCommitUnconfirmed'));
      result = await integrate(oid);
    } catch (error) {
      if (fetched) result = { warning: true, message: t(onIntegrationError, { detail: errorText(error) }) };
      else failure = new BranchError(t('git.fetchUnconfirmed', { detail: errorText(error) }), { warning: false, terminal: error.auth });
    } finally {
      try { await this.client.text(['update-ref', '-d', receipt, ...(oid ? [oid] : [])], WRITE); }
      catch {
        const detail = t('git.receiptCleanupFailed');
        if (failure) failure.message += `\n${detail}`;
        else result = { warning: true, message: `${result.message}\n${detail}` };
      }
    }
    if (failure) throw failure;
    return result;
  }

  async fastForwardStatus(tip, oid) {
    if (await this.reads.isAncestor(oid, tip.oid)) return { message: t('git.pullUpToDate') };
    if (!(await this.reads.isAncestor(tip.oid, oid))) return { warning: true, message: t('git.pullDiverged') };
    return undefined;
  }

  async pull(plan, checkEditors, confirmStash) {
    await this.verifyPull(plan, checkEditors);
    return this.withFetchedCommit(plan.upstream, async oid => {
      await this.verifyPull(plan, checkEditors);
      return await this.fastForwardStatus(plan.tip, oid) || this.integratePull(plan, oid, checkEditors, confirmStash);
    }, 'git.fastForwardUnconfirmed');
  }

  async update(plan, checkEditors, confirmStash) {
    if (plan.work) return this.pull(plan, checkEditors, confirmStash);
    const verify = async () => {
      await this.verifyUpdateSource(plan);
      await this.assertNotCheckedOut(plan.tip);
    };
    await verify();
    return this.withFetchedCommit(plan.upstream, async oid => {
      await verify();
      const status = await this.fastForwardStatus(plan.tip, oid);
      if (status) return status;
      await verify();
      // Use Git's non-forced fetch rather than update-ref: Git refuses to move
      // a branch checked out in any worktree. The object is already here.
      await this.client.text([...FETCH, '--', pathToFileURL(this.client.root).href,
        `${oid}:${plan.tip.ref}`], { ...WRITE, localFetch: true });
      if ((await this.named(plan.tip.ref)).oid !== oid) throw changed('git.changedBranchTip');
      return { message: t('git.pulled', { name: plan.tip.name, oid: shortOid(oid) }) };
    }, 'git.fastForwardUnconfirmed');
  }

  async prepareIntegration(ref, mode, fetch) {
    const work = await this.working();
    if (!work.head.ref || !work.head.oid) throw new BranchError(t('git.integrationLocalHead'));
    if (ref === work.head.ref) throw new BranchError(t('git.integrationSameBranch'));
    const current = await this.named(work.head.ref);
    if (!sameHead(work.head, current)) throw changed('git.changedCurrentBranch');
    this.assertIntegrationClean(work);
    const { tip, upstream } = fetch ? await this.remoteBranch(ref) : { tip: await this.named(ref) };
    if (tip.kind !== 'local' && tip.kind !== 'remote') throw new BranchError(t('git.explicitBranch'));
    return { current, tip, work, mode, upstream, url: fetch ? await this.remoteEndpoint(upstream.remote) : undefined };
  }

  assertIntegrationClean(work) {
    if (work.trackedPaths.length) throw new BranchError(t('git.integrationCleanWork'));
  }

  async verifyIntegration(plan, checkEditors, fetched = false) {
    if (!fetched) await this.verifyTip(plan.tip);
    if (plan.upstream) {
      if (!sameUpstream(plan.upstream, await this.mappingFor(plan.tip.ref))) throw changed('git.changedRemoteMapping');
      if (await this.remoteEndpoint(plan.upstream.remote) !== plan.url) throw changed('git.changedRemoteUrl');
    }
    const work = await this.verifyWork(plan.work);
    this.assertIntegrationClean(work);
    checkEditors?.();
  }

  async protectRebasePaths(plan, oid) {
    const untracked = [...plan.work.untrackedPaths, ...await this.reads.ignoredPaths()];
    if (!untracked.length) return;
    const [checkoutPaths, replayPaths] = await Promise.all([
      this.reads.changedPaths(plan.current.oid, oid), this.reads.replayPaths(oid, plan.current.oid)
    ]);
    const ignoreCase = process.platform === 'win32' || (await this.configValues('core.ignorecase', { bool: true })).at(-1) === 'true';
    if (pathsOverlap(untracked, [...checkoutPaths, ...replayPaths], ignoreCase)) throw new BranchError(t('git.rebaseUnsafePaths'));
  }

  async integrate(plan, checkEditors, confirmRewrite) {
    await this.verifyIntegration(plan, checkEditors);
    const apply = async oid => {
      if (plan.upstream) await this.verifyIntegration(plan, checkEditors, true);
      if (await this.reads.isAncestor(oid, plan.current.oid)) return { message: t('git.integrationUpToDate', { name: plan.current.name }) };
      const rebase = plan.mode === 'rebase';
      const fastForward = rebase && await this.reads.isAncestor(plan.current.oid, oid);
      if (!fastForward && !(await this.reads.commonAncestor(plan.current.oid, oid))) throw new BranchError(t('git.integrationUnrelated'));
      if (rebase) await this.protectRebasePaths(plan, oid);
      if (rebase && !fastForward) {
        if (!await confirmRewrite?.(oid)) return { warning: true, message: t(plan.upstream ? 'git.rebaseFetchedCancelled' : 'git.rebaseCancelled') };
        await this.protectRebasePaths(plan, oid);
      }
      await this.verifyIntegration(plan, checkEditors, Boolean(plan.upstream));
      const args = rebase ? ['-c', 'merge.directoryRenames=false', '-c', 'rebase.updateRefs=false', 'rebase', '--merge',
        '--no-autostash', '--no-autosquash', '--no-rebase-merges', '--no-fork-point', '--', oid]
        : ['merge', '--ff', '--no-squash', '--commit', '--no-autostash', '--no-overwrite-ignore', '--no-edit', '--', oid];
      try {
        const options = { ...WRITE, offline: true };
        if (fastForward) await this.fastForward(oid, options);
        else await this.client.text(['-c', 'submodule.recurse=false', '-c', 'rerere.enabled=false', ...args], options);
      } catch (error) {
        const state = await this.reads.workingState(this.dirs.gitDir);
        if (state.conflicted || state.operation) {
          return { warning: true, message: t(rebase ? 'git.rebasePaused' : 'git.mergePaused', { detail: errorText(error) }) };
        }
        throw error;
      }
      const actual = await this.reads.head();
      if (actual.ref !== plan.current.ref || !actual.oid || !(await this.reads.isAncestor(oid, actual.oid))) throw changed('git.changedCurrentBranch');
      return { message: t(rebase ? 'git.rebased' : 'git.merged', { name: plan.current.name, oid: shortOid(oid) }) };
    };
    return plan.upstream ? this.withFetchedCommit(plan.upstream, apply, 'git.integrationFetchUnconfirmed') : apply(plan.tip.oid);
  }

  async pushSource(ref) {
    const tip = await this.named(ref);
    if (tip.kind !== 'local') throw new BranchError(t('git.pushLocalOnly'));
    return tip;
  }

  preferredPush(tip) {
    const upstream = tip.upstream;
    return upstream?.remote && upstream.remote !== '.' && upstream.source?.startsWith(HEADS)
      ? { remote: upstream.remote, name: branchName(upstream.source) } : undefined;
  }

  async pushTracking(remote, target) {
    const configs = await this.remoteRules();
    const rules = configs.get(remote);
    const matches = rules ? mappedTracking(rules, target) : [];
    if (matches.length !== 1) return undefined;
    try {
      const mapped = await this.mappingFor(matches[0], configs);
      return mapped.remote === remote && mapped.source === target ? matches[0] : undefined;
    } catch (error) { if (!(error instanceof BranchError)) throw error; return undefined; }
  }

  async preparePush(tip, remote, name, setUpstream) {
    await this.validateName(name);
    const url = await this.remoteEndpoint(remote, true);
    const target = localRef(name);
    const tracking = setUpstream ? await this.pushTracking(remote, target) : undefined;
    if (setUpstream && !tracking) throw new BranchError(t('git.pushTrackingAmbiguous'));
    return { tip, remote, name, target, url, tracking };
  }

  async push(plan) {
    const before = await this.verifyTip(plan.tip);
    if (!sameUpstream(before.upstream, plan.tip.upstream)) throw changed('git.changedUpstreamConfig');
    if ((await this.remoteEndpoint(plan.remote, true)) !== plan.url) throw changed('git.changedPushUrl');
    if (plan.tracking && await this.pushTracking(plan.remote, plan.target) !== plan.tracking) throw changed('git.changedRemoteMapping');
    await this.verifyTip(plan.tip);
    await this.#pushSingle(plan.remote, `${plan.tip.oid}:${plan.target}`, {
      rejected: 'git.pushRejected', unconfirmed: 'git.pushUnconfirmed'
    });
    const message = t('git.pushed', { name: plan.tip.name, remote: plan.remote, target: plan.name });
    if (!plan.tracking) return { message };
    try {
      const after = await this.verifyTip(plan.tip);
      if (!sameUpstream(after.upstream, plan.tip.upstream)) throw changed('git.changedUpstreamConfig');
      if ((await this.pushTracking(plan.remote, plan.target)) !== plan.tracking) throw changed('git.changedRemoteMapping');
      await this.settingUpstream(plan.tip.name, plan.tracking);
      return { message: `${message} ${t('git.upstreamSet')}` };
    } catch (error) {
      return { warning: true, message: `${message}\n${t('git.upstreamSetFailed', { detail: errorText(error) })}` };
    }
  }

  async #pushSingle(remote, refspec, { lease, rejected, unconfirmed }) {
    try {
      await this.client.text([...SINGLE_PUSH, ...(lease ? [`--force-with-lease=${lease}`] : []), '--', remote, refspec], NETWORK);
    } catch (error) {
      const known = error instanceof GitError && (error.rejected || error.auth) && !error.remoteFailure;
      throw new BranchError(t(known ? rejected : unconfirmed, { detail: errorText(error) }), { warning: false, terminal: error.auth });
    }
  }
}

module.exports = { GitActions, WriteQueue };
