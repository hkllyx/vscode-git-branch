'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { GitOperations } = require('../src/git-operations');

test('multi-select: F2, independent deletion, two-ref Diff and native Compare source groups', async t => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'gb-multi-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const git = new GitOperations(cwd);
  await git.exec(['init', '-b', 'main']);
  await git.exec(['config', 'user.name', 'Test']);
  await git.exec(['config', 'user.email', 'test@example.invalid']);
  await fs.writeFile(path.join(cwd, 'file.txt'), 'base');
  await git.exec(['add', '.']); await git.exec(['commit', '-m', 'base']);
  const base = await git.resolve('HEAD');
  await git.create('left'); await git.checkout({ ref: 'left' });
  await fs.writeFile(path.join(cwd, 'file.txt'), 'left');
  await fs.writeFile(path.join(cwd, 'only-left.txt'), 'left');
  await git.exec(['add', '.']); await git.exec(['commit', '-m', 'left-only']);
  const leftHash = await git.resolve('HEAD');
  await git.create('right', base); await git.checkout({ ref: 'right' });
  await fs.writeFile(path.join(cwd, 'file.txt'), 'right');
  await fs.writeFile(path.join(cwd, 'only-right.txt'), 'right');
  await git.exec(['add', '.']); await git.exec(['commit', '-m', 'right-only']);
  const rightHash = await git.resolve('HEAD');
  await git.checkout({ ref: 'main' });
  await git.exec(['update-ref', 'refs/remotes/origin/right', rightHash]);
  for (const name of ['delete-a', 'delete-b', 'rename-me']) await git.create(name);
  const commands = new Map(), contexts = new Map(), messages = [], tabs = [];
  let tree, onSelection, input = 'renamed';
  let answers = [];
  const disposable = { dispose() {} };
  const view = { ...disposable, selection: [], reveal: async () => {}, onDidChangeSelection: fn => { onSelection = fn; return disposable; } };
  const mock = {
    EventEmitter: class { event = () => {}; fire() {} dispose() {} },
    TreeItem: class { constructor(label) { this.label = label; } },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ThemeIcon: class { constructor(id, color) { this.id = id; this.color = color; } },
    ThemeColor: class { constructor(id) { this.id = id; } },
    MarkdownString: class { value = ''; appendText(s) { this.value += s; } appendMarkdown(s) { this.value += s; } },
    Uri: { file: fsPath => ({ scheme: 'file', fsPath }), from: x => x },
    RelativePattern: class {}, ViewColumn: { Active: -1 },
    TabInputTextDiff: class { constructor(original, modified) { this.original = original; this.modified = modified; } },
    workspace: { workspaceFolders: [{ uri: { fsPath: cwd } }], textDocuments: [],
      registerTextDocumentContentProvider: () => disposable,
      createFileSystemWatcher: () => ({ ...disposable, onDidChange() {}, onDidCreate() {}, onDidDelete() {} }) },
    extensions: { getExtension: () => undefined },
    commands: {
      registerCommand: (id, fn) => { commands.set(id, fn); return disposable; },
      executeCommand: async (id, ...args) => {
        if (id === 'setContext') { contexts.set(args[0], args[1]); return; }
        if (commands.has(id)) return commands.get(id)(...args);
        if (id === 'vscode.diff') tabs.push({ label: args[2], input: new mock.TabInputTextDiff(args[0], args[1]) });
      }
    },
    window: {
      createTreeView: (id, options) => { assert.equal(options.canSelectMany, true); tree = options.treeDataProvider; return view; },
      registerFileDecorationProvider: () => disposable,
      showInputBox: async () => input,
      showWarningMessage: async () => answers.shift(),
      showInformationMessage: text => { messages.push(text); }, showErrorMessage: text => { messages.push(text); },
      tabGroups: { all: [{ viewColumn: 1, tabs }], close: async targets => {
        for (const tab of targets) { const index = tabs.indexOf(tab); if (index >= 0) tabs.splice(index, 1); }
        return true;
      } }
    }
  };
  const originalLoad = Module._load;
  Module._load = function(request, ...args) { return request === 'vscode' ? mock : originalLoad.call(this, request, ...args); };
  const context = { subscriptions: [] };
  try {
    delete require.cache[require.resolve('../src/extension')];
    await require('../src/extension').activate(context);
    const run = (id, ...args) => commands.get(`git-branch.${id}`)(...args);
    const roots = await tree.getChildren();
    const local = name => roots[0].children.find(node => node.ref === name);
    const left = local('left'), right = local('right');
    view.selection = [local('rename-me')]; onSelection({ selection: view.selection });
    assert.equal(contexts.get('git-branch.singleLocal'), true);
    answers = ['Rename']; await run('rename');
    assert.equal(await git.resolve('refs/heads/renamed'), base);
    view.selection = [left, right]; onSelection({ selection: view.selection });
    assert.equal(contexts.get('git-branch.singleLocal'), false);
    assert.equal(contexts.get('git-branch.twoBranches'), true);
    input = 'should-not-rename'; await run('rename');
    await assert.rejects(git.resolve('refs/heads/should-not-rename'));
    const keybinding = require('../package.json').contributes.keybindings[0];
    assert.equal(keybinding.key, 'f2'); assert.match(keybinding.when, /listFocus/);
    await run('compareSelected', left, [left, right]);
    const group = (await tree.getChildren()).find(node => node.compareGroup);
    let session = (await tree.getChildren(group))[0];
    assert.equal(tree.getTreeItem(session).label, 'left ↔ right');
    let sides = await tree.getChildren(session);
    assert.deepEqual(sides.map(node => node.history.total), [1, 1]);
    assert.notEqual(tree.getTreeItem(sides[0]).iconPath.color.id, tree.getTreeItem(sides[1]).iconPath.color.id);
    let commits = await tree.getChildren(sides[0]);
    assert.equal(commits[0].commit.hash, leftHash);
    const files = await tree.getChildren(commits[0]);
    await run('openCompareDiff', files.find(node => node.file.newPath === 'file.txt'));
    const commitTab = tabs.at(-1);
    assert.equal(JSON.parse(commitTab.input.original.query).hash, base);
    assert.equal(JSON.parse(commitTab.input.modified.query).hash, leftHash);
    await run('swapCompare', session);
    session = (await tree.getChildren(group))[0];
    assert.equal(tree.getTreeItem(session).label, 'right ↔ left');
    sides = await tree.getChildren(session); commits = await tree.getChildren(sides[0]);
    assert.equal(commits[0].commit.hash, rightHash);
    assert.ok(tabs.includes(commitTab)); // Commit changes retain parent → commit direction.
    await run('refreshCompare', session);
    session = (await tree.getChildren(group))[0];
    assert.equal(tree.getTreeItem(session).label, 'right ↔ left');
    await run('closeCompare', session);
    assert.equal(tabs.length, 0);
    assert.ok(!(await tree.getChildren()).some(node => node.compareGroup));
    await run('diffSelected', left, [left, right]);
    const diffRoot = (await tree.getChildren()).find(node => node.diffGroup);
    const diffSession = (await tree.getChildren(diffRoot))[0];
    assert.equal(tree.getTreeItem(diffSession).label, 'left ↔ right');
    let diffFiles = await tree.getChildren(diffSession);
    const added = diffFiles.find(node => node.file.newPath === 'only-right.txt');
    assert.equal(added.file.status, 'A');
    await run('openWorktreeDiff', added);
    assert.equal(JSON.parse(tabs[0].input.modified.query).hash, rightHash);
    const previous = tabs[0].input;
    await run('swapWorktree', diffSession);
    assert.equal(tree.getTreeItem(diffSession).label, 'right ↔ left');
    assert.equal(tabs[0].input.original, previous.modified);
    assert.equal(tabs[0].input.modified, previous.original);
    diffFiles = await tree.getChildren(diffSession);
    assert.equal(diffFiles.find(node => node.file.oldPath === 'only-right.txt').file.status, 'D');
    await run('refreshWorktree', diffSession);
    assert.equal(tree.workingTreeFor(diffSession).result.left, rightHash);
    assert.equal(tree.getTreeItem(diffSession).label, 'right ↔ left');
    await run('closeWorktree', diffSession);
    assert.equal(tabs.length, 0);
    const remote = roots[1].children[0].children[0];
    await run('worktree', left, [left, remote]);
    assert.equal(tree.workingTrees.size, 1);
    await run('worktree', left); // WT session for same branch must coexist with two-ref session.
    assert.equal(tree.workingTrees.size, 2);
    await run('compare', local('main'), [local('main'), left]); // Current is allowed in a pair.
    assert.equal(tree.comparisons.size, 1);
    await run('compare', left, [left, roots[0]]);
    assert.equal(tree.comparisons.size, 1);
    const missing = { ...left, ref: 'missing', label: 'missing' };
    answers = ['Delete', undefined];
    await run('delete', left, [left, missing, local('delete-a'), local('main'), local('delete-b')]);
    assert.equal(await git.resolve('refs/heads/left'), leftHash); // Force prompt cancelled, later deletes continue.
    await assert.rejects(git.resolve('refs/heads/delete-a'));
    await assert.rejects(git.resolve('refs/heads/delete-b'));
    assert.equal(await git.current(), 'main');
    assert.ok(messages.includes('Delete: 2 succeeded, 1 failed, 2 skipped.'));
    answers = ['Delete', 'Force Delete']; await run('delete', left);
    await assert.rejects(git.resolve('refs/heads/left'));
    assert.equal(await git.resolve('refs/remotes/origin/right'), rightHash);
    assert.equal(await git.exec(['status', '--porcelain']), '');
  } finally {
    for (const subscription of context.subscriptions) subscription.dispose();
    Module._load = originalLoad;
  }
});
