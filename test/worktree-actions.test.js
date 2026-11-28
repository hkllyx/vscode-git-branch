'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { GitClient } = require('../src/git/gitClient');
const { fixture } = require('../test-support/gitFixture');

async function prepare(repo, kind, ...paths) {
  const actions = repo.actions.worktree;
  const choices = await actions.choices(await repo.reads.head());
  const files = paths.map(file => {
    const change = choices.files.find(change => change.file === file);
    assert.ok(change, `${file} is selectable`);
    return change;
  });
  return actions.plan(kind, choices, files);
}

const has = (repo, spec) => repo.client.query(['cat-file', '-e', spec]).then(result => result.code === 0);

test('Commit and Amend include only the selected files, preserving the index and disk contents of other files', async t => {
  const { repo } = await fixture(t);
  const local = await repo('commit');
  const base = await local.commit('initial', { 'selected.txt': 'original', 'keep.txt': 'original', 'delete.txt': 'old' });
  await local.write('selected.txt', 'first stage');
  await local.write('keep.txt', 'keep staged');
  await local.git('add', '--', 'selected.txt', 'keep.txt');
  await local.write('selected.txt', 'saved worktree');
  await local.write('keep.txt', 'keep unstaged too');
  const newFile = process.platform === 'win32' ? '[literal] path.txt' : ':(glob) literal.txt';
  await local.write(newFile, 'new');
  await local.git('rm', '--', 'delete.txt');
  const plan = await prepare(local, 'commit', 'selected.txt', newFile, 'delete.txt');
  await local.actions.worktree.execute(plan, { message: 'selected\n\nbody\n' });
  const after = await local.head();
  assert.equal((await local.reads.commit(after)).parents[0], base);
  assert.equal(await local.git('show', 'HEAD:selected.txt'), 'saved worktree');
  assert.equal(await local.git('show', `HEAD:${newFile}`), 'new');
  assert.equal(await has(local, 'HEAD:delete.txt'), false);
  assert.equal(await local.git('show', 'HEAD:keep.txt'), 'original');
  assert.equal(await local.git('show', ':keep.txt'), 'keep staged');
  assert.equal(await local.read('keep.txt'), 'keep unstaged too');
  await local.write(newFile, 'amended');
  const amend = await prepare(local, 'commit', newFile);
  assert.match((await local.actions.worktree.amendable(amend)).message, /^selected/);
  await local.actions.worktree.execute(amend, { amend: true, message: 'amended\n\nmultiline\n' });
  assert.notEqual(await local.head(), after);
  assert.equal((await local.reads.commit(await local.head())).parents[0], base);
  assert.equal((await local.reads.commit(await local.head())).message.trim(), 'amended\n\nmultiline');
  assert.equal(await local.git('show', `HEAD:${newFile}`), 'amended');
  assert.equal(await local.git('show', ':keep.txt'), 'keep staged');
  assert.equal(await local.read('keep.txt'), 'keep unstaged too');
});

test('Amend rejects a tip known to a remote; a commit-hook failure leaves new paths untracked', async t => {
  const { repo } = await fixture(t);
  const local = await repo('hook');
  const root = await local.commit('root', { 'keep': 'base' });
  await local.git('update-ref', 'refs/remotes/origin/main', root);
  await local.write('keep', 'staged');
  await local.git('add', '--', 'keep');
  await local.write('new.txt', 'new');
  const plan = await prepare(local, 'commit', 'new.txt');
  assert.equal(await local.actions.worktree.amendable(plan), undefined);
  await assert.rejects(local.actions.worktree.execute(plan, { amend: true, message: 'no' }), /cannot be amended/i);
  const hook = path.join(local.dirs.gitDir, 'hooks', 'pre-commit');
  await fs.mkdir(path.dirname(hook), { recursive: true });
  await fs.writeFile(hook, '#!/bin/sh\necho fixture-rejected >&2\nexit 1\n', { mode: 0o755 });
  await assert.rejects(local.actions.worktree.execute(plan, { message: 'new' }), /fixture-rejected/);
  assert.equal(await local.head(), root);
  assert.equal(await local.git('show', ':keep'), 'staged');
  assert.equal(await local.read('new.txt'), 'new');
  assert.match(await local.git('status', '--short'), /^\?\? new\.txt$/m);
});

test('Rollback restores both rename paths and deletes only selected new files', async t => {
  const { repo } = await fixture(t);
  const local = await repo('rollback');
  const root = await local.commit('root', { 'old.txt': 'old', 'keep.txt': 'base', '.gitignore': 'ignored.txt\n' });
  await local.git('mv', '--', 'old.txt', 'new name.txt');
  await local.write('new name.txt', 'unstaged after rename');
  await local.write('new.txt', 'untracked');
  await local.write('added.txt', 'staged addition');
  await local.write('keep.txt', 'keep');
  await local.write('ignored.txt', 'ignored');
  await local.git('add', '--', 'keep.txt', 'added.txt');
  const plan = await prepare(local, 'rollback', 'new name.txt', 'new.txt', 'added.txt');
  assert.deepEqual([...plan.paths].sort(), ['added.txt', 'new name.txt', 'new.txt', 'old.txt']);
  await local.actions.worktree.execute(plan);
  assert.equal(await local.head(), root);
  assert.equal(await local.read('old.txt'), 'old');
  for (const file of ['new name.txt', 'new.txt', 'added.txt']) await assert.rejects(local.read(file), { code: 'ENOENT' });
  assert.equal(await local.git('show', ':keep.txt'), 'keep');
  assert.equal(await local.read('ignored.txt'), 'ignored');
  assert.equal((await local.git('status', '--porcelain')).trim(), 'M  keep.txt');
});

test('Stash has only selected index/worktree contents, and native apply --index restores both plus untracked files', async t => {
  const { repo } = await fixture(t);
  const local = await repo('stash');
  const root = await local.commit('root', { 'mixed.txt': 'base', 'keep.txt': 'base', 'old.txt': 'rename', 'deleted.txt': 'gone' });
  await local.write('mixed.txt', 'selected staged');
  await local.write('keep.txt', 'unselected staged');
  await local.git('add', '--', 'mixed.txt', 'keep.txt');
  await local.write('mixed.txt', 'selected unstaged');
  await local.write('keep.txt', 'unselected unstaged');
  await local.write('new file', 'untracked');
  await local.write('unused', 'not selected');
  await local.git('mv', '--', 'old.txt', 'renamed.txt');
  await local.git('rm', '--', 'deleted.txt');
  const plan = await prepare(local, 'stash', 'mixed.txt', 'new file', 'renamed.txt', 'deleted.txt');
  await local.actions.worktree.execute(plan, { message: 'partial work' });
  assert.match(await local.git('stash', 'list'), /On main: partial work/);
  assert.equal(await local.head(), root);
  assert.equal(await local.read('mixed.txt'), 'base');
  assert.equal(await local.read('old.txt'), 'rename');
  assert.equal(await local.read('deleted.txt'), 'gone');
  await assert.rejects(local.read('renamed.txt'), { code: 'ENOENT' });
  await assert.rejects(local.read('new file'), { code: 'ENOENT' });
  assert.equal(await local.read('unused'), 'not selected');
  assert.equal(await local.git('show', ':keep.txt'), 'unselected staged');
  assert.equal(await local.read('keep.txt'), 'unselected unstaged');
  assert.equal(await local.git('show', 'stash@{0}^2:keep.txt'), 'base');
  assert.equal(await local.git('show', 'stash@{0}:keep.txt'), 'base');
  assert.equal(await local.git('show', 'stash@{0}^2:mixed.txt'), 'selected staged');
  assert.equal(await local.git('show', 'stash@{0}:mixed.txt'), 'selected unstaged');
  assert.equal(await local.git('show', 'stash@{0}^3:new file'), 'untracked');
  assert.equal(await has(local, 'stash@{0}^3:unused'), false);
  // Git's native apply can reject even unrelated dirty paths. Verify vanilla
  // restoration in a clean linked worktree, leaving the original untouched.
  const target = path.join(path.dirname(local.dir), 'apply-here');
  await local.git('worktree', 'add', '--detach', '--', target, root);
  const applied = { dir: target, client: new GitClient(target) };
  const git = (...args) => applied.client.text(args, { write: true });
  await git('stash', 'apply', '--index', 'stash@{0}');
  assert.equal(await git('show', ':mixed.txt'), 'selected staged');
  assert.equal(await fs.readFile(path.join(target, 'mixed.txt'), 'utf8'), 'selected unstaged');
  assert.equal(await fs.readFile(path.join(target, 'new file'), 'utf8'), 'untracked');
  assert.equal(await git('show', ':renamed.txt'), 'rename');
  assert.equal(await has(applied, ':deleted.txt'), false);
  assert.equal(await local.git('show', ':keep.txt'), 'unselected staged');
  assert.equal(await local.read('keep.txt'), 'unselected unstaged');
});

test('A stash remains recoverable if cleanup is interrupted after saving', async t => {
  const { repo } = await fixture(t);
  const local = await repo('stash-interrupted');
  await local.commit('root');
  await local.write('keep.txt', 'unsaved in Git');
  const actions = local.actions.worktree;
  const plan = await prepare(local, 'stash', 'keep.txt');
  const original = actions.discard;
  actions.discard = () => { throw new Error('simulated write failure'); };
  t.after(() => { actions.discard = original; });
  const result = await actions.execute(plan);
  assert.equal(result.warning, true);
  assert.match(result.message, /stash.*was saved.*cleanup did not finish/i);
  assert.equal(await local.read('keep.txt'), 'unsaved in Git');
  assert.equal(await local.git('show', 'stash@{0}^3:keep.txt'), 'unsaved in Git');
});

test('Rechecks saved content, refuses a conflicting selection, and leaves data alone if confirmation is stale', async t => {
  const { repo } = await fixture(t);
  const local = await repo('stale');
  await local.commit('root', { 'modified': 'base', 'recreated': 'base' });
  await local.write('modified', 'first edit');
  const rollback = await prepare(local, 'rollback', 'modified');
  await local.write('modified', 'later edit');
  await assert.rejects(local.actions.worktree.execute(rollback), /selected file changed/i);
  assert.equal(await local.read('modified'), 'later edit');
  await local.git('rm', '--', 'recreated');
  await local.write('recreated', 'locally replaced');
  await assert.rejects(prepare(local, 'stash', 'recreated'), /overlaps another change/i);
  assert.equal(await local.read('recreated'), 'locally replaced');
  assert.equal(await has(local, 'refs/stash'), false);
});
