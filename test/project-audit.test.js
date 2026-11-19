'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { GitOperations } = require('../src/git-operations');

test('branch-name validation distinguishes invalid syntax from runtime failure', async t => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'gb-validation-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const git = new GitOperations(cwd, path.join(cwd, 'missing-git'));
  await assert.rejects(git.validateName('valid-branch'), error => error.code === 'ENOENT');
  for (const code of [1, 128]) {
    git.exec = async () => { throw Object.assign(new Error('invalid name'), { code }); };
    assert.equal(await git.validateName('bad..name'), 'Invalid Git branch name.');
  }
  for (const code of ['EACCES', 'ETIMEDOUT']) {
    git.exec = async () => { throw Object.assign(new Error('runtime failure'), { code }); };
    await assert.rejects(git.validateName('valid-branch'), error => error.code === code);
  }
});

test('worktree normalization reads symlink target text and does not dereference outside files', async t => {
  const git = new GitOperations(path.join(os.tmpdir(), 'gb-symlink-reader'));
  const original = { lstat: fs.lstat, readlink: fs.readlink, readFile: fs.readFile };
  t.after(() => Object.assign(fs, original));
  const reads = [];
  fs.lstat = async () => ({ isSymbolicLink: () => true });
  fs.readlink = async location => { reads.push(location); return '../outside-private-file'; };
  fs.readFile = async () => { throw new Error('Must not dereference a symlink'); };
  assert.equal((await git.readWorktreeFile('link.txt')).toString(), '../outside-private-file');
  assert.deepEqual(reads, [path.join(git.cwd, 'link.txt')]);
  await assert.rejects(git.readWorktreeFile('../outside'), /outside/);
  fs.lstat = async () => ({ isSymbolicLink: () => false });
  fs.readFile = async () => Buffer.from('ordinary contents');
  assert.equal((await git.readWorktreeFile('ordinary.txt')).toString(), 'ordinary contents');
});
