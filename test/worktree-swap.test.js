'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { GitOperations } = require('../src/git-operations');

test('complete worktree swap: status, paths, existing tabs, groups, refresh, cancel, recovery and close', async t => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'gb-swap-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const git = new GitOperations(cwd);
  await git.exec(['init', '-b', 'main']);
  await git.exec(['config', 'user.name', 'Test']);
  await git.exec(['config', 'user.email', 'test@example.invalid']);
  for (const [name, text] of [['keep.txt', 'base'], ['deleted.txt', 'gone'], ['old.txt', 'rename']]) {
    await fs.writeFile(path.join(cwd, name), text);
  }
  await git.exec(['add', '.']); await git.exec(['commit', '-m', 'base']);
  await git.create('other');
  await fs.mkdir(path.join(cwd, 'sub'));
  await git.exec(['mv', 'old.txt', 'sub/new.txt']);
  await fs.unlink(path.join(cwd, 'deleted.txt'));
  await fs.writeFile(path.join(cwd, 'keep.txt'), 'disk changes');
  await fs.writeFile(path.join(cwd, 'added.txt'), 'untracked');
  const beforeIndex = await git.exec(['diff', '--cached']);
  const beforeStatus = await git.exec(['status', '--porcelain']);
  const groups = [{ viewColumn: 1, tabs: [] }, { viewColumn: 2, tabs: [] }];
  const commands = new Map(), messages = [], openings = [], closed = [];
  const disposable = { dispose() {} };
  let tree, snapshotProvider, cancelClose = false, partialCancel = false, failNextOpen = false, delayNext;
  const mock = {
    EventEmitter: class { event = () => {}; fire() {} dispose() {} },
    TreeItem: class { constructor(label) { this.label = label; } },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ThemeIcon: class { constructor(id) { this.id = id; } }, ThemeColor: class {},
    MarkdownString: class {
      value = '';
      appendText(text) { this.value += text; return this; }
      appendMarkdown(text) { this.value += text; return this; }
    },
    Uri: { file: fsPath => ({ scheme: 'file', fsPath }), from: value => value },
    RelativePattern: class {}, ViewColumn: { Active: -1 },
    TabInputTextDiff: class { constructor(original, modified) { this.original = original; this.modified = modified; } },
    env: { clipboard: { writeText: async () => {} } },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: cwd } }],
      textDocuments: [{ isDirty: true, uri: { scheme: 'file', fsPath: path.join(cwd, 'keep.txt') }, getText: () => 'unsaved editor' }],
      registerTextDocumentContentProvider: (scheme, provider) => { snapshotProvider = provider; return disposable; },
      createFileSystemWatcher: () => ({ ...disposable, onDidChange() {}, onDidCreate() {}, onDidDelete() {} })
    },
    extensions: { getExtension: () => ({ isActive: true, exports: { getAPI: () => ({ git: { path: 'git' } }) } }) },
    commands: {
      registerCommand: (id, fn) => { commands.set(id, fn); return disposable; },
      executeCommand: async (id, ...args) => {
        if (id !== 'vscode.diff') return;
        if (delayNext) { const delay = delayNext; delayNext = undefined; await delay; }
        if (failNextOpen) { failNextOpen = false; throw new Error('Simulated editor failure'); }
        const [original, modified, label, options] = args;
        const group = groups.find(g => g.viewColumn === options.viewColumn) || groups[0];
        const tab = { label, input: new mock.TabInputTextDiff(original, modified) };
        group.tabs.push(tab);
        openings.push({ tab, group, options });
      }
    },
    window: {
      tabGroups: { all: groups, close: async tabs => {
        if (cancelClose) return false;
        const targets = partialCancel ? tabs.slice(0, 1) : tabs;
        for (const group of groups) group.tabs = group.tabs.filter(tab => !targets.includes(tab));
        closed.push(...targets);
        return !partialCancel;
      } },
      createTreeView: (id, options) => { tree = options.treeDataProvider; return { ...disposable, reveal: async () => {} }; },
      registerFileDecorationProvider: () => disposable,
      showWarningMessage: async () => undefined,
      showInformationMessage: text => messages.push(text), showErrorMessage: text => messages.push(text)
    }
  };
  const load = Module._load;
  Module._load = function(request, ...args) { return request === 'vscode' ? mock : load.call(this, request, ...args); };
  const context = { subscriptions: [] };
  try {
    await require('../src/extension').activate(context);
    const run = (id, node) => commands.get(`git-branch.${id}`)(node);
    const node = { kind: 'branch', ref: 'main', label: 'main', remote: false };
    const other = { ...node, ref: 'other', label: 'other' };
    await run('worktree', node); await run('worktree', other);
    const active = () => tree.workingTreeFor(node);
    const originals = active().result.files;
    assert.deepEqual(new Set(originals.map(f => f.status[0])), new Set(['A', 'D', 'M', 'R']));
    let fileNodes = await tree.getChildren({ ...node, diffSession: true });
    for (const file of fileNodes) await run('openWorktreeDiff', file);
    const oldTabs = [...groups[0].tabs];
    const moved = groups[0].tabs.pop(); groups[1].tabs.push(moved);
    const unrelated = { label: 'unrelated', input: new mock.TabInputTextDiff({ scheme: 'file' }, { scheme: 'file' }) };
    groups[0].tabs.push(unrelated);
    const otherFile = (await tree.getChildren({ ...other, diffSession: true }))[0];
    await run('openWorktreeDiff', otherFile);
    const otherTab = groups[0].tabs.at(-1);
    const openCount = openings.length;
    await run('swapWorktree', node);
    assert.equal(active().result.reversed, true);
    assert.equal(tree.getTreeItem({ ...node, diffSession: true }).label, 'Working Tree ↔ main');
    assert.ok(tree.getTreeItem({ ...node, diffSession: true }).tooltip.value.startsWith('Left: Working Tree  \nRight: main'));
    assert.equal(tree.workingTreeFor(other).result.reversed, undefined);
    assert.ok(groups[0].tabs.includes(unrelated) && groups[0].tabs.includes(otherTab));
    for (const oldTab of oldTabs) {
      assert.ok(closed.includes(oldTab));
      const replacement = openings.slice(openCount).find(entry => entry.tab.input.original === oldTab.input.modified && entry.tab.input.modified === oldTab.input.original);
      assert.ok(replacement);
      assert.match(replacement.tab.label, /\(Working Tree ↔ main\)$/);
      assert.equal(replacement.group.viewColumn, oldTab === moved ? 2 : 1);
    }
    for (const [index, file] of active().result.files.entries()) {
      assert.equal(file.oldPath, originals[index].newPath);
      assert.equal(file.newPath, originals[index].oldPath);
      assert.equal(file.status, originals[index].status === 'A' ? 'D' : originals[index].status === 'D' ? 'A' : originals[index].status);
    }
    const staleCount = openings.length;
    await run('openWorktreeDiff', fileNodes[0]);
    assert.equal(openings.length, staleCount);
    fileNodes = await tree.getChildren({ ...node, diffSession: true });
    const renamed = fileNodes.find(file => file.file.status.startsWith('R'));
    assert.equal(tree.getTreeItem(renamed).label, 'old.txt');
    assert.equal(tree.getTreeItem(fileNodes.find(file => file.file.status === 'A')).resourceUri.query, 'A');
    assert.equal(tree.getTreeItem(fileNodes.find(file => file.file.status === 'D')).resourceUri.query, 'D');
    await run('diffTree', { ...node, diffSession: true });
    const reversedTree = await tree.getChildren({ ...node, diffSession: true });
    assert.ok(reversedTree.some(file => file.kind === 'worktree-file' && file.file.newPath === 'old.txt'));
    assert.ok(!reversedTree.some(file => file.kind === 'worktree-folder' && file.label === 'sub'));
    await run('diffList', { ...node, diffSession: true });
    await run('openWorktreeDiff', renamed);
    assert.equal(openings.at(-1).tab.input.original.fsPath, path.join(cwd, 'sub', 'new.txt'));
    assert.equal(JSON.parse(openings.at(-1).tab.input.modified.query).file, 'old.txt');
    assert.equal(await snapshotProvider.provideTextDocumentContent(openings.at(-1).tab.input.modified), 'rename');
    for (const file of fileNodes.filter(file => ['A', 'D'].includes(file.file.status))) {
      await run('openWorktreeDiff', file);
      const input = openings.at(-1).tab.input;
      if (file.file.status === 'D') {
        assert.equal(input.original.fsPath, path.join(cwd, 'added.txt'));
        assert.equal(JSON.parse(input.modified.query).file, null);
      } else {
        assert.equal(JSON.parse(input.original.query).file, null);
        assert.equal(JSON.parse(input.modified.query).file, 'deleted.txt');
      }
    }
    await run('refreshWorktree', node);
    assert.equal(active().result.reversed, true);
    await run('swapWorktree', node);
    assert.equal(active().result.reversed, false);
    assert.deepEqual(active().result.files, originals);
    assert.equal(tree.getTreeItem({ ...node, diffSession: true }).label, 'main ↔ Working Tree');
    await run('diffTree', { ...node, diffSession: true });
    const normalTree = await tree.getChildren({ ...node, diffSession: true });
    const folder = normalTree.find(file => file.kind === 'worktree-folder' && file.label === 'sub');
    assert.ok(folder);
    assert.equal(tree.getTreeItem((await tree.getChildren(folder))[0]).label, 'new.txt');
    await run('diffList', { ...node, diffSession: true });
    const countBeforeCancel = openings.length;
    cancelClose = true;
    await run('swapWorktree', node);
    cancelClose = false;
    assert.equal(active().result.reversed, false);
    assert.equal(openings.length, countBeforeCancel);
    partialCancel = true;
    await run('swapWorktree', node);
    partialCancel = false;
    assert.equal(active().result.reversed, false);
    assert.match(messages.at(-1), /Swap cancelled/);
    failNextOpen = true;
    await run('swapWorktree', node);
    assert.equal(active().result.reversed, false);
    assert.match(messages.at(-1), /Swap failed: Simulated editor failure/);
    // A swap waits for a tab already opening rather than leaving it behind in the old direction.
    let release;
    delayNext = new Promise(resolve => { release = resolve; });
    const opening = run('openWorktreeDiff', (await tree.getChildren({ ...node, diffSession: true }))[0]);
    await new Promise(resolve => setImmediate(resolve));
    const swapping = run('swapWorktree', node);
    release(); await opening; await swapping;
    assert.equal(active().result.reversed, true);
    tree.setWorkingTree(node, { ...active().result, reversed: false, files: [] });
    await run('swapWorktree', node);
    assert.equal(active().result.reversed, false);
    assert.equal(tree.getTreeItem({ ...node, diffSession: true }).description, 'Files · 0');
    assert.equal((await tree.getChildren({ ...node, diffSession: true }))[0].kind, 'worktree-empty');
    await run('swapWorktree', node);
    assert.equal(active().result.reversed, true);
    await run('closeWorktree', node);
    assert.equal(tree.workingTreeFor(node), undefined);
    assert.ok(groups[0].tabs.includes(otherTab));
    assert.ok(groups[0].tabs.includes(unrelated));
    assert.equal(groups[1].tabs.length, 0); // Reversed tabs carry the marker on either side.
    assert.equal(await git.exec(['diff', '--cached']), beforeIndex);
    assert.equal(await git.exec(['status', '--porcelain']), beforeStatus);
    assert.equal(await fs.readFile(path.join(cwd, 'keep.txt'), 'utf8'), 'disk changes');
    assert.equal(mock.workspace.textDocuments[0].getText(), 'unsaved editor');
  } finally {
    for (const subscription of context.subscriptions) subscription.dispose?.();
    Module._load = load;
    delete require.cache[require.resolve('../src/extension')];
  }
});
