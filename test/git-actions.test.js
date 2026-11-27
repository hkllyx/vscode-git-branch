'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { fixture } = require('../test-support/gitFixture');
const { WriteQueue } = require('../src/git/actions');
const { GitError } = require('../src/git/gitClient');

const allowStash = async () => true;
const localRef = name => `refs/heads/${name}`;
const remoteRef = name => `refs/remotes/${name}`;
const upstream = (local, name = 'main') => local.reads.refs({ ref: localRef(name) }).then(([branch]) => branch?.upstream);
const branchTip = (repo, name = 'main') => repo.reads.resolveCommit(localRef(name));

async function noReceipts(local) {
  assert.equal(await local.git('for-each-ref', '--format=%(refname)', 'refs/git-branch/'), '');
}

test('create validates full names, fixes the start point and never inherits an upstream by default', async t => {
  const f = await fixture(t);
  const { local, initial } = await f.remotePair();
  const { actions } = local;
  const tip = await actions.named('HEAD');
  await assert.rejects(actions.create({ name: 'main/child', tip }), /ref path conflict/);
  await assert.rejects(actions.create({ name: 'main', tip }), /already exists/);
  await assert.rejects(actions.create({ name: '-bad', tip }), /Git branch name/);
  await assert.rejects(actions.create({ name: '@{-1}', tip }), /Git branch name/);
  const name = 'feature/搜索';
  await actions.create({ name, tip: await actions.named(remoteRef('origin/main')) });
  assert.equal(await branchTip(local, name), initial);
  assert.equal(await upstream(local, name), undefined);
  assert.equal((await local.reads.head()).ref, localRef('main'));
  await assert.rejects(actions.create({ name: 'feature', tip }), /ref path conflict/);
  if (process.platform === 'win32') await assert.rejects(actions.create({ name: 'MAIN', tip }), /Local branch main already exists/);
  const next = await local.commit('advance');
  await assert.rejects(actions.create({ name: 'stale', tip }), /confirm again/);
  assert.equal(await branchTip(local, 'stale'), undefined);
  await local.git('switch', '--detach', next);
  await actions.create({ name: 'from-detached', tip: await actions.named('HEAD') });
  assert.deepEqual(await local.reads.head(), { ref: undefined, oid: next });
  await actions.checkout(await actions.prepareCheckout(localRef('from-detached')));
  assert.deepEqual(await local.reads.head(), { ref: localRef('from-detached'), oid: next });
  const empty = await f.repo('empty');
  await assert.rejects(empty.actions.named('HEAD'), /no commits yet/);
});

test('rename preserves branch tip and tracking, including the current local branch', async t => {
  const f = await fixture(t);
  const { local, remote, initial } = await f.remotePair();
  const { actions } = local;
  const before = await upstream(local);
  const tip = await actions.branchToManage(localRef('main'), { rename: true });
  await local.git('branch', 'taken');
  await assert.rejects(actions.renameBranch(tip, 'taken'), /already exists/);
  await assert.rejects(actions.branchToManage(remoteRef('origin/main'), { rename: true }), /local branch/);
  await local.write('common.txt', 'keep edits when renaming');
  const result = await actions.renameBranch(tip, 'main-renamed');
  assert.match(result.message, /Renamed main to main-renamed/);
  assert.equal(await branchTip(local), undefined);
  assert.deepEqual(await local.reads.head(), { ref: localRef('main-renamed'), oid: initial });
  assert.deepEqual(await upstream(local, 'main-renamed'), before);
  assert.equal(await branchTip(remote), initial);
  assert.equal(await local.read('common.txt'), 'keep edits when renaming');
});

test('branch management rejects other worktrees, stale plans and unsafe deletion', async t => {
  const f = await fixture(t);
  const { local, remote, initial } = await f.remotePair();
  const { actions } = local;
  await assert.rejects(actions.branchToManage(localRef('main')), /cannot delete the current branch/);
  await local.git('branch', 'merged');
  const merged = await actions.branchToManage(localRef('merged'));
  const linked = path.join(f.root, 'linked');
  await local.git('worktree', 'add', linked, 'merged');
  await assert.rejects(actions.renameBranch(merged, 'renamed'), /another worktree/);
  await assert.rejects(actions.deleteBranch(merged), /another worktree/);
  await local.git('worktree', 'remove', linked);
  await local.git('switch', '-c', 'unmerged');
  const unmerged = await local.commit('unmerged', { 'new.txt': 'unmerged' });
  await local.git('switch', 'main');
  const orphan = await actions.branchToManage(localRef('unmerged'));
  await assert.rejects(actions.deleteBranch(orphan), /not fully merged/);
  assert.equal(await branchTip(local, 'unmerged'), unmerged);
  await local.git('update-ref', merged.ref, unmerged);
  await assert.rejects(actions.deleteBranch(merged), /branch tip changed/);
  await assert.rejects(actions.renameBranch(merged, 'renamed'), /branch tip changed/);
  await local.git('update-ref', merged.ref, initial);
  assert.match((await actions.deleteBranch(merged)).message, /Deleted local branch merged/);
  assert.equal(await branchTip(local, 'merged'), undefined);
  assert.equal(await branchTip(remote), initial);
});

test('local checkout preserves safe edits and refuses tracked, untracked, ignored or other-worktree overwrites', async t => {
  const f = await fixture(t);
  const local = await f.repo('local');
  const root = await local.commit('root', { 'common.txt': 'root', 'carry.txt': 'old', '.gitignore': 'ignored.txt\n' });
  await local.git('switch', '-c', 'other');
  await local.commit('target', { 'common.txt': 'target', 'untracked.txt': 'target' });
  await local.git('add', '-f', '--', '.gitignore');
  await local.write('ignored.txt', 'target');
  await local.git('add', '-f', '--', 'ignored.txt');
  await local.git('commit', '-m', 'track ignored path on target');
  await local.git('switch', 'main');
  const { actions } = local;
  const checkout = async () => actions.checkout(await actions.prepareCheckout(localRef('other')));
  await local.write('common.txt', 'do not overwrite');
  await assert.rejects(checkout(), GitError);
  assert.equal(await local.read('common.txt'), 'do not overwrite');
  await local.git('restore', 'common.txt');
  await local.write('untracked.txt', 'keep untracked');
  await assert.rejects(checkout(), GitError);
  assert.equal(await local.read('untracked.txt'), 'keep untracked');
  const fs = require('node:fs/promises');
  await fs.unlink(path.join(local.dir, 'untracked.txt'));
  await local.write('ignored.txt', 'keep ignored');
  await assert.rejects(checkout(), GitError);
  assert.equal(await local.read('ignored.txt'), 'keep ignored');
  await fs.unlink(path.join(local.dir, 'ignored.txt'));
  await local.git('worktree', 'add', path.join(f.root, 'linked'), 'other');
  await assert.rejects(checkout(), GitError);
  assert.equal((await local.reads.head()).oid, root);
  await local.git('worktree', 'remove', path.join(f.root, 'linked'));
  await local.write('carry.txt', 'safe edit');
  const plan = await actions.prepareCheckout(localRef('other'));
  await actions.checkout(plan);
  assert.equal(await local.read('carry.txt'), 'safe edit');
  assert.equal((await local.reads.head()).ref, localRef('other'));
});

test('remote checkout strips only the configured remote prefix and rejects local collisions before and after confirmation', async t => {
  const f = await fixture(t);
  const { local, seed, initial } = await f.remotePair();
  const remote = 'review/team';
  const name = 'feature/origin/search';
  const source = localRef(name);
  const tracking = remoteRef(`${remote}/${name}`);
  await seed.git('push', 'origin', `HEAD:${source}`);
  await local.git('remote', 'rename', 'origin', remote);
  await local.git('fetch', '--no-tags', remote);
  const { actions } = local;
  // main already tracks this very remote. Selecting the remote entry still fails.
  await assert.rejects(actions.prepareRemoteCheckout(remoteRef(`${remote}/main`)), /Local branch main already exists/);
  await local.git('branch', 'feature');
  await assert.rejects(actions.prepareRemoteCheckout(tracking), /ref path conflict with local branch feature/);
  await local.git('branch', '-d', 'feature');

  const localTip = await local.commit('local advance');
  const plan = await actions.prepareRemoteCheckout(tracking);
  assert.equal(plan.name, name);
  assert.deepEqual(plan.upstream, { remote, source, tracking });
  // Another Git process creates the name while this operation awaits confirmation.
  await local.git('branch', '--no-track', name, localTip);
  await assert.rejects(actions.checkout(plan), /Local branch feature\/origin\/search already exists/);
  assert.deepEqual(await local.reads.head(), { ref: localRef('main'), oid: localTip });
  assert.equal(await branchTip(local, name), localTip);
  assert.equal(await upstream(local, name), undefined);
  await local.git('branch', '-d', name);

  assert.equal((await actions.checkout(await actions.prepareRemoteCheckout(tracking))).warning, undefined);
  assert.deepEqual(await local.reads.head(), { ref: source, oid: initial });
  assert.deepEqual(await upstream(local, name), plan.upstream);
  await assert.rejects(actions.prepareRemoteCheckout(tracking), /already exists/);
});

test('remote checkout preserves the displayed suffix for custom mappings and refuses ambiguous tracking', async t => {
  const f = await fixture(t);
  const { local, seed, initial } = await f.remotePair();
  const source = localRef('topic/a');
  await seed.git('push', 'origin', `HEAD:${source}`);
  await local.git('config', '--replace-all', 'remote.origin.fetch', '+refs/heads/topic/*:refs/remotes/origin/cache/*');
  await local.git('fetch', '--no-tags', 'origin');
  const tracking = remoteRef('origin/cache/a');
  const { actions } = local;
  const plan = await actions.prepareRemoteCheckout(tracking);
  assert.equal(plan.name, 'cache/a');
  assert.deepEqual(plan.upstream, { tracking, source, remote: 'origin' });
  assert.equal((await actions.checkout(plan)).warning, undefined);
  assert.deepEqual(await local.reads.head(), { ref: localRef('cache/a'), oid: initial });
  assert.deepEqual(await upstream(local, 'cache/a'), plan.upstream);
  await local.git('config', '--add', 'remote.origin.fetch', '+refs/heads/topic/*:refs/remotes/origin/also/*');
  await assert.rejects(actions.prepareRemoteCheckout(tracking), /multiple mappings/);
  await local.git('config', '--add', 'remote.origin.fetch', '^refs/heads/topic/a');
  await assert.rejects(actions.prepareRemoteCheckout(tracking), /unique remote branch/);
  await local.git('config', '--replace-all', 'remote.origin.fetch', '+refs/heads/topic/*:refs/remotes/mirror-cache/*');
  await local.git('fetch', '--no-tags', 'origin');
  const alias = await actions.prepareRemoteCheckout(remoteRef('mirror-cache/a'));
  assert.equal(alias.name, 'mirror-cache/a', 'do not remove an unrelated leading component');
  assert.equal(alias.upstream.source, source);
});

test('pull fetches one ref, fast-forwards its pinned OID and reports already current', async t => {
  const f = await fixture(t);
  const { local, seed, initial } = await f.remotePair();
  const { actions } = local;
  const next = await seed.commit('advance', { 'common.txt': 'updated\n' });
  await seed.git('branch', 'unrequested');
  await seed.git('tag', 'unrequested-tag');
  await seed.git('push', 'origin', 'main', 'unrequested', 'unrequested-tag');
  await local.git('update-ref', remoteRef('origin/stale'), initial);
  await local.git('config', 'fetch.prune', 'true');
  await local.git('config', 'fetch.pruneTags', 'true');
  await local.git('config', 'remote.origin.tagOpt', '--tags');
  await local.git('config', 'pull.rebase', 'true');
  await local.git('config', 'branch.main.mergeOptions', '--squash --no-commit');
  const fetchHead = path.join(local.dirs.gitDir, 'FETCH_HEAD');
  const fs = require('node:fs/promises');
  await fs.writeFile(fetchHead, 'keep fetch log\n');
  assert.equal(await local.head(), initial);
  const plan = await actions.preparePull(localRef('main'));
  const result = await actions.pull(plan);
  assert.match(result.message, /fast-forwarded/);
  assert.equal(result.warning, undefined);
  assert.equal(await local.head(), next);
  assert.equal(await local.reads.resolveCommit(remoteRef('origin/main')), next);
  assert.equal(await local.reads.resolveCommit(remoteRef('origin/unrequested')), undefined);
  assert.equal(await local.reads.resolveCommit(remoteRef('origin/stale')), initial);
  assert.equal(await local.reads.resolveCommit('refs/tags/unrequested-tag'), undefined);
  assert.equal(await fs.readFile(fetchHead, 'utf8'), 'keep fetch log\n');
  await noReceipts(local);
  assert.match((await actions.pull(await actions.preparePull())).message, /already up to date/);
  await noReceipts(local);
});

test('update reports divergence without touching dirty work and rechecks after a fetch', async t => {
  const f = await fixture(t);
  const { local, seed } = await f.remotePair();
  const next = await seed.commit('remote advance', { 'remote.txt': 'remote' });
  await seed.git('push', 'origin', 'main');
  const localTip = await local.commit('local advance', { 'local.txt': 'local' });
  await local.write('untracked.txt', 'dirty');
  await local.write('common.txt', 'dirty tracked edit');
  const { actions } = local;
  const before = await local.git('status', '--porcelain=v2');
  const divergent = await actions.pull(await actions.preparePull());
  assert.equal(divergent.warning, true);
  assert.match(divergent.message, /cannot fast-forward/);
  assert.equal(await local.head(), localTip);
  assert.equal(await local.reads.resolveCommit(remoteRef('origin/main')), next);
  assert.equal(await local.git('status', '--porcelain=v2'), before);
  assert.equal(await local.git('stash', 'list'), '');
  await noReceipts(local);
  await assert.rejects(actions.preparePull(localRef('other')), /only update the current branch/);
  const stale = await actions.preparePull();
  let confirms = 0;
  const stopped = await actions.pull(stale, () => {
    if (++confirms === 2) throw new Error('Editor state changed during fetch');
  });
  assert.match(stopped.message, /Fetched the upstream.*fast-forward was not confirmed/);
  assert.match(stopped.message, /Editor state changed during fetch/);
  assert.equal(await local.git('status', '--porcelain=v2'), before);
  await noReceipts(local);
});

test('update fast-forwards around non-overlapping unstaged, untracked and ignored files without stashing', async t => {
  const f = await fixture(t);
  const { local, seed } = await f.remotePair();
  const next = await seed.commit('remote advance', { 'remote.txt': 'remote' });
  await seed.git('push', 'origin', 'main');
  await local.write('common.txt', 'unstaged');
  await local.write('untracked.txt', 'untracked');
  await local.write('ignored.txt', 'ignored');
  const before = await local.git('status', '--porcelain=v2');
  assert.equal((await local.actions.pull(await local.actions.preparePull())).warning, undefined);
  assert.equal(await local.head(), next);
  assert.equal(await local.git('status', '--porcelain=v2'), before);
  assert.equal(await local.git('stash', 'list'), '');
  assert.equal(await local.read('common.txt'), 'unstaged');
  assert.equal(await local.read('untracked.txt'), 'untracked');
  assert.equal(await local.read('ignored.txt'), 'ignored');
  assert.match((await local.actions.pull(await local.actions.preparePull())).message, /already up to date/);
  assert.equal(await local.git('stash', 'list'), '');
  await noReceipts(local);
});

test('update restores both staged and unstaged bytes by stash OID, not by shared stash position', async t => {
  const f = await fixture(t);
  const { local, seed } = await f.remotePair();
  await local.write('common.txt', 'old saved edit\n');
  await local.git('stash', 'push', '-m', 'already there');
  const existing = await local.reads.resolveCommit('refs/stash');
  const next = await seed.commit('remote advance', { 'remote.txt': 'remote' });
  await seed.git('push', 'origin', 'main');
  await local.write('common.txt', 'staged edit\n');
  await local.git('add', 'common.txt');
  await local.write('common.txt', 'then edited again\n');
  await local.write('copy.txt', 'untracked text');
  await local.write('ignored.txt', 'ignored text');
  const plan = await local.actions.preparePull();
  assert.equal(plan.work.staged, true);
  assert.deepEqual(plan.work.trackedPaths, ['common.txt']);
  const query = local.client.query.bind(local.client);
  local.client.query = async (args, opts) => {
    const result = await query(args, opts);
    if (args.includes('stash') && args.includes('push') && result.code === 0) {
      await local.git('stash', 'store', '-m', 'other worktree stash', existing);
    }
    return result;
  };
  const result = await local.actions.pull(plan, undefined, allowStash);
  assert.equal(result.warning, undefined, result.message);
  assert.match(result.message, /Restored local edits and their staged state/);
  assert.match(result.message, /Recovery copy kept/);
  assert.equal(await local.head(), next);
  assert.equal(await local.git('show', ':common.txt'), 'staged edit\n');
  assert.equal(await local.read('common.txt'), 'then edited again\n');
  assert.equal(await local.read('copy.txt'), 'untracked text');
  assert.equal(await local.read('ignored.txt'), 'ignored text');
  assert.equal(await local.reads.resolveCommit('refs/stash'), existing);
  const entries = await local.git('stash', 'list', '--format=%gs');
  assert.match(entries, /other worktree stash\n.*Git Branch Update.*\n.*already there/);
  await noReceipts(local);
});

test('update reports a successful fast-forward separately from a restore conflict and retains the backup', async t => {
  const f = await fixture(t);
  const { local, seed, initial } = await f.remotePair();
  const next = await seed.commit('overlapping remote edit', { 'common.txt': 'remote changed this line\n' });
  await seed.git('push', 'origin', 'main');
  await local.write('common.txt', 'local changed the same line\n');
  const result = await local.actions.pull(await local.actions.preparePull(), undefined, allowStash);
  assert.equal(result.warning, true);
  assert.match(result.message, /fast-forwarded to/);
  assert.match(result.message, /Could not fully restore local changes/);
  assert.match(result.message, /Recovery copy kept/);
  assert.equal(await local.head(), next);
  assert.equal((await local.reads.workingState(local.dirs.gitDir)).conflicted, true);
  const stash = await local.reads.resolveCommit('refs/stash');
  assert.equal(await local.reads.resolveCommit(`${stash}^1`), initial);
  assert.equal(await local.git('show', `${stash}:common.txt`), 'local changed the same line\n');
  await noReceipts(local);
});

test('when an untracked file blocks the fast-forward, update preserves it and reapplies saved staged work', async t => {
  const f = await fixture(t);
  const { local, seed, initial } = await f.remotePair();
  const next = await seed.commit('add path', { 'overlap.txt': 'remote added this\n' });
  await seed.git('push', 'origin', 'main');
  await local.write('overlap.txt', 'untracked local file\n');
  await local.write('common.txt', 'staged local edit\n');
  await local.git('add', 'common.txt');
  const result = await local.actions.pull(await local.actions.preparePull(), undefined, allowStash);
  assert.equal(result.warning, true);
  assert.match(result.message, /untracked working tree files would be overwritten/);
  assert.match(result.message, /Restored local edits and their staged state/);
  assert.equal(await local.head(), initial);
  assert.equal(await local.reads.resolveCommit(remoteRef('origin/main')), next);
  assert.equal(await local.read('overlap.txt'), 'untracked local file\n');
  assert.equal(await local.git('show', ':common.txt'), 'staged local edit\n');
  await noReceipts(local);
});

test('update does not stash an untracked or ignored replacement at the path of a staged deletion', async t => {
  const f = await fixture(t);
  const { local, seed, initial } = await f.remotePair();
  const next = await seed.commit('safe upstream path', { 'remote.txt': 'remote' });
  await seed.git('push', 'origin', 'main');
  await local.git('rm', '--cached', '--', 'common.txt');
  await local.write('common.txt', 'local replacement');
  for (const ignored of [false, true]) {
    if (ignored) await local.write('.git/info/exclude', 'common.txt\n');
    const before = await local.git('status', '--porcelain=v2', '--ignored');
    const result = await local.actions.pull(await local.actions.preparePull());
    assert.equal(result.warning, true);
    assert.match(result.message, /An untracked or ignored file occupies a path needed to save local changes/);
    assert.equal(await local.head(), initial);
    assert.equal(await local.reads.resolveCommit(remoteRef('origin/main')), next);
    assert.equal(await local.read('common.txt'), 'local replacement');
    assert.equal(await local.git('status', '--porcelain=v2', '--ignored'), before);
    assert.equal(await local.git('stash', 'list'), '');
    await noReceipts(local);
  }
});

test('pull uses fetched receipt rather than tracking ref moved by another process', async t => {
  const f = await fixture(t);
  const { local, seed, initial } = await f.remotePair();
  const next = await seed.commit('advance');
  await seed.git('push', 'origin', 'main');
  const plan = await local.actions.preparePull();
  const run = local.client.query.bind(local.client);
  local.client.query = async (args, opts) => {
    const result = await run(args, opts);
    if (args.includes('fetch') && result.code === 0) {
      await local.git('update-ref', remoteRef('origin/main'), initial);
    }
    return result;
  };
  await local.actions.pull(plan);
  assert.equal(await local.head(), next);
  assert.equal(await local.reads.resolveCommit(remoteRef('origin/main')), initial);
  await noReceipts(local);
});

test('pull leaves ignored files intact when a new commit would overwrite them', async t => {
  const f = await fixture(t);
  const { local, seed, initial } = await f.remotePair();
  await seed.write('ignored.txt', 'remote');
  await seed.git('add', '-f', 'ignored.txt');
  await seed.git('commit', '-m', 'track formerly ignored file');
  await seed.git('push', 'origin', 'main');
  await local.write('ignored.txt', 'not tracked locally');
  const result = await local.actions.pull(await local.actions.preparePull());
  assert.equal(result.warning, true);
  assert.match(result.message, /Fetched the upstream.*fast-forward was not confirmed/);
  assert.equal(await local.head(), initial);
  assert.equal(await local.read('ignored.txt'), 'not tracked locally');
  await noReceipts(local);
});

test('push targets one branch, optionally sets tracking, does not push tags or edit the worktree', async t => {
  const f = await fixture(t);
  const { remote, local, initial } = await f.remotePair();
  await local.git('switch', '-c', 'outgoing');
  const oid = await local.commit('local only', { 'other.txt': 'committed' });
  await local.git('tag', '-a', 'local-tag', '-m', 'do not send');
  await local.git('switch', 'main');
  await local.write('common.txt', 'not in commit');
  await local.git('config', 'push.followTags', 'true');
  await local.git('config', 'push.default', 'matching');
  const { actions } = local;
  const tip = await actions.pushSource(localRef('outgoing'));
  const plan = await actions.preparePush(tip, 'origin', 'review/outgoing', true);
  const result = await actions.push(plan);
  assert.match(result.message, /Set the upstream/);
  assert.equal(await branchTip(remote, 'review/outgoing'), oid);
  assert.equal(await branchTip(remote), initial);
  assert.equal(await remote.reads.resolveCommit('refs/tags/local-tag'), undefined);
  assert.equal(await local.head(), initial);
  assert.equal(await local.read('common.txt'), 'not in commit');
  assert.deepEqual(await upstream(local, 'outgoing'), { remote: 'origin', source: localRef('review/outgoing'), tracking: remoteRef('origin/review/outgoing') });
});

test('push refuses stale sources, mirror/multi-target remotes and non-fast-forward updates', async t => {
  const f = await fixture(t);
  const { remote, seed, local, initial } = await f.remotePair();
  const next = await seed.commit('advance');
  await seed.git('push', 'origin', 'main');
  const { actions } = local;
  const tip = await actions.pushSource(localRef('main'));
  const plan = await actions.preparePush(tip, 'origin', 'main', false);
  await assert.rejects(actions.push(plan), /remote rejected the push/);
  assert.equal(await branchTip(remote), next);
  await local.git('config', 'remote.origin.mirror', 'true');
  await assert.rejects(actions.preparePush(tip, 'origin', 'main', false), /mirror remote/);
  await local.git('config', 'remote.origin.mirror', 'false');
  await local.git('config', '--add', 'remote.origin.pushurl', remote.url);
  await local.git('config', '--add', 'remote.origin.pushurl', remote.dir);
  await assert.rejects(actions.preparePush(tip, 'origin', 'main', false), /multiple push URLs/);
  await local.git('config', '--unset-all', 'remote.origin.pushurl');
  await local.commit('change after confirmation');
  await assert.rejects(actions.push(plan), /branch tip changed/);
  assert.equal(await branchTip(remote), next);
  assert.equal(tip.oid, initial);
});

test('delete actually removes the server ref via its configured mapping and preserves the same-named local branch', async t => {
  const f = await fixture(t);
  const { local, remote, seed, initial } = await f.remotePair();
  const source = localRef('topic/review');
  const tracking = remoteRef('origin/cached/review');
  await seed.git('push', 'origin', `HEAD:${source}`, `HEAD:${localRef('cached/review')}`);
  await local.git('config', '--replace-all', 'remote.origin.fetch', `+${source}:${tracking}`);
  await local.git('fetch', 'origin');
  await local.git('branch', 'topic/review');
  const { actions } = local;
  const plan = await actions.prepareRemoteDelete(tracking);
  assert.deepEqual(plan.upstream, { remote: 'origin', source, tracking });
  assert.match((await actions.deleteRemote(plan)).message, /Deleted server branch origin\/topic\/review/);
  assert.equal(await remote.reads.resolveCommit(source), undefined);
  assert.equal(await branchTip(remote, 'cached/review'), initial, 'not the shortened tracking name');
  assert.equal(await branchTip(remote), initial, 'no other server ref is touched');
  assert.equal(await local.reads.resolveCommit(tracking), undefined);
  assert.equal(await local.reads.resolveCommit(source), initial, 'same-named local branch survives');
  assert.deepEqual(await local.reads.head(), { ref: localRef('main'), oid: initial });
});

test('server deletion refuses a stale server tip and honors the server deletion policy', async t => {
  const f = await fixture(t);
  const { local, remote, seed, initial } = await f.remotePair();
  const source = localRef('topic');
  const tracking = remoteRef('origin/topic');
  await seed.git('switch', '-c', 'topic');
  await seed.git('push', 'origin', 'topic');
  await local.git('fetch', 'origin');
  const plan = await local.actions.prepareRemoteDelete(tracking);
  const next = await seed.commit('changed on the server after confirmation');
  await seed.git('push', 'origin', 'topic');
  await assert.rejects(local.actions.deleteRemote(plan), /server branch was not deleted.*stale info/s);
  assert.equal(await local.reads.resolveCommit(tracking), initial);
  assert.equal(await remote.reads.resolveCommit(source), next);
  await local.git('fetch', 'origin');
  const protectedPlan = await local.actions.prepareRemoteDelete(tracking);
  await remote.git('config', 'receive.denyDeletes', 'true');
  await assert.rejects(local.actions.deleteRemote(protectedPlan), /server branch was not deleted.*deletion prohibited/s);
  assert.equal(await remote.reads.resolveCommit(source), next);
  assert.equal(await local.reads.resolveCommit(tracking), next);
});

test('server deletion refuses changed or ambiguous mappings, mirror pushes and different or multiple endpoints', async t => {
  const f = await fixture(t);
  const { local, remote, seed, initial } = await f.remotePair();
  const other = await f.repo('another-remote', { bare: true });
  const source = localRef('topic');
  const tracking = remoteRef('origin/topic');
  await seed.git('push', 'origin', `HEAD:${source}`, 'HEAD:refs/tags/topic');
  await seed.git('push', other.url, `HEAD:${source}`);
  await local.git('fetch', 'origin');
  const { actions } = local;
  const plan = await actions.prepareRemoteDelete(tracking);
  await local.git('config', '--add', 'remote.origin.fetch', `+refs/tags/topic:${tracking}`);
  await assert.rejects(actions.deleteRemote(plan), /unique remote branch/);
  await local.git('config', '--fixed-value', '--unset-all', 'remote.origin.fetch', `+refs/tags/topic:${tracking}`);
  await local.git('config', '--replace-all', 'remote.origin.fetch', `+${localRef('main')}:${tracking}`);
  await assert.rejects(actions.deleteRemote(plan), /mapping.*changed/i);
  await local.git('config', '--replace-all', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*');
  await local.git('config', 'remote.origin.mirror', 'true');
  await assert.rejects(actions.prepareRemoteDelete(tracking), /mirror remote/);
  await local.git('config', 'remote.origin.mirror', 'false');
  await local.git('config', '--add', 'remote.origin.pushurl', other.url);
  await assert.rejects(actions.deleteRemote(plan), /fetch and push URLs differ/);
  await local.git('config', '--add', 'remote.origin.pushurl', remote.url);
  await assert.rejects(actions.prepareRemoteDelete(tracking), /multiple push URLs/);
  assert.equal(await remote.reads.resolveCommit(source), initial);
  assert.equal(await other.reads.resolveCommit(source), initial);
});

test('server deletion refuses local-path remotes that share the current Git repository', async t => {
  const f = await fixture(t);
  const local = await f.repo('local');
  const oid = await local.commit('initial');
  await local.git('branch', 'topic');
  await local.git('remote', 'add', 'loop', local.url);
  await local.git('fetch', 'loop');
  const ref = remoteRef('loop/topic');
  await assert.rejects(local.actions.prepareRemoteDelete(ref), /points to the current repository or a linked worktree/);
  const linked = path.join(f.root, 'linked worktree');
  await local.git('worktree', 'add', linked, 'topic');
  await local.git('config', 'remote.loop.url', linked);
  await assert.rejects(local.actions.prepareRemoteDelete(ref), /points to the current repository or a linked worktree/);
  assert.equal(await branchTip(local, 'topic'), oid);
});

test('writes to the same common Git dir run in order even after failure', async () => {
  const queue = new WriteQueue();
  const calls = [];
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  const failed = queue.run('shared', async () => { calls.push('first'); await wait; throw new Error('failed'); });
  const later = queue.run('shared', () => calls.push('second'));
  await queue.run('other', () => calls.push('other'));
  assert.deepEqual(calls, ['first', 'other']);
  release();
  await assert.rejects(failed, /failed/);
  await later;
  assert.deepEqual(calls, ['first', 'other', 'second']);
});
