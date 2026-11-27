'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture } = require('../test-support/gitFixture');
const { GitClient } = require('../src/git/gitClient');
const { GitReads } = require('../src/git/reads');

const branch = name => `refs/heads/${name}`;
const tracking = name => `refs/remotes/origin/${name}`;
const tip = (repo, name) => repo.reads.resolveCommit(branch(name));
const upstream = (repo, name) => repo.reads.refs({ ref: branch(name) }).then(([item]) => item.upstream);

async function topicPair(t) {
  const f = await fixture(t);
  const pair = await f.remotePair();
  await pair.seed.git('switch', '-c', 'topic');
  await pair.seed.git('push', 'origin', 'topic');
  await pair.local.git('fetch', 'origin');
  await pair.local.git('branch', '--track', 'topic', 'origin/topic');
  return { ...f, ...pair };
}

test('background Update fast-forwards the selected upstream and leaves HEAD, index and disk alone', async t => {
  const { local, seed, initial, root } = await topicPair(t);
  const { actions } = local;
  const next = await seed.commit('remote topic advance', { 'topic.txt': 'from topic' });
  await seed.git('push', 'origin', 'topic');
  await local.write('common.txt', 'our staged change\n');
  await local.git('add', 'common.txt');
  await local.write('common.txt', 'our unstaged change\n');
  const before = await local.git('status', '--porcelain=v2');
  const originalUpstream = await upstream(local, 'topic');
  const result = await actions.update(await actions.prepareUpdate(branch('topic')),
    () => assert.fail('background update must not check editors'), () => assert.fail('background update must not stash'));
  assert.equal(result.warning, undefined, result.message);
  assert.match(result.message, /fast-forwarded/);
  assert.equal(await tip(local, 'topic'), next);
  assert.equal(await local.reads.resolveCommit(tracking('topic')), next);
  assert.deepEqual(await local.reads.head(), { ref: branch('main'), oid: initial });
  assert.deepEqual(await upstream(local, 'topic'), originalUpstream);
  assert.equal(await local.git('status', '--porcelain=v2'), before);
  assert.equal(await local.git('show', ':common.txt'), 'our staged change\n');
  assert.equal(await local.read('common.txt'), 'our unstaged change\n');
  assert.equal(await local.git('stash', 'list'), '');

  const inProgress = await actions.prepareUpdate(branch('topic'));
  const linked = path.join(root, 'linked worktree');
  await local.git('worktree', 'add', linked, 'topic');
  await assert.rejects(actions.update(inProgress), /topic is checked out at/);
  await assert.rejects(actions.prepareUpdate(branch('topic')), /topic is checked out at/);
  await local.git('worktree', 'remove', linked);

  const other = (await local.git('commit-tree', `${next}^{tree}`, '-p', next, '-m', 'local topic advance')).trim();
  await local.git('update-ref', branch('topic'), other, next);
  await seed.commit('another remote topic advance');
  await seed.git('push', 'origin', 'topic');
  const diverged = await actions.update(await actions.prepareUpdate(branch('topic')));
  assert.equal(diverged.warning, true);
  assert.match(diverged.message, /cannot fast-forward/);
  assert.equal(await tip(local, 'topic'), other);
  assert.equal(await local.git('status', '--porcelain=v2'), before);
  assert.equal(await local.git('for-each-ref', 'refs/git-branch/'), '');
});

test('Checkout and Update switches first; a later fetch failure leaves the target checked out', async t => {
  const { local, seed, remote } = await topicPair(t);
  const next = await seed.commit('remote topic advance', { 'topic.txt': 'remote edit' });
  await seed.git('push', 'origin', 'topic');
  const { actions } = local;
  const result = await actions.checkoutAndUpdate(await actions.prepareCheckoutUpdate(branch('topic')));
  assert.equal(result.warning, undefined, result.message);
  assert.match(result.message, /Checked out topic\./);
  assert.deepEqual(await local.reads.head(), { ref: branch('topic'), oid: next });
  assert.equal(await local.read('topic.txt'), 'remote edit');
  await assert.rejects(actions.prepareCheckoutUpdate(branch('topic')), /another local branch/);
  await local.git('switch', 'main');
  const plan = await actions.prepareCheckoutUpdate(branch('topic'));
  await remote.git('update-ref', '-d', branch('topic'));
  await assert.rejects(actions.checkoutAndUpdate(plan), /Checked out topic, but could not finish updating/);
  assert.deepEqual(await local.reads.head(), { ref: branch('topic'), oid: next });
  assert.equal(await local.git('for-each-ref', 'refs/git-branch/'), '');
});

test('declining a required Stash leaves tracked disk and index content untouched', async t => {
  const f = await fixture(t);
  const { local, seed, initial } = await f.remotePair();
  const next = await seed.commit('remote advance', { 'server.txt': 'new file' });
  await seed.git('push', 'origin', 'main');
  await local.write('common.txt', 'staged bytes\n');
  await local.git('add', 'common.txt');
  await local.write('common.txt', 'unstaged bytes\n');
  const { actions } = local;
  let confirmations = 0;
  const result = await actions.update(await actions.prepareUpdate(branch('main')), undefined, () => { confirmations++; return false; });
  assert.equal(confirmations, 1);
  assert.equal(result.warning, true);
  assert.match(result.message, /saving local changes was not approved/);
  assert.deepEqual(await local.reads.head(), { ref: branch('main'), oid: initial });
  assert.equal(await local.reads.resolveCommit(tracking('main')), next, 'fetch may still update tracking');
  assert.equal(await local.git('show', ':common.txt'), 'staged bytes\n');
  assert.equal(await local.read('common.txt'), 'unstaged bytes\n');
  assert.equal(await local.git('stash', 'list'), '');
});

test('Merge into Current uses the cached ref; Pull Using Merge fetches and merges the current server tip', async t => {
  const { local, seed } = await topicPair(t);
  const cached = await seed.commit('cached topic', { 'cached.txt': 'cached' });
  await seed.git('push', 'origin', 'topic');
  await local.git('fetch', 'origin');
  const fresh = await seed.commit('newer server topic', { 'fresh.txt': 'fresh' });
  await seed.git('push', 'origin', 'topic');
  const ours = await local.commit('local advance', { 'ours.txt': 'ours' });
  const originalUpstream = await upstream(local, 'main');
  const { actions } = local;
  const merge = await actions.integrate(await actions.prepareIntegration(tracking('topic'), 'merge', false));
  assert.equal(merge.warning, undefined, merge.message);
  assert.equal((await local.reads.head()).ref, branch('main'));
  assert.equal(await local.reads.resolveCommit('HEAD^1'), ours);
  assert.equal(await local.reads.resolveCommit('HEAD^2'), cached);
  assert.equal(await local.reads.resolveCommit(tracking('topic')), cached);
  const pull = await actions.integrate(await actions.prepareIntegration(tracking('topic'), 'merge', true));
  assert.equal(pull.warning, undefined, pull.message);
  assert.equal((await local.reads.head()).ref, branch('main'));
  assert.equal(await local.reads.resolveCommit('HEAD^2'), fresh);
  assert.equal(await local.reads.resolveCommit(tracking('topic')), fresh);
  assert.equal(await local.read('fresh.txt'), 'fresh');
  assert.deepEqual(await upstream(local, 'main'), originalUpstream);
  assert.equal(await local.git('for-each-ref', 'refs/git-branch/'), '');
});

test('cached integration does not lazy-fetch absent blobs from a partial clone', async t => {
  const f = await fixture(t);
  const { remote, seed, initial } = await f.remotePair();
  await remote.git('config', 'uploadpack.allowFilter', 'true');
  const source = await seed.commit('contains an absent blob', { 'missing.txt': 'not in this checkout' });
  await seed.git('push', 'origin', `HEAD:${branch('topic')}`);
  const partial = await f.repo('partial', { url: remote.url, filter: 'blob:none' });
  const blob = { mode: '100644', oid: (await seed.git('rev-parse', `${source}:missing.txt`)).trim() };
  await assert.rejects(partial.reads.blob(blob));
  const plan = await partial.actions.prepareIntegration(tracking('topic'), 'merge', false);
  await assert.rejects(partial.actions.integrate(plan), /transport 'file' not allowed|could not fetch/i);
  await assert.rejects(partial.reads.blob(blob));
  assert.deepEqual(await partial.reads.head(), { ref: branch('main'), oid: initial });
});

test('Rebase and Pull Using Rebase move only the current branch, even with updateRefs configured', async t => {
  const { local, seed, initial } = await topicPair(t);
  const cached = await seed.commit('cached topic', { 'cached.txt': 'cached' });
  await seed.git('push', 'origin', 'topic');
  await local.git('fetch', 'origin');
  const fresh = await seed.commit('newer server topic', { 'fresh.txt': 'fresh' });
  await seed.git('push', 'origin', 'topic');
  const ours = await local.commit('local advance', { 'ours.txt': 'ours' });
  await local.git('branch', 'keep');
  await local.git('config', 'rebase.updateRefs', 'true');
  const before = await upstream(local, 'main');
  const { actions } = local;
  const approvals = [];
  const approve = oid => { approvals.push(oid); return true; };
  const rebase = await actions.integrate(await actions.prepareIntegration(tracking('topic'), 'rebase', false), undefined, approve);
  assert.equal(rebase.warning, undefined, rebase.message);
  assert.equal((await local.reads.head()).ref, branch('main'));
  assert.equal(await local.reads.resolveCommit('HEAD^'), cached);
  assert.equal(await local.reads.resolveCommit(tracking('topic')), cached);
  assert.equal(await tip(local, 'keep'), ours);
  await local.git('branch', 'also-keep');
  const previous = await tip(local, 'also-keep');
  const pull = await actions.integrate(await actions.prepareIntegration(tracking('topic'), 'rebase', true), undefined, async oid => {
    // Another fetch moving the cached tracking ref must not change what this prompt approved.
    await local.git('update-ref', tracking('topic'), cached);
    return approve(oid);
  });
  assert.equal(pull.warning, undefined, pull.message);
  assert.equal((await local.reads.head()).ref, branch('main'));
  assert.equal(await local.reads.resolveCommit('HEAD^'), fresh);
  assert.equal(await local.reads.resolveCommit(tracking('topic')), cached);
  assert.deepEqual(approvals, [cached, fresh]);
  assert.equal(await tip(local, 'topic'), initial);
  assert.equal(await tip(local, 'keep'), ours);
  assert.equal(await tip(local, 'also-keep'), previous);
  assert.equal(await local.read('ours.txt'), 'ours');
  assert.deepEqual(await upstream(local, 'main'), before);
  assert.equal(await local.git('for-each-ref', 'refs/git-branch/'), '');
});

test('Rebase prompts only for a rewrite; cancelled remote rebase keeps the fetch but not a branch change', async t => {
  const { local, seed } = await topicPair(t);
  const { actions } = local;
  const fast = await seed.commit('fast forward to remote topic', { 'new.txt': 'remote\n' });
  await seed.git('push', 'origin', 'topic');
  const prompt = () => assert.fail('fast-forward and already-contained targets must not ask to rewrite history');
  const forward = await actions.integrate(await actions.prepareIntegration(tracking('topic'), 'rebase', true), undefined, prompt);
  assert.equal(forward.warning, undefined, forward.message);
  assert.equal(await local.head(), fast);
  const unchanged = await actions.integrate(await actions.prepareIntegration(tracking('topic'), 'rebase', false), undefined, prompt);
  assert.match(unchanged.message, /already/);
  const ours = await local.commit('local work after fast forward', { 'mine.txt': 'mine' });
  const theirs = await seed.commit('new remote work', { 'theirs.txt': 'theirs' });
  await seed.git('push', 'origin', 'topic');
  let prompts = 0;
  const cancelled = await actions.integrate(await actions.prepareIntegration(tracking('topic'), 'rebase', true), undefined, oid => {
    assert.equal(oid, theirs);
    prompts++;
    return false;
  });
  assert.equal(prompts, 1);
  assert.match(cancelled.message, /Fetch completed. Rebase cancelled/);
  assert.equal(await local.head(), ours);
  assert.equal(await local.reads.resolveCommit(tracking('topic')), theirs);
  assert.equal(await local.git('for-each-ref', 'refs/git-branch/'), '');
});

test('merge and rebase preserve Git conflict states and support native abort without moving the source', async t => {
  const { local } = await topicPair(t);
  await local.git('switch', 'topic');
  const theirs = await local.commit('them', { 'common.txt': 'them\n' });
  await local.git('switch', 'main');
  const ours = await local.commit('us', { 'common.txt': 'us\n' });
  const { actions } = local;
  for (const [operation, marker] of [['merge', 'MERGE_HEAD'], ['rebase', 'rebase-merge']]) {
    const result = await actions.integrate(await actions.prepareIntegration(branch('topic'), operation, false), undefined, () => {
      assert.equal(operation, 'rebase');
      return true;
    });
    assert.equal(result.warning, true);
    assert.match(result.message, new RegExp(`git ${operation} --continue`));
    const work = await local.reads.workingState(local.dirs.gitDir);
    assert.equal(work.conflicted, true);
    assert.equal(work.operation, marker);
    await local.git(operation, '--abort');
    assert.deepEqual(await local.reads.head(), { ref: branch('main'), oid: ours });
    assert.equal(await tip(local, 'topic'), theirs);
    assert.equal(await local.read('common.txt'), 'us\n');
  }
});

test('integration rejects dirty tracked work, and rebase refuses to replace an ignored file', async t => {
  const { local, initial } = await topicPair(t);
  await local.git('switch', 'topic');
  await local.write('ignored.txt', 'tracked on topic');
  await local.git('add', '-f', 'ignored.txt');
  await local.git('commit', '-m', 'track ignored path on topic');
  await local.git('switch', 'main');
  await local.write('common.txt', 'unsaved changes on disk');
  const { actions } = local;
  await assert.rejects(actions.prepareIntegration(branch('topic'), 'merge', false), /Commit or stash/);
  await local.git('restore', 'common.txt');
  await local.write('ignored.txt', 'preserve this file');
  await assert.rejects(actions.integrate(await actions.prepareIntegration(branch('topic'), 'rebase', false)), /may overwrite/);
  assert.deepEqual(await local.reads.head(), { ref: branch('main'), oid: initial });
  assert.equal(await local.read('ignored.txt'), 'preserve this file');
});

test('worktrees from current, inactive and remote branches share objects without changing the original checkout', async t => {
  const { local, seed, root, initial } = await topicPair(t);
  const remoteTip = await seed.commit('another remote branch', { 'review.txt': 'review' });
  await seed.git('push', 'origin', `HEAD:${branch('review')}`);
  await local.git('fetch', 'origin');
  await local.write('common.txt', 'modified in original checkout');
  const { actions } = local;
  const current = await actions.prepareWorktree(branch('main'));
  assert.equal(current.newBranch, true);
  assert.equal(current.suggestedName, 'main');
  const mainFolder = await actions.worktreePath(path.join(root, 'worktree from current'));
  await assert.rejects(actions.createWorktree(current, mainFolder, 'main'), /already exists/);
  const created = await actions.createWorktree(current, mainFolder, 'main-next');
  assert.equal(created.warning, undefined, created.message);
  assert.deepEqual(await new GitReads(new GitClient(mainFolder)).head(), { ref: branch('main-next'), oid: initial });
  assert.equal(await upstream(local, 'main-next'), undefined);

  const topicFolder = path.join(root, 'existing empty dir');
  await fs.mkdir(topicFolder);
  const topic = await actions.prepareWorktree(branch('topic'));
  assert.equal(topic.newBranch, false);
  const existing = await actions.createWorktree(topic, await actions.worktreePath(topicFolder), 'topic');
  assert.equal(existing.warning, undefined, existing.message);
  assert.deepEqual(await new GitReads(new GitClient(topicFolder)).head(), { ref: branch('topic'), oid: initial });
  await assert.rejects(actions.createWorktree(topic, mainFolder + '-second', 'topic'), /topic is checked out at/);
  assert.equal((await actions.prepareWorktree(branch('topic'))).newBranch, true);

  const remote = await actions.prepareWorktree(tracking('review'));
  assert.equal(remote.newBranch, true);
  assert.equal(remote.suggestedName, 'review');
  const reviewFolder = await actions.worktreePath(path.join(root, 'review directory'));
  const review = await actions.createWorktree(remote, reviewFolder, remote.suggestedName);
  assert.equal(review.warning, undefined, review.message);
  assert.deepEqual(await new GitReads(new GitClient(reviewFolder)).head(), { ref: branch('review'), oid: remoteTip });
  assert.deepEqual(await upstream(local, 'review'), { remote: 'origin', source: branch('review'), tracking: tracking('review') });
  assert.deepEqual(await local.reads.head(), { ref: branch('main'), oid: initial });
  assert.equal(await local.read('common.txt'), 'modified in original checkout');
  await assert.rejects(actions.worktreePath(local.dir), /new or empty folder/);
  await assert.rejects(actions.worktreePath(path.join(local.dirs.commonDir, 'nested')), /metadata directories/);
  await assert.rejects(actions.worktreePath(path.join(root, 'uncreated-parent', 'child')), /parent folder must exist/);
});
