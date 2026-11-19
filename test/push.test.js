'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const { GitOperations } = require('../src/git-operations');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gb-push-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'local');
  await fs.mkdir(cwd);
  const git = new GitOperations(cwd);
  await git.exec(['init', '-b', 'main']);
  await git.exec(['config', 'user.name', 'Test']);
  await git.exec(['config', 'user.email', 'test@example.invalid']);
  await fs.writeFile(path.join(cwd, 'file.txt'), 'base');
  await git.exec(['add', '.']); await git.exec(['commit', '-m', 'base']);
  const serverPath = path.join(root, 'server.git');
  await git.exec(['clone', '--bare', cwd, serverPath]);
  await git.exec(['remote', 'add', 'origin', serverPath]);
  return { root, cwd, git, server: new GitOperations(serverPath) };
}
const node = ref => ({ kind: 'branch', ref, remote: false, label: ref });

test('Push publishes missing remote branches, follows upstream, preserves dirty files and rejects unsafe destinations', async t => {
  const { cwd, git, server } = await fixture(t);
  const base = await git.resolve('HEAD');
  await git.create('feature/new', base);
  await git.checkout(node('feature/new'));
  await git.exec(['commit', '--allow-empty', '-m', 'feature']);
  const feature = await git.resolve('HEAD');
  await git.checkout(node('main'));
  await fs.writeFile(path.join(cwd, 'file.txt'), 'dirty');
  await fs.writeFile(path.join(cwd, 'untracked.txt'), 'untracked');
  const status = await git.exec(['status', '--porcelain']);
  const index = await git.exec(['diff', '--cached']);
  const target = await git.pushTarget(node('feature/new'));
  assert.deepEqual(target.remotes, ['origin']);
  await git.exec(['tag', '-a', 'not-pushed', '-m', 'tag', feature]);
  await git.exec(['config', 'push.followTags', 'true']);
  await git.exec(['config', 'push.default', 'matching']);
  await git.exec(['config', 'remote.origin.push', '+refs/heads/*:refs/heads/*']);
  assert.equal(await git.push(node('feature/new'), 'origin'), 'feature/new → origin/feature/new');
  assert.equal(await server.resolve('refs/heads/feature/new'), feature);
  await assert.rejects(server.resolve('refs/tags/not-pushed'));
  assert.equal(await git.exec(['config', '--get', 'branch.feature/new.remote']), 'origin\n');
  assert.equal(await git.exec(['config', '--get', 'branch.feature/new.merge']), 'refs/heads/feature/new\n');
  assert.equal(await git.current(), 'main');
  assert.equal(await git.exec(['status', '--porcelain']), status);
  assert.equal(await git.exec(['diff', '--cached']), index);
  assert.equal(await server.resolve('refs/heads/main'), base);
  // A missing configured upstream is recreated under its configured (different) name.
  await git.create('different', feature);
  await git.exec(['config', 'branch.different.remote', 'origin']);
  await git.exec(['config', 'branch.different.merge', 'refs/heads/remote-name']);
  await git.push(node('different'));
  assert.equal(await server.resolve('refs/heads/remote-name'), feature);
  await assert.rejects(server.resolve('refs/heads/different'));
  // Non-fast-forward is rejected even with a force refspec in remote config.
  await git.exec(['update-ref', 'refs/heads/feature/new', base]);
  await assert.rejects(git.push(node('feature/new')), /rejected|failed to push/i);
  assert.equal(await server.resolve('refs/heads/feature/new'), feature);
  await git.exec(['config', 'remote.origin.mirror', 'true']);
  await assert.rejects(git.push(node('different')), /Mirror/);
  await git.exec(['config', '--unset', 'remote.origin.mirror']);
  await git.create('local-track', base);
  await git.setTracking('local-track', 'refs/heads/main');
  await assert.rejects(git.pushTarget(node('local-track')), /tracks a local/);
  await assert.rejects(git.push(node('main'), 'missing'), /no longer configured/);
  await assert.rejects(git.pushTarget({ ...node('main'), remote: true }), /local branch/);
  await assert.rejects(git.pushTarget({ ...node('main'), diffSession: true }), /local branch/);
  await assert.rejects(git.pushTarget(node('../invalid')));
  await assert.rejects(git.pushTarget(node('deleted')));
  await git.exec(['remote', 'set-url', 'origin', path.join(cwd, 'nonexistent.git')]);
  await assert.rejects(git.push(node('different')));
  assert.equal(await git.exec(['status', '--porcelain']), status);
  await git.exec(['remote', 'remove', 'origin']);
  await assert.rejects(git.pushTarget(node('main')), /No remote/);
});

test('Push menu command auto-publishes with one remote, supports cancellation and enforces local single selection', async t => {
  const { cwd, git, server, root } = await fixture(t);
  await git.create('auto'); await git.create('cancelled'); await git.create('chosen');
  const commands = new Map(), messages = [];
  let tree, pickerCalls = 0, choice;
  const disposable = { dispose() {} };
  const mock = {
    EventEmitter: class { event = () => {}; fire() {} dispose() {} },
    RelativePattern: class {},
    workspace: { workspaceFolders: [{ uri: { fsPath: cwd } }],
      registerTextDocumentContentProvider: () => disposable,
      createFileSystemWatcher: () => ({ ...disposable, onDidChange() {}, onDidCreate() {}, onDidDelete() {} }) },
    extensions: { getExtension: () => undefined },
    commands: { executeCommand: async () => {}, registerCommand: (id, fn) => { commands.set(id, fn); return disposable; } },
    window: { createTreeView: (id, options) => { tree = options.treeDataProvider; return disposable; },
      registerFileDecorationProvider: () => disposable,
      showInformationMessage: text => messages.push(text), showErrorMessage: text => messages.push(text),
      showQuickPick: async items => { pickerCalls++; return choice && items.find(item => item.remote === choice); } }
  };
  const originalLoad = Module._load;
  Module._load = function(request, ...args) { return request === 'vscode' ? mock : originalLoad.call(this, request, ...args); };
  const context = { subscriptions: [] };
  try {
    delete require.cache[require.resolve('../src/extension')];
    await require('../src/extension').activate(context);
    const push = commands.get('git-branch.push');
    await push(node('auto'));
    assert.equal(pickerCalls, 0);
    assert.equal(await server.resolve('refs/heads/auto'), await git.resolve('refs/heads/auto'));
    assert.ok(messages.some(text => text === 'Pushed: auto → origin/auto'));
    await git.exec(['remote', 'add', 'backup', path.join(root, 'server.git')]);
    await push(node('cancelled'));
    assert.equal(pickerCalls, 1);
    await assert.rejects(server.resolve('refs/heads/cancelled'));
    await assert.rejects(git.exec(['config', '--get', 'branch.cancelled.remote']));
    choice = 'backup'; await push(node('chosen'));
    assert.equal(await server.resolve('refs/heads/chosen'), await git.resolve('HEAD'));
    assert.equal((await git.exec(['config', '--get', 'branch.chosen.remote'])).trim(), 'backup');
    await push(node('auto')); // Existing tracking does not show another remote picker.
    assert.equal(pickerCalls, 2);
    await push({ ...node('origin/main'), remote: true });
    await push(node('main'), [node('main'), node('auto')]);
    await push({ ...node('main'), diffSession: true });
    assert.equal(messages.filter(text => text === 'Select one local branch to push.').length, 3);
    assert.equal(await git.current(), 'main');
    assert.equal(await git.exec(['status', '--porcelain']), '');
    assert.ok(tree);
  } finally {
    for (const item of context.subscriptions) item.dispose?.();
    Module._load = originalLoad;
  }
});
