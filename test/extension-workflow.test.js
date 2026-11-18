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
  await git.exec(['pack-refs', '--all']);
  const commands = new Map(), providers = new Map();
  const messages = [], panels = [], diffs = [], patterns = [], inputOptions = [];
  let tree, refreshes = 0, input, answer, choose = false;
  const disposable = { dispose() {} };
  const mock = {
    EventEmitter: class { event = () => {}; fire() { refreshes++; } dispose() {} },
    TreeItem: class { constructor(label) { this.label = label; } },
    TreeItemCollapsibleState: { None: 0, Expanded: 2, Collapsed: 1 }, ThemeIcon: class {},
    Uri: { from: value => ({ query: '', ...value }) },
    ViewColumn: { Active: -1, Beside: -2 },
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
        assert.equal(args[0], 'vscode.diff');
        assert.equal(args[4].preview, false); // Pin each file diff; do not replace preview tabs.
        assert.equal(args[4].viewColumn, -1); // Same editor group, not a new split group.
        diffs.push(args);
      }
    },
    window: {
      createTreeView: (id, options) => { tree = options.treeDataProvider; return disposable; },
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
    assert.deepEqual(roots.map(r => r.label), ['Local', 'Remote', 'Tags']);
    assert.equal(roots[1].children[0].children.length, 1); // Hide symbolic origin/HEAD.
    const main = roots[0].children.find(n => n.ref === 'main');
    const selected = roots[0].children.find(n => n.ref === 'feature/test');
    assert.equal(tree.getTreeItem(main).contextValue, 'gb-current');
    assert.equal(tree.getTreeItem(selected).contextValue, 'gb-local');
    const remote = roots[1].children[0].children[0], tag = roots[2].children[0];
    assert.equal(tag.ref, 'feature/test');
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
    for (const id of ['checkout', 'compare', 'merge', 'rebase']) {
      await run(id, tag); await run(id, undefined);
    }
    const beforeRefresh = refreshes; await run('refresh'); assert.ok(refreshes > beforeRefresh);
    assert.ok(!messages.some(m => /failed:/i.test(m)), messages.join('\n'));
  } finally {
    for (const item of context.subscriptions) item.dispose();
    Module._load = originalLoad;
  }
});
