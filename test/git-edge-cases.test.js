'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { GitOperations } = require('../src/git-operations');

async function fixture(t, suffix) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), `git-branch-${suffix}-`));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const git = new GitOperations(cwd);
  await git.exec(['init', '-b', 'main']);
  await git.exec(['config', 'user.email', 'test@example.invalid']);
  await git.exec(['config', 'user.name', 'Test']);
  return { git, cwd };
}

test('conflicts and dirty changes are preserved; current branch and detached HEAD are protected', async t => {
  const { git, cwd } = await fixture(t, 'conflicts');
  await fs.writeFile(path.join(cwd, 'conflict.txt'), 'base\n');
  await git.exec(['add', '.']); await git.exec(['commit', '-m', 'base']);
  const base = await git.resolve('HEAD');
  await git.create('other'); await git.checkout({ ref: 'other' });
  await fs.writeFile(path.join(cwd, 'conflict.txt'), 'other\n');
  await git.exec(['add', '.']); await git.exec(['commit', '-m', 'other']);
  await git.checkout({ ref: 'main' });
  await fs.writeFile(path.join(cwd, 'conflict.txt'), 'dirty\n');
  await assert.rejects(git.checkout({ ref: 'other' }), /overwritten/);
  await assert.rejects(git.integrate('merge', 'refs/heads/other'), /Commit or stash/);
  await assert.rejects(git.integrate('rebase', 'refs/heads/other'), /Commit or stash/);
  assert.equal(await fs.readFile(path.join(cwd, 'conflict.txt'), 'utf8'), 'dirty\n');
  assert.equal(await git.current(), 'main');
  await fs.writeFile(path.join(cwd, 'conflict.txt'), 'main\n');
  await git.exec(['add', '.']); await git.exec(['commit', '-m', 'main']);
  const main = await git.resolve('HEAD');
  await assert.rejects(git.remove('main'), error => /cannot delete branch/i.test(error.message) && error.unmergedBranch === false);
  await assert.rejects(git.remove('main', true), error => /cannot delete branch/i.test(error.message) && error.unmergedBranch === false);
  await assert.rejects(git.remove('other'), error => /not fully merged/.test(error.message) && error.unmergedBranch === true);
  await assert.rejects(git.integrate('merge', 'refs/heads/other'), /conflict/i);
  assert.match(await fs.readFile(path.join(cwd, 'conflict.txt'), 'utf8'), /<<<<<<< HEAD/);
  await assert.rejects(git.integrate('merge', 'refs/heads/other'), /already in progress/);
  await git.exec(['merge', '--abort']);
  assert.equal(await git.resolve('HEAD'), main);
  await assert.rejects(git.integrate('rebase', 'refs/heads/other'), /conflict|could not apply/i);
  await assert.rejects(git.integrate('rebase', 'refs/heads/other'), /already in progress|detached/);
  await git.exec(['rebase', '--abort']);
  assert.equal(await git.resolve('HEAD'), main);
  await git.exec(['switch', '--detach', base]);
  assert.equal(await git.current(), undefined);
  assert.equal((await git.branches()).current, undefined);
  assert.ok((await git.compare('refs/heads/other')).files.length);
  await assert.rejects(git.integrate('merge', 'refs/heads/other'), /detached/);
  await assert.rejects(git.integrate('rebase', 'refs/heads/other'), /detached/);
});

test('empty repositories, same-name refs, annotation tags and non-repositories', async t => {
  const { git, cwd } = await fixture(t, 'refs');
  assert.deepEqual((await git.branches()).branches, []);
  assert.deepEqual(await git.tags(), []);
  await assert.rejects(git.compare('HEAD'));
  await assert.rejects(git.create('no-commit'));
  await git.exec(['commit', '--allow-empty', '-m', 'base']);
  await git.exec(['tag', '-a', 'annotated', '-m', 'annotation']);
  await git.create('same'); await git.exec(['tag', 'same']);
  assert.equal(await git.validateName('same'), 'A local branch with this name already exists.');
  assert.ok((await git.tags()).some(tag => tag.name === 'same'));
  assert.equal(await git.resolve('refs/tags/annotated'), await git.resolve('HEAD'));
  for (const name of ['bad..name', 'with space', '-leading', '@{-1}', 'a.lock', ' trailing ']) {
    assert.ok(await git.validateName(name), name);
  }
  await git.create('中文/分支');
  await git.rename('中文/分支', '中文/新分支');
  await git.remove('中文/新分支');
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'git-branch-nonrepo-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  const nonRepository = new GitOperations(outside);
  await assert.rejects(nonRepository.branches(), /not a git repository/i);
  await assert.rejects(nonRepository.current(), /not a git repository/i);
  // An explicitly missing executable must not be hidden as detached HEAD.
  const broken = new GitOperations(outside, path.join(cwd, 'missing-git'));
  await assert.rejects(broken.current());
  await assert.rejects(broken.branches());
});

test('Git worktrees and packed refs retain branch identity and safe operation', async t => {
  const { git, cwd } = await fixture(t, 'worktree');
  await git.exec(['commit', '--allow-empty', '-m', 'base']);
  const worktree = path.join(cwd, 'linked-worktree');
  await git.exec(['worktree', 'add', '-b', 'linked', worktree]);
  const linked = new GitOperations(worktree);
  assert.equal(await linked.current(), 'linked');
  await assert.rejects(linked.checkout({ ref: 'main' }), /already used by worktree|already checked out/i);
  await assert.rejects(linked.remove('main', true), error => /cannot delete branch/i.test(error.message) && error.unmergedBranch === false);
  await git.exec(['pack-refs', '--all']);
  await linked.create('from-linked', 'refs/heads/main');
  assert.equal(await linked.resolve('refs/heads/from-linked'), await git.resolve('HEAD'));
  await linked.remove('from-linked');
  assert.equal((await linked.compare('refs/heads/main')).files.length, 0);
});
