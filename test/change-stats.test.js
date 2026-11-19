'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { GitOperations, parseNumstat } = require('../src/git-operations');

test('numstat handles binary and rename paths containing tabs/newlines', () => {
  assert.deepEqual(parseNumstat('4\t2\tfile\0-\t-\tbinary\0' + '0\t0\t\0old\tname\0new\nname\0'),
    { insertions: 4, deletions: 2, binaryFiles: 1 });
  assert.deepEqual(parseNumstat(''), { insertions: 0, deletions: 0, binaryFiles: 0 });
  assert.throws(() => parseNumstat('bad\0'), /Malformed/);
});

test('line counts: snapshots, root commits, dirty text, untracked and cached deletion stay read-only', async t => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'gb-line-stats-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const git = new GitOperations(cwd);
  await git.exec(['init', '-b', 'main']);
  await git.exec(['config', 'user.name', 'Test']);
  await git.exec(['config', 'user.email', 'test@example.invalid']);
  await git.exec(['config', 'core.autocrlf', 'false']);
  await fs.writeFile(path.join(cwd, 'text.txt'), 'one\ntwo\nthree\n');
  await fs.writeFile(path.join(cwd, 'binary.bin'), Buffer.from([0, 1, 2]));
  await git.exec(['add', '.']); await git.exec(['commit', '-m', 'Root', '-m', 'Full message\nsecond paragraph']);
  const base = await git.resolve('HEAD');
  const root = await git.commitDetails(base);
  assert.equal(root.message, 'Root\n\nFull message\nsecond paragraph');
  assert.deepEqual(root.stats, { insertions: 3, deletions: 0, binaryFiles: 1 });
  await fs.writeFile(path.join(cwd, 'text.txt'), 'one\nchanged\nthree\nextra\n');
  await fs.writeFile(path.join(cwd, 'binary.bin'), Buffer.from([0, 3, 4]));
  await git.exec(['add', '.']); await git.exec(['commit', '-m', 'Second']);
  const next = await git.resolve('HEAD');
  assert.deepEqual((await git.compare(base, next)).stats, { insertions: 2, deletions: 1, binaryFiles: 1 });
  assert.deepEqual((await git.compare(next, base)).stats, { insertions: 1, deletions: 2, binaryFiles: 1 });
  assert.deepEqual((await git.commitDetails(next)).stats, { insertions: 2, deletions: 1, binaryFiles: 1 });
  await git.exec(['rm', '--cached', 'text.txt']);
  await fs.writeFile(path.join(cwd, 'added.txt'), 'new\nline\n');
  const status = await git.exec(['status', '--porcelain=v1', '-z']);
  const index = await fs.readFile(path.join(cwd, '.git', 'index'));
  const disk = await fs.readFile(path.join(cwd, 'text.txt'));
  const result = await git.worktreeCompare(next, [{ file: 'text.txt', text: 'one\nchanged\n' }]);
  assert.deepEqual(result.stats, { insertions: 2, deletions: 2, binaryFiles: 0 });
  assert.deepEqual(result.files.map(file => file.status).sort(), ['A', 'M']);
  assert.equal(await git.exec(['status', '--porcelain=v1', '-z']), status);
  assert.deepEqual(await fs.readFile(path.join(cwd, '.git', 'index')), index);
  assert.deepEqual(await fs.readFile(path.join(cwd, 'text.txt')), disk);
  const binaryDirty = await git.worktreeCompare(next, [{ file: 'text.txt', text: 'one\nchanged\nthree\nextra\n' }]);
  assert.deepEqual(binaryDirty.stats, { insertions: 2, deletions: 0, binaryFiles: 0 });
  await fs.writeFile(path.join(cwd, 'binary.bin'), Buffer.from([0, 7, 8]));
  const worktreeBinary = await git.worktreeCompare(next, [{ file: 'text.txt', text: 'one\nchanged\nthree\nextra\n' }]);
  assert.deepEqual(worktreeBinary.stats, { insertions: 2, deletions: 0, binaryFiles: 1 });
  await fs.mkdir(path.join(cwd, 'special-directory'));
  assert.deepEqual(await git.worktreeStats(next, [{ oldPath: null, newPath: 'special-directory' }], []),
    { insertions: 0, deletions: 0, binaryFiles: 0, unsupportedFiles: 1 });
});
