'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { GitOperations } = require('../src/git-operations');

test('create inherits local upstream; setting and clearing tracking never moves commits or files', async t => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'gb-tracking-config-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const git = new GitOperations(cwd);
  await git.exec(['init', '-b', 'main']);
  await git.exec(['config', 'user.name', 'Test']);
  await git.exec(['config', 'user.email', 'test@example.invalid']);
  await git.exec(['commit', '--allow-empty', '-m', 'base']);
  const base = await git.resolve('HEAD');
  const record = async name => (await git.branches()).branches.find(b => b.name === name && !b.remote);
  await git.create('untracked', 'refs/heads/main');
  assert.equal((await record('untracked')).upstream, '');
  await git.exec(['remote', 'add', 'origin', cwd]);
  await git.exec(['update-ref', 'refs/remotes/origin/main', base]);
  await git.setTracking('main', 'refs/remotes/origin/main');
  for (const [name, start] of [['child', 'refs/heads/main'], ['implicit', 'HEAD'], ['short-name', 'main']]) {
    await git.create(name, start);
    assert.equal((await record(name)).upstream, 'refs/remotes/origin/main');
    assert.equal(await git.resolve(`refs/heads/${name}`), base);
    assert.equal((await git.exec(['config', `branch.${name}.remote`])).trim(), 'origin');
    assert.equal((await git.exec(['config', `branch.${name}.merge`])).trim(), 'refs/heads/main');
  }
  // A stale/missing upstream is still inherited as configuration, not silently removed.
  await git.exec(['update-ref', '-d', 'refs/remotes/origin/main']);
  await git.create('gone-child', 'refs/heads/main');
  assert.equal((await git.exec(['config', 'branch.gone-child.remote'])).trim(), 'origin');
  assert.equal((await git.exec(['config', 'branch.gone-child.merge'])).trim(), 'refs/heads/main');
  await git.exec(['update-ref', 'refs/remotes/origin/main', base]);
  await git.setTracking('main', 'refs/heads/untracked');
  await git.create('local-upstream-child', 'refs/heads/main');
  assert.equal((await record('local-upstream-child')).upstream, 'refs/heads/untracked');
  await git.exec(['tag', 'main', base]); // Explicitly qualified local source remains unambiguous.
  await git.create('tag-child', 'refs/tags/main');
  await git.create('remote-child', 'refs/remotes/origin/main');
  await git.create('hash-child', base);
  for (const name of ['tag-child', 'hash-child']) assert.equal((await record(name)).upstream, '');
  assert.equal((await record('remote-child')).upstream, 'refs/remotes/origin/main');
  await git.create('remote-short-child', 'origin/main');
  assert.equal((await record('remote-short-child')).upstream, 'refs/remotes/origin/main');
  // Explicit creation modes also work when Git's global auto-tracking behavior is disabled.
  await git.exec(['config', 'branch.autoSetupMerge', 'false']);
  await git.create('remote-config-disabled', 'refs/remotes/origin/main');
  await git.create('local-config-disabled', 'refs/heads/child');
  assert.equal((await record('remote-config-disabled')).upstream, 'refs/remotes/origin/main');
  assert.equal((await record('local-config-disabled')).upstream, 'refs/remotes/origin/main');
  await git.exec(['switch', '--detach', base]);
  await git.create('detached-child');
  assert.equal((await record('detached-child')).upstream, '');
  await git.checkout({ ref: 'child' });
  await fs.writeFile(path.join(cwd, 'dirty.txt'), 'preserve\n');
  const before = await git.exec(['status', '--porcelain']);
  await git.setTracking('child', 'refs/heads/untracked');
  assert.equal((await record('child')).upstream, 'refs/heads/untracked');
  await git.setTracking('child', 'refs/remotes/origin/main');
  assert.equal((await record('child')).upstream, 'refs/remotes/origin/main');
  assert.equal(await git.resolve('HEAD'), base);
  assert.equal(await git.current(), 'child');
  assert.equal(await git.exec(['status', '--porcelain']), before);
  await assert.rejects(git.setTracking('child', 'refs/heads/child'), /cannot track itself/);
  await assert.rejects(git.setTracking('child', 'refs/tags/main'), /valid tracking/);
  await assert.rejects(git.setTracking('child', 'refs/remotes/origin/missing'));
  await git.exec(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
  await assert.rejects(git.setTracking('child', 'refs/remotes/origin/HEAD'), /symbolic/);
  assert.equal((await record('child')).upstream, 'refs/remotes/origin/main');
  await git.setTracking('child', null);
  await git.setTracking('child', null); // Idempotent clearing.
  assert.equal((await record('child')).upstream, '');
  await git.create('no-upstream-child', 'refs/heads/child');
  assert.equal((await record('no-upstream-child')).upstream, '');
  assert.equal(await fs.readFile(path.join(cwd, 'dirty.txt'), 'utf8'), 'preserve\n');
});
