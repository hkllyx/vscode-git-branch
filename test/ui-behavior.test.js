'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { compileFunction } = require('node:vm');
const { createCommitTimeFormatter } = require('../media/commitTime');
const { configureLocale, t: message } = require('../src/i18n');
const { BranchActivation } = require('../src/views/branchActivation');
const { fixture } = require('../test-support/gitFixture');

function loadWithMocks(filename, mocks) {
  const load = createRequire(filename);
  const module = { exports: {} };
  compileFunction(readFileSync(filename, 'utf8'), ['require', 'module'], { filename })(id => mocks[id] ?? load(id), module);
  return module.exports;
}

async function workbench(local, window) {
  const noop = () => {};
  const repo = { id: local.url, root: { fsPath: local.dir, scheme: 'file' }, name: path.basename(local.dir),
    snapshot: await local.reads.snapshot(local.dirs, false), actions: local.actions, reads: local.reads, repository: { inputBox: { value: '' } } };
  const registry = { active: repo, repositories: new Map([[repo.id, repo]]), onChange: noop, connect: noop,
    write: (_repo, task) => task(local.actions) };
  const commands = new Map();
  const vscode = {
    env: { language: 'en' }, InputBoxValidationSeverity: { Error: 3 }, ProgressLocation: { Notification: 15 },
    workspace: { isTrusted: true, textDocuments: [], registerTextDocumentContentProvider: noop },
    commands: { executeCommand: noop, registerCommand: (key, action) => commands.set(key, action) },
    window: {
      createTreeView: () => ({ onDidChangeSelection: noop, onDidChangeVisibility: noop }),
      registerWebviewViewProvider: noop, withProgress: (_options, task) => task(), ...window
    }
  };
  const { activate } = loadWithMocks(require.resolve('../src/extension'), {
    vscode, './model/repoModel': { RepoRegistry: function () { return registry; } },
    './views/branchesProvider': { BranchesProvider: class {} }, './panel/graphController': { GraphController: class {
      constructor(_context, _registry, _documents, ui) { this.ui = ui; }
      commitCommand(kind, { rows, guard = noop }) { return this.ui.historyCommit(kind, repo, repo.snapshot.head, rows, guard); }
      askCommitMessage(...args) { return window.askCommitMessage(...args); }
    } },
    './panel/historyDocuments': { HistoryDocuments: class {} }
  });
  activate({ subscriptions: [] });
  const action = (id, arg) => commands.get(`git-branch.${id}`)(typeof arg === 'string' ? { repoId: repo.id, ref: arg } : arg);
  return Object.assign(action, { repository: repo.repository });
}

function nameInput() {
  let change, accept, hide;
  return {
    onDidChangeValue: listener => { change = listener; },
    onDidAccept: listener => { accept = listener; },
    onDidHide: listener => { hide = listener; },
    show() { this.visible = true; },
    hide() { if (this.visible) { this.visible = false; hide(); } },
    dispose() { this.disposed = true; },
    type(value) { this.value = value; change(value); },
    submit() { accept(); }
  };
}

async function waitFor(check, label) {
  for (const deadline = Date.now() + 8000; Date.now() < deadline;) {
    if (check()) return;
    await delay(20);
  }
  assert.fail(`Timed out: ${label}`);
}

test('a Branches item opens on a second activation, not a single activation or a different ref', () => {
  const activation = new BranchActivation();
  const first = { repoId: 'repo1', ref: 'refs/heads/main' };
  const other = { ...first, ref: 'refs/heads/topic' };
  assert.equal(activation.activate(first, false, 0), false);
  activation.selectionChanged(first);
  assert.equal(activation.activate(first, false, 100), true);
  assert.equal(activation.activate(first, false, 150), false);
  assert.equal(activation.activate(first, false, 800), false);
  assert.equal(activation.activate(other, false, 900), false);
  activation.selectionChanged(first);
  assert.equal(activation.activate(other, false, 1000), false);
  assert.equal(activation.activate({ ...other, repoId: 'repo2' }, false, 1100), false);
  activation.reset();
  assert.equal(activation.activate(first, true, 1200), true);
});

test('commit time tooltip uses one local timestamp with an optional relative hint in all three languages', () => {
  const commit = new Date(2026, 0, 2, 3, 4, 5);
  const iso = commit.toISOString();
  const now = new Date(commit.getTime() + 5 * 60_000);
  for (const locale of ['en', 'zh-cn', 'zh-tw']) {
    const format = createCommitTimeFormatter(locale);
    const relative = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
    assert.deepEqual(format(iso, now), {
      label: '2026/01/02 03:04', title: `2026/01/02 03:04:05 · ${relative.format(-5, 'minute')}`
    });
    assert.equal(format(iso, new Date(2026, 0, 3, 14)).title, `2026/01/02 03:04:05 · ${relative.format(-1, 'day')}`);
    assert.equal(format(iso, new Date(2026, 2, 5)).title, '2026/01/02 03:04:05');
    assert.equal(format(undefined).label, '—');
  }
});

test('create from a branch shows the source, prefills its exact name and provides blocking validation', async t => {
  const f = await fixture(t);
  const local = await f.repo('local');
  const oid = await local.commit('source commit');
  const source = 'feature/source';
  const created = 'feature/source-next';
  await local.git('branch', source);
  const headOid = await local.commit('different current tip');
  const calls = [];
  const input = nameInput();
  const action = await workbench(local, {
    showQuickPick: () => assert.fail('right-click create must not ask for the source again'),
    createInputBox: () => { calls.push('name'); return input; },
    showWarningMessage: () => assert.fail('accepting a new branch name must not ask for confirmation again'),
    showInformationMessage: (title, action) => {
      calls.push('offer checkout');
      assert.equal(title, message('action.checkoutCreated', { name: created, repo: 'local' }));
      assert.equal(action, message('action.checkoutButton'));
    }
  });
  const creation = action('createFrom', `refs/heads/${source}`);
  try {
    await waitFor(() => input.validationMessage, 'validate the prefilled branch before typing');
    assert.equal(input.title, message('action.createName', { name: source, oid: oid.slice(0, 8) }));
    assert.equal(input.value, source);
    assert.deepEqual(input.valueSelection, [source.length, source.length]);
    const initialError = input.validationMessage;
    assert.deepEqual(initialError, { message: `Local branch ${source} already exists.`, severity: 3 });
    input.submit();
    await waitFor(() => input.validationMessage !== initialError, 'recheck the name on Enter');
    assert.equal(input.visible, true);
    assert.deepEqual(calls, ['name']);
    input.type('feature');
    await waitFor(() => input.validationMessage?.message.includes('ref path conflict'), 'show a path conflict while editing');
    assert.equal(input.validationMessage.severity, 3);
    input.type('');
    await waitFor(() => input.validationMessage?.message === message('branch.nameEmpty'), 'show empty name error');
    input.type(created);
    input.submit();
    await waitFor(() => input.disposed, 'accept the valid name and dispose the input');
  } finally { input.hide(); }
  await creation;
  assert.deepEqual(calls, ['name', 'offer checkout']);
  assert.equal(await local.reads.resolveCommit(`refs/heads/${created}`), oid);
  assert.deepEqual(await local.reads.head(), { ref: 'refs/heads/main', oid: headOid });
});

test('create from HEAD prefills the attached branch name and leaves detached HEAD blank', async t => {
  const f = await fixture(t);
  const local = await f.repo('local');
  const oid = await local.commit('source commit');
  const inputs = [];
  const setup = () => workbench(local, {
    showQuickPick: items => items[0],
    createInputBox: () => { const input = nameInput(); inputs.push(input); return input; },
    showWarningMessage: () => assert.fail('cancelled input must not open a confirmation')
  });
  const attached = (await setup())('create');
  try { await waitFor(() => inputs[0]?.validationMessage, 'validate the current branch name'); }
  finally { inputs[0]?.hide(); }
  await attached;
  await local.git('switch', '--detach', oid);
  const detached = (await setup())('create');
  try { await waitFor(() => inputs[1]?.visible, 'show the detached input'); }
  finally { inputs[1]?.hide(); }
  await detached;
  assert.deepEqual(inputs.map(({ title, value }) => ({ title, value })), [
    { title: `Create Branch from HEAD (main) (${oid.slice(0, 8)})`, value: 'main' },
    { title: `Create Branch from HEAD (Detached) (${oid.slice(0, 8)})`, value: '' }
  ]);
});

test('remote checkout reports same-name conflicts without prompting and directly uses the derived local name', async t => {
  const f = await fixture(t);
  const { local, seed, initial } = await f.remotePair();
  await seed.git('push', 'origin', 'HEAD:refs/heads/feature/remote');
  await local.git('fetch', '--no-tags', 'origin');
  const warnings = [];
  const action = await workbench(local, {
    createInputBox: () => assert.fail('remote checkout must not ask for a local name'),
    showWarningMessage: (...args) => { warnings.push(args); return args[2]; },
    showInformationMessage: () => {}
  });
  await action('checkoutRemote', 'refs/remotes/origin/main');
  assert.deepEqual(warnings, [['Git Branch: Local branch main already exists.']]);
  assert.equal((await local.reads.head()).ref, 'refs/heads/main');
  await action('checkoutRemote', 'refs/remotes/origin/feature/remote');
  assert.equal(warnings.length, 1);
  const [tip] = await local.reads.refs({ ref: 'refs/heads/feature/remote' });
  assert.equal(tip.upstream.tracking, 'refs/remotes/origin/feature/remote');
  assert.deepEqual(await local.reads.head(), { ref: 'refs/heads/feature/remote', oid: initial });
});

test('remote Delete confirms the exact server branch; cancel does not touch either branch', async t => {
  const f = await fixture(t);
  const { local, remote, seed, initial } = await f.remotePair();
  const source = 'refs/heads/topic';
  await seed.git('push', 'origin', `HEAD:${source}`);
  await local.git('fetch', 'origin');
  await local.git('branch', 'topic');
  let approve = false;
  let prompts = 0;
  const notifications = [];
  const action = await workbench(local, {
    showWarningMessage: (title, options, button) => {
      prompts++;
      assert.equal(title, message('action.deleteRemoteConfirm'));
      assert.equal(options.modal, true);
      assert.ok(options.detail.includes(message('action.deleteRemoteLabel', { remote: 'origin', ref: source, oid: initial.slice(0, 8) })));
      assert.ok(options.detail.includes(message('action.deleteRemotePolicy')));
      assert.equal(button, 'Delete');
      return approve ? button : undefined;
    },
    showErrorMessage: value => assert.fail(value),
    showInformationMessage: value => notifications.push(value)
  });
  await action('deleteBranch', 'refs/remotes/origin/topic');
  assert.equal(await remote.reads.resolveCommit(source), initial);
  assert.deepEqual(notifications, []);
  approve = true;
  await action('deleteBranch', 'refs/remotes/origin/topic');
  assert.equal(prompts, 2);
  assert.equal(await remote.reads.resolveCommit(source), undefined);
  assert.equal(await local.reads.resolveCommit(source), initial);
  assert.deepEqual(notifications, ['Deleted server branch origin/topic. No local branch was deleted.']);
});

test('normal local checkout, cached Merge and Update do not request confirmation', async t => {
  const f = await fixture(t);
  const { local, seed, initial } = await f.remotePair();
  await local.git('switch', '-c', 'topic');
  const topic = await local.commit('topic tip', { 'topic.txt': 'topic' });
  await local.git('switch', 'main');
  const warnings = [];
  const action = await workbench(local, {
    showWarningMessage: (...args) => { warnings.push(args); },
    showErrorMessage: value => assert.fail(value), showInformationMessage: () => {}
  });
  await action('checkout', 'refs/heads/topic');
  assert.equal(await local.head(), topic);
  await action('checkout', 'refs/heads/main');
  const remote = await seed.commit('remote advance', { 'server.txt': 'server' });
  await seed.git('push', 'origin', 'main');
  await action('pull', 'refs/heads/main');
  assert.equal(await local.head(), remote);
  await action('mergeIntoCurrent', 'refs/heads/topic');
  assert.equal(await local.read('topic.txt'), 'topic');
  assert.equal(await local.read('server.txt'), 'server');
  assert.equal(await local.reads.resolveCommit('HEAD^2'), topic);
  assert.equal(await local.reads.resolveCommit('refs/heads/topic^'), initial);
  assert.deepEqual(warnings, []);
});

test('Undo confirms once and fills only an empty SCM draft; selecting a Reset mode is the only confirmation', async t => {
  const f = await fixture(t);
  const local = await f.repo('local');
  const root = await local.commit('initial', { 'base.txt': 'initial' });
  const tip = await local.commit('latest message', { 'tip.txt': 'tip' });
  let confirm = false, prompts = 0;
  const window = {
    showWarningMessage: (title, options, label) => {
      assert.equal(title, 'Undo Commit');
      assert.equal(options.modal, true);
      assert.ok(options.detail.includes(tip.slice(0, 8)));
      prompts++;
      return confirm ? label : undefined;
    }, showInformationMessage: () => {}, showErrorMessage: value => assert.fail(value)
  };
  const action = await workbench(local, window);
  const context = { rows: [{ oid: tip }] };
  await action('undo', context);
  assert.equal(await local.head(), tip);
  confirm = true;
  await action('undo', context);
  assert.equal(await local.head(), root);
  assert.equal(action.repository.inputBox.value, 'latest message');
  assert.equal(prompts, 2);
  await local.git('reset', '--hard', tip);
  action.repository.inputBox.value = 'existing draft';
  await action('undo', context);
  assert.equal(action.repository.inputBox.value, 'existing draft');
  assert.equal(prompts, 3);
  await local.git('reset', '--hard', tip);
  const reset = await workbench(local, {
    showQuickPick: (options, { title }) => {
      assert.deepEqual(options.map(option => option.mode), ['soft', 'mixed', 'keep', 'hard']);
      assert.ok(title.includes(`${tip.slice(0, 8)} → ${root.slice(0, 8)}`));
      return options[0];
    }, showWarningMessage: () => assert.fail('the reset mode should not need a second modal'),
    showInformationMessage: () => {}, showErrorMessage: value => assert.fail(value)
  });
  await reset('reset', { rows: [{ oid: root }] });
  assert.equal(await local.head(), root);
  assert.equal(await local.git('show', ':tip.txt'), 'tip');
});

test('native history menus are scoped to both supported webview keys, with no command palette entries', () => {
  const { contributes } = require('../package.json');
  const menu = contributes.menus['webview/context'];
  const viewScope = '(webview == git-branch.log || webviewId == git-branch.log)';
  const keys = area => menu.filter(row => row.when === `${viewScope} && gbArea == ${area}`)
    .map(row => row.command.slice('git-branch.'.length));
  assert.deepEqual(keys('commit'), ['copyRevision', 'cherryPick', 'checkoutRevision', 'compareLocal', 'reset', 'revert', 'undo', 'editMessage', 'squash', 'drop', 'newBranch', 'newTag']);
  assert.deepEqual(keys('file'), ['editSource', 'openRepositoryVersion', 'applyFiles']);
  assert.equal(menu.length, keys('commit').length + keys('file').length);
  for (const key of [...keys('commit'), ...keys('file')]) assert.ok(contributes.menus.commandPalette.some(row => row.command === `git-branch.${key}` && row.when === 'false'));
});

test('Branches keeps the native tree and exposes the expected menu for each branch type, in order', () => {
  const { contributes } = require('../package.json');
  const branches = contributes.views.scm.find(view => view.id === 'git-branch.branches');
  assert.ok(branches);
  assert.equal(branches.type ?? 'tree', 'tree');
  const menu = contributes.menus['view/item/context'];
  const menuFor = kind => menu.filter(item => {
    assert.ok(item.when.startsWith('view == git-branch.branches && '));
    const [, exactly, alternatives] = /viewItem (?:== gb-([a-z]+)|=~ \/\^gb-\(([a-z|]+)\)\$\/)$/u.exec(item.when);
    return exactly === kind || alternatives?.split('|').includes(kind);
  }).sort((a, b) => a.group.localeCompare(b.group)).map(item => item.command.slice('git-branch.'.length));
  assert.deepEqual(menuFor('current'), ['openHistory', 'createFrom', 'compareWith', 'compareWorktree', 'newWorktree', 'pull', 'push', 'copyBranchName', 'renameBranch']);
  assert.deepEqual(menuFor('local'), ['openHistory', 'checkout', 'createFrom', 'checkoutUpdate', 'compareWithCurrent', 'compareWith', 'compareWorktree',
    'mergeIntoCurrent', 'rebaseCurrent', 'newWorktree', 'pull', 'push', 'copyBranchName', 'renameBranch', 'deleteBranch']);
  assert.deepEqual(menuFor('remote'), ['openHistory', 'checkoutRemote', 'createFrom', 'compareWithCurrent', 'compareWith', 'compareWorktree',
    'mergeIntoCurrent', 'rebaseCurrent', 'newWorktree', 'pullMerge', 'pullRebase', 'copyBranchName', 'deleteBranch']);
  assert.deepEqual(menuFor('head'), ['openHistory']);
  assert.deepEqual(menuFor('tag'), ['openHistory']);
  assert.deepEqual(menuFor('section'), []);
  const catalog = require('../package.nls.json');
  const label = command => catalog[contributes.commands.find(item => item.command === `git-branch.${command}`).title.slice(1, -1)];
  assert.equal(label('compareWithCurrent'), 'Compare with Current');
  assert.equal(label('compareWith'), 'Compare with…');
  assert.equal(label('checkout'), 'Checkout');
  assert.equal(label('checkoutRemote'), 'Checkout');
  assert.equal(label('pull'), 'Update');
  assert.equal(label('deleteBranch'), 'Delete…');
});

test('history opens the working tree Diff using a host-issued file token and saved bytes', async t => {
  const f = await fixture(t);
  const local = await f.repo('local');
  const base = await local.commit('initial', { 'file.txt': 'on branch' });
  await local.git('branch', 'base');
  await local.commit('current', { 'file.txt': 'in head' });
  await local.write('file.txt', 'on disk');
  const calls = [], editors = [];
  const vscode = { Uri: { from: ({ scheme, path }) => `${scheme}:${path}` },
    workspace: { isTrusted: true }, window: { showTextDocument: uri => editors.push(uri) },
    commands: { executeCommand: (...args) => calls.push(args) } };
  const { GraphController } = loadWithMocks(require.resolve('../src/panel/graphController'), { vscode });
  const { HistoryDocuments } = loadWithMocks(require.resolve('../src/panel/historyDocuments'), { vscode });
  const repo = { id: local.url, root: { fsPath: local.dir }, name: 'local',
    snapshot: await local.reads.snapshot(local.dirs, false), reads: local.reads, actions: local.actions,
    commitCache: new Map(), filesCache: new Map() };
  const registry = { active: repo, repositories: new Map([[repo.id, repo]]), onChange: () => ({ dispose() {} }) };
  const documents = new HistoryDocuments();
  const controller = new GraphController({}, registry, documents, {});
  t.after(() => { controller.dispose(); documents.dispose(); });
  controller.ready = true;
  controller.view = { visible: true, webview: { postMessage: () => true } };
  controller.compareWorktree(repo, await local.actions.named('refs/heads/base'));
  await waitFor(() => controller.comparePacket?.files && controller.selectionPacket?.detail, 'load worktree files and commit data');
  const scope = { repoId: repo.id, generation: controller.generation };
  assert.deepEqual(controller.meta().compare, { left: { label: 'base', oid: base }, right: { label: 'Working Tree' }, workingTree: true, stale: false });
  const [file] = controller.comparePacket.files;
  assert.equal(file.path, 'file.txt');
  await controller.onMessage({ ...scope, type: 'openDiff', token: '../file.txt' });
  await controller.onMessage({ ...scope, type: 'openDiff', token: file.id, generation: controller.generation - 1 });
  assert.deepEqual(calls, []);
  await controller.onMessage({ ...scope, type: 'openDiff', token: file.id });
  const [[command, left, right, title]] = calls;
  assert.equal(command, 'vscode.diff');
  assert.equal(documents.provideTextDocumentContent(left), 'on branch');
  assert.equal(documents.provideTextDocumentContent(right), 'on disk');
  assert.match(title, /file\.txt · .* → Working Tree/);
  const context = { webview: 'git-branch.log', gbArea: 'file', gbRepo: repo.id, gbGeneration: scope.generation,
    gbRevision: controller.selectionRevision, gbHeadRef: repo.snapshot.head.ref, gbHeadOid: repo.snapshot.head.oid,
    gbSource: 'snapshot', gbToken: file.id };
  const stale = { message: message('history.staleAction') };
  for (const overrides of [{ gbGeneration: scope.generation - 1 }, { gbRevision: context.gbRevision - 1 },
    { gbHeadOid: base }, { gbToken: '123456' }, { gbSource: 'commit' }]) {
    await assert.rejects(controller.fileCommand('openRepositoryVersion', { ...context, ...overrides }), stale);
  }
  assert.deepEqual(editors, []);
  await controller.fileCommand('openRepositoryVersion', context);
  assert.equal(documents.provideTextDocumentContent(editors[0]), 'on branch');
  await controller.onMessage({ ...scope, type: 'swap' });
  assert.equal(controller.generation, scope.generation);
  assert.equal(controller.comparison.left.oid, base);
  assert.equal(await local.read('file.txt'), 'on disk');
});

test('single merge issues distinct parent Diff tokens; multi-select omits parent groups', async t => {
  const f = await fixture(t);
  const local = await f.repo('merge-parents');
  await local.commit('initial', { 'src/client.txt': 'base\n' });
  await local.git('switch', '-c', 'topic');
  const side = await local.commit('Topic change', { 'src/client.txt': 'topic\n', 'side.txt': 'side\n' });
  await local.git('switch', 'main');
  const main = await local.commit('Main change', { 'src/client.txt': 'main\n', 'main.txt': 'main\n' });
  await assert.rejects(local.git('merge', '--no-ff', '-m', 'Merge topic', 'topic'));
  const merge = await local.commit('Resolve merge', { 'src/client.txt': 'resolution\n' });
  const vscode = { workspace: { isTrusted: true } };
  const { GraphController } = loadWithMocks(require.resolve('../src/panel/graphController'), { vscode });
  const repo = { id: local.url, root: { fsPath: local.dir }, name: 'local',
    snapshot: await local.reads.snapshot(local.dirs, false), reads: local.reads,
    commitCache: new Map(), filesCache: new Map() };
  const registry = { active: repo, repositories: new Map([[repo.id, repo]]), onChange: () => ({ dispose() {} }) };
  const opened = [];
  const controller = new GraphController({}, registry, { open: (_, change) => opened.push(change) }, {});
  t.after(() => controller.dispose());
  controller.view = { visible: true, webview: { postMessage: () => true } };
  await controller.onMessage({ type: 'ready' });
  await waitFor(() => controller.selectionPacket?.parentGroups?.length === 2, 'merge parent groups');
  const send = (type, data) => controller.onMessage({ type, generation: controller.generation, repoId: repo.id, ...data });
  const { files: [combined], parentGroups: [first, second] } = controller.selectionPacket;
  assert.equal(combined.path, 'src/client.txt');
  assert.deepEqual([first, second].map(group => [group.oid, group.subject]), [[main, 'Main change'], [side, 'Topic change']]);
  const byPath = (group, path) => group.files.find(file => file.path === path);
  const fromMain = byPath(first, combined.path);
  const fromSide = byPath(second, combined.path);
  for (const file of [combined, fromMain, fromSide]) await send('openDiff', { token: file.id });
  assert.equal(new Set([combined.id, fromMain.id, fromSide.id]).size, 3);
  assert.deepEqual(opened.map(change => [change.baseOid, change.afterOid]), [[main, merge], [main, merge], [side, merge]]);
  assert.equal(await local.reads.blob(opened[2].old), 'topic\n');
  const ids = [byPath(first, 'side.txt').id, byPath(second, 'main.txt').id];
  await send('selectFiles', { source: 'commit', ids });
  await assert.rejects(controller.fileCommand('applyFiles', { webview: 'git-branch.log', gbArea: 'file',
    gbGeneration: controller.generation, gbRepo: repo.id, gbRevision: controller.selectionRevision,
    gbHeadRef: repo.snapshot.head.ref, gbHeadOid: merge, gbSource: 'commit', gbToken: ids[0], gbFiles: ids.join(',') }),
  { message: message('history.mixedParentChanges') });
  await send('select', { oid: main, mode: 'toggle' });
  assert.deepEqual(controller.selectionPacket.parentGroups, []);
  assert.equal(controller.selectionPacket.detail, undefined);
  await send('openDiff', { token: fromSide.id });
  assert.equal(opened.length, 3);
});

test('history columns default to Author and Date while keeping Hash available and preserving saved choices', async t => {
  const packets = [];
  const values = new Map();
  const workspaceState = { get: key => values.get(key), update: (key, value) => values.set(key, value) };
  let pick = () => undefined;
  const vscode = { window: { showQuickPick: (items, options) => {
    assert.equal(options.canPickMany, true);
    const labels = ['history.author', 'history.columnHash', 'history.columnDate'].map(key => message(key));
    assert.deepEqual(items.map(item => item.label), labels);
    return pick(items);
  } } };
  const { GraphController } = loadWithMocks(require.resolve('../src/panel/graphController'), { vscode });
  const registry = { repositories: new Map(), onChange: () => ({ dispose() {} }) };
  const start = () => {
    const controller = new GraphController({ workspaceState }, registry, {}, {});
    t.after(() => controller.dispose());
    controller.ready = true;
    controller.view = { visible: true, webview: { postMessage: packet => packets.push(packet) } };
    return controller;
  };
  const controller = start();
  const { generation } = controller;
  const openPicker = () => controller.onMessage({ generation, type: 'chooseColumns' });
  assert.deepEqual(controller.commitColumns, ['author', 'date']);
  pick = items => {
    assert.deepEqual(items.map(item => item.picked), [true, false, true]);
    return [items[2], items[1], items[0]];
  };
  await openPicker();
  assert.deepEqual(packets.at(-1), { generation, type: 'commitColumns', repoId: undefined, payload: ['author', 'hash', 'date'] });
  assert.deepEqual(start().commitColumns, ['author', 'hash', 'date']);
  pick = items => {
    assert.ok(items.every(item => item.picked));
    return undefined;
  };
  await openPicker();
  assert.equal(packets.length, 1);
  pick = () => [];
  await openPicker();
  assert.deepEqual(start().commitColumns, []);
  assert.equal(controller.generation, generation);
});

test('history context targets the clicked commit or its selection and rejects stale and single-only group commands', async t => {
  const vscode = { workspace: { isTrusted: true } };
  const { GraphController } = loadWithMocks(require.resolve('../src/panel/graphController'), { vscode });
  const head = { oid: 'a'.repeat(40), ref: 'refs/heads/main' };
  const repo = { id: 'repo', root: { fsPath: __dirname }, snapshot: { head, allRefs: [], byRef: new Map() } };
  const registry = { active: repo, repositories: new Map([[repo.id, repo]]), onChange: () => ({ dispose() {} }) };
  const calls = [];
  const ui = { historyCommit: (kind, r, h, rows, guard) => { calls.push({ kind, r, h, oids: rows.map(row => row.oid), guard }); } };
  const controller = new GraphController({}, registry, {}, ui);
  t.after(() => controller.dispose());
  controller.ready = true;
  controller.view = { visible: true, webview: { postMessage: () => true } };
  const row = letter => ({ oid: letter.repeat(40) });
  const [a, b, c] = controller.rows = ['a', 'b', 'c'].map(row);
  controller.known = new Map(controller.rows.map(item => [item.oid, item]));
  controller.selection.selected = new Set([c.oid, a.oid]);
  const context = { webview: 'git-branch.log', gbArea: 'commit', gbRepo: repo.id, gbGeneration: controller.generation,
    gbRevision: controller.selectionRevision, gbHeadRef: head.ref, gbHeadOid: head.oid };
  const stale = { message: message('history.staleAction') };
  await assert.rejects(controller.commitCommand('drop', { ...context, gbOid: a.oid }), stale);
  await assert.rejects(controller.commitCommand('copyRevision', { ...context, gbOid: 'd'.repeat(40) }), stale);
  assert.deepEqual(calls, []);
  await controller.commitCommand('copyRevision', { ...context, gbOid: c.oid });
  await controller.commitCommand('checkoutRevision', { ...context, gbOid: b.oid });
  assert.deepEqual(calls.map(call => [call.kind, call.oids]), [['copyRevision', [a.oid, c.oid]], ['checkoutRevision', [b.oid]]]);
  calls[0].guard();
  controller.selectionRevision++;
  assert.throws(calls[0].guard, stale);
  assert.equal(calls[0].r, repo);
  assert.equal(calls[0].h, head);
});

test('branch hovers contain only the name and optional upstream; the current branch uses the gold branch glyph', t => {
  const { BranchesProvider } = loadWithMocks(require.resolve('../src/views/branchesProvider'), { vscode: {
    TreeItemCollapsibleState: { None: 0, Expanded: 2 }, TreeItem: class {},
    ThemeIcon: class { constructor(id, color) { this.id = id; this.color = color; } },
    ThemeColor: class { constructor(id) { this.id = id; } }, EventEmitter: class {},
    Uri: { joinPath: (...parts) => parts.join('/') }
  } });
  const oid = 'a'.repeat(40);
  const main = { ref: 'refs/heads/main', name: 'main', kind: 'local', oid, upstream: { tracking: 'refs/remotes/origin/main' } };
  const topic = { ref: 'refs/heads/topic', name: 'topic', kind: 'local', oid };
  const remote = { ref: 'refs/remotes/origin/topic', name: 'origin/topic', kind: 'remote', oid };
  const tag = { ref: 'refs/tags/v1', name: 'v1', kind: 'tag', oid };
  const repo = { id: 'test', snapshot: { head: main, allRefs: [main, topic, remote, tag] } };
  const provider = new BranchesProvider({ showTags: true }, 'ext');
  t.after(() => configureLocale('en'));
  for (const language of ['en', 'zh-cn', 'zh-tw', 'ja']) {
    configureLocale(language);
    const upstream = message('branch.upstreamLabel', { name: 'origin/main' });
    const nodes = [
      [provider.roots(repo)[0], 'gb-head', ['main', upstream]],
      [provider.branch(repo, main), 'gb-current', ['main', upstream]],
      [provider.branch(repo, topic), 'gb-local', ['topic']],
      [provider.branch(repo, remote), 'gb-remote', ['origin/topic']],
      [provider.branch(repo, tag), 'gb-tag', ['v1']]
    ];
    for (const [node, contextValue, details] of nodes) {
      const treeItem = provider.getTreeItem(node);
      const current = contextValue === 'gb-current';
      assert.equal(treeItem.tooltip, details.join('\n'));
      assert.equal(treeItem.accessibilityInformation.label, (current ? [...details, message('branch.current')] : details).join('\n'));
      if (current) {
        assert.equal(treeItem.iconPath, 'ext/media/codicons/git-branch-yellow.svg');
      } else {
        assert.equal(treeItem.iconPath.id, contextValue === 'gb-tag' ? 'tag' : 'git-branch');
        assert.equal(treeItem.iconPath.color?.id, contextValue === 'gb-head' ? 'charts.blue' : undefined);
      }
      assert.equal(treeItem.contextValue, contextValue);
      assert.equal(treeItem.command.command, 'git-branch.activateRef');
    }
    const nonCommit = provider.getTreeItem(provider.branch(repo, { ...tag, oid: undefined }));
    assert.equal(nonCommit.contextValue, 'gb-noncommit-tag');
    assert.equal(nonCommit.tooltip, 'v1');
    assert.equal(nonCommit.command, undefined);
  }
});
