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
  await git.exec(['add', '.']); await git.exec(['commit', '-m', 'feature', '-m', 'Full body <script>\n[unsafe](command:evil)']);
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
  const tabGroups = [{ tabs: [] }, { tabs: [] }], closedTabs = [], copied = [];
  const hoverText = item => item.tooltip.value
    .replace(/ \[\$\(copy\)\]\(command:git-branch.copyBranchName\?[^ ]+ "Copy branch name"\)/g, '')
    .replace(/\\([\\`*_{}\[\]()<>#+\-.!])/g, '$1').replace(/ {2}\n/g, '\n');
  const copyNames = item => [...item.tooltip.value.matchAll(/command:git-branch.copyBranchName\?([^ ]+)/g)]
    .map(match => JSON.parse(decodeURIComponent(match[1]))[0]);
  let tree, diffTree, decorations, panelFocuses = 0, refreshes = 0, input, answer, trackingSelection, choose = false;
  const disposable = { dispose() {} };
  const mock = {
    EventEmitter: class { event = () => {}; fire() { refreshes++; } dispose() {} },
    TreeItem: class { constructor(label) { this.label = label; } },
    MarkdownString: class {
      value = '';
      appendText(text) { this.value += text.replace(/[\\`*_{}\[\]()<>#+\-.!]/g, '\\$&'); return this; }
      appendMarkdown(text) { this.value += text; return this; }
    },
    env: { clipboard: { writeText: async text => copied.push(text) } },
    TreeItemCollapsibleState: { None: 0, Expanded: 2, Collapsed: 1 }, ThemeIcon: class { constructor(id, color) { this.id = id; this.color = color; } },
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
          assert.ok(node.diffSession || node.kind === 'compare-session');
          assert.equal(options.expand, true);
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
      showQuickPick: async (items, options) => options?.title?.startsWith('Set Tracking')
        ? trackingSelection?.(items, options) : choose ? items[0] : undefined
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
    for (const [group, icon] of [[roots[0], 'repo'], [roots[1], 'globe'], [roots[2], 'folder'], [roots[1].children[0], 'remote']]) {
      assert.equal(tree.getTreeItem(group).iconPath.id, icon);
    }
    let remote = roots[1].children[0].children[0];
    const tag = roots[2].children[0];
    assert.equal(tag.ref, 'feature/test');
    for (const node of [main, selected, remote, tag]) {
      const item = tree.getTreeItem(node);
      assert.equal(item.label, node.label);
      assert.equal(item.iconPath.id, node.kind === 'tag' ? 'tag' : 'git-branch');
      assert.equal(item.iconPath.color?.id, node.current && !node.remote ? 'charts.yellow' : undefined);
      assert.equal(item.description, undefined); // Branch/tag names have no trailing hash.
      assert.ok(item.tooltip instanceof mock.MarkdownString);
      assert.deepEqual(item.tooltip.isTrusted, { enabledCommands: node.kind === 'tag'
        ? ['git-branch.copyBranchName'] : ['git-branch.copyBranchName', 'git-branch.copyCommitHash'] });
      assert.equal(item.tooltip.supportThemeIcons, true);
      assert.equal(item.tooltip.supportHtml, false);
      assert.ok(!item.tooltip.value.includes('\n\n')); // One compact paragraph, not spaced paragraphs.
      assert.equal(item.tooltip.value.split('  \n').length, hoverText(item).split('\n').length);
      const expectedCopyNames = node.kind === 'tag' ? [] : [node.ref];
      if (!node.remote && node.kind !== 'tag' && node.upstream) expectedCopyNames.push(node.upstream.replace(/^refs\/(heads|remotes)\//, ''));
      assert.deepEqual(copyNames(item), expectedCopyNames);
      assert.ok(hoverText(item).includes(`${node.kind === 'tag' ? 'Tag' : 'Branch'} name: ${node.ref}`));
      if (node.kind === 'tag') assert.ok(hoverText(item).includes(`Hash: ${node.hash}`));
      assert.ok(hoverText(item).includes(`Last commit: ${node.kind === 'tag' ? '' : `${node.commitAuthor} · `}${node.commitDate.replace('T', ' ')}`));
      if (node.kind !== 'tag') {
        assert.equal(node.commitAuthor, 'Test');
        assert.ok(!item.tooltip.value.includes(node.hash));
        assert.ok(!hoverText(item).includes('Hash:'));
        const commitLine = item.tooltip.value.split('  \n')[1];
        assert.ok(hoverText(item).includes(`Last commit: Test · ${node.commitDate.replace('T', ' ')} · ${node.hash.slice(0, 7)}`));
        assert.ok(commitLine.endsWith(`${node.hash.slice(0, 7)} [$(copy)](command:git-branch.copyCommitHash?${encodeURIComponent(JSON.stringify([node.hash.slice(0, 7)]))} "Copy short commit hash")`));
        const link = /command:git-branch.copyCommitHash\?([^ ]+)/.exec(item.tooltip.value);
        await commands.get('git-branch.copyCommitHash')(JSON.parse(decodeURIComponent(link[1]))[0]);
        assert.equal(copied.pop(), node.hash.slice(0, 7));
      }
      assert.doesNotMatch(hoverText(item), /Current branch:|Default branch:|commits; local refs only/);
    }
    assert.equal(main.commitDate, (await git.exec(['show', '-s', '--format=%cI', base])).trim());
    assert.equal(remote.commitDate, (await git.exec(['show', '-s', '--format=%cI', feature])).trim());
    assert.equal(main.upstream, 'refs/remotes/origin/main');
    assert.match(hoverText(tree.getTreeItem(main)), /Tracking branch: origin\/main/);
    assert.match(hoverText(tree.getTreeItem(selected)), /Tracking branch: Not configured/);
    for (const [ahead, behind, expected] of [[1, 1, '1↓ 1↑'], [2, 1, '1↓ 2↑'], [3, 0, '3↑'], [0, 4, '4↓'], [0, 0, undefined]]) {
      const item = tree.getTreeItem({ ...main, ahead, behind, trackingMissing: false });
      assert.equal(item.description, expected);
      assert.equal(item.label, main.label);
      assert.match(hoverText(item), new RegExp(`Tracking status: ${ahead} ahead, ${behind} behind$`));
    }
    const missing = tree.getTreeItem({ ...main, trackingMissing: true, ahead: undefined, behind: undefined });
    assert.equal(missing.description, undefined);
    assert.match(hoverText(missing), /upstream ref is missing locally/);
    assert.equal(tree.getTreeItem({ ...selected, ahead: 10, behind: 20 }).description, undefined); // No upstream.
    assert.equal(tree.getTreeItem({ ...remote, upstream: main.upstream, ahead: 10, behind: 20 }).description, undefined);
    assert.doesNotMatch(hoverText(tree.getTreeItem(remote)), /Tracking branch:|Tracking status:/);
    assert.doesNotMatch(hoverText(tree.getTreeItem(tag)), /Tracking branch:|Tracking status:/);
    await assert.rejects(git.create('feature/test'), /already exists/);
    const run = (id, node) => commands.get(`git-branch.${id}`)(node);
    const copyItem = tree.getTreeItem({ ...selected, ref: 'feature/[Copy](command:other)' });
    assert.equal((copyItem.tooltip.value.match(/\]\(command:/g) || []).length, 2); // Only our name and short-hash links are active.
    assert.deepEqual(copyNames(copyItem), ['feature/[Copy](command:other)']);
    await run('copyBranchName', copyNames(copyItem)[0]);
    assert.equal(copied.pop(), 'feature/[Copy](command:other)'); // Name only, without labels or other fields.
    const mainNames = copyNames(tree.getTreeItem(main));
    for (const name of mainNames) await run('copyBranchName', name);
    assert.deepEqual(copied.splice(0), ['main', 'origin/main']);
    await run('copyBranchName', {});
    assert.equal(copied.length, 0);
    const upstreamOf = async name => (await git.branches()).branches.find(b => b.ref === `refs/heads/${name}`).upstream;
    // Native modal dialogs supply Cancel themselves; only contribute the destructive action.
    const originalCheckout = GitOperations.prototype.checkout;
    const originalWarning = mock.window.showWarningMessage;
    const decisions = [];
    try {
      GitOperations.prototype.checkout = async (node, confirm) => {
        assert.equal(node, remote);
        const confirmed = await confirm({ name: 'remote/test', remote: remote.ref, count: 1 });
        decisions.push(confirmed);
        return confirmed ? 'remote/test' : false;
      };
      mock.window.showWarningMessage = async (message, options, ...buttons) => {
        assert.equal(options.modal, true);
        assert.deepEqual(buttons, ['Drop Local Commits']);
        return answer;
      };
      const beforeMessages = messages.length;
      answer = undefined; // Native Cancel and dismissal both resolve undefined.
      await run('checkout', remote);
      assert.equal(messages.length, beforeMessages); // Never announce checkout on cancellation.
      answer = 'Drop Local Commits';
      await run('checkout', remote);
      assert.equal(messages.pop(), 'Checked out: remote/test');
      assert.deepEqual(decisions, [false, true]);
    } finally {
      GitOperations.prototype.checkout = originalCheckout;
      mock.window.showWarningMessage = originalWarning;
      answer = undefined;
    }
    // Set Tracking validates local nodes, excludes self/symbolic refs, and handles cancellation.
    await run('setTracking', main);
    assert.equal(await upstreamOf('main'), 'refs/remotes/origin/main');
    trackingSelection = (items, options) => {
      assert.equal(options.title, 'Set Tracking — feature/test');
      assert.ok(!items.some(item => item.upstream === 'refs/heads/feature/test' || item.upstream?.endsWith('/HEAD')));
      return items.find(item => item.upstream === 'refs/remotes/origin/remote/test');
    };
    await run('setTracking', selected);
    assert.equal(await upstreamOf('feature/test'), 'refs/remotes/origin/remote/test');
    trackingSelection = items => items.find(item => item.upstream === null);
    await run('setTracking', selected);
    assert.equal(await upstreamOf('feature/test'), '');
    await run('setTracking', remote);
    assert.match(messages.pop(), /Right-click a local branch/);
    await run('setTracking', { ...selected, diffSession: true });
    assert.match(messages.pop(), /Right-click a local branch/);
    trackingSelection = undefined;
    input = 'from-selected'; await run('create', selected);
    assert.equal(await git.resolve('refs/heads/from-selected'), feature);
    assert.equal(inputOptions.at(-1).value, 'feature/test');
    input = 'from-remote'; await run('create', remote);
    assert.equal(await git.resolve('refs/heads/from-remote'), feature);
    assert.equal(inputOptions.at(-1).value, 'remote/test'); // Exclude origin/, preserve branch path.
    input = 'from-tag'; await run('create', tag);
    assert.equal(await git.resolve('refs/heads/from-tag'), base);
    assert.equal(inputOptions.at(-1).value, 'feature/test');
    input = 'from-head'; await run('create');
    assert.equal(await git.resolve('refs/heads/from-head'), base);
    assert.equal(inputOptions.at(-1).title, 'Create Branch (from main)');
    input = 'from-group'; await run('create', roots[0]);
    assert.equal(await git.resolve('refs/heads/from-group'), base);
    assert.equal(inputOptions.at(-1).title, 'Create Branch (from main)');
    input = 'from-remote-group'; await run('create', roots[1].children[0]);
    assert.equal(await git.resolve('refs/heads/from-remote-group'), base);
    assert.equal(inputOptions.at(-1).prompt, 'New branch name (based on main)');
    assert.equal(inputOptions.at(-1).value, 'main');
    assert.equal(await git.current(), 'main');
    for (const [name, expected] of [
      ['from-selected', ''], ['from-remote', 'refs/remotes/origin/remote/test'], ['from-tag', ''],
      ['from-head', 'refs/remotes/origin/main'], ['from-group', 'refs/remotes/origin/main'],
      ['from-remote-group', 'refs/remotes/origin/main']
    ]) assert.equal(await upstreamOf(name), expected);
    input = undefined; await run('create', selected); // Input cancellation.
    await run('createAndCheckout', selected);
    assert.equal(await git.current(), 'main');
    for (const [suffix, node, hash] of [
      ['selected', selected, feature], ['remote', remote, feature], ['tag', tag, base],
      ['main', main, base], ['head', undefined, base], ['group', roots[0], base]
    ]) {
      input = `checkout-${suffix}`;
      await run('createAndCheckout', node);
      assert.equal(inputOptions.at(-1).value, suffix === 'remote' ? 'remote/test'
        : ['selected', 'tag'].includes(suffix) ? 'feature/test' : 'main');
      assert.equal(await git.current(), input);
      assert.equal(await git.resolve('HEAD'), hash);
      const expectedTracking = suffix === 'remote' ? 'refs/remotes/origin/remote/test'
        : ['main', 'head', 'group'].includes(suffix) ? 'refs/remotes/origin/main' : '';
      assert.equal(await upstreamOf(input), expectedTracking);
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
    await git.create('remote/test', feature); // Actual server ref for the required fetch (self-hosted test remote).
    await run('checkout', remote); assert.equal(await git.current(), 'remote/test');
    await run('checkout', main); await run('checkout', remote); // Existing tracking branch.
    assert.equal(await git.current(), 'remote/test'); await run('checkout', main);
    await run('compare', selected);
    const compareRoot = (await tree.getChildren()).find(node => node.comparisonsGroup);
    const first = (await tree.getChildren(compareRoot))[0];
    assert.equal(tree.getTreeItem(compareRoot).iconPath.id, 'layers');
    assert.equal(tree.getTreeItem(first).iconPath.id, 'git-compare');
    assert.notEqual(tree.getTreeItem(compareRoot).iconPath.id, tree.getTreeItem(first).iconPath.id);
    assert.equal(first.entry.result.left, feature);
    assert.equal(first.entry.result.right, base);
    const sides = await tree.getChildren(first);
    const commits = await tree.getChildren(sides[0]);
    const commitItem = tree.getTreeItem(commits[0]);
    assert.equal(commitItem.description, `${commits[0].commit.author} · ${commits[0].commit.date}`);
    assert.equal(commitItem.iconPath.id, 'git-commit');
    assert.equal(commitItem.tooltip, undefined);
    await tree.resolveTreeItem(commitItem, commits[0], { isCancellationRequested: false });
    assert.ok(commitItem.tooltip.value.includes('Full body'));
    assert.ok(!commitItem.tooltip.value.includes('<script>'));
    assert.ok(!commitItem.tooltip.value.includes('[unsafe](command:evil)'));
    assert.ok(hoverText(commitItem).includes('2 files changed, 2 insertions(+), 1 deletions(-)'));
    assert.deepEqual(commitItem.tooltip.isTrusted, { enabledCommands: ['git-branch.copyCommitHash'] });
    assert.equal(commitItem.tooltip.supportThemeIcons, true);
    assert.ok(!commitItem.tooltip.value.includes('\n\n')); // No paragraph margins.
    assert.ok(hoverText(commitItem).startsWith(`Test · ${commits[0].commit.date}\n\u00a0\nfeature`));
    assert.ok(commitItem.tooltip.value.includes('  \n\u00a0  \n2 files changed'));
    assert.ok(commitItem.tooltip.value.includes(`${feature.slice(0, 7)} [$(copy)](command:git-branch.copyCommitHash?`));
    assert.ok(!commitItem.tooltip.value.includes(`[${feature.slice(0, 7)}](`));
    const hashLink = /command:git-branch.copyCommitHash\?([^ ]+)/.exec(commitItem.tooltip.value);
    await run('copyCommitHash', JSON.parse(decodeURIComponent(hashLink[1]))[0]);
    assert.equal(copied.pop(), feature.slice(0, 7));
    await run('copyCommitHash', 'invalid');
    assert.equal(copied.length, 0);
    const commitFiles = await tree.getChildren(commits[0]);
    assert.equal(commitFiles[0].details.hash, feature);
    assert.equal(commitFiles[0].details.left, base);
    assert.equal(commitFiles.length, 2);
    await run('openCompareDiff', commitFiles[0]);
    assert.equal(JSON.parse(diffs.pop()[1].query).hash, base);
    const immutableTab = tabGroups[0].tabs.at(-1);
    await fs.writeFile(path.join(cwd, 'new-main.txt'), 'new main\n');
    await git.exec(['add', '.']); await git.exec(['commit', '-m', 'main changes']);
    const changedMain = await git.resolve('HEAD');
    await run('compare', selected);
    const second = (await tree.getChildren(compareRoot))[0];
    assert.equal(second.entry.result.right, changedMain);
    assert.equal(first.entry.result.right, base);
    await run('openCompareDiff', commitFiles[0]); // Stale tree nodes are rejected.
    assert.equal(diffs.length, 0);
    await run('openDiff'); assert.equal(diffs.length, 0); // Picker cancellation.
    choose = true; await run('openDiff');
    assert.equal(diffs[0][0], 'vscode.diff');
    assert.equal(JSON.parse(diffs[0][1].query).hash, feature);
    assert.equal(JSON.parse(diffs[0][2].query).hash, changedMain);
    assert.equal(diffs[0][4].viewColumn, -1);
    assert.equal(diffs[0][4].preview, false);
    const rightContent = await providers.get('git-branch-snapshot').provideTextDocumentContent(immutableTab.input.modified);
    assert.equal(rightContent, await git.content(feature, JSON.parse(immutableTab.input.modified.query).file));
    await run('closeCompare', second);
    assert.ok(closedTabs.includes(immutableTab));
    assert.equal(tree.comparisons.size, 0);
    assert.equal(panels.length, 0);
    closedTabs.length = 0; // Start a fresh baseline for independent Working Tree close tests.
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
    const diffGroup = (await tree.getChildren()).find(n => n.comparisonsGroup);
    assert.equal(diffGroup.label, 'Comparisons');
    assert.equal(tree.getTreeItem(diffGroup).contextValue, 'gb-comparisons-group');
    diffTree = { getChildren: async () => (await scmTree.getChildren(diffGroup)).filter(node => node.diffSession) };
    worktreeBranch = (await diffTree.getChildren())[0];
    assert.equal(await tree.getParent(worktreeBranch), diffGroup);
    let children = await tree.getChildren(worktreeBranch);
    assert.equal(tree.getTreeItem(worktreeBranch).contextValue, 'gb-diff-session-list-path');
    assert.equal(tree.getTreeItem(worktreeBranch).label, `${worktreeBranch.label} ↔ Working Tree`);
    assert.equal(path.basename(tree.getTreeItem(worktreeBranch).iconPath.dark.fsPath), 'branch-diff.svg');
    assert.equal(path.basename(tree.getTreeItem(worktreeBranch).iconPath.light.fsPath), 'branch-diff-light.svg');
    assert.equal(tree.getTreeItem(worktreeBranch).description, '1 file');
    assert.equal(hoverText(tree.getTreeItem(worktreeBranch)), `Left: ${worktreeBranch.ref}\nRight: Working Tree\n1 file changed, 1 insertions(+), 1 deletions(-)`);
    assert.deepEqual(copyNames(tree.getTreeItem(worktreeBranch)), [worktreeBranch.ref]);
    assert.ok(!children.some(n => n.kind === 'worktree-action'));
    const menus = require('../package.json').contributes.menus['view/item/context'];
    for (const id of ['refreshWorktree', 'closeWorktree']) {
      const menu = menus.find(m => m.command === `git-branch.${id}`);
      assert.match(menu.group, /^inline@/);
      assert.match(menu.when, /view == git-branch.branches/);
      assert.ok(menu.when.includes('viewItem =~ /^gb-diff-session-/'));
    }
    // Comparison sessions must not match any branch action menu.
    for (const menu of menus.filter(m => m.command && !m.group.startsWith('inline') && m.when.includes(' =~ /'))) {
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
    const remoteCount = tree.workingTreeFor(remote).result.files.length;
    const remoteStats = tree.workingTreeFor(remote).result.stats;
    assert.equal(hoverText(tree.getTreeItem(remote)), `Left: ${remote.ref}\nRight: Working Tree\n${remoteCount} files changed, ${remoteStats.insertions} insertions(+), ${remoteStats.deletions} deletions(-)`);
    for (const branch of [worktreeBranch, selected, remote]) {
      assert.equal(tree.getTreeItem(branch).contextValue, 'gb-diff-session-list-path');
      assert.equal(path.basename(tree.getTreeItem(branch).iconPath.dark.fsPath), 'branch-diff.svg');
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
    const unrelatedDiff = { input: new mock.TabInputTextDiff(mock.Uri.file(path.join(cwd, 'file.txt')), mock.Uri.file(path.join(cwd, 'file.txt'))) };
    tabGroups[0].tabs.push(unrelatedDiff); // An unrelated native diff must not close.
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
    await run('diffSortName', selected);
    assert.deepEqual((await tree.getChildren(selected)).map(n => n.file.newPath || n.file.oldPath), ['src/a.ts', 'lib/b.ts', 'root.ts', 'src/z.ts']);
    await run('diffSortStatus', selected);
    assert.deepEqual((await tree.getChildren(selected)).map(n => n.file.status), ['A', 'D', 'M', 'M']);
    await run('diffSortPath', selected);
    assert.equal((await tree.getChildren(selected))[0].file.oldPath, 'lib/b.ts');
    await run('diffTree', selected);
    assert.equal(tree.workingTreeFor(selected).settings.layout, 'tree');
    await run('diffTree.current', selected);
    assert.equal(tree.getTreeItem(selected).contextValue, 'gb-diff-session-tree-path');
    await run('diffList'); // No target must not change any session.
    assert.equal(tree.workingTreeFor(selected).settings.layout, 'tree');
    const folders = await tree.getChildren(selected);
    assert.deepEqual(folders.map(n => n.label || n.file.newPath), ['lib', 'src', 'root.ts']);
    const nested = await tree.getChildren(folders[1]);
    assert.equal(await tree.getParent(nested[0]), folders[1]);
    assert.equal(tree.getTreeItem(nested[0]).description, '');
    assert.equal(tree.getTreeItem(folders[1]).contextValue, 'gb-comparison-folder');
    await run('diffList', selected);
    assert.equal((await tree.getChildren(selected)).length, 4);
    assert.equal(tree.getTreeItem((await tree.getChildren(selected))[1]).description, '');
    tree.clearWorkingTree('refs/heads/' + selected.ref);
    assert.ok(!(await tree.getChildren()).some(n => n.comparisonsGroup)); // Hidden after the final session closes.
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
