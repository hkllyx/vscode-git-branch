'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { GitOperations } = require('../src/git-operations');

test('delete and rename accept real tree data nodes without contextValue', async t => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'git-branch-actions-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const git = new GitOperations(cwd);
  await git.exec(['init', '-b', 'main']);
  await git.exec(['config', 'user.email', 'test@example.invalid']);
  await git.exec(['config', 'user.name', 'Test']);
  await git.exec(['commit', '--allow-empty', '-m', 'base']);
  await git.create('to-delete');
  await git.create('to-rename');
  await git.create('cancel-delete');
  await git.create('force-delete');
  await git.checkout({ ref: 'force-delete' });
  await git.exec(['commit', '--allow-empty', '-m', 'unmerged commit']);
  await git.create('cancel-force');
  await git.checkout({ ref: 'main' });
  await git.exec(['tag', 'v1']);
  await git.exec(['update-ref', 'refs/remotes/origin/remote', await git.resolve('HEAD')]);
  const commands = new Map();
  const messages = [], dialogs = [];
  let tree;
  let confirmed = 'Delete';
  let queuedConfirmations = [];
  let newName;
  const disposable = { dispose() {} };
  const mock = {
    EventEmitter: class { event = () => {}; fire() {} dispose() {} },
    TreeItem: class { constructor(label) { this.label = label; } },
    TreeItemCollapsibleState: { None: 0, Expanded: 2, Collapsed: 1 },
    ThemeIcon: class {},
    RelativePattern: class {},
    workspace: {
      workspaceFolders: [{ uri: { fsPath: cwd } }],
      registerTextDocumentContentProvider: () => disposable,
      createFileSystemWatcher: () => ({ ...disposable, onDidChange() {}, onDidCreate() {}, onDidDelete() {} })
    },
    extensions: { getExtension: () => undefined },
    commands: { registerCommand: (id, fn) => { commands.set(id, fn); return disposable; } },
    window: {
      registerFileDecorationProvider: () => disposable,
      createTreeView: (id, options) => { tree = options.treeDataProvider; return disposable; },
      showInformationMessage: message => messages.push(message),
      showErrorMessage: message => messages.push(message),
      showWarningMessage: async (message, options, ...actions) => {
        dialogs.push({ message, options, actions });
        return queuedConfirmations.length ? queuedConfirmations.shift() : confirmed;
      },
      showInputBox: async () => newName
    }
  };
  const originalLoad = Module._load;
  Module._load = function (request, ...args) { return request === 'vscode' ? mock : originalLoad.call(this, request, ...args); };
  try {
    await require('../src/extension').activate({ subscriptions: [] });
    const roots = await tree.getChildren();
    const locals = roots[0].children;
    const local = name => locals.find(node => node.ref === name);
    assert.equal(local('to-delete').contextValue, undefined);
    assert.equal(tree.getTreeItem(local('to-delete')).contextValue, 'gb-local');
    await commands.get('git-branch.delete')(local('to-delete'));
    await assert.rejects(git.resolve('refs/heads/to-delete'));
    assert.ok(!dialogs.some(dialog => dialog.actions.includes('Force Delete')));
    queuedConfirmations = ['Delete', undefined];
    await commands.get('git-branch.delete')(local('cancel-force'));
    assert.ok(await git.resolve('refs/heads/cancel-force'));
    assert.equal(dialogs.at(-1).actions[0], 'Force Delete');
    assert.equal(dialogs.at(-1).options.modal, true);
    queuedConfirmations = ['Delete', 'Force Delete'];
    await commands.get('git-branch.delete')(local('force-delete'));
    await assert.rejects(git.resolve('refs/heads/force-delete'));
    assert.equal(await git.current(), 'main');
    await commands.get('git-branch.delete')(local('main'));
    assert.equal(await git.current(), 'main');
    assert.ok(messages.some(message => message.includes('Cannot delete the current branch')));
    const remote = roots[1].children[0].children[0];
    const tag = roots[2].children[0];
    for (const node of [remote, tag, roots[0], undefined]) {
      await commands.get('git-branch.delete')(node);
      await commands.get('git-branch.rename')(node);
    }
    assert.ok(await git.resolve('refs/remotes/origin/remote'));
    assert.ok(await git.resolve('refs/tags/v1'));
    confirmed = undefined;
    await commands.get('git-branch.delete')(local('cancel-delete'));
    assert.ok(await git.resolve('refs/heads/cancel-delete'));
    confirmed = 'Rename'; newName = 'renamed';
    await commands.get('git-branch.rename')(local('to-rename'));
    assert.ok(await git.resolve('refs/heads/renamed'));
    await assert.rejects(git.resolve('refs/heads/to-rename'));
    newName = 'main-renamed';
    await commands.get('git-branch.rename')(local('main'));
    assert.equal(await git.current(), 'main-renamed');
    assert.ok(!messages.some(message => /failed:/i.test(message)), messages.join('\n'));
  } finally {
    Module._load = originalLoad;
  }
});
