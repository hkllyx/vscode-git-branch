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
  await fs.mkdir(path.join(cwd, 'src', 'nested'), { recursive: true });
  await fs.writeFile(path.join(cwd, 'src', 'nested', 'left.txt'), 'nested left');
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
  const savedState = new Map();
  const context = { subscriptions: [], workspaceState: {
    get: key => savedState.get(key), update: async (key, value) => savedState.set(key, value)
  } };
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
    assert.match(keybinding.when, /focusedView == git-branch\.branches/);
    assert.match(keybinding.when, /!inputFocus/);
    assert.equal(contexts.get('git-branch.multiSelection'), true);
    const menus = require('../package.json').contributes.menus['view/item/context'];
    for (const id of ['checkout', 'create', 'createAndCheckout', 'merge', 'rebase', 'setTracking', 'rename', 'compare', 'worktree']) {
      assert.ok(menus.find(menu => menu.command === `git-branch.${id}`).when.includes('!git-branch.multiSelection'), id);
    }
    assert.ok(!menus.find(menu => menu.command === 'git-branch.update').when.includes('!git-branch.multiSelection'));
    const savedUpdate = tree.git.update;
    const updatedNames = [];
    tree.git.update = async node => { updatedNames.push(node.ref); if (node.ref === 'left') throw new Error('Update failed for this branch'); return 'Fetched'; };
    await run('update', left, [left, right]);
    assert.deepEqual(updatedNames, ['left', 'right']);
    assert.ok(messages.includes('Update: 1 succeeded, 1 failed.'));
    await run('update', right);
    assert.ok(messages.includes('Update: 1 succeeded, 0 failed.'));
    tree.git.update = savedUpdate;
    await run('compareSelected', left, [left, right]);
    const group = (await tree.getChildren()).find(node => node.comparisonsGroup);
    let session = (await tree.getChildren(group))[0];
    assert.equal(tree.getTreeItem(session).label, 'left ↔ right');
    assert.equal(tree.getTreeItem(session).iconPath.id, 'git-compare');
    assert.equal(tree.getTreeItem(group).iconPath.id, 'layers');
    let sides = await tree.getChildren(session);
    assert.ok(sides.every(side => tree.getTreeItem(side).iconPath.id === 'git-branch'));
    assert.deepEqual(sides.map(node => node.history.total), [1, 1]);
    assert.deepEqual(sides.map(node => tree.getTreeItem(node).label), ['Left only', 'Right only']);
    assert.deepEqual(sides.map(node => tree.getTreeItem(node).description), ['1 commits', '1 commits']);
    assert.match(tree.getTreeItem(sides[0]).tooltip, /left/);
    assert.equal(tree.getTreeItem(session).description, '2 commits');
    assert.equal(tree.getTreeItem({ ...session, entry: { ...session.entry, result: { ...session.entry.result,
      selected: { total: 7 }, current: { total: 8 } } } }).description, '15 commits');
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
    assert.ok(!(await tree.getChildren()).some(node => node.comparisonsGroup));
    // Zero-commit sides are hidden without changing left/right identities.
    await run('compareSelected', left, [left, local('main')]);
    let oneSided = (await tree.getChildren(group))[0];
    assert.equal(tree.getTreeItem(oneSided).description, '1 commit');
    let visibleSides = await tree.getChildren(oneSided);
    assert.equal(visibleSides.length, 1);
    assert.equal(tree.getTreeItem(visibleSides[0]).label, 'Left only');
    await run('swapCompare', oneSided);
    oneSided = (await tree.getChildren(group))[0];
    visibleSides = await tree.getChildren(oneSided);
    assert.equal(visibleSides.length, 1);
    assert.equal(tree.getTreeItem(visibleSides[0]).label, 'Right only');
    await run('refreshCompare', oneSided);
    oneSided = (await tree.getChildren(group))[0];
    assert.equal((await tree.getChildren(oneSided)).length, 1);
    await run('closeCompare', oneSided);
    // Distinct local/remote refs with equal tips show one non-expandable empty row.
    const sameTipRemote = roots[1].children[0].children.find(node => node.ref === 'origin/right');
    await run('compareSelected', right, [right, sameTipRemote]);
    const equalSession = (await tree.getChildren(group))[0];
    assert.equal(tree.getTreeItem(equalSession).description, 'Commits');
    let emptyRows = await tree.getChildren(equalSession);
    assert.equal(emptyRows.length, 1);
    assert.equal(emptyRows[0].kind, 'compare-empty');
    assert.equal(tree.getTreeItem(emptyRows[0]).label, 'No differences');
    assert.equal(await tree.getParent(emptyRows[0]), equalSession);
    assert.deepEqual(await tree.getChildren(emptyRows[0]), []);
    await run('swapCompare', equalSession);
    await run('refreshCompare', equalSession);
    emptyRows = await tree.getChildren((await tree.getChildren(group))[0]);
    assert.equal(emptyRows.length, 1);
    assert.equal(tree.getTreeItem(emptyRows[0]).label, 'No differences');
    await run('closeCompare', equalSession);
    await run('diffSelected', left, [left, right]);
    const diffRoot = (await tree.getChildren()).find(node => node.comparisonsGroup);
    const diffSession = (await tree.getChildren(diffRoot))[0];
    assert.equal(tree.getTreeItem(diffSession).label, 'left ↔ right');
    assert.equal(path.basename(tree.getTreeItem(diffSession).iconPath.dark.fsPath), 'branch-diff.svg');
    assert.equal(path.basename(tree.getTreeItem(diffSession).iconPath.light.fsPath), 'branch-diff-light.svg');
    assert.equal(tree.getTreeItem(diffRoot).iconPath.id, 'layers');
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
    const combined = (await tree.getChildren()).filter(node => node.comparisonsGroup);
    assert.equal(combined.length, 1);
    const entries = await tree.getChildren(combined[0]);
    assert.equal(entries.length, 3);
    const historySession = entries.find(node => node.kind === 'compare-session');
    const fileSessions = entries.filter(node => node.diffSession);
    await run('diffTree', historySession);
    await run('diffSortStatus', historySession);
    await run('diffTree', fileSessions[0]);
    assert.deepEqual(historySession.entry.settings, { layout: 'tree', sort: 'status' });
    assert.deepEqual(savedState.get('git-branch.comparisonSettings')[historySession.key], { layout: 'tree', sort: 'status' });
    assert.deepEqual(tree.workingTreeFor(fileSessions[0]).settings, { layout: 'tree', sort: 'path' });
    assert.deepEqual(tree.workingTreeFor(fileSessions[1]).settings, { layout: 'list', sort: 'path' });
    const historySides = await tree.getChildren(historySession);
    const historyCommits = await tree.getChildren(historySides.find(side => side.history.total > 0));
    const historyFiles = await tree.getChildren(historyCommits[0]);
    assert.ok(historyFiles.length);
    assert.ok(historyFiles.every(node => node.kind === 'compare-file' || node.kind === 'compare-folder'));
    const directory = historyFiles.find(node => node.kind === 'compare-folder');
    assert.equal(tree.getTreeItem(directory).label, 'src');
    const nestedDirectory = (await tree.getChildren(directory))[0];
    const nestedFile = (await tree.getChildren(nestedDirectory))[0];
    assert.equal(tree.getTreeItem(nestedFile).description, '');
    assert.equal(await tree.getParent(nestedFile), nestedDirectory);
    await run('openCompareDiff', nestedFile);
    assert.equal(JSON.parse(tabs.at(-1).input.modified.query).hash, leftHash);
    await run('swapCompare', historySession);
    assert.deepEqual(await tree.getChildren(directory), []);
    const countAfterSwap = tabs.length;
    await run('openCompareDiff', nestedFile);
    assert.equal(tabs.length, countAfterSwap); // Stale directory descendants cannot reopen tabs.
    await run('refreshCompare', historySession);
    const refreshed = tree.comparisons.get(historySession.key);
    assert.deepEqual(refreshed.settings, { layout: 'tree', sort: 'status' });
    await run('closeCompare', historySession);
    assert.ok((await tree.getChildren()).some(node => node.comparisonsGroup));
    await run('compare', local('main'), [local('main'), left]);
    assert.deepEqual(tree.comparisons.get(historySession.key).settings, { layout: 'tree', sort: 'status' });
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
