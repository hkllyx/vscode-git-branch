'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { GitOperations } = require('../src/git-operations');
const { formatGitDate } = require('../src/date-format');

async function fixture(t) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'gb-history-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const git = new GitOperations(cwd);
  await git.exec(['init', '-b', 'main']);
  await git.exec(['config', 'user.name', 'Test']);
  await git.exec(['config', 'user.email', 'test@example.invalid']);
  return { cwd, git };
}

test('branch history pagination is bounded, immutable and includes parent metadata', async t => {
  const { cwd, git } = await fixture(t);
  let input = '';
  for (let index = 1; index <= 205; index++) {
    const message = `Commit ${index}`;
    input += `commit refs/heads/main\nmark :${index}\ncommitter Test <test@example.invalid> ${1700000000 + index} +0000\ndata ${Buffer.byteLength(message)}\n${message}\n`;
    if (index > 1) input += `from :${index - 1}\n`;
    input += '\n';
  }
  execFileSync(git.executable, ['fast-import', '--quiet'], { cwd, input, windowsHide: true });
  const tip = await git.resolve('HEAD');
  const first = await git.branchHistory(tip);
  assert.equal(first.total, 205);
  assert.equal(first.commits.length, 200);
  assert.equal(first.commits[0].hash, tip);
  assert.equal(first.commits[0].parents.length, 1);
  assert.equal(first.commits[0].merge, false);
  await git.exec(['commit', '--allow-empty', '-m', 'Later tip']);
  const second = await git.branchHistory(tip, 200);
  assert.equal(second.total, 205);
  assert.equal(second.commits.length, 5);
  assert.equal(new Set([...first.commits, ...second.commits].map(commit => commit.hash)).size, 205);
  assert.equal(second.commits.at(-1).parents.length, 0);
  assert.equal((await git.branchHistory(tip, 205)).commits.length, 0);
  await assert.rejects(git.branchHistory('HEAD'), /Invalid/);
  await assert.rejects(git.branchHistory(tip, -1), /Invalid/);
});

test('native branch history, merge dimming, compact copy hover, files, paging and stale nodes', async t => {
  const { cwd, git } = await fixture(t);
  await fs.writeFile(path.join(cwd, 'base.txt'), 'base\n');
  await git.exec(['add', '.']); await git.exec(['commit', '-m', 'Root']);
  const base = await git.resolve('HEAD');
  await git.create('base'); await git.create('topic'); await git.checkout({ ref: 'topic' });
  await fs.writeFile(path.join(cwd, 'topic.txt'), 'topic\n');
  await git.exec(['add', '.']); await git.exec(['commit', '-m', 'Merge word, but only one parent']);
  const topicHash = await git.resolve('HEAD');
  await git.checkout({ ref: 'main' });
  await fs.writeFile(path.join(cwd, 'main.txt'), 'main\n');
  await git.exec(['add', '.']); await git.exec(['commit', '-m', 'Main work']);
  const parent = await git.resolve('HEAD');
  await git.exec(['merge', '--no-ff', '-m', 'Join histories', '-m', 'Full body <script>\n[unsafe](command:evil)', 'topic']);
  const mergeHash = await git.resolve('HEAD');
  await git.exec(['update-ref', 'refs/remotes/origin/main', mergeHash]);
  const page = await git.branchHistory(mergeHash);
  assert.equal(page.total, 4);
  assert.equal(page.commits[0].merge, true);
  assert.deepEqual(page.commits[0].parents, [parent, topicHash]);
  assert.equal(page.commits.find(commit => commit.hash === topicHash).merge, false);
  const commands = new Map(), diffs = [], messages = [], copied = [];
  const disposable = { dispose() {} };
  let tree, decorations;
  const mock = {
    EventEmitter: class { event = () => {}; fire() {} dispose() {} },
    TreeItem: class { constructor(label, state) { this.label = label; this.collapsibleState = state; } },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ThemeIcon: class { constructor(id, color) { this.id = id; this.color = color; } },
    ThemeColor: class { constructor(id) { this.id = id; } },
    MarkdownString: class {
      value = '';
      appendText(text) { this.value += text.replace(/[\\`*_{}\[\]()<>#+\-.!]/g, '\\$&'); return this; }
      appendMarkdown(text) { this.value += text; return this; }
    },
    Uri: { from: value => value, file: fsPath => ({ scheme: 'file', fsPath }) },
    RelativePattern: class {}, ViewColumn: { Active: -1 },
    env: { clipboard: { writeText: async text => copied.push(text) } },
    workspace: { workspaceFolders: [{ uri: { fsPath: cwd } }], textDocuments: [],
      registerTextDocumentContentProvider: () => disposable,
      createFileSystemWatcher: () => ({ ...disposable, onDidChange() {}, onDidCreate() {}, onDidDelete() {} }) },
    extensions: { getExtension: () => undefined },
    commands: { registerCommand: (id, fn) => { commands.set(id, fn); return disposable; },
      executeCommand: async (id, ...args) => { if (id === 'vscode.diff') diffs.push(args); } },
    window: {
      createTreeView: (id, options) => { tree = options.treeDataProvider; return { ...disposable, reveal: async () => {} }; },
      registerFileDecorationProvider: provider => { decorations = provider; return disposable; },
      showErrorMessage: text => messages.push(text), showInformationMessage: text => messages.push(text)
    }
  };
  const originalLoad = Module._load;
  Module._load = function(request, ...args) { return request === 'vscode' ? mock : originalLoad.call(this, request, ...args); };
  const context = { subscriptions: [] };
  try {
    delete require.cache[require.resolve('../src/extension')];
    await require('../src/extension').activate(context);
    const run = (id, ...args) => commands.get(`git-branch.${id}`)(...args);
    let roots = await tree.getChildren();
    let main = roots[0].children.find(node => node.ref === 'main');
    const remote = roots[1].children[0].children[0];
    assert.equal(tree.getTreeItem(main).collapsibleState, 1);
    assert.equal(tree.getTreeItem(remote).collapsibleState, 1);
    let commits = await tree.getChildren(main);
    assert.equal(commits.length, 4);
    assert.equal(commits[0].commit.hash, mergeHash);
    assert.equal(await tree.getParent(commits[0]), main);
    assert.equal((await tree.getChildren(remote))[0].commit.hash, mergeHash);
    assert.ok(!(await tree.getChildren()).some(node => node.comparisonsGroup));
    const mergeItem = tree.getTreeItem(commits[0]);
    assert.equal(mergeItem.iconPath.id, 'git-merge');
    assert.equal(mergeItem.iconPath.color.id, 'descriptionForeground');
    const decoration = decorations.provideFileDecoration(mergeItem.resourceUri);
    assert.equal(decoration.color.id, 'descriptionForeground');
    assert.equal(decoration.tooltip, 'Merge commit');
    assert.equal(decoration.badge, undefined);
    const normalItem = tree.getTreeItem(commits.find(node => node.commit.hash === topicHash));
    assert.equal(normalItem.iconPath.id, 'git-commit');
    assert.equal(normalItem.iconPath.color, undefined);
    assert.equal(normalItem.resourceUri, undefined);
    await tree.resolveTreeItem(mergeItem, commits[0], {});
    const lines = mergeItem.tooltip.value.split('  \n');
    assert.ok(lines[0].replace(/\\([\\`*_{}\[\]()<>#+\-.!])/g, '$1')
      .startsWith(`Test · ${formatGitDate(commits[0].commit.date)} · ${mergeHash.slice(0, 7)} [$(copy)]`));
    assert.equal(lines[1].replace(/\\([\\`*_{}\[\]()<>#+\-.!])/g, '$1'),
      '1 file changed, 1 insertions(+), 0 deletions(-); Merge commit (first-parent changes)');
    assert.equal(lines[2], '\u00a0');
    assert.equal(lines[3], 'Join histories');
    assert.ok(mergeItem.tooltip.value.includes('Full body'));
    assert.ok(!mergeItem.tooltip.value.includes('<script>'));
    assert.ok(!mergeItem.tooltip.value.includes('[unsafe](command:evil)'));
    assert.deepEqual(mergeItem.tooltip.isTrusted, { enabledCommands: ['git-branch.copyCommitHash'] });
    assert.equal(mergeItem.tooltip.supportHtml, false);
    const link = /command:git-branch.copyCommitHash\?([^ ]+)/.exec(lines[0]);
    await run('copyCommitHash', JSON.parse(decodeURIComponent(link[1]))[0]);
    assert.deepEqual(copied, [mergeHash.slice(0, 7)]);
    const files = await tree.getChildren(commits[0]);
    assert.equal(files.length, 1);
    assert.equal(files[0].file.newPath, 'topic.txt');
    await run('openCompareDiff', files[0]);
    assert.equal(JSON.parse(diffs[0][0].query).hash, parent);
    assert.equal(JSON.parse(diffs[0][1].query).hash, mergeHash);
    await run('compare', main, [main, roots[0].children.find(node => node.ref === 'base')]);
    const group = (await tree.getChildren()).find(node => node.comparisonsGroup);
    const comparison = (await tree.getChildren(group))[0];
    const side = (await tree.getChildren(comparison))[0];
    assert.equal(tree.getTreeItem((await tree.getChildren(side))[0]).iconPath.id, 'git-merge');
    const originalHistory = tree.git.branchHistory;
    let loads = 0;
    tree.branchHistories.delete('history:refs/heads/main');
    tree.git.branchHistory = async (hash, skip = 0) => {
      loads++;
      const result = await originalHistory.call(tree.git, hash, skip);
      return { ...result, commits: result.commits.slice(0, 2) };
    };
    commits = await tree.getChildren(main);
    assert.equal(commits.length, 3);
    const more = commits.at(-1);
    assert.equal(tree.getTreeItem(more).command.command, 'git-branch.loadBranchHistory');
    await Promise.all([run('loadBranchHistory', more), run('loadBranchHistory', more)]);
    assert.equal(loads, 2); // Initial page plus one shared next-page request.
    assert.equal((await tree.getChildren(main)).length, 4);
    assert.equal(loads, 2); // Cached expansion does not reload the history page.
    const oldCommit = commits[0], oldFiles = await tree.getChildren(oldCommit);
    await git.exec(['commit', '--allow-empty', '-m', 'New tip']);
    roots = await tree.getChildren();
    main = roots[0].children.find(node => node.ref === 'main');
    assert.deepEqual(await tree.getChildren(oldCommit), []);
    await run('openCompareDiff', oldFiles[0]);
    assert.equal(diffs.length, 1);
    await run('loadBranchHistory', more);
    assert.equal(loads, 2);
    tree.git.branchHistory = async () => { throw new Error('Temporary history failure'); };
    assert.deepEqual(await tree.getChildren(main), []);
    assert.ok(messages.at(-1).includes('Temporary history failure'));
    tree.git.branchHistory = originalHistory;
    assert.equal((await tree.getChildren(main))[0].commit.hash, await git.resolve('HEAD'));
    // An old failed load must not delete the replacement after a branch moves.
    tree.branchHistories.delete('history:refs/heads/main');
    let rejectOld, markStarted;
    const started = new Promise(resolve => { markStarted = resolve; });
    tree.git.branchHistory = () => new Promise((resolve, reject) => { rejectOld = reject; markStarted(); });
    const oldLoading = tree.getChildren(main);
    await started;
    await git.exec(['commit', '--allow-empty', '-m', 'Another new tip']);
    roots = await tree.getChildren();
    main = roots[0].children.find(node => node.ref === 'main');
    tree.git.branchHistory = originalHistory;
    const replacement = await tree.getChildren(main);
    const latestEntry = replacement[0].entry;
    const messageCount = messages.length;
    rejectOld(new Error('Obsolete load failure'));
    assert.deepEqual(await oldLoading, []);
    assert.equal(messages.length, messageCount);
    assert.equal(tree.commitEntry(latestEntry.key), latestEntry);
    assert.equal(await git.current(), 'main');
    assert.equal(await git.exec(['status', '--porcelain']), '');
  } finally {
    for (const subscription of context.subscriptions) subscription.dispose();
    Module._load = originalLoad;
  }
});
