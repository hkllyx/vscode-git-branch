'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('../test-support/gitFixture');

const run = async (repo, kind, oids, options) => repo.actions.history.execute(await repo.actions.history.prepare(kind, oids), options);

async function mixedHistory(t) {
  const f = await fixture(t);
  const repo = await f.repo('history');
  const root = await repo.commit('root', { 'shared.txt': 'root\n', '.gitignore': 'ignored.txt\n' });
  const earlier = await repo.commit('earlier', { 'first.txt': 'first\n' });
  const head = await repo.commit('later', { 'later.txt': 'later\n' });
  return { repo, root, earlier, head };
}

test('history checkout detaches HEAD, and branch and lightweight tag creation use the exact selected revision', async t => {
  const { repo, root, earlier, head } = await mixedHistory(t);
  const history = repo.actions.history;
  await run(repo, 'checkoutRevision', [root]);
  assert.deepEqual(await repo.reads.head(), { ref: undefined, oid: root });
  assert.equal(await repo.reads.resolveCommit('refs/heads/main'), head);
  await history.newRef('branch', earlier, 'feature/review');
  await history.newRef('tag', root, 'review/initial');
  assert.equal(await repo.reads.resolveCommit('refs/heads/feature/review'), earlier);
  assert.equal(await repo.reads.resolveCommit('refs/tags/review/initial'), root);
  assert.equal((await repo.git('cat-file', '-t', 'refs/tags/review/initial')).trim(), 'commit');
  await assert.rejects(history.newRef('tag', head, 'review/initial'), /already exists/);
  await assert.rejects(history.newRef('tag', head, 'review'), /conflicts with the ref path/);
  await assert.rejects(history.newRef('tag', head, '-f'), /valid tag name/);
  assert.equal(await repo.head(), root);
});

test('sequencer picks commits in supplied oldest-first order and reverts newest first on the current branch', async t => {
  const { repo, head } = await mixedHistory(t);
  await repo.git('switch', '-c', 'topic');
  const one = await repo.commit('one', { 'picked.txt': 'one\n' });
  const two = await repo.commit('two', { 'picked.txt': 'one\ntwo\n' });
  await repo.git('switch', 'main');
  const history = repo.actions.history;
  const rows = await Promise.all([one, two].map(async oid => ({ oid, ...(await repo.reads.commit(oid)) })));
  await repo.commit('main-only', { 'main.txt': 'preserve\n' });
  assert.deepEqual(await history.eligibility(rows, await repo.reads.head()), { cherryPick: true, revert: false });
  await assert.rejects(history.prepare('revert', [one]), /must already belong/);
  const result = await run(repo, 'cherryPick', [one, two]);
  assert.equal(result.warning, undefined, result.message);
  const picked = await repo.head(), older = await repo.reads.resolveCommit('HEAD^');
  assert.equal(await repo.read('picked.txt'), 'one\ntwo\n');
  assert.match(await repo.git('log', '-2', '--format=%s'), /^two\r?\none/);
  await assert.rejects(history.prepare('cherryPick', [picked]), /already belong/);
  const reverted = await run(repo, 'revert', [picked, older]);
  assert.equal(reverted.warning, undefined, reverted.message);
  await assert.rejects(repo.read('picked.txt'), { code: 'ENOENT' });
  assert.equal(await repo.read('main.txt'), 'preserve\n');
  assert.notEqual(await repo.head(), head);
});

test('cherry-pick preserves native conflict state and never guesses a merge parent', async t => {
  const { repo, head } = await mixedHistory(t);
  await repo.git('switch', '-c', 'topic');
  const theirs = await repo.commit('their edit', { 'shared.txt': 'theirs\n' });
  await repo.git('switch', 'main');
  const ours = await repo.commit('our edit', { 'shared.txt': 'ours\n' });
  const result = await run(repo, 'cherryPick', [theirs]);
  assert.equal(result.warning, true);
  assert.match(result.message, /git cherry-pick --continue/);
  assert.equal((await repo.reads.workingState(repo.dirs.gitDir)).operation, 'CHERRY_PICK_HEAD');
  await repo.git('cherry-pick', '--abort');
  assert.equal(await repo.head(), ours);
  await repo.git('switch', '-c', 'merger', head);
  await repo.git('merge', '--no-ff', '-m', 'merge', 'topic');
  const merge = await repo.head();
  await assert.rejects(repo.actions.history.prepare('revert', [merge]), /does not guess/);
  await assert.rejects(repo.actions.history.prepare('undo', [merge]), /linear range/);
  await assert.rejects(repo.actions.history.prepare('drop', [head]), /linear range/);
});

test('Undo moves only HEAD, returns the draft, and preserves staged and unstaged changes', async t => {
  const { repo, earlier, head } = await mixedHistory(t);
  await repo.write('extra.txt', 'staged\n');
  await repo.git('add', 'extra.txt');
  await repo.write('shared.txt', 'unstaged\n');
  await assert.rejects(repo.actions.history.prepare('undo', [earlier]), /HEAD commit/);
  const result = await run(repo, 'undo', [head]);
  assert.equal(result.draft, 'later');
  assert.equal(await repo.head(), earlier);
  assert.deepEqual((await repo.git('diff', '--cached', '--name-only')).trim().split(/\r?\n/), ['extra.txt', 'later.txt']);
  assert.equal(await repo.read('shared.txt'), 'unstaged\n');
});

test('history rewrites reject commits in remote-tracking history, including a ref arriving after preparation', async t => {
  const { repo, earlier, head } = await mixedHistory(t);
  const history = repo.actions.history;
  const pending = await history.prepare('undo', [head]);
  await repo.git('update-ref', 'refs/remotes/origin/known', head);
  await assert.rejects(history.execute(pending), /remote-tracking ref contains/);
  for (const [kind, oid] of [['undo', head], ['editMessage', earlier], ['drop', earlier], ['squash', head]]) {
    await assert.rejects(history.prepare(kind, [oid]), /remote-tracking ref contains/);
  }
  const row = { oid: head, ...(await repo.reads.commit(head)) };
  assert.deepEqual(await history.eligibility([row], await repo.reads.head()), { cherryPick: false, revert: true, rewrite: false, undo: false, drop: false });
  assert.equal(await repo.head(), head);
});

test('editing HEAD is multiline and message-only even with an unrelated staged file', async t => {
  const { repo, earlier, head } = await mixedHistory(t);
  const originalTree = await repo.git('rev-parse', 'HEAD^{tree}');
  const message = 'New subject\n\nA detailed body with UTF-8: café.\n# this line stays';
  await repo.write('extra.txt', 'staged\n');
  await repo.git('add', 'extra.txt');
  const index = await repo.git('diff', '--cached', '--no-ext-diff');
  await run(repo, 'editMessage', [head], { message });
  assert.equal((await repo.reads.commit(await repo.head())).message, message);
  assert.equal(await repo.reads.resolveCommit('HEAD^'), earlier);
  assert.equal(await repo.git('rev-parse', 'HEAD^{tree}'), originalTree);
  assert.equal(await repo.git('diff', '--cached', '--no-ext-diff'), index);
});

test('editing an older commit preserves its authored identity and replays the later line without updating other refs', async t => {
  const { repo, root, earlier, head } = await mixedHistory(t);
  const originalAuthor = await repo.git('show', '-s', '--format=%an <%ae>%n%aI', earlier);
  const originalTree = await repo.git('rev-parse', 'HEAD^{tree}');
  await repo.git('branch', 'keep');
  await repo.git('config', 'rebase.updateRefs', 'true');
  const result = await run(repo, 'editMessage', [earlier], { message: 'Earlier edited\n\nNew body.' });
  assert.equal(result.warning, undefined, result.message);
  const replacement = await repo.reads.resolveCommit('HEAD^');
  assert.notEqual(replacement, earlier);
  assert.equal((await repo.reads.commit(replacement)).message, 'Earlier edited\n\nNew body.');
  assert.equal(await repo.git('show', '-s', '--format=%an <%ae>%n%aI', replacement), originalAuthor);
  assert.equal(await repo.reads.resolveCommit('HEAD^^'), root);
  assert.equal(await repo.reads.resolveCommit('refs/heads/keep'), head);
  assert.equal(await repo.git('rev-parse', 'HEAD^{tree}'), originalTree);
  assert.equal((await repo.reads.commit(await repo.head())).message, 'later');
});

test('Squash Into HEAD uses just the staged patch and keeps the message and unstaged edits', async t => {
  const { repo, earlier, head } = await mixedHistory(t);
  await assert.rejects(repo.actions.history.prepare('squash', [head]), /Stage the changes/);
  await repo.write('shared.txt', 'staged\n');
  await repo.git('add', 'shared.txt');
  await repo.write('shared.txt', 'unstaged on the same path\n');
  await run(repo, 'squash', [head]);
  assert.equal(await repo.git('show', 'HEAD:shared.txt'), 'staged\n');
  assert.equal(await repo.read('shared.txt'), 'unstaged on the same path\n');
  assert.equal(await repo.reads.resolveCommit('HEAD^'), earlier);
  assert.equal((await repo.reads.commit(await repo.head())).message, 'later');
});

test('Squash Into an earlier commit applies the staged patch there, replays later commits and keeps a recovery copy', async t => {
  const { repo, root, earlier } = await mixedHistory(t);
  await repo.write('shared.txt', 'squashed into earlier\n');
  await repo.git('add', 'shared.txt');
  const result = await run(repo, 'squash', [earlier]);
  assert.equal(result.warning, undefined, result.message);
  assert.match(result.message, /Recovery copy kept/);
  assert.equal(await repo.git('show', 'HEAD^:shared.txt'), 'squashed into earlier\n');
  assert.equal(await repo.git('show', 'HEAD:later.txt'), 'later\n');
  assert.equal(await repo.reads.resolveCommit('HEAD^^'), root);
  assert.equal(await repo.git('status', '--porcelain'), '');
  assert.match(await repo.git('stash', 'list'), /Git Branch Squash /);
});

test('Squash refuses an unplaceable staged patch without changing the existing index or checkout', async t => {
  const { repo, earlier, head } = await mixedHistory(t);
  await repo.write('later.txt', 'only head has the base of this patch\n');
  await repo.git('add', 'later.txt');
  const before = await repo.git('status', '--porcelain=v2');
  await assert.rejects(run(repo, 'squash', [earlier]), /staged patch cannot be applied/);
  assert.equal(await repo.head(), head);
  assert.equal(await repo.git('status', '--porcelain=v2'), before);
  assert.equal(await repo.git('stash', 'list'), '');
});

test('Drop removes only the requested commit and cannot drop the root', async t => {
  const { repo, root, earlier } = await mixedHistory(t);
  await assert.rejects(repo.actions.history.prepare('drop', [root]), /requires a parent/);
  const result = await run(repo, 'drop', [earlier]);
  assert.equal(result.warning, undefined, result.message);
  assert.equal(await repo.reads.resolveCommit('HEAD^'), root);
  assert.equal((await repo.reads.commit(await repo.head())).message, 'later');
  await assert.rejects(repo.read('first.txt'), { code: 'ENOENT' });
  const latest = await repo.head();
  await run(repo, 'drop', [latest]);
  assert.equal(await repo.head(), root);
  await assert.rejects(repo.read('later.txt'), { code: 'ENOENT' });
});

test('reset supports Soft, Mixed, Keep and Hard with distinct index/worktree effects', async t => {
  const f = await fixture(t);
  for (const mode of ['soft', 'mixed', 'keep', 'hard']) {
    const repo = await f.repo(mode);
    const start = await repo.commit('start', { 'file.txt': 'old\n', 'other.txt': 'original\n' });
    const head = await repo.commit('next', { 'file.txt': 'committed\n' });
    await repo.write('other.txt', 'local edit\n');
    await assert.rejects(repo.actions.history.prepare('reset', [head]), /already points/);
    await run(repo, 'reset', [start], { mode });
    assert.equal(await repo.head(), start);
    assert.equal(await repo.read('file.txt'), ['soft', 'mixed'].includes(mode) ? 'committed\n' : 'old\n');
    assert.equal(await repo.git('show', ':file.txt'), mode === 'soft' ? 'committed\n' : 'old\n');
    assert.equal(await repo.read('other.txt'), mode === 'hard' ? 'original\n' : 'local edit\n');
  }
});

test('Hard reset will not overwrite ignored or untracked paths or changes made during confirmation', async t => {
  const { repo, head } = await mixedHistory(t);
  await repo.git('switch', '-c', 'other');
  await repo.write('ignored.txt', 'tracked there');
  await repo.git('add', '-f', 'ignored.txt');
  const target = await repo.commit('tracks ignored', { 'untracked-here.txt': 'there' });
  await repo.git('switch', 'main');
  await repo.write('untracked-here.txt', 'preserve untracked');
  await repo.write('ignored.txt', 'preserve ignored');
  await assert.rejects(run(repo, 'reset', [target], { mode: 'hard' }), /could overwrite/);
  assert.equal(await repo.read('ignored.txt'), 'preserve ignored');
  assert.equal(await repo.read('untracked-here.txt'), 'preserve untracked');
  assert.equal(await repo.head(), head);
  await repo.write('shared.txt', 'edit before prompt');
  const plan = await repo.actions.history.prepare('reset', [await repo.reads.resolveCommit('HEAD^')]);
  await repo.write('shared.txt', 'edit after prompt');
  await assert.rejects(repo.actions.history.execute(plan, { mode: 'hard' }), /changed/);
  assert.equal(await repo.read('shared.txt'), 'edit after prompt');
  assert.equal(await repo.head(), head);
});
