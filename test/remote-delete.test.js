'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const { GitOperations } = require('../src/git-operations');

async function remoteFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gb-remote-delete-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const serverPath = path.join(root, 'server.git');
  await fs.mkdir(serverPath);
  const server = new GitOperations(serverPath);
  await server.exec(['init', '--bare', '-b', 'main']);
  const cwd = path.join(root, 'local');
  await fs.mkdir(cwd);
  const git = new GitOperations(cwd);
  await git.exec(['init', '-b', 'main']);
  await git.exec(['config', 'user.name', 'Test']);
  await git.exec(['config', 'user.email', 'test@example.invalid']);
  await fs.writeFile(path.join(cwd, 'file.txt'), 'base');
  await git.exec(['add', '.']); await git.exec(['commit', '-m', 'base']);
  await git.exec(['remote', 'add', 'origin', serverPath]);
  await git.exec(['push', '-u', 'origin', 'main']);
  return { root, cwd, git, server };
}

test('Remote deletion is explicit, bounded and removes only an unchanged tracking ref', async t => {
  const { git, server } = await remoteFixture(t);
  const base = await git.resolve('HEAD');
  await git.create('feature/x', base); await git.checkout({ ref: 'feature/x' });
  await git.exec(['commit', '--allow-empty', '-m', 'feature']);
  const feature = await git.resolve('HEAD');
  await git.checkout({ ref: 'main' });
  await git.push({ kind: 'branch', ref: 'feature/x', remote: false }, 'origin');
  assert.equal(await server.resolve('refs/heads/feature/x'), feature);
  const node = { kind: 'branch', ref: 'origin/feature/x', remote: true, label: 'origin/feature/x' };
  assert.deepEqual(await git.remoteBranch(node),
    { remote: 'origin', name: 'feature/x', ref: 'refs/remotes/origin/feature/x', upstream: 'refs/remotes/origin/feature/x' });
  const locals = await git.correspondingLocals(node);
  assert.equal(locals.find(item => item.ref === 'feature/x').tracksDeletedRemote, true);
  await git.exec(['tag', 'keep-tag', feature]);
  await git.exec(['config', 'push.followTags', 'true']);
  assert.equal(await git.removeRemote(node), 'origin/feature/x');
  await assert.rejects(server.resolve('refs/heads/feature/x'));
  assert.equal(await git.resolve('refs/tags/keep-tag'), feature);
  await assert.rejects(server.resolve('refs/tags/keep-tag'));
  await assert.rejects(git.resolve('refs/remotes/origin/feature/x'));
  assert.equal(await git.resolve('refs/heads/feature/x'), feature);
  await assert.rejects(git.removeRemote(node));
  await assert.rejects(git.removeRemote({ kind: 'branch', ref: 'feature/x', remote: false }), /remote branch/);
  await assert.rejects(git.remoteBranch({ kind: 'branch', ref: 'unknown/x', remote: true }), /not configured/);
  await git.exec(['push', '--no-force', '--no-follow-tags', '--recurse-submodules=no', '--',
    'origin', `refs/heads/feature/x:refs/heads/other`]);
  await git.exec(['fetch', 'origin']);
  await git.exec(['config', 'remote.origin.mirror', 'true']);
  await assert.rejects(git.removeRemote({ kind: 'branch', ref: 'origin/other', remote: true }), /Mirror/);
  assert.equal(await server.resolve('refs/heads/other'), feature);
  await git.exec(['config', '--unset', 'remote.origin.mirror']);
});

test('Remote delete command asks about locals, skips the current branch and never deletes locals after remote failure', async t => {
  const { cwd, git, server } = await remoteFixture(t);
  const base = await git.resolve('HEAD');
  for (const name of ['topic', 'checkout-later', 'current-local']) {
    await git.create(name, base);
  }
  await git.checkout({ ref: 'checkout-later' });
  await git.exec(['commit', '--allow-empty', '-m', 'local-only']);
  await git.checkout({ ref: 'main' });
  const remotes = ['topic', 'checkout-later', 'current-local'];
  for (const name of remotes) {
    await git.exec(['push', 'origin', `refs/heads/${name}:refs/heads/${name}`]);
  }
  await git.exec(['fetch', 'origin']);
  await git.checkout({ ref: 'current-local' });
  const currentHash = await git.resolve('HEAD');
  const commands = new Map(), messages = [], dialogs = [];
  let tree, answers = [];
  const disposable = { dispose() {} };
  const mock = {
    EventEmitter: class { event = () => {}; fire() {} dispose() {} },
    TreeItem: class { constructor(label) { this.label = label; } },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ThemeIcon: class { constructor(id, color) { this.id = id; this.color = color; } },
    ThemeColor: class { constructor(id) { this.id = id; } },
    MarkdownString: class { value = ''; appendText(text) { this.value += text; } appendMarkdown(text) { this.value += text; } },
    Uri: { file: fsPath => ({ scheme: 'file', fsPath }), from: value => value },
    RelativePattern: class {}, ViewColumn: { Active: -1 },
    workspace: { workspaceFolders: [{ uri: { fsPath: cwd } }], textDocuments: [],
      registerTextDocumentContentProvider: () => disposable,
      createFileSystemWatcher: () => ({ ...disposable, onDidChange() {}, onDidCreate() {}, onDidDelete() {} }) },
    extensions: { getExtension: () => undefined },
    commands: { executeCommand: async () => {}, registerCommand: (id, fn) => { commands.set(id, fn); return disposable; } },
    window: { createTreeView: (id, options) => { tree = options.treeDataProvider; return disposable; },
      registerFileDecorationProvider: () => disposable,
      showInformationMessage: text => messages.push(text), showErrorMessage: text => messages.push(text),
      showWarningMessage: async (text, options, ...actions) => { dialogs.push({ text, actions }); return answers.shift(); } }
  };
  const originalLoad = Module._load;
  Module._load = function(request, ...args) { return request === 'vscode' ? mock : originalLoad.call(this, request, ...args); };
  const context = { subscriptions: [] };
  try {
    delete require.cache[require.resolve('../src/extension')];
    await require('../src/extension').activate(context);
    const run = (id, ...args) => commands.get(`git-branch.${id}`)(...args);
    const roots = await tree.groups();
    const remoteNode = name => roots[1].children[0].children.find(node => node.ref === `origin/${name}`);
    answers = ['Delete', 'Keep Local Branches'];
    await run('delete', remoteNode('topic'));
    await assert.rejects(server.resolve('refs/heads/topic'));
    assert.ok(await git.resolve('refs/heads/topic'));
    assert.ok(!dialogs.some(dialog => /current branch/.test(dialog.text)));
    answers = ['Delete', 'Delete Local Branches'];
    await run('delete', remoteNode('checkout-later'));
    await assert.rejects(server.resolve('refs/heads/checkout-later'));
    assert.ok(await git.resolve('refs/heads/checkout-later')); // Unmerged local still needs Force confirmation.
    assert.ok(dialogs.some(dialog => /not fully merged/.test(dialog.text)));
    answers = ['Delete', 'Delete Local Branches'];
    await run('delete', remoteNode('current-local'));
    await assert.rejects(server.resolve('refs/heads/current-local'));
    assert.equal(await git.current(), 'current-local');
    assert.equal(await git.resolve('refs/heads/current-local'), currentHash);
    // Mixed selection: a local explicitly chosen alongside its remote must not
    // be offered a second time by the corresponding-local prompt.
    await git.create('mixed', base);
    await git.exec(['push', 'origin', 'refs/heads/mixed:refs/heads/mixed']);
    await git.exec(['fetch', 'origin']);
    await run('refresh');
    const freshRoots = await tree.groups();
    const mixedRemote = freshRoots[1].children[0].children.find(node => node.ref === 'origin/mixed');
    const mixedLocal = freshRoots[0].children.find(item => item.ref === 'mixed');
    assert.ok(mixedRemote && mixedLocal);
    const promptsBeforeMixed = dialogs.filter(dialog => /corresponding local branch/.test(dialog.text)).length;
    answers = ['Delete', 'Force Delete'];
    await run('delete', mixedRemote, [mixedRemote, mixedLocal]);
    await assert.rejects(server.resolve('refs/heads/mixed'));
    await assert.rejects(git.resolve('refs/heads/mixed'));
    assert.equal(dialogs.filter(dialog => /corresponding local branch/.test(dialog.text)).length, promptsBeforeMixed);
    await git.exec(['remote', 'set-url', 'origin', path.join(cwd, 'does-not-exist.git')]);
    answers = ['Delete'];
    await run('delete', remoteNode('topic'));
    assert.ok(messages.some(text => text.startsWith('Delete: 0 succeeded, 1 failed')));
    const localPromptCount = dialogs.filter(dialog => /corresponding local branch/.test(dialog.text)).length;
    assert.equal(localPromptCount, 2); // Never asks again after a failed remote deletion.
    assert.equal(await git.current(), 'current-local');
    assert.equal(await git.exec(['status', '--porcelain']), '');
  } finally {
    for (const item of context.subscriptions) item.dispose?.();
    Module._load = originalLoad;
  }
});
