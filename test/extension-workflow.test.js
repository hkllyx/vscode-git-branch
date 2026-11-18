'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { GitOperations } = require('../src/git-operations');

test('all editor commands: selected refs, cached Compare tabs, active-tab diff and lifecycle', async t => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'git-branch-workflow-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const git = new GitOperations(cwd);
  await git.exec(['init', '-b', 'main']);
  await git.exec(['config', 'user.email', 'test@example.invalid']);
  await git.exec(['config', 'user.name', 'Test']);
  await fs.writeFile(path.join(cwd, 'file.txt'), 'base\n');
  await git.exec(['add', '.']); await git.exec(['commit', '-m', 'base']);
  const base = await git.resolve('HEAD');
  await git.create('feature/test'); await git.checkout({ ref: 'feature/test' });
  await fs.writeFile(path.join(cwd, 'file.txt'), 'feature\n');
  await fs.writeFile(path.join(cwd, '中文 added.txt'), 'added\n');
  await git.exec(['add', '.']); await git.exec(['commit', '-m', 'feature']);
  const feature = await git.resolve('HEAD');
  await git.checkout({ ref: 'main' });
  // Branch and tag share a name but point at different commits.
  await git.exec(['tag', 'feature/test', base]);
  await git.exec(['remote', 'add', 'origin', cwd]);
  await git.exec(['update-ref', 'refs/remotes/origin/remote/test', feature]);
  await git.exec(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/remote/test']);
  await git.exec(['config', 'branch.main.remote', 'origin']);
  await git.exec(['config', 'branch.main.merge', 'refs/heads/main']);
  await git.exec(['pack-refs', '--all']);
  const commands = new Map(), providers = new Map(), contextKeys = new Map();
  const messages = [], panels = [], diffs = [], patterns = [], inputOptions = [];
  const tabGroups = [{ tabs: [] }, { tabs: [] }], closedTabs = [];
  let tree, diffTree, decorations, panelFocuses = 0, refreshes = 0, input, answer, choose = false;
  const disposable = { dispose() {} };
  const mock = {
    EventEmitter: class { event = () => {}; fire() { refreshes++; } dispose() {} },
    TreeItem: class { constructor(label) { this.label = label; } },
    TreeItemCollapsibleState: { None: 0, Expanded: 2, Collapsed: 1 }, ThemeIcon: class { constructor(id) { this.id = id; } },
    ThemeColor: class { constructor(id) { this.id = id; } },
    Uri: { from: value => ({ query: '', ...value }), file: fsPath => ({ scheme: 'file', fsPath }) },
    ViewColumn: { Active: -1, Beside: -2 },
    TabInputTextDiff: class { constructor(original, modified) { this.original = original; this.modified = modified; } },
    RelativePattern: class { constructor(base, pattern) { patterns.push({ base, pattern }); } },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: cwd } }],
      registerTextDocumentContentProvider: (scheme, provider) => { providers.set(scheme, provider); return disposable; },
      createFileSystemWatcher: () => ({ ...disposable, onDidChange() {}, onDidCreate() {}, onDidDelete() {} })
    },
    extensions: { getExtension: () => ({ isActive: true, exports: { getAPI: () => ({ git: { path: 'git' } }) } }) },
    commands: {
      registerCommand: (id, fn) => { commands.set(id, fn); return disposable; },
      executeCommand: async (...args) => {
        if (args[0] === 'git-branch.branches.focus') { panelFocuses++; return; }
        if (args[0] === 'setContext') { contextKeys.set(args[1], args[2]); return; }
        if (commands.has(args[0])) return commands.get(args[0])(...args.slice(1));
        assert.equal(args[0], 'vscode.diff');
        assert.equal(args[4].preview, false); // Pin each file diff; do not replace preview tabs.
        assert.equal(args[4].viewColumn, -1); // Same editor group, not a new split group.
        diffs.push(args);
        tabGroups[0].tabs.push({ input: new mock.TabInputTextDiff(args[1], args[2]) });
      }
    },
    window: {
      tabGroups: { all: tabGroups, close: async (tabs, preserveFocus) => {
        assert.equal(preserveFocus, true);
        closedTabs.push(...tabs);
        for (const group of tabGroups) group.tabs = group.tabs.filter(tab => !tabs.includes(tab));
        return true;
      } },
      registerFileDecorationProvider: provider => { decorations = provider; return disposable; },
      createTreeView: (id, options) => {
        assert.equal(id, 'git-branch.branches');
        tree = options.treeDataProvider;
        return { ...disposable, reveal: async (node, options) => {
          assert.equal(node.diffSession, true);
          assert.equal(node.kind, 'branch'); assert.equal(options.expand, true);
        } };
      },
      showInformationMessage: message => messages.push(message), showErrorMessage: message => messages.push(message),
      showInputBox: async options => { inputOptions.push(options); return input; }, showWarningMessage: async () => answer,
      createWebviewPanel: (type, title, column, options) => {
        assert.equal(column, -1); assert.equal(options.enableScripts, true);
        assert.deepEqual(options.localResourceRoots, []);
        let receive, activate, close, closed = false;
        const panel = {
          title, sent: [],
          webview: {
            html: '', onDidReceiveMessage: fn => { receive = fn; return disposable; },
            postMessage: async message => { panel.sent.push(message); }
          },
          onDidChangeViewState: fn => { activate = fn; return disposable; },
          onDidDispose: fn => { close = fn; return disposable; },
          message: message => receive(message),
          activate: () => activate({ webviewPanel: { active: true } }),
          dispose: () => { if (!closed) { closed = true; close(); } }
        };
        panels.push(panel); return panel;
      },
      showQuickPick: async items => choose ? items[0] : undefined
    }
  };
  const originalLoad = Module._load;
  Module._load = function (request, ...args) { return request === 'vscode' ? mock : originalLoad.call(this, request, ...args); };
  const context = { subscriptions: [] };
  try {
    await require('../src/extension').activate(context);
    for (const { command } of require('../package.json').contributes.commands) assert.ok(commands.has(command));
    assert.ok(patterns.some(p => p.pattern.includes('packed-refs')));
    let roots = await tree.getChildren();
    assert.deepEqual(roots.map(r => r.label), ['Local', 'Remote', 'Tags']); // Diff hidden until a comparison opens.
    assert.equal(roots[1].children[0].children.length, 1); // Hide symbolic origin/HEAD.
    const main = roots[0].children.find(n => n.ref === 'main');
    let selected = roots[0].children.find(n => n.ref === 'feature/test');
    assert.equal(tree.getTreeItem(main).contextValue, 'gb-current');
    assert.equal(tree.getTreeItem(selected).contextValue, 'gb-local');
    let remote = roots[1].children[0].children[0];
    const tag = roots[2].children[0];
    assert.equal(tag.ref, 'feature/test');
    for (const node of [main, selected, remote, tag]) {
      const item = tree.getTreeItem(node);
      assert.equal(item.label, node.label);
      assert.equal(item.description, undefined); // Branch/tag names have no trailing hash.
      assert.ok(item.tooltip.includes(`${node.kind === 'tag' ? 'Tag' : 'Branch'} name: ${node.ref}`));
      assert.ok(item.tooltip.includes(`Hash: ${node.hash}`));
      assert.ok(item.tooltip.includes(`Last commit: ${node.commitDate.replace('T', ' ')}`));
    }
    assert.equal(main.commitDate, (await git.exec(['show', '-s', '--format=%cI', base])).trim());
    assert.equal(remote.commitDate, (await git.exec(['show', '-s', '--format=%cI', feature])).trim());
    assert.equal(main.upstream, 'refs/remotes/origin/main');
    assert.match(tree.getTreeItem(main).tooltip, /Tracking branch: origin\/main/);
    assert.match(tree.getTreeItem(selected).tooltip, /Tracking branch: Not configured/);
    assert.match(tree.getTreeItem(remote).tooltip, /Tracking branch: Not applicable \(remote branch\)/);
    assert.match(tree.getTreeItem(tag).tooltip, /Tracking branch: Not applicable \(tag\)/);
    await assert.rejects(git.create('feature/test'), /already exists/);
    const run = (id, node) => commands.get(`git-branch.${id}`)(node);
    input = 'from-selected'; await run('create', selected);
    assert.equal(await git.resolve('refs/heads/from-selected'), feature);
    input = 'from-remote'; await run('create', remote);
    assert.equal(await git.resolve('refs/heads/from-remote'), feature);
    input = 'from-tag'; await run('create', tag);
    assert.equal(await git.resolve('refs/heads/from-tag'), base);
    input = 'from-head'; await run('create');
    assert.equal(await git.resolve('refs/heads/from-head'), base);
    assert.equal(inputOptions.at(-1).title, 'Create Branch (from main)');
    input = 'from-group'; await run('create', roots[0]);
    assert.equal(await git.resolve('refs/heads/from-group'), base);
    assert.equal(inputOptions.at(-1).title, 'Create Branch (from main)');
    input = 'from-remote-group'; await run('create', roots[1].children[0]);
    assert.equal(await git.resolve('refs/heads/from-remote-group'), base);
    assert.equal(inputOptions.at(-1).prompt, 'New branch name (based on main)');
    assert.equal(await git.current(), 'main');
    input = undefined; await run('create', selected); // Input cancellation.
    await run('createAndCheckout', selected);
    assert.equal(await git.current(), 'main');
    for (const [suffix, node, hash] of [
      ['selected', selected, feature], ['remote', remote, feature], ['tag', tag, base],
      ['head', undefined, base], ['group', roots[0], base]
    ]) {
      input = `checkout-${suffix}`;
      await run('createAndCheckout', node);
      assert.equal(await git.current(), input);
      assert.equal(await git.resolve('HEAD'), hash);
      await run('checkout', main);
    }
    // A rejected checkout must preserve the created branch and report the partial success.
    await fs.writeFile(path.join(cwd, 'file.txt'), 'uncommitted\n');
    input = 'checkout-blocked'; await run('createAndCheckout', selected);
    assert.equal(await git.current(), 'main');
    assert.equal(await git.resolve('refs/heads/checkout-blocked'), feature);
    assert.match(messages.pop(), /was created, but checkout failed:/);
    await git.exec(['restore', '--', 'file.txt']);
    // Duplicate creation must not switch to an existing branch.
    input = 'feature/test'; await run('createAndCheckout', selected);
    assert.equal(await git.current(), 'main');
    assert.match(messages.pop(), /Create branch failed:/);
    await run('checkout', selected); assert.equal(await git.current(), 'feature/test');
    await run('checkout', main); assert.equal(await git.current(), 'main');
    await run('checkout', remote); assert.equal(await git.current(), 'remote/test');
    await run('checkout', main); await run('checkout', remote); // Existing tracking branch.
    assert.equal(await git.current(), 'remote/test'); await run('checkout', main);
    await run('compare', selected);
    const first = panels[0];
    assert.ok(first.webview.html.includes(feature)); assert.ok(first.webview.html.includes(base));
    assert.ok(first.webview.html.includes('中文 added.txt'));
    await first.message({ type: 'commit', side: 'selected', hash: feature });
    const detail = first.sent.at(-1).detail;
    assert.equal(detail.hash, feature); assert.equal(detail.left, base);
    assert.equal(detail.files.length, 2);
    await first.message({ type: 'diff', scope: 'commit', hash: feature, index: 0 });
    assert.equal(JSON.parse(diffs.pop()[1].query).hash, base);
    const sentCount = first.sent.length;
    await first.message({ type: 'commit', side: 'selected', hash: base }); // Not in unique history.
    await first.message({ type: 'diff', scope: 'commit', hash: base, index: 0 });
    await first.message({ type: 'diff', scope: 'branch', index: -1 });
    assert.equal(first.sent.length, sentCount); assert.equal(diffs.length, 0);
    await fs.writeFile(path.join(cwd, 'new-main.txt'), 'new main\n');
    await git.exec(['add', '.']); await git.exec(['commit', '-m', 'main changes']);
    const changedMain = await git.resolve('HEAD');
    await run('compare', selected);
    const second = panels[1];
    assert.ok(second.webview.html.includes(changedMain)); assert.ok(!first.webview.html.includes(changedMain));
    first.activate();
    await run('openDiff'); assert.equal(diffs.length, 0); // Picker cancellation.
    choose = true; await run('openDiff');
    assert.equal(diffs[0][0], 'vscode.diff');
    assert.equal(JSON.parse(diffs[0][1].query).hash, feature);
    assert.equal(JSON.parse(diffs[0][2].query).hash, base); // Active panel, not last created comparison.
    assert.equal(diffs[0][4].viewColumn, -1);
    assert.equal(diffs[0][4].preview, false);
    const rightContent = await providers.get('git-branch-snapshot').provideTextDocumentContent(diffs[0][2]);
    assert.equal(rightContent, 'base\n');
    first.dispose();
    const beforeClose = diffs.length;
    await first.message({ type: 'diff', scope: 'branch', index: 0 });
    assert.equal(diffs.length, beforeClose);
    answer = undefined;
    await run('merge', selected); await run('rebase', selected);
    assert.equal(await git.resolve('HEAD'), changedMain);
    answer = 'Merge'; await run('merge', selected);
    await git.exec(['merge-base', '--is-ancestor', feature, 'HEAD']);
    // Rebase target differs from the same-name tag: use fully qualified local branch.
    await git.create('rebase-source', base); await git.checkout({ ref: 'rebase-source' });
    await fs.writeFile(path.join(cwd, 'rebase-only.txt'), 'rebase\n');
    await git.exec(['add', '.']); await git.exec(['commit', '-m', 'rebase source']);
    const rebaseHead = await git.resolve('HEAD'); await git.checkout({ ref: 'main' });
    await git.exec(['tag', 'rebase-source', base]);
    roots = await tree.getChildren();
    answer = 'Rebase'; await run('rebase', roots[0].children.find(n => n.ref === 'rebase-source'));
    await git.exec(['merge-base', '--is-ancestor', rebaseHead, 'HEAD']);
    roots = await tree.getChildren();
    const panelCount = panels.length;
    await run('compare', roots[0].children.find(n => n.current));
    await run('compare', { ...main, current: false }); // Stale node still cannot compare current branch.
    assert.equal(panels.length, panelCount);
    assert.match(messages.at(-1), /Select a different branch/);
    mock.workspace.textDocuments = [{ isDirty: true, uri: { scheme: 'file', fsPath: path.join(cwd, 'new-main.txt') },
      getText: () => 'unsaved editor changes\n' }];
    let worktreeBranch = roots[0].children.find(n => n.current);
    await run('worktree', worktreeBranch);
    assert.equal(panels.length, panelCount);
    assert.ok(panelFocuses > 0);
    assert.deepEqual(await tree.getChildren(worktreeBranch), []);
    assert.equal(tree.getTreeItem(worktreeBranch).description, undefined);
    const scmTree = tree;
    const diffGroup = (await tree.getChildren()).find(n => n.diffGroup);
    assert.equal(diffGroup.label, 'Diff');
    assert.equal(tree.getTreeItem(diffGroup).contextValue, 'gb-diff-group');
    diffTree = { getChildren: () => scmTree.getChildren(diffGroup) };
    worktreeBranch = (await diffTree.getChildren())[0];
    assert.equal(await tree.getParent(worktreeBranch), diffGroup);
    let children = await tree.getChildren(worktreeBranch);
    assert.equal(tree.getTreeItem(worktreeBranch).contextValue, 'gb-diff-session');
    assert.equal(tree.getTreeItem(worktreeBranch).label, `${worktreeBranch.label} ↔ Working Tree`);
    assert.equal(tree.getTreeItem(worktreeBranch).iconPath.id, 'git-compare');
    assert.equal(tree.getTreeItem(worktreeBranch).description, '1 file');
    assert.match(tree.getTreeItem(worktreeBranch).tooltip, /Working Tree Diff: 1 changed file/);
    assert.ok(!children.some(n => n.kind === 'worktree-action'));
    const menus = require('../package.json').contributes.menus['view/item/context'];
    for (const id of ['refreshWorktree', 'closeWorktree']) {
      const menu = menus.find(m => m.command === `git-branch.${id}`);
      assert.match(menu.group, /^inline@/);
      assert.match(menu.when, /view == git-branch.branches/);
      assert.ok(menu.when.includes('viewItem == gb-diff-session'));
    }
    // Comparison sessions must not match any branch action menu.
    for (const menu of menus.filter(m => m.command && m.when.includes(' =~ /'))) {
      const pattern = new RegExp(menu.when.split(' =~ /')[1].slice(0, -1));
      assert.ok(!pattern.test('gb-diff-session'));
    }
    const fileNode = children.find(n => n.kind === 'worktree-file');
    const fileItem = tree.getTreeItem(fileNode);
    assert.equal(fileItem.label, 'new-main.txt');
    assert.equal(fileItem.contextValue, 'gb-worktree-file');
    assert.equal(fileItem.command.command, 'git-branch.openWorktreeDiff');
    assert.equal(fileItem.description, ''); // Status is a right-aligned badge, not path text.
    assert.equal(fileItem.resourceUri.scheme, 'git-branch-worktree-file');
    const decoration = decorations.provideFileDecoration(fileItem.resourceUri);
    assert.equal(decoration.badge, 'M');
    assert.equal(decoration.color.id, 'gitDecoration.modifiedResourceForeground');
    for (const [status, color] of [['A', 'added'], ['D', 'deleted'], ['R100', 'renamed']]) {
      const item = tree.getTreeItem({ ...fileNode, file: { ...fileNode.file, status, newPath: 'long/path/file.txt' } });
      assert.equal(item.description, 'long/path');
      const badge = decorations.provideFileDecoration(item.resourceUri);
      assert.equal(badge.badge, status[0]);
      assert.equal(badge.color.id, `gitDecoration.${color}ResourceForeground`);
      assert.equal(badge.propagate, false);
    }
    assert.equal(decorations.provideFileDecoration({ scheme: 'file', query: 'M' }), undefined);
    assert.equal(decorations.provideFileDecoration({ scheme: 'git-branch-worktree-file', query: '__proto__' }), undefined);
    assert.equal(await tree.getParent(fileNode), worktreeBranch);
    await run('openWorktreeDiff', fileNode);
    assert.equal(diffs.at(-1)[2].scheme, 'file');
    assert.equal(diffs.at(-1)[2].fsPath, path.join(cwd, 'new-main.txt'));
    assert.equal(JSON.parse(diffs.at(-1)[1].query).hash, await git.resolve('HEAD'));
    const sessionTab = tabGroups[0].tabs.at(-1);
    // Multiple lists and requests coexist, including local/remote branches with equal tips.
    await Promise.all([run('worktree', selected), run('worktree', remote)]);
    assert.equal((await diffTree.getChildren()).length, 3);
    assert.deepEqual(await scmTree.getChildren(selected), []);
    const sessions = await diffTree.getChildren();
    selected = sessions.find(n => n.ref === selected.ref && !n.remote);
    remote = sessions.find(n => n.ref === remote.ref && n.remote);
    assert.equal(tree.getTreeItem(remote).label, `${remote.ref} ↔ Working Tree`);
    for (const branch of [worktreeBranch, selected, remote]) {
      assert.equal(tree.getTreeItem(branch).contextValue, 'gb-diff-session');
      assert.equal(tree.getTreeItem(branch).iconPath.id, 'git-compare');
      assert.match(tree.getTreeItem(branch).label, / ↔ Working Tree$/);
      assert.match(tree.getTreeItem(branch).description, /^\d+ files?$/);
    }
    const selectedFile = (await tree.getChildren(selected)).find(n => n.kind === 'worktree-file');
    const remoteFile = (await tree.getChildren(remote)).find(n => n.kind === 'worktree-file');
    assert.ok(selectedFile && remoteFile);
    assert.equal(await tree.getParent(selectedFile), selected);
    assert.equal(await tree.getParent(remoteFile), remote);
    assert.notEqual(tree.getTreeItem(selectedFile).id, tree.getTreeItem(remoteFile).id);
    await run('openWorktreeDiff', selectedFile);
    const selectedTab = tabGroups[0].tabs.at(-1);
    await run('openWorktreeDiff', remoteFile);
    const remoteTab = tabGroups[0].tabs.at(-1);
    assert.notEqual(JSON.parse(selectedTab.input.original.query).worktreeSession,
      JSON.parse(remoteTab.input.original.query).worktreeSession);
    assert.equal(closedTabs.length, 0);
    await run('openWorktreeDiff', fileNode); // Original branch still clickable after other lists open.
    assert.equal(JSON.parse(diffs.at(-1)[1].query).hash, await git.resolve('HEAD'));
    mock.workspace.textDocuments = [];
    await run('refreshWorktree', worktreeBranch);
    children = await tree.getChildren(worktreeBranch);
    assert.equal(children.filter(n => n.kind === 'worktree-file').length, 0);
    assert.ok(children.some(n => n.kind === 'worktree-empty'));
    const oldDiffCount = diffs.length;
    await run('openWorktreeDiff', fileNode); // Reject stale snapshot/file after refresh.
    assert.equal(diffs.length, oldDiffCount);
    // A moved/duplicated diff in another editor group must also close.
    const secondGroupTab = { input: sessionTab.input };
    tabGroups[1].tabs.push(secondGroupTab);
    const normalTab = { input: { uri: mock.Uri.file(path.join(cwd, 'new-main.txt')) } };
    tabGroups[1].tabs.push(normalTab);
    const unrelatedDiff = tabGroups[0].tabs[0]; // Compare with Current tab.
    await run('closeWorktree', worktreeBranch);
    assert.ok(closedTabs.includes(sessionTab));
    assert.ok(closedTabs.includes(secondGroupTab));
    assert.ok(!closedTabs.includes(normalTab));
    assert.ok(!closedTabs.includes(unrelatedDiff));
    assert.ok(tabGroups[1].tabs.includes(normalTab));
    assert.deepEqual(await tree.getChildren(worktreeBranch), []);
    assert.ok(!closedTabs.includes(selectedTab));
    assert.ok(!closedTabs.includes(remoteTab));
    assert.ok((await tree.getChildren(remote)).some(n => n.file === remoteFile.file));
    await run('closeWorktree', remote);
    assert.ok(closedTabs.includes(remoteTab));
    assert.ok(!closedTabs.includes(selectedTab));
    await run('openWorktreeDiff', selectedFile);
    assert.equal(JSON.parse(diffs.at(-1)[1].query).hash, feature);
    await run('closeWorktree', selected);
    assert.ok(closedTabs.includes(selectedTab));
    const synthetic = { ref: selected.ref, files: [
      { status: 'M', newPath: 'src/z.ts' }, { status: 'A', newPath: 'src/a.ts' },
      { status: 'D', oldPath: 'lib/b.ts' }, { status: 'M', newPath: 'root.ts' }
    ] };
    tree.setWorkingTree(selected, synthetic);
    await run('diffSortName');
    assert.deepEqual((await tree.getChildren(selected)).map(n => n.file.newPath || n.file.oldPath), ['src/a.ts', 'lib/b.ts', 'root.ts', 'src/z.ts']);
    await run('diffSortStatus');
    assert.deepEqual((await tree.getChildren(selected)).map(n => n.file.status), ['A', 'D', 'M', 'M']);
    await run('diffSortPath');
    assert.equal((await tree.getChildren(selected))[0].file.oldPath, 'lib/b.ts');
    // The ⋯ dropdown is a native anchored submenu; its commands only set state + when-clause context keys.
    await run('diffTree');
    assert.equal(tree.diffLayout, 'tree');
    assert.equal(contextKeys.get('git-branch.diffLayout'), 'tree');
    await run('diffTree.current'); // Re-applying the ✓ current entry is idempotent.
    assert.equal(tree.diffLayout, 'tree');
    assert.equal(contextKeys.get('git-branch.diffSort'), 'path');
    const folders = await tree.getChildren(selected);
    assert.deepEqual(folders.map(n => n.label || n.file.newPath), ['lib', 'src', 'root.ts']);
    const nested = await tree.getChildren(folders[1]);
    assert.equal(await tree.getParent(nested[0]), folders[1]);
    assert.equal(tree.getTreeItem(nested[0]).description, '');
    assert.equal(tree.getTreeItem(folders[1]).contextValue, 'gb-worktree-folder');
    await run('diffList');
    assert.equal((await tree.getChildren(selected)).length, 4);
    assert.equal(tree.getTreeItem((await tree.getChildren(selected))[1]).description, '');
    tree.clearWorkingTree('refs/heads/' + selected.ref);
    assert.ok(!(await tree.getChildren()).some(n => n.diffGroup)); // Diff group hides when no comparisons remain.
    for (const id of ['checkout', 'compare', 'worktree', 'merge', 'rebase']) {
      await run(id, tag); await run(id, undefined);
    }
    const beforeRefresh = refreshes; await run('refresh'); assert.ok(refreshes > beforeRefresh);
    assert.ok(!messages.some(m => /failed:/i.test(m)), messages.join('\n'));
  } finally {
    for (const item of context.subscriptions) item.dispose();
    Module._load = originalLoad;
  }
});
