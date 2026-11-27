'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture } = require('../test-support/gitFixture');
const { SelectedChanges, repositoryVersion, editableFileSide, canApply } = require('../src/git/selectedChanges');
const { combineChanges } = require('../src/panel/historyState');

const filesOf = async (repo, oid) => repo.reads.commitFiles(oid, await repo.reads.commit(oid));

async function patchFixture(t) {
  const f = await fixture(t);
  const repo = await f.repo('patches');
  const text = 'initial\n1\n2\n3\n4\n5\n6\nlast\n';
  const base = await repo.commit('base', { 'src/[literal].txt': text, 'z.txt': 'original\n', 'excluded.txt': 'old\n', '.gitignore': 'ignored.txt\n' });
  await repo.git('switch', '-c', 'topic');
  const edited = await repo.commit('change files', {
    'src/[literal].txt': text.replace('initial', 'topic'), 'z.txt': 'payload\n', 'excluded.txt': 'do not apply this\n'
  });
  await repo.git('switch', 'main');
  return { ...f, repo, base, edited, text, patches: new SelectedChanges(repo.actions) };
}

test('file Cherry-Pick applies only the selected contextual patches and preserves HEAD, index, and disjoint edits', async t => {
  const { repo, base, edited, text, patches } = await patchFixture(t);
  await repo.write('staged.txt', 'staged contents\n');
  await repo.git('add', 'staged.txt');
  await repo.write('src/[literal].txt', text.replace('last', 'unrelated local edit'));
  const index = await repo.git('ls-files', '-s');
  const files = (await filesOf(repo, edited)).filter(file => file.path !== 'excluded.txt');
  const result = await patches.apply(files, await repo.reads.head());
  assert.match(result.message, /Applied changes for 2 file/);
  assert.equal(await repo.read('src/[literal].txt'), text.replace('initial', 'topic').replace('last', 'unrelated local edit'));
  assert.equal(await repo.read('z.txt'), 'payload\n');
  assert.equal(await repo.read('excluded.txt'), 'old\n');
  assert.equal(await repo.head(), base);
  assert.equal(await repo.git('ls-files', '-s'), index);
  assert.equal(await repo.git('show', ':staged.txt'), 'staged contents\n');
});

test('one failing hunk stops the entire selected-file batch before modifying the working tree', async t => {
  const { repo, base, edited, text, patches } = await patchFixture(t);
  await repo.write('z.txt', 'a local edit in the selected hunk\n');
  const status = await repo.git('status', '--porcelain=v2');
  const files = (await filesOf(repo, edited)).filter(file => file.path !== 'excluded.txt');
  await assert.rejects(patches.apply(files), /No changes were applied/);
  assert.equal(await repo.read('src/[literal].txt'), text);
  assert.equal(await repo.read('z.txt'), 'a local edit in the selected hunk\n');
  assert.equal(await repo.head(), base);
  assert.equal(await repo.git('status', '--porcelain=v2'), status);
});

test('file patches support exact renames, deletes, and Unicode/binary additions with pinned snapshots', async t => {
  const { repo, base, patches } = await patchFixture(t);
  await repo.git('switch', '-c', 'another');
  await fs.mkdir(path.join(repo.dir, 'renamed folder'));
  await repo.git('mv', 'z.txt', 'renamed folder/z.txt');
  const source = await repo.commit('rename and create binary', { 'bin/資料 ä.bin': Buffer.from([0, 88, 4]), 'excluded.txt': null });
  await repo.git('switch', 'main');
  const changes = await repo.reads.branchFiles(base, source);
  const rename = changes.find(file => file.status === 'R');
  assert.equal(repositoryVersion(rename).path, 'renamed folder/z.txt');
  assert.equal(editableFileSide(rename).path, 'renamed folder/z.txt');
  assert.equal(repositoryVersion(changes.find(file => file.status === 'D')), undefined);
  await patches.apply(changes);
  assert.equal(await repo.read('renamed folder/z.txt'), 'original\n');
  await assert.rejects(repo.read('z.txt'), { code: 'ENOENT' });
  await assert.rejects(repo.read('excluded.txt'), { code: 'ENOENT' });
  assert.deepEqual(await fs.readFile(path.join(repo.dir, 'bin/資料 ä.bin')), Buffer.from([0, 88, 4]));
  assert.equal(await repo.git('diff', '--cached', '--name-only'), '');
});

test('combined changes patch endpoints without adding an unselected file, and disable applying incomplete or gapped results', async t => {
  const { repo, base, patches } = await patchFixture(t);
  await repo.git('switch', '-c', 'combined');
  const first = await repo.commit('first selected', { 'z.txt': 'first\n', 'gap.txt': '1\n' });
  await repo.commit('skipped', { 'debug.txt': 'not selected\n', 'gap.txt': '1\nskipped\n' });
  const end = await repo.commit('last selected', { 'z.txt': 'first\nlast\n', 'gap.txt': '1\nskipped\nlast\n' });
  await repo.git('switch', 'main');
  const items = await Promise.all([end, first].map(async oid => {
    const commit = await repo.reads.commit(oid);
    return { files: (await repo.reads.commitFiles(oid, commit)).map(file => ({ ...file, baseOid: commit.parents[0], afterOid: oid })) };
  }));
  const changes = await combineChanges(items, oid => repo.reads.firstParentHistory(oid));
  assert.deepEqual(changes.map(file => [file.path, canApply(file)]), [['gap.txt', false], ['z.txt', true]]);
  const kept = changes.find(canApply);
  await assert.rejects(patches.apply(changes), /safe file patch/);
  await assert.rejects(patches.apply([{ ...kept, partial: true }]), /safe file patch/);
  await patches.apply([kept]);
  assert.equal(await repo.read('z.txt'), 'first\nlast\n');
  await assert.rejects(repo.read('debug.txt'), { code: 'ENOENT' });
  assert.equal(await repo.head(), base);
});

test('working-tree, ignored/untracked and junction paths cannot be accidentally used as patch destinations', async t => {
  const { repo, root, base, edited, patches } = await patchFixture(t);
  await repo.git('switch', '-c', 'adds');
  await repo.write('ignored.txt', 'use ignored path in fixed snapshot');
  await repo.git('add', '-f', 'ignored.txt');
  const adds = await repo.commit('add', { 'untracked.txt': 'snapshot content' });
  await repo.git('switch', 'main');
  await repo.write('ignored.txt', 'keep hidden');
  await repo.write('untracked.txt', 'keep untracked');
  const choices = await filesOf(repo, adds);
  for (const file of choices) await assert.rejects(patches.apply([file]), /could overwrite/);
  assert.equal(await repo.read('ignored.txt'), 'keep hidden');
  assert.equal(await repo.read('untracked.txt'), 'keep untracked');
  const file = (await filesOf(repo, edited)).find(file => file.path.startsWith('src/'));
  const working = { ...file, workingTree: true };
  assert.equal(repositoryVersion(working).oid, file.old.oid);
  await assert.rejects(patches.apply([working]), /safe file patch/);
  const outside = path.join(root, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, '[literal].txt'), 'unchanged');
  await fs.unlink(path.join(repo.dir, 'src', '[literal].txt'));
  await fs.rmdir(path.join(repo.dir, 'src'));
  await fs.symlink(outside, path.join(repo.dir, 'src'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(patches.apply([file]), /Only regular files/);
  assert.equal(await fs.readFile(path.join(outside, '[literal].txt'), 'utf8'), 'unchanged');
  assert.equal(await repo.head(), base);
});
