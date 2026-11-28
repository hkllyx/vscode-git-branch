'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { compileFunction } = require('node:vm');
const { formatCommitTime } = require('../media/commitTime');
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
  const listeners = [];
  const registry = { active: repo, repositories: new Map([[repo.id, repo]]), onChange: listener => listeners.push(listener), connect: noop,
    write: (_repo, task) => task(local.actions) };
  const commands = new Map(), contextKeys = new Map();
  const tree = { onDidChangeSelection: noop, onDidChangeVisibility: noop };
  let history;
  const vscode = {
    env: { language: 'en' }, InputBoxValidationSeverity: { Error: 3 }, ProgressLocation: { Notification: 15 },
    QuickPickItemKind: { Separator: -1 }, ThemeIcon: class { constructor(id) { this.id = id; } },
    workspace: { isTrusted: true, textDocuments: [], registerTextDocumentContentProvider: noop },
    commands: { executeCommand: (_command, key, value) => contextKeys.set(key, value), registerCommand: (key, action) => commands.set(key, action) },
    window: {
      createTreeView: () => tree,
      registerWebviewViewProvider: noop, withProgress: (_options, task) => task(), ...window
    }
  };
  const { activate } = loadWithMocks(require.resolve('../src/extension'), {
    vscode, './model/repoModel': { RepoRegistry: function () { return registry; } },
    './views/branchesProvider': { BranchesProvider: class { refresh() {} } }, './panel/graphController': { GraphController: class {
      range = 'HEAD';
      constructor(_context, _registry, _documents, ui) { this.ui = ui; history = this; }
      setRange(_repo, ref) { this.range = ref; }
      compare(_repo, left, right) { this.comparison = { left, right }; }
      async show() {}
      commitCommand(kind, { rows, guard = noop }) { return this.ui.historyCommit(kind, repo, repo.snapshot.head, rows, guard); }
      worktreeCommand(kind, { guard = noop } = {}) { return this.ui.localChanges(kind, repo, repo.snapshot.head, guard); }
      askCommitMessage(...args) { return window.askCommitMessage(...args); }
    } },
    './panel/historyDocuments': { HistoryDocuments: class {} }
  });
  activate({ subscriptions: [] });
  const action = (id, arg) => commands.get(`git-branch.${id}`)(typeof arg === 'string' ? { repoId: repo.id, ref: arg } : arg);
  return Object.assign(action, { repository: repo.repository, registry, history, tree, contextKeys, notify: () => listeners.forEach(listener => listener()) });
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

test('commit dates keep the local minute format in columns and use a single second-precise format elsewhere', () => {
  const iso = new Date(2026, 0, 2, 3, 4, 5).toISOString();
  assert.deepEqual(formatCommitTime(iso), { label: '2026/01/02 03:04', precise: '2026-01-02 03:04:05' });
  assert.deepEqual(formatCommitTime(undefined), { label: '—', precise: '—' });
  assert.deepEqual(formatCommitTime('invalid'), { label: 'invalid', precise: 'invalid' });
});

test('history follows the checked-out branch by default and preserves manually chosen ranges', async t => {
  const { GraphController } = loadWithMocks(require.resolve('../src/panel/graphController'), { vscode: {} });
  const main = { ref: 'refs/heads/main', name: 'main', kind: 'local', oid: '1'.repeat(40) };
  const other = { ref: 'refs/heads/other', name: 'other', kind: 'local', oid: '2'.repeat(40) };
  const allRefs = [main, other];
  const byRef = new Map(allRefs.map(ref => [ref.ref, ref]));
  const snapshot = ({ ref, oid }) => ({ head: { ref, oid }, allRefs, byRef, shallow: '' });
  const tips = [];
  const reads = { historyPage: async options => {
    tips.push(options.tips);
    return { commits: [], hasMore: false, scanned: 0 };
  }, worktreeFiles: async () => [] };
  const repo = { id: 'repo', name: 'repo', root: {}, reads };
  const registry = { active: repo, repositories: new Map([[repo.id, repo]]), onChange: () => ({ dispose() {} }) };
  const controller = new GraphController({}, registry, {}, {});
  t.after(() => controller.dispose());
  controller.ready = true;
  controller.view = { visible: true, webview: { postMessage: () => true } };
  assert.equal(controller.meta().range, 'HEAD', 'while reading the repository');
  const checkout = head => { repo.snapshot = snapshot(head); controller.repoChanged(); };
  checkout(main);
  assert.equal(controller.meta().range, 'main');
  checkout(other);
  assert.equal(controller.meta().range, 'other');
  checkout({ ref: 'refs/heads/same-tip', oid: other.oid });
  assert.equal(controller.meta().range, 'same-tip', 'switching branches at the same commit updates the label');
  checkout({ oid: other.oid });
  assert.equal(controller.meta().range, 'HEAD', 'detached HEAD keeps showing the checked-out revision');
  checkout({ ref: 'refs/heads/unborn' });
  assert.equal(controller.meta().range, 'unborn');
  assert.deepEqual(tips, [[main.oid], [other.oid], [other.oid], []], 'detaching re-queries to remove any working-tree row');
  controller.setRange(repo, 'all');
  checkout(main);
  assert.equal(controller.meta().range, message('history.allBranches'));
  assert.deepEqual(tips.at(-1), [main.oid, other.oid]);
  controller.setRange(repo, other.ref);
  assert.equal(controller.meta().range, 'other');
  checkout({ oid: main.oid });
  assert.deepEqual(controller.target.tips, [other.oid]);
  assert.equal(controller.range, other.ref);
  controller.setRange(repo, 'HEAD');
  assert.deepEqual(tips.at(-1), [main.oid]);
  controller.setRange(repo, 'all');
  registry.active = { ...repo, id: 'next', snapshot: snapshot(other) };
  controller.repoChanged();
  assert.equal(controller.meta().range, 'other', 'new repositories start at the checked-out branch');
  assert.deepEqual(tips.at(-1), [other.oid]);
  await Promise.resolve();
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

test('the history range picker stars the current branch and keeps native Local, Remote and optional Tags sections', async t => {
  const f = await fixture(t);
  const local = await f.repo('local');
  const oid = await local.commit('source commit', { 'base.txt': 'base' });
  await local.git('branch', 'a-topic');
  await local.git('update-ref', 'refs/remotes/origin/main', oid);
  await local.git('tag', '-a', 'v1', '-m', 'Version 1');
  await local.git('tag', 'blob-tag', 'HEAD:base.txt');
  let scenario;
  let disposed = 0;
  const action = await workbench(local, {
    createQuickPick() {
      let accept, hide;
      return {
        onDidAccept(listener) { accept = listener; },
        onDidHide(listener) { hide = listener; },
        show() { scenario(this, accept); },
        hide() { hide(); },
        dispose() { disposed++; }
      };
    }
  });
  const { registry, history } = action;
  const { active: repo } = registry;
  // Exercise visibility even with cached tag refs present after a toggle.
  repo.snapshot = await local.reads.snapshot(local.dirs, true);
  scenario = (picker, accept) => {
    assert.deepEqual(picker.items.map(item => item.label), ['HEAD', 'All Branches', 'Local', 'main', 'a-topic', 'Remote', 'origin/main']);
    assert.deepEqual(picker.items.filter(item => item.kind === -1).map(item => item.label), ['Local', 'Remote']);
    assert.deepEqual(picker.activeItems, [picker.items[3]]);
    assert.equal(picker.activeItems[0].iconPath.id, 'star-full');
    assert.deepEqual(picker.items.map(item => item.iconPath?.id), [undefined, undefined, undefined, 'star-full', 'git-branch', undefined, 'git-branch']);
    assert.equal(picker.activeItems[0].description, undefined);
    assert.equal(picker.items[0].description, undefined);
    assert.equal(picker.matchOnDescription, true);
    picker.selectedItems = [picker.items[5]];
    accept();
    picker.hide();
  };
  await history.ui.chooseRange();
  assert.equal(history.range, 'HEAD', 'a separator or a cancellation does not change the range');
  let finishRefresh;
  registry.setTags = show => new Promise(resolve => {
    registry.showTags = show;
    finishRefresh = resolve;
  });
  const enabling = action('showTags');
  history.range = 'refs/remotes/origin/main';
  scenario = (picker, accept) => {
    assert.equal(picker.activeItems[0].ref, 'refs/remotes/origin/main');
    assert.deepEqual(picker.items.filter(item => item.kind === -1).map(item => item.label), ['Local', 'Remote', 'Tags']);
    assert.ok(picker.items.find(item => item.ref === 'refs/heads/main').iconPath);
    assert.ok(!picker.items.some(item => item.label === 'blob-tag'));
    assert.equal(picker.items.at(-1).iconPath.id, 'tag');
    picker.selectedItems = [picker.items.at(-1)];
    accept();
  };
  const chooseTag = history.ui.chooseRange();
  await delay(5);
  assert.equal(disposed, 1, 'opening the picker waits for the tag refresh');
  finishRefresh();
  await Promise.all([enabling, chooseTag]);
  assert.equal(history.range, 'refs/tags/v1');
  assert.deepEqual(await local.reads.head(), { ref: 'refs/heads/main', oid });
  await local.git('switch', '--detach', oid);
  repo.snapshot = await local.reads.snapshot(local.dirs, true);
  history.range = 'HEAD';
  scenario = picker => {
    assert.equal(picker.activeItems[0].ref, 'HEAD');
    assert.ok(!picker.items.some(item => item.iconPath?.id === 'star-full'));
    picker.hide();
  };
  await history.ui.chooseRange();
  assert.equal(disposed, 3);
});

test('comparison, history, checkout and push share the native ref layout but constrain their choices', async t => {
  const f = await fixture(t);
  const local = await f.repo('ref-picker');
  const oid = await local.commit('first');
  await local.git('branch', 'topic');
  await local.git('update-ref', 'refs/remotes/origin/topic', oid);
  await local.git('tag', 'v1');
  const expected = [];
  const seen = [];
  const action = await workbench(local, {
    createQuickPick() {
      let accept, hide;
      return {
        onDidAccept(listener) { accept = listener; }, onDidHide(listener) { hide = listener; },
        show() {
          const { title, labels, focus, choose, shortHashes, roles = {}, unavailable } = expected.shift();
          seen.push(this.title);
          assert.equal(this.title, title);
          assert.deepEqual(this.items.map(item => item.label), labels);
          assert.equal(this.matchOnDescription, true);
          assert.equal(this.activeItems[0]?.label, focus);
          for (const item of this.items.filter(item => item.kind !== -1 && !['HEAD', 'All Branches'].includes(item.label))) {
            assert.equal(item.description, shortHashes ? oid.slice(0, 8) : roles[item.label]);
            assert.equal(item.iconPath?.id, ({ main: 'star-full', v1: 'tag', 'Working Tree': 'folder' })[item.label] ?? 'git-branch');
          }
          if (unavailable) {
            this.selectedItems = [this.items.find(item => item.label === unavailable)];
            accept();
            assert.equal(this.hidden, undefined, 'the opposite endpoint is marked but cannot be accepted');
          }
          if (choose) {
            this.selectedItems = [this.items.find(item => item.label === choose)];
            accept();
          } else this.hide();
        },
        hide() { this.hidden = true; hide(); }, dispose() {}
      };
    },
    showErrorMessage: value => assert.fail(value)
  });
  const { registry, history } = action;
  const repo = registry.active;
  registry.showTags = true;
  repo.snapshot = await local.reads.snapshot(local.dirs, true);
  const labels = ['Local', 'main', 'topic', 'Remote', 'origin/topic'];
  const compareLabels = ['Working Tree', ...labels];
  expected.push({ title: message('history.pickRange'), labels: ['HEAD', 'All Branches', ...labels, 'Tags', 'v1'], focus: 'main' });
  await history.ui.chooseRange();
  expected.push({ title: message('action.checkoutPick'), labels, focus: 'main', shortHashes: true });
  await action('checkout');
  expected.push({ title: message('action.pushPick'), labels: ['Local', 'main', 'topic'], focus: 'main', shortHashes: true });
  await action('push');
  const compareWithTopic = { title: message('action.comparePickWith', { name: 'topic' }), labels: compareLabels,
    focus: 'main', roles: { topic: 'Base' }, unavailable: 'topic' };
  expected.push({ ...compareWithTopic, choose: 'origin/topic' });
  await action('compareWith', 'refs/heads/topic');
  assert.equal(history.comparison.left.ref, 'refs/heads/topic');
  assert.equal(history.comparison.right.ref, 'refs/remotes/origin/topic');
  expected.push({ ...compareWithTopic, choose: 'main' });
  await action('compareWith', 'refs/heads/topic');
  assert.equal(history.comparison.left.ref, 'refs/heads/topic');
  assert.equal(history.comparison.right.ref, 'refs/heads/main');
  expected.push({ title: message('action.comparePickWith', { name: 'main' }), labels: compareLabels,
    focus: 'topic', roles: { main: 'Base' }, unavailable: 'main', choose: 'Working Tree' });
  await action('compareWith', 'refs/heads/main');
  assert.equal(history.comparison.left.ref, 'refs/heads/main');
  assert.deepEqual(history.comparison.right, { name: 'Working Tree', oid, worktree: true });
  const base = { title: message('action.comparePickBase'), labels: compareLabels, focus: 'main', choose: 'Working Tree' };
  const target = { title: message('action.comparePickTarget'), labels: compareLabels,
    focus: 'main', choose: 'topic', roles: { 'Working Tree': 'Base' }, unavailable: 'Working Tree' };
  expected.push(base, target);
  await action('compare');
  assert.deepEqual(expected, []);
  assert.deepEqual(seen.slice(-2), [base.title, target.title]);
  assert.deepEqual(history.comparison.left, { name: 'Working Tree', oid, worktree: true });
  assert.equal(history.comparison.right.ref, 'refs/heads/topic');
  expected.push({ title: target.title, labels: compareLabels, focus: 'origin/topic', roles: { main: 'Base', 'origin/topic': 'Target' } });
  assert.equal(await history.ui.pickComparisonRef(repo, 'right', { exclude: 'refs/heads/main', current: 'refs/remotes/origin/topic' }), undefined);
  assert.deepEqual(expected, []);
  assert.deepEqual(await local.reads.head(), { ref: 'refs/heads/main', oid });
});

test('Branches switches repositories from the inline action only when multiple repositories are open', async t => {
  const f = await fixture(t);
  const local = await f.repo('local');
  const action = await workbench(local, { showQuickPick: items => items.find(item => item.id === 'other') });
  const { registry, tree, contextKeys } = action;
  const key = 'git-branch.hasMultipleRepositories';
  assert.equal(contextKeys.get(key), false);
  assert.equal(tree.description, undefined);
  const other = { id: 'other', name: 'other' };
  registry.repositories.set(other.id, other);
  registry.choices = () => [...registry.repositories.values()];
  registry.select = async id => { registry.active = registry.repositories.get(id); action.notify(); };
  action.notify();
  assert.equal(contextKeys.get(key), true);
  assert.equal(tree.description, 'local');
  await action('selectRepository');
  assert.equal(registry.active, other);
  assert.equal(tree.description, 'other');
  registry.repositories.delete(local.url);
  action.notify();
  assert.equal(contextKeys.get(key), false);
  assert.equal(tree.description, undefined);
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
  assert.deepEqual(keys('file'), ['showDiff', 'editSource', 'openRepositoryVersion', 'applyFiles']);
  assert.equal(menu.find(row => row.command === 'git-branch.showDiff').group, '1_files@0');
  assert.equal(contributes.commands.find(row => row.command === 'git-branch.showDiff').enablement, 'gbCanShowDiff');
  assert.deepEqual(keys('worktree'), ['commitWorktree', 'rollbackWorktree', 'stashWorktree']);
  const scopes = [...keys('commit'), ...keys('file'), ...keys('worktree')];
  assert.equal(menu.length, scopes.length);
  for (const key of scopes) assert.ok(contributes.menus.commandPalette.some(row => row.command === `git-branch.${key}` && row.when === 'false'));
});

test('Uncommitted Changes picks specific files, prompts once for Rollback, and uses the amend message form', async t => {
  const { repo } = await fixture(t);
  const local = await repo('worktree-menu');
  const head = await local.commit('existing message', { 'picked.txt': 'base', 'keep.txt': 'base' });
  await local.write('picked.txt', 'chosen');
  await local.write('keep.txt', 'keep');
  await local.write('new.txt', 'stash this');
  let approveRollback = false, mode, selected = 'picked.txt', confirmations = 0;
  const action = await workbench(local, {
    showQuickPick: (items, options) => {
      if (!options.canPickMany) {
        assert.deepEqual(items.map(item => item.amend), [false, true]);
        return items[1];
      }
      assert.ok(options.title.includes('worktree-menu · main'));
      return items.filter(item => item.label === selected);
    },
    showWarningMessage: (_title, { modal, detail }, button) => {
      confirmations++;
      assert.equal(modal, true);
      assert.match(detail, /picked\.txt/);
      assert.doesNotMatch(detail, /keep\.txt/);
      return approveRollback ? button : undefined;
    },
    askCommitMessage: (_repo, _head, oid, value, requested) => {
      assert.equal(oid, head);
      assert.match(value, /^existing message/);
      mode = requested;
      return 'updated message';
    },
    showInputBox: () => '', showInformationMessage: () => {}, showErrorMessage: value => assert.fail(value)
  });
  await action('rollbackWorktree');
  assert.equal(await local.read('picked.txt'), 'chosen');
  approveRollback = true;
  await action('rollbackWorktree');
  assert.equal(await local.read('picked.txt'), 'base');
  assert.equal(await local.read('keep.txt'), 'keep');
  selected = 'new.txt';
  await action('stashWorktree');
  assert.match(await local.git('stash', 'list'), /Selected local changes/);
  await assert.rejects(local.read('new.txt'), { code: 'ENOENT' });
  selected = 'keep.txt';
  await action('commitWorktree');
  assert.equal(mode, 'amend');
  assert.equal((await local.reads.commit(await local.head())).message.trim(), 'updated message');
  assert.equal(confirmations, 2, 'only rollback has a modal confirmation');
});

test('worktree commands require a current virtual row and refresh only the comparison worktree endpoint', async () => {
  const { GraphController } = loadWithMocks(require.resolve('../src/panel/graphController'), { vscode: { workspace: { isTrusted: true } } });
  const head = { ref: 'refs/heads/main', oid: '1'.repeat(40) };
  const tip = '2'.repeat(40);
  const repo = { id: 'git', root: { fsPath: '/tmp/git' }, snapshot: { head, byRef: new Map(), allRefs: [] } };
  const registry = { active: repo, repositories: new Map([[repo.id, repo]]), onChange: () => ({ dispose() {} }) };
  const calls = [];
  const controller = new GraphController({}, registry, {}, { localChanges: (kind, target, expected, guard) => {
    guard();
    calls.push({ kind, target, expected });
    repo.snapshot = { ...repo.snapshot, head: { ...head, oid: tip } };
    return { message: 'done' };
  } });
  controller.ready = true;
  controller.view = { visible: true };
  controller.reset = keepSelection => assert.equal(keepSelection, true);
  const virtual = `worktree:${head.oid}`;
  const context = { webviewId: 'git-branch.log', gbArea: 'worktree', gbOid: virtual, gbRepo: repo.id, gbGeneration: controller.generation,
    gbRevision: controller.selectionRevision, gbHeadRef: head.ref, gbHeadOid: head.oid };
  controller.known.set(head.oid, { oid: head.oid });
  controller.known.set(virtual, { oid: virtual, baseOid: head.oid, worktree: true, side: 'left' });
  const pinned = { name: 'other', oid: '3'.repeat(40) };
  controller.comparison = { left: { worktree: true, oid: head.oid }, right: pinned };
  await assert.rejects(controller.worktreeCommand('commit', { ...context, gbOid: head.oid }), /changed/i);
  await assert.rejects(controller.worktreeCommand('commit', { ...context, gbRepo: 'other' }), /changed/i);
  await controller.worktreeCommand('commit', context);
  assert.deepEqual(calls, [{ kind: 'commit', target: repo, expected: head }]);
  assert.equal(controller.comparison.left.oid, tip);
  assert.equal(controller.comparison.right, pinned);
  await assert.rejects(controller.worktreeCommand('commit', context), /changed/i);
});

test('Branches keeps the native tree and exposes the expected menu for each branch type, in order', () => {
  const { contributes } = require('../package.json');
  const branches = contributes.views.scm.find(view => view.id === 'git-branch.branches');
  assert.ok(branches);
  assert.equal(branches.type ?? 'tree', 'tree');
  const titleMenu = contributes.menus['view/title'];
  assert.deepEqual(titleMenu.filter(item => item.group.startsWith('navigation@')), [
    { command: 'git-branch.selectRepository', when: 'view == git-branch.branches && git-branch.hasMultipleRepositories', group: 'navigation@1' },
    { command: 'git-branch.refresh', when: 'view == git-branch.branches', group: 'navigation@2' }
  ]);
  assert.equal(titleMenu.filter(item => item.command === 'git-branch.selectRepository').length, 1);
  assert.ok(!contributes.commands.some(item => ['git-branch.find', 'git-branch.create'].includes(item.command)));
  const menu = contributes.menus['view/item/context'];
  const menuFor = kind => menu.filter(item => {
    assert.ok(item.when.startsWith('view == git-branch.branches && '));
    const [, exactly, alternatives] = /viewItem (?:== gb-([a-z]+)|=~ \/\^gb-\(([a-z|]+)\)\$\/)$/u.exec(item.when);
    return exactly === kind || alternatives?.split('|').includes(kind);
  }).sort((a, b) => a.group.localeCompare(b.group)).map(item => item.command.slice('git-branch.'.length));
  assert.deepEqual(menuFor('current'), ['openHistory', 'createFrom', 'compareWith', 'newWorktree', 'pull', 'push', 'copyBranchName', 'renameBranch']);
  assert.deepEqual(menuFor('local'), ['openHistory', 'checkout', 'createFrom', 'checkoutUpdate', 'compareWith',
    'mergeIntoCurrent', 'rebaseCurrent', 'newWorktree', 'pull', 'push', 'copyBranchName', 'renameBranch', 'deleteBranch']);
  assert.deepEqual(menuFor('remote'), ['openHistory', 'checkoutRemote', 'createFrom', 'compareWith',
    'mergeIntoCurrent', 'rebaseCurrent', 'newWorktree', 'pullMerge', 'pullRebase', 'copyBranchName', 'deleteBranch']);
  assert.deepEqual(menuFor('head'), ['openHistory']);
  assert.deepEqual(menuFor('tag'), ['openHistory']);
  assert.deepEqual(menuFor('section'), []);
  const catalog = require('../package.nls.json');
  const label = command => catalog[contributes.commands.find(item => item.command === `git-branch.${command}`).title.slice(1, -1)];
  assert.equal(label('compareWith'), 'Compare with…');
  assert.equal(label('checkout'), 'Checkout');
  assert.equal(label('checkoutRemote'), 'Checkout');
  assert.equal(label('pull'), 'Update');
  assert.equal(label('deleteBranch'), 'Delete…');
});

test('current branch history shows a shared Uncommitted Changes row before HEAD without consuming a page slot', async t => {
  const f = await fixture(t);
  const local = await f.repo('current-worktree');
  const base = await local.commit('initial', { 'staged.txt': 'old', 'tracked.txt': 'old', '.gitignore': 'ignored.txt\n' });
  const oid = await local.commit('newest');
  await local.git('branch', 'topic'); // Same OID does not make it the checked-out branch.
  await local.git('update-ref', 'refs/remotes/origin/main', oid);
  await local.git('tag', 'tip');
  await local.write('staged.txt', 'new staged');
  await local.git('add', '--', 'staged.txt');
  await local.write('tracked.txt', 'saved but unstaged');
  await local.write('new.txt', 'untracked');
  await local.write('ignored.txt', 'ignored');
  const originalPage = local.reads.historyPage.bind(local.reads);
  local.reads.historyPage = options => originalPage({ ...options, limit: 1 });
  const { GraphController } = loadWithMocks(require.resolve('../src/panel/graphController'), { vscode: {} });
  const repo = { id: local.url, root: { fsPath: local.dir }, name: 'local', reads: local.reads,
    snapshot: await local.reads.snapshot(local.dirs, true), commitCache: new Map(), filesCache: new Map() };
  const registry = { active: repo, showTags: true, repositories: new Map([[repo.id, repo]]), onChange: () => ({ dispose() {} }) };
  const opened = [];
  const controller = new GraphController({}, registry, { open: (_repo, change) => opened.push(change) }, {});
  t.after(() => controller.dispose());
  controller.ready = true;
  controller.view = { visible: true, webview: { postMessage: () => true } };
  controller.resume();
  const send = (type, data) => controller.onMessage({ type, generation: controller.generation, repoId: repo.id, ...data });
  const virtual = `worktree:${oid}`;
  await waitFor(() => controller.selectionPacket?.files?.length === 3, 'local file diff');
  assert.deepEqual(controller.rows.map(row => row.oid), [virtual, oid]);
  assert.equal(controller.rows[0].subject, message('history.workingTreeCommit'));
  assert.deepEqual(controller.rows[0].graph.edges.map(edge => edge.oid), [oid]);
  assert.equal(controller.rows[1].graph.incoming, true);
  assert.equal(controller.selectionPacket.detail, undefined);
  assert.deepEqual(controller.selectionPacket.files.map(file => [file.path, file.status]).sort(),
    [['new.txt', 'A'], ['staged.txt', 'M'], ['tracked.txt', 'M']]);
  const file = controller.selectionPacket.files.find(file => file.path === 'tracked.txt');
  assert.equal(file.apply, false);
  await send('openDiff', { token: file.id });
  assert.equal(opened[0].workingTree, true);
  assert.equal(opened[0].baseOid, oid);
  assert.equal(await local.reads.workingBlob(opened[0]), 'saved but unstaged');
  await send('loadMore');
  assert.deepEqual(controller.rows.map(row => row.oid), [virtual, oid, base]);
  assert.equal(controller.hasMore, false);

  for (const range of ['refs/heads/main', 'refs/heads/topic', 'refs/remotes/origin/main', 'refs/tags/tip', 'all', 'HEAD']) {
    controller.setRange(repo, range);
    await waitFor(() => controller.pageLoaded, range);
    assert.equal(Boolean(controller.rows[0]?.worktree), range === 'refs/heads/main' || range === 'HEAD');
  }
  await send('setFilter', { text: 'newest' });
  await waitFor(() => controller.pageLoaded, 'filter omits the virtual row');
  assert.deepEqual(controller.rows.map(row => row.oid), [oid]);
  await send('setFilter', { text: 'Uncommitted' });
  await waitFor(() => controller.pageLoaded, 'filter matches the virtual row');
  assert.deepEqual(controller.rows.map(row => row.oid), [virtual]);
  assert.deepEqual(controller.rows[0].graph.edges.map(edge => edge.oid), [oid], 'missing HEAD is a boundary, not a synthetic link');
  await local.git('checkout', '--detach', oid);
  repo.snapshot = await local.reads.snapshot(local.dirs, true);
  controller.repoChanged();
  await send('setFilter', { text: '' });
  await waitFor(() => controller.pageLoaded, 'detached HEAD history');
  assert.equal(controller.rows[0].oid, oid);
});

test('current branch history updates local changes without resetting the loaded commit pages or stealing selection', async t => {
  const f = await fixture(t);
  const local = await f.repo('live-worktree');
  const oid = await local.commit('initial', { 'tracked.txt': 'clean' });
  const { GraphController } = loadWithMocks(require.resolve('../src/panel/graphController'), { vscode: {} });
  const repo = { id: local.url, root: { fsPath: local.dir }, name: 'local', reads: local.reads,
    snapshot: await local.reads.snapshot(local.dirs, false), commitCache: new Map(), filesCache: new Map() };
  const notify = async () => {
    repo.snapshot = await local.reads.snapshot(local.dirs, false);
    controller.repoChanged();
  };
  const registry = { active: repo, repositories: new Map([[repo.id, repo]]), onChange: () => ({ dispose() {} }), refresh: notify };
  const controller = new GraphController({}, registry, {}, {});
  t.after(() => controller.dispose());
  controller.ready = true;
  controller.view = { visible: true, webview: { postMessage: () => true } };
  controller.resume();
  await waitFor(() => controller.selectionPacket?.detail?.oid === oid, 'clean history');
  assert.deepEqual(controller.rows.map(row => row.oid), [oid]);
  const { generation } = controller;
  const realRow = controller.rows[0];
  const send = (type, data) => controller.onMessage({ type, generation: controller.generation, repoId: repo.id, ...data });
  await local.write('tracked.txt', 'local');
  await notify();
  await waitFor(() => controller.rows[0]?.worktree, 'insert the virtual row');
  const virtual = controller.rows[0].oid;
  assert.equal(controller.rows[1], realRow);
  assert.equal(controller.selection.focus, oid);
  await send('select', { oid: virtual, mode: 'replace' });
  await local.write('extra.txt', 'new untracked file');
  await notify();
  await waitFor(() => controller.selectionPacket?.files?.length === 2, 'update the selected virtual diff');
  await local.write('tracked.txt', 'clean');
  await local.git('clean', '-f', '--', 'extra.txt');
  await notify();
  await waitFor(() => controller.selectionPacket?.detail?.oid === oid, 'remove the virtual row and restore HEAD selection');
  assert.deepEqual(controller.rows, [realRow]);
  assert.equal(controller.known.has(virtual), false);
  assert.equal(controller.generation, generation);
});

test('history opens the working tree Diff using a host-issued file token and saved bytes', async t => {
  const f = await fixture(t);
  const local = await f.repo('local');
  const base = await local.commit('initial', { 'file.txt': 'on branch' });
  await local.git('branch', 'base');
  const current = await local.commit('current', { 'file.txt': 'in head' });
  await local.write('file.txt', 'on disk');
  await local.write('untracked.txt', 'available only locally');
  const calls = [], editors = [];
  const vscode = { Uri: { from: ({ scheme, path }) => `${scheme}:${path}` },
    workspace: { isTrusted: true }, window: { showTextDocument: uri => editors.push(uri) },
    commands: { executeCommand: (...args) => calls.push(args) } };
  const { GraphController } = loadWithMocks(require.resolve('../src/panel/graphController'), { vscode });
  const { HistoryDocuments } = loadWithMocks(require.resolve('../src/panel/historyDocuments'), { vscode });
  const repo = { id: local.url, root: { fsPath: local.dir }, name: 'local',
    snapshot: await local.reads.snapshot(local.dirs, false), reads: local.reads, actions: local.actions,
    commitCache: new Map(), filesCache: new Map() };
  const registry = { active: repo, repositories: new Map([[repo.id, repo]]), onChange: () => ({ dispose() {} }), refresh: async () => {
    repo.snapshot = await local.reads.snapshot(local.dirs, false);
    controller.repoChanged();
  } };
  const documents = new HistoryDocuments();
  const controller = new GraphController({}, registry, documents, {});
  t.after(() => { controller.dispose(); documents.dispose(); });
  controller.ready = true;
  controller.view = { visible: true, webview: { postMessage: () => true } };
  await controller.compareWorktree(repo, await local.actions.named('refs/heads/base'));
  await waitFor(() => controller.comparePacket?.files && controller.selectionPacket?.files, 'load worktree comparison and synthetic selection');
  const scope = { repoId: repo.id, generation: controller.generation };
  const send = (type, data) => controller.onMessage({ type, generation: controller.generation, repoId: repo.id, ...data });
  assert.deepEqual(controller.meta().compare, { left: { label: 'base', oid: base }, right: { label: 'Working Tree', oid: current, worktree: true },
    collapsed: [], workingTree: true, stale: false });
  assert.deepEqual(controller.comparePacket.counts, { left: 0, right: 2 });
  const synthetic = controller.rows.find(row => row.worktree);
  assert.equal(synthetic.side, 'right');
  assert.equal(synthetic.subject, 'Uncommitted Changes');
  assert.deepEqual(synthetic.parents, [current]);
  assert.deepEqual(synthetic.graph.edges.map(edge => edge.oid), [current]);
  assert.equal(controller.known.get(current).graph.incoming, true);
  assert.equal(controller.selection.focus, synthetic.oid);
  assert.equal(controller.selectionPacket.detail, undefined);
  assert.ok(controller.selectionPacket.files.every(file => !file.apply));
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
    await assert.rejects(controller.fileCommand('showDiff', { ...context, ...overrides }), stale);
  }
  assert.deepEqual(editors, []);
  assert.equal(calls.length, 1);
  const otherFiles = controller.comparePacket.files.filter(candidate => candidate.id !== file.id).map(candidate => candidate.id);
  await send('selectFiles', { source: 'snapshot', ids: otherFiles });
  await controller.fileCommand('showDiff', context);
  assert.deepEqual([...controller.fileSelection.snapshot], otherFiles);
  assert.equal(calls.length, 2);
  assert.equal(calls.at(-1)[0], 'vscode.diff');
  assert.deepEqual(calls.at(-1).slice(1, 3).map(uri => documents.provideTextDocumentContent(uri)), ['on branch', 'on disk']);
  await controller.fileCommand('openRepositoryVersion', context);
  assert.equal(documents.provideTextDocumentContent(editors[0]), 'on branch');
  await controller.onMessage({ ...scope, type: 'swap' });
  await waitFor(() => controller.comparePacket?.files && controller.selectionPacket?.files, 'load reversed comparison');
  assert.equal(controller.comparison.right.oid, base);
  assert.equal(controller.comparison.left.worktree, true);
  assert.deepEqual(controller.comparePacket.counts, { left: 2, right: 0 });
  const leftWorktree = controller.rows.find(row => row.worktree);
  assert.equal(leftWorktree.side, 'left');
  assert.deepEqual(leftWorktree.graph.edges.map(edge => edge.oid), [current]);
  assert.equal(controller.known.get(current).graph.incoming, true);
  assert.equal(controller.comparePacket.files.find(file => file.path === 'untracked.txt').status, 'D');
  await send('openDiff', { token: controller.comparePacket.files.find(file => file.path === 'file.txt').id });
  assert.deepEqual(calls.at(-1).slice(1, 3).map(uri => documents.provideTextDocumentContent(uri)), ['on disk', 'on branch']);
  await send('openDiff', { token: controller.selectionPacket.files.find(file => file.path === 'file.txt').id });
  assert.deepEqual(calls.at(-1).slice(1, 3).map(uri => documents.provideTextDocumentContent(uri)), ['in head', 'on disk']);
  await send('selectAllCommits', { focusedOid: current });
  await waitFor(() => controller.selectionPacket?.files?.length === 2, 'combined real and synthetic changes');
  const combined = controller.selectionPacket.files.find(file => file.path === 'file.txt');
  assert.equal(combined.apply, false);
  assert.equal(combined.includesGap, false);
  assert.equal(combined.repositoryVersion, true);
  await send('openDiff', { token: combined.id });
  assert.deepEqual(calls.at(-1).slice(1, 3).map(uri => documents.provideTextDocumentContent(uri)), ['on branch', 'on disk']);
  await assert.rejects(controller.commitCommand('copyRevision', { ...context, gbArea: 'commit', gbGeneration: controller.generation,
    gbRevision: controller.selectionRevision, gbOid: synthetic.oid }), { message: message('history.worktreeNotACommit') });

  const newHead = await local.commit('commit the working files', { 'file.txt': 'committed' });
  await local.write('file.txt', 'saved after commit');
  await send('refresh');
  await waitFor(() => controller.comparePacket?.files && controller.rows.find(row => row.worktree)?.baseOid === newHead, 'refresh pins actual HEAD');
  assert.equal(controller.comparison.left.oid, newHead);
  assert.equal(controller.meta().compare.stale, false);
  assert.equal(await local.read('file.txt'), 'saved after commit');

  await controller.compareWorktree(repo, await local.actions.named('refs/heads/main'));
  await waitFor(() => controller.comparePacket?.files && controller.rows.length, 'worktree comparison against its own HEAD');
  assert.deepEqual(controller.rows.map(row => row.oid), [`worktree:${newHead}`]);
  assert.deepEqual(controller.rows[0].graph.edges.map(edge => edge.oid), [newHead]);
  assert.equal(controller.known.has(newHead), false, 'a shared HEAD is not injected into the unique commits');
});

test('the toolbar picks either comparison endpoint and cancels drafts on dismissal or repository change', async t => {
  const f = await fixture(t);
  const local = await f.repo('comparison-picker');
  const oid = await local.commit('first');
  await local.git('branch', 'topic');
  await local.git('branch', 'other');
  await local.git('tag', 'version');
  const { GraphController } = loadWithMocks(require.resolve('../src/panel/graphController'), { vscode: {} });
  const main = 'refs/heads/main', topic = 'refs/heads/topic', other = 'refs/heads/other';
  const repo = { id: local.url, root: { fsPath: local.dir }, name: 'local', actions: local.actions,
    snapshot: await local.reads.snapshot(local.dirs, true), reads: local.reads, commitCache: new Map(), filesCache: new Map() };
  const second = { ...repo, id: 'second', commitCache: new Map(), filesCache: new Map() };
  const registry = { active: repo, showTags: true, repositories: new Map([[repo.id, repo], [second.id, second]]),
    onChange: () => ({ dispose() {} }) };
  const messages = [];
  let picker;
  const controller = new GraphController({}, registry, {}, {
    pickComparisonRef: (repository, side, options) => new Promise(resolve => { picker = { ...options, repository, side, resolve }; })
  });
  t.after(() => controller.dispose());
  controller.view = { visible: true, webview: { postMessage: packet => messages.push(packet) } };
  controller.ready = true;
  const send = type => controller.onMessage({ type, generation: controller.generation, repoId: controller.repo.id });
  const switchTo = next => { registry.active = next; controller.repoChanged(); };

  for (const [range, base, draft] of [['all', main, 'main'], ['refs/tags/version', main, 'main'], [topic, topic, 'topic']]) {
    controller.setRange(repo, range);
    const generation = controller.generation;
    const pending = send('startComparison');
    assert.equal(messages.at(-1).type, 'meta');
    assert.equal(messages.at(-1).payload.compareDraft, draft);
    assert.equal(picker.exclude, base);
    assert.equal(picker.side, 'right');
    assert.equal(picker.repository, repo);
    assert.equal(controller.meta().compare, undefined);
    picker.resolve(undefined);
    await pending;
    assert.equal(controller.meta().compareDraft, undefined);
    assert.equal(controller.generation, generation);
    assert.equal(controller.range, range);
  }

  let choosing = send('startComparison');
  picker.resolve(main);
  await choosing;
  assert.deepEqual([controller.comparison.left.ref, controller.comparison.right.ref], [topic, main]);
  assert.equal(controller.meta().compareDraft, undefined);
  assert.equal(controller.meta().pickingEndpoint, false);

  const pinnedRight = controller.comparison.right;
  choosing = send('chooseRange');
  assert.equal(picker.side, 'left');
  assert.equal(picker.current, topic);
  assert.equal(picker.exclude, main);
  picker.resolve(other);
  await choosing;
  const pinnedLeft = controller.comparison.left;
  assert.equal(pinnedLeft.ref, other);
  assert.equal(controller.comparison.right, pinnedRight, 'do not re-pin the other endpoint');

  choosing = send('chooseTarget');
  assert.equal(picker.side, 'right');
  assert.equal(picker.current, main);
  assert.equal(picker.exclude, other);
  picker.resolve(undefined);
  await choosing;
  assert.equal(controller.comparison.right, pinnedRight, 'cancelling keeps the existing comparison');
  choosing = send('chooseTarget');
  picker.resolve(topic);
  await choosing;
  assert.equal(controller.comparison.left, pinnedLeft);
  assert.equal(controller.comparison.right.ref, topic);

  const pinnedTopic = controller.comparison.right;
  choosing = send('chooseTarget');
  picker.resolve('worktree');
  await choosing;
  assert.equal(controller.comparison.left, pinnedLeft);
  const pinnedWorktree = controller.comparison.right;
  assert.equal(pinnedWorktree.worktree, true);
  assert.equal(pinnedWorktree.oid, oid);
  choosing = send('chooseRange');
  assert.equal(picker.current, other);
  assert.equal(picker.exclude, 'worktree');
  picker.resolve('worktree');
  await choosing;
  assert.equal(controller.comparison.left, pinnedLeft);
  assert.equal(controller.comparison.right, pinnedWorktree, 'reject choosing the opposite worktree endpoint');
  choosing = send('chooseTarget');
  assert.equal(picker.current, 'worktree');
  picker.resolve(pinnedTopic.ref);
  await choosing;
  assert.equal(controller.comparison.right.ref, topic);

  await send('exitComparison');
  assert.equal(controller.range, topic, 'exiting restores the pre-comparison history range');
  choosing = send('startComparison');
  picker.resolve(main);
  await choosing;
  choosing = send('chooseRange');
  const pending = picker;
  switchTo(second);
  assert.equal(pending.signal.aborted, true);
  assert.equal(controller.meta().compare, undefined);
  assert.equal(controller.range, 'HEAD');
  switchTo(repo);
  pending.resolve(other);
  await choosing;
  assert.equal(controller.meta().compare, undefined, 'a late result cannot revive comparison after a repository switch');
  assert.deepEqual(await local.reads.head(), { ref: main, oid });
});

test('comparison groups fold independently without reloading history or changing File Diff', async t => {
  const f = await fixture(t);
  const local = await f.repo('comparison-fold');
  await local.commit('shared', { 'file.txt': 'shared' });
  await local.git('branch', 'topic');
  const left = await local.commit('base only', { 'file.txt': 'base' });
  await local.git('switch', 'topic');
  const right = await local.commit('target only', { 'file.txt': 'target' });
  const { GraphController } = loadWithMocks(require.resolve('../src/panel/graphController'), { vscode: {} });
  const repo = { id: local.url, root: { fsPath: local.dir }, name: 'local', actions: local.actions,
    snapshot: await local.reads.snapshot(local.dirs, false), reads: local.reads, commitCache: new Map(), filesCache: new Map() };
  const controller = new GraphController({}, { active: repo, repositories: new Map([[repo.id, repo]]),
    onChange: () => ({ dispose() {} }), refresh: async () => {} }, {}, {});
  t.after(() => controller.dispose());
  controller.view = { visible: true, webview: { postMessage: () => true } };
  controller.ready = true;
  const branches = await Promise.all(['main', 'topic'].map(name => local.actions.named(`refs/heads/${name}`)));
  const send = (type, args = {}) => controller.onMessage({ type, generation: controller.generation, repoId: repo.id, ...args });
  const waitRows = async oids => {
    await waitFor(() => !controller.pageState().loading && controller.rows.length === oids.length, 'load comparison commits');
    assert.deepEqual(new Set(controller.rows.map(row => row.oid)), new Set(oids));
  };
  controller.compare(repo, ...branches);
  await waitRows([left, right]);
  await waitFor(() => controller.comparePacket?.files && controller.selectionPacket?.detail, 'load comparison and commit selection');
  assert.deepEqual(controller.displayRows().map(row => row.oid), [left, right]);
  assert.equal(controller.selection.focus, left);
  await send('select', { oid: right, mode: 'range' });
  assert.deepEqual([...controller.selection.selected], [left, right]);
  const packet = controller.comparePacket;
  assert.deepEqual(packet.counts, { left: 1, right: 1 });
  const [file] = packet.files;
  await send('selectFiles', { source: 'snapshot', ids: [file.id] });

  const generation = controller.generation;
  const rows = controller.rows;
  await send('toggleComparisonGroup', { side: 'left' });
  assert.deepEqual(controller.meta().compare.collapsed, ['left']);
  assert.deepEqual(controller.displayRows().map(row => row.oid), [right]);
  assert.deepEqual([...controller.selection.selected], [right]);
  await send('toggleComparisonGroup', { side: 'right', generation: generation - 1 });
  await send('select', { oid: left, mode: 'toggle' });
  await send('selectAllCommits');
  assert.deepEqual([...controller.selection.selected], [right]);
  await send('toggleComparisonGroup', { side: 'right' });
  assert.deepEqual(controller.displayRows(), []);
  assert.equal(controller.selection.selected.size, 0);
  await send('toggleComparisonGroup', { side: 'right' });
  assert.deepEqual(controller.displayRows().map(row => row.oid), [right]);
  assert.equal(controller.generation, generation);
  assert.equal(controller.rows, rows);
  assert.equal(controller.comparePacket, packet);
  assert.ok(controller.snapshotFiles.has(file.id));
  assert.deepEqual([...controller.fileSelection.snapshot], [file.id]);

  await send('setFilter', { text: 'base' });
  await waitRows([left]);
  assert.deepEqual(controller.displayRows(), []);
  await send('setFilter', { text: '' });
  await waitRows([left, right]);
  assert.deepEqual(controller.displayRows().map(row => row.oid), [right]);
  assert.equal(controller.comparePacket, packet);

  await send('swap');
  await waitRows([left, right]);
  assert.deepEqual(controller.meta().compare.collapsed, ['right']);
  assert.deepEqual(controller.displayRows().map(row => row.oid), [right]);
  await send('refresh');
  await waitRows([left, right]);
  assert.deepEqual(controller.meta().compare.collapsed, ['right']);
  await local.git('branch', '-f', 'main', 'topic');
  await send('refresh');
  await waitFor(() => controller.comparePacket?.same, 'show same-tip comparison after refresh');
  await waitRows([]);
  assert.deepEqual(controller.comparePacket.counts, { left: 0, right: 0 });
  assert.deepEqual(controller.comparePacket.files, []);
  await send('exitComparison');
  assert.equal(controller.meta().compare, undefined);
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
  for (const file of [combined, fromMain]) await send('openDiff', { token: file.id });
  await controller.fileCommand('showDiff', { webview: 'git-branch.log', gbArea: 'file',
    gbGeneration: controller.generation, gbRepo: repo.id, gbRevision: controller.selectionRevision,
    gbHeadRef: repo.snapshot.head.ref, gbHeadOid: merge, gbSource: 'commit', gbToken: fromSide.id });
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

test('keyboard commit selection covers all loaded rows and bounds combined diffs and writes', async t => {
  const f = await fixture(t);
  const local = await f.repo('keyboard-commits');
  const base = await local.commit('base', { 'base.txt': 'base\n' });
  const tip = await local.commit('tip', { 'tip.txt': 'tip\n' });
  const vscode = { workspace: { isTrusted: true } };
  const { GraphController } = loadWithMocks(require.resolve('../src/panel/graphController'), { vscode });
  const repo = { id: local.url, root: { fsPath: local.dir }, name: 'local', actions: local.actions,
    snapshot: await local.reads.snapshot(local.dirs, false), reads: local.reads, commitCache: new Map(), filesCache: new Map() };
  const registry = { active: repo, repositories: new Map([[repo.id, repo]]), onChange: () => ({ dispose() {} }) };
  const commands = [];
  const controller = new GraphController({}, registry, {}, {
    historyCommit: (kind, _repo, _head, rows) => commands.push({ kind, count: rows.length })
  });
  t.after(() => controller.dispose());
  controller.view = { visible: true, webview: { postMessage: () => true } };
  await controller.onMessage({ type: 'ready' });
  await waitFor(() => controller.selectionPacket?.detail?.oid === tip, 'load initial commit');
  const send = (type, data) => controller.onMessage({ type, generation: controller.generation, repoId: repo.id, ...data });
  await send('selectAllCommits', { focusedOid: base });
  assert.deepEqual(controller.selectionPacket.selected, [tip, base]);
  assert.equal(controller.selectionPacket.focus, base);
  assert.deepEqual(controller.selectionPacket.files.map(file => file.path), ['base.txt', 'tip.txt']);
  await send('clearCommits', { generation: controller.generation - 1 });
  assert.equal(controller.selectionPacket.selected.length, 2);
  await send('clearCommits');
  assert.deepEqual(controller.selectionPacket.selected, []);
  assert.equal(controller.selectionPacket.focus, undefined);
  assert.equal(controller.selectionFiles.size, 0);
  await send('selectAllCommits');
  assert.equal(controller.selectionPacket.selected.length, 2);

  for (let index = 1; index <= 49; index++) {
    const row = { oid: index.toString(16).padStart(40, '0') };
    controller.rows.push(row);
    controller.known.set(row.oid, row);
  }
  let reads = 0;
  controller.readCommit = () => { reads++; throw new Error('Unexpected read for an oversized selection'); };
  await send('selectAllCommits');
  await send('retrySelection');
  assert.equal(controller.selectionPacket.selected.length, 51);
  assert.equal(controller.selectionPacket.selectionOverLimit, 50);
  assert.equal(controller.selectionPacket.files, undefined);
  assert.equal(reads, 0);
  const context = { webview: 'git-branch.log', gbArea: 'commit', gbRepo: repo.id, gbGeneration: controller.generation,
    gbRevision: controller.selectionRevision, gbHeadRef: repo.snapshot.head.ref, gbHeadOid: tip, gbOid: tip };
  await assert.rejects(controller.commitCommand('cherryPick', context), { message: message('history.selectionLimit', { count: 50 }) });
  await controller.commitCommand('copyRevision', context);
  assert.deepEqual(commands, [{ kind: 'copyRevision', count: 51 }]);
  await send('clearCommits');
  assert.deepEqual(controller.selectionPacket.selected, []);
  assert.equal(controller.selectionPacket.selectionOverLimit, undefined);
});

test('file selection accepts more than the patch limit without allowing a large batch apply', async t => {
  const vscode = { workspace: { isTrusted: true } };
  const { GraphController } = loadWithMocks(require.resolve('../src/panel/graphController'), { vscode });
  const repo = { id: 'repo', name: 'local', root: { fsPath: 'repo' },
    snapshot: { byRef: new Map(), head: { oid: 'a'.repeat(40), ref: 'refs/heads/main' } } };
  const registry = { active: repo, repositories: new Map([[repo.id, repo]]), onChange: () => ({ dispose() {} }) };
  const controller = new GraphController({}, registry, {}, {
    applyHistoryFiles: () => assert.fail('Oversized selection must not apply')
  });
  t.after(() => controller.dispose());
  controller.view = { visible: true, webview: { postMessage: () => true } };
  controller.ready = true;
  const ids = Array.from({ length: 201 }, (_, index) => String(index));
  for (const id of ids) controller.selectionFiles.set(id, {});
  const select = values => controller.onMessage({ type: 'selectFiles', generation: controller.generation,
    repoId: repo.id, source: 'commit', ids: values });
  await select(ids);
  assert.deepEqual([...controller.fileSelection.commit], ids);
  await select(['not-a-token']);
  assert.equal(controller.fileSelection.commit.size, 201);
  await assert.rejects(controller.fileCommand('applyFiles', { webview: 'git-branch.log', gbArea: 'file', gbRepo: repo.id,
    gbGeneration: controller.generation, gbRevision: controller.selectionRevision, gbHeadRef: repo.snapshot.head.ref,
    gbHeadOid: repo.snapshot.head.oid, gbSource: 'commit', gbToken: ids[0], gbFiles: ids.join(',') }),
  { message: message('git.historyPatchFileLimit', { count: 200 }) });
  await select([]);
  assert.equal(controller.fileSelection.commit.size, 0);
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
  // HEAD identity includes the branch, even if switching branches keeps the same OID.
  repo.snapshot.head = { ...head, ref: 'refs/heads/topic' };
  assert.throws(calls[0].guard, stale);
  repo.snapshot.head = { ...head, oid: b.oid };
  assert.throws(calls[0].guard, stale);
  repo.snapshot.head = head;
  controller.selectionRevision++;
  assert.throws(calls[0].guard, stale);
  assert.equal(calls[0].r, repo);
  assert.equal(calls[0].h, head);
});

test('history HTML embeds Codicons from installed VS Code assets without allowing font requests', () => {
  const appRoot = path.resolve('mock-app');
  const modern = 'out/media/codicon.ttf';
  const legacy = 'out/vs/base/browser/ui/codicons/codicon/codicon.ttf';
  const builtInCss = 'extensions/simple-browser/media/codicon.css';
  const font = Buffer.from([0, 1, 0, 0]);
  for (const candidate of [modern, legacy, builtInCss, undefined]) {
    const reads = [];
    const vscode = { env: { appRoot }, Uri: { joinPath: (...parts) => parts.join('/') } };
    const { GraphController } = loadWithMocks(require.resolve('../src/panel/graphController'), { vscode,
      'node:fs': { readFileSync(file) {
        const relative = path.relative(appRoot, file).split(path.sep).join('/');
        reads.push(relative);
        if (relative === candidate) return relative === builtInCss ? `@font-face{src:url(data:font/ttf;base64,${font.toString('base64')})}` : font;
        throw new Error('not found');
      } }
    });
    const controller = new GraphController({}, { repositories: new Map(), onChange: () => ({ dispose() {} }) }, {}, {});
    const html = controller.html({ asWebviewUri: uri => uri, cspSource: 'webview:' }, 'media');
    controller.dispose();
    assert.deepEqual(reads, candidate === modern ? [modern] : candidate === legacy ? [modern, legacy] : [modern, legacy, builtInCss]);
    assert.equal(html.match(/data-codicon-font="([^"]+)"/)?.[1], candidate ? font.toString('base64') : undefined);
    assert.match(html, /default-src 'none'/);
    assert.doesNotMatch(html, /font-src/);
    assert.match(html, /class="refresh-label">[^<]+</);
    assert.match(html, /id="filter-text"[\s\S]*id="refresh"[\s\S]*id="swap"[\s\S]*id="exit-compare"[\s\S]*id="commit-columns"/);
    assert.doesNotMatch(html, /id="log-title"/);
    assert.match(html, /id="files"[\s\S]*<footer id="snapshot-caption"[\s\S]*<section id="details" class="details"[\s\S]*<h2[^>]*><button id="detail-title"[^>]*aria-expanded="true" aria-controls="detail-content"/);
    assert.match(html, /id="detail-content" class="detail-content scroll" tabindex="0"/);
    assert.match(html, /src="media\/historyRows\.js"[\s\S]*src="media\/graph\.js"/);
  }
});

test('branch hovers contain only the name and optional upstream; the current branch uses the native star', t => {
  const { BranchesProvider } = loadWithMocks(require.resolve('../src/views/branchesProvider'), { vscode: {
    TreeItemCollapsibleState: { None: 0, Expanded: 2 }, TreeItem: class {},
    ThemeIcon: class { constructor(id, color) { this.id = id; this.color = color; } },
    ThemeColor: class { constructor(id) { this.id = id; } }, EventEmitter: class {}
  } });
  const oid = 'a'.repeat(40);
  const main = { ref: 'refs/heads/main', name: 'main', kind: 'local', oid, upstream: { tracking: 'refs/remotes/origin/main' } };
  const topic = { ref: 'refs/heads/topic', name: 'topic', kind: 'local', oid,
    upstream: { tracking: 'refs/remotes/origin/topic' }, trackingCount: { ahead: 2, behind: 1 } };
  const remote = { ref: 'refs/remotes/origin/topic', name: 'origin/topic', kind: 'remote', oid };
  const tag = { ref: 'refs/tags/v1', name: 'v1', kind: 'tag', oid };
  const repo = { id: 'test', snapshot: { head: main, allRefs: [main, topic, remote, tag] } };
  const provider = new BranchesProvider({ showTags: true });
  t.after(() => configureLocale('en'));
  for (const language of ['en', 'zh-cn', 'zh-tw', 'ja']) {
    configureLocale(language);
    const upstream = message('branch.upstreamLabel', { name: 'origin/main' });
    const nodes = [
      [provider.roots(repo)[0], 'gb-head', ['main', upstream]],
      [provider.branch(repo, main), 'gb-current', ['main', upstream]],
      [provider.branch(repo, topic), 'gb-local', ['topic', message('branch.upstreamLabel', { name: 'origin/topic' })]],
      [provider.branch(repo, remote), 'gb-remote', ['origin/topic']],
      [provider.branch(repo, tag), 'gb-tag', ['v1']]
    ];
    for (const [node, contextValue, details] of nodes) {
      const treeItem = provider.getTreeItem(node);
      const current = contextValue === 'gb-current';
      assert.equal(treeItem.tooltip, details.join('\n'));
      assert.equal(treeItem.accessibilityInformation.label, (current ? [...details, message('branch.current')] : details).join('\n'));
      assert.equal(treeItem.iconPath?.id, current ? 'star-full' : contextValue === 'gb-tag' ? 'tag' : contextValue === 'gb-head' ? undefined : 'git-branch');
      assert.equal(treeItem.iconPath?.color?.id, current ? 'charts.yellow' : undefined);
      assert.equal(treeItem.contextValue, contextValue);
      assert.equal(treeItem.description, contextValue === 'gb-local' ? '↑2 ↓1' : contextValue === 'gb-head' ? undefined : '');
      assert.equal(treeItem.command.command, 'git-branch.activateRef');
    }
    const nonCommit = provider.getTreeItem(provider.branch(repo, { ...tag, oid: undefined }));
    assert.equal(nonCommit.contextValue, 'gb-noncommit-tag');
    assert.equal(nonCommit.tooltip, 'v1');
    assert.equal(nonCommit.command, undefined);
  }
});
