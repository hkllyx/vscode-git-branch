'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { GitOperations } = require('../src/git-operations');

test('remote checkout fetches latest, confirms local-only commits, cancels safely and protects dirty files', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gb-remote-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, 'source');
  const localPath = path.join(root, 'local');
  await fs.mkdir(sourcePath); await fs.mkdir(localPath);
  const source = new GitOperations(sourcePath);
  const local = new GitOperations(localPath);
  for (const git of [source, local]) {
    await git.exec(['init', '-b', 'main']);
    await git.exec(['config', 'user.name', 'Test']);
    await git.exec(['config', 'user.email', 'test@example.invalid']);
  }
  await source.exec(['commit', '--allow-empty', '-m', 'base']);
  await source.create('feature/topic');
  await local.exec(['remote', 'add', 'origin', sourcePath]);
  const node = { ref: 'origin/feature/topic', remote: true };
  await local.checkout(node);
  assert.equal(await local.current(), 'feature/topic');
  const base = await local.resolve('HEAD');
  await source.checkout({ ref: 'feature/topic' });
  await source.exec(['commit', '--allow-empty', '-m', 'remote latest']);
  const latest = await source.resolve('HEAD');
  await local.checkout(node, () => { throw new Error('No confirmation for behind-only'); });
  assert.equal(await local.resolve('HEAD'), latest);
  await local.exec(['commit', '--allow-empty', '-m', 'local only']);
  const localOnly = await local.resolve('HEAD');
  await local.create('other');
  await local.checkout({ ref: 'other' });
  let confirmations = 0;
  const cancel = info => {
    confirmations++;
    assert.equal(info.count, 1);
    assert.equal(info.name, 'feature/topic');
    return false;
  };
  assert.equal(await local.checkout(node, cancel), false);
  assert.equal(await local.current(), 'other');
  assert.equal(await local.resolve('refs/heads/feature/topic'), localOnly);
  assert.equal(await local.checkout(node), false); // No callback cannot authorize dropping commits.
  await fs.writeFile(path.join(localPath, 'untracked.txt'), 'keep');
  await assert.rejects(local.checkout(node, () => true), /Commit or stash/);
  assert.equal(await local.resolve('refs/heads/feature/topic'), localOnly);
  await fs.unlink(path.join(localPath, 'untracked.txt'));
  await local.checkout(node, () => true);
  assert.equal(await local.resolve('HEAD'), latest);
  assert.equal(await local.current(), 'feature/topic');
  assert.equal(confirmations, 1);
  // Rewritten remote history also requires confirmation rather than an ancestry assumption.
  await source.exec(['reset', '--hard', base]);
  assert.equal(await local.checkout(node, () => false), false);
  assert.equal(await local.resolve('HEAD'), latest);
  await local.checkout(node, () => true);
  assert.equal(await local.resolve('HEAD'), base);
  // A deleted remote ref must fail fetch, never use the stale tracking ref.
  await source.checkout({ ref: 'main' });
  await source.exec(['branch', '-D', 'feature/topic']);
  await assert.rejects(local.checkout(node));
  assert.equal(await local.resolve('HEAD'), base);
});
