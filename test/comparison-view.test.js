'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { GitOperations } = require('../src/git-operations');
const { comparisonHtml, comparisonClient, openComparison, openWorkingTree } = require('../src/comparison-view');

test('branch comparison: both directions, equal tips, root, merge and immutable commit files', async t => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'git-branch-history-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const git = new GitOperations(cwd);
  await git.exec(['init', '-b', 'main']);
  await git.exec(['config', 'user.name', '中文 Author']);
  await git.exec(['config', 'user.email', 'test@example.invalid']);
  await fs.writeFile(path.join(cwd, 'base.txt'), 'base\n');
  await git.exec(['add', '.']); await git.exec(['commit', '-m', 'root']);
  const base = await git.resolve('HEAD');
  const root = await git.commitDetails(base);
  assert.equal(root.left, null); assert.deepEqual(root.parents, []);
  assert.equal(root.files[0].status, 'A'); assert.equal(root.files[0].oldPath, null);
  await git.create('feature'); await git.checkout({ ref: 'feature' });
  await git.exec(['mv', 'base.txt', '中文 renamed.txt']);
  await git.exec(['commit', '-m', 'feature <script>alert(1)</script>', '-m', 'Detailed message\nsecond line']);
  const feature = await git.resolve('HEAD');
  await git.checkout({ ref: 'main' });
  await fs.writeFile(path.join(cwd, 'main.txt'), 'main\n');
  await git.exec(['add', '.']); await git.exec(['commit', '-m', 'main only']);
  const main = await git.resolve('HEAD');
  const result = await git.branchComparison('refs/heads/feature');
  assert.deepEqual(result.selected.commits.map(c => c.hash), [feature]);
  assert.deepEqual(result.current.commits.map(c => c.hash), [main]);
  assert.equal(result.selected.total, 1); assert.equal(result.current.total, 1);
  assert.equal(result.selected.commits[0].author, '中文 Author');
  const detail = await git.commitDetails(feature);
  assert.match(detail.message, /Detailed message\nsecond line/);
  assert.equal(detail.files[0].status, 'R100');
  assert.equal(await git.content(detail.left, detail.files[0].oldPath), 'base\n');
  assert.equal(await git.content(detail.right, detail.files[0].newPath), 'base\n');
  await git.exec(['merge', '--no-edit', 'feature']);
  const merge = await git.commitDetails(await git.resolve('HEAD'));
  assert.equal(merge.parents.length, 2); assert.equal(merge.left, main);
  assert.equal(merge.files[0].status, 'R100');
  const merged = await git.branchComparison('refs/heads/feature');
  assert.equal(merged.selected.total, 0); assert.equal(merged.current.total, 2);
  const equal = await git.branchComparison('HEAD');
  assert.equal(equal.selected.total, 0); assert.equal(equal.current.total, 0); assert.equal(equal.files.length, 0);
  // Earlier result is not changed by later merges.
  assert.equal(result.right, main); assert.equal(result.selected.commits[0].hash, feature);
  await assert.rejects(git.commitDetails('--bad'), /Invalid commit/);
});

test('history pagination is bounded and arguments cannot inject revisions', async () => {
  const git = new GitOperations('.');
  const hash = 'a'.repeat(40), other = 'b'.repeat(40), calls = [];
  git.exec = async args => { calls.push(args); return args[0] === 'log' ? [hash, 'User', '2026-11-18T12:00:00+08:00', 'subject', ''].join('\0') : '201\n'; };
  const page = await git.uniqueCommits(hash, other, 200);
  assert.equal(page.total, 201); assert.equal(page.commits.length, 1);
  assert.ok(calls[0].includes('--max-count=200')); assert.ok(calls[0].includes('--skip=200'));
  assert.ok(calls[0].includes(`${other}..${hash}`));
  await assert.rejects(git.uniqueCommits('--all', other), /Invalid comparison/);
  await assert.rejects(git.uniqueCommits(hash, other, -1), /Invalid comparison/);
});

function domHarness(data) {
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.style = {}; this.textContent = ''; }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; }
    setAttribute() {}
  }
  const nodes = Object.fromEntries(['title', 'tips', 'histories', 'branch-files', 'toggle', 'error', 'note'].map(id => [id, new Element('div')]));
  const messages = []; let receive;
  const sandbox = {
    document: { getElementById: id => nodes[id], createElement: tag => new Element(tag) },
    window: { addEventListener: (event, fn) => { receive = fn; } },
    acquireVsCodeApi: () => ({ getState: () => undefined, setState() {}, postMessage: message => messages.push(message) })
  };
  vm.runInNewContext(`(${comparisonClient.toString()})(${JSON.stringify(data)})`, sandbox);
  return { nodes, messages, receive };
}

test('comparison UI: CSP, escaped repository data, lists, filtering, details, diff and modes', () => {
  const hash = 'a'.repeat(40), right = 'b'.repeat(40);
  const data = {
    ref: 'feature</script><script>evil()</script>', currentLabel: 'main', left: hash, right,
    selected: { total: 201, commits: [{ hash, subject: '<img onerror=evil()>', author: 'Alice', date: '2026-11-18T12:00:00+08:00' }] },
    current: { total: 0, commits: [] }, files: [{ status: 'M', oldPath: 'a.txt', newPath: 'a.txt' }]
  };
  const html = comparisonHtml(data);
  assert.match(html, /default-src 'none'/); assert.match(html, /script-src 'nonce-/);
  const compactRows = html.match(/\.commit,\.file\{([^}]+)\}/)[1];
  assert.match(compactRows, /padding:2px 12px/);
  assert.match(compactRows, /line-height:1\.4(?:;|$)/);
  assert.ok(!/(?:^|;)(?:height|min-height|max-height|font-size):/.test(compactRows));
  assert.match(html, /\.file span:last-child\{[^}]*text-overflow:ellipsis;white-space:nowrap/);
  assert.ok(!html.includes('</script><script>evil()'));
  assert.ok(!html.includes('<img onerror'));
  const { nodes, messages, receive } = domHarness(data);
  assert.equal(nodes.title.textContent, `${data.ref} ↔ main`);
  const firstHistory = nodes.histories.children[0].children[0];
  const input = firstHistory.children[0].children[0], list = firstHistory.children[2];
  assert.equal(list.children[0].children[0].textContent, '<img onerror=evil()>');
  input.value = 'missing'; input.oninput(); assert.match(list.children[0].textContent, /No matching/);
  input.value = 'alice'; input.oninput(); list.children[0].onclick();
  assert.equal(messages.at(-1).type, 'commit');
  receive({ data: { type: 'detail', side: 'selected', detail: {
    hash, author: 'Alice', email: 'a@example.invalid', date: '2026-11-18', parents: [right], message: 'body', files: data.files
  } } });
  const inspector = nodes.histories.children[0].children[1];
  assert.equal(inspector.children[1].children[0].title, 'a.txt\nOpen side-by-side diff');
  inspector.children[1].children[0].onclick();
  assert.equal(messages.at(-1).scope, 'commit'); assert.equal(messages.at(-1).index, 0);
  assert.match(inspector.children[2].textContent, /body/);
  firstHistory.children[3].children[1].onclick(); assert.equal(messages.at(-1).type, 'more');
  nodes.toggle.onclick(); assert.equal(nodes.histories.style.display, 'none');
  nodes['branch-files'].children[0].onclick(); assert.equal(messages.at(-1).scope, 'branch');
  nodes.toggle.onclick(); assert.equal(nodes.histories.style.display, 'grid');
  receive({ data: { type: 'error', message: '<script>error</script>' } });
  assert.equal(nodes.error.textContent, '<script>error</script>');
});

test('working tree comparison includes disk, index, untracked and dirty editor files without changing Git state', async t => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'git-branch-working-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const git = new GitOperations(cwd);
  await git.exec(['init', '-b', 'main']);
  await git.exec(['config', 'user.name', 'Test']); await git.exec(['config', 'user.email', 'test@example.invalid']);
  for (const file of ['tracked.txt', 'deleted.txt', 'cached-delete.txt', 'clean.txt', 'renamed.txt']) {
    await fs.writeFile(path.join(cwd, file), `${file}\n`);
  }
  await fs.writeFile(path.join(cwd, '.gitignore'), 'ignored.txt\n');
  await git.exec(['add', '.']); await git.exec(['commit', '-m', 'base']);
  const base = await git.resolve('HEAD');
  await git.create('selected'); await git.checkout({ ref: 'selected' });
  await fs.writeFile(path.join(cwd, 'branch-only.txt'), 'selected branch\n');
  await git.exec(['add', '.']); await git.exec(['commit', '-m', 'selected branch only']);
  const selected = await git.resolve('HEAD');
  await git.exec(['update-ref', 'refs/remotes/origin/selected', selected]);
  await git.checkout({ ref: 'main' });
  await fs.writeFile(path.join(cwd, 'tracked.txt'), 'staged\n'); await git.exec(['add', 'tracked.txt']);
  await fs.writeFile(path.join(cwd, 'tracked.txt'), 'unstaged\n');
  await git.exec(['rm', 'deleted.txt']);
  await git.exec(['rm', '--cached', 'cached-delete.txt']); // Same worktree content: no diff against base.
  await git.exec(['mv', 'renamed.txt', 'moved.txt']);
  await fs.writeFile(path.join(cwd, 'staged-add.txt'), 'staged addition\n'); await git.exec(['add', 'staged-add.txt']);
  await fs.writeFile(path.join(cwd, '中文 new.txt'), 'untracked\n');
  await fs.writeFile(path.join(cwd, 'ignored.txt'), 'ignored\n');
  const index = await git.exec(['ls-files', '--stage', '-z']);
  const status = await git.exec(['status', '--porcelain=v1', '-z']);
  const result = await git.worktreeCompare('refs/heads/main', [
    { file: 'clean.txt', text: 'unsaved editor content\n' },
    { file: 'ignored.txt', text: 'ignored unsaved' }, { file: '../outside.txt', text: 'outside' }
  ]);
  assert.equal(result.worktree, true); assert.equal(result.left, base); assert.equal(result.right, null);
  const files = new Map(result.files.map(file => [file.newPath || file.oldPath, file]));
  assert.equal(files.get('tracked.txt').status, 'M'); assert.equal(files.get('clean.txt').status, 'M');
  assert.equal(files.get('deleted.txt').newPath, null);
  assert.equal(files.get('moved.txt').status, 'R100'); assert.equal(files.get('moved.txt').oldPath, 'renamed.txt');
  assert.equal(files.get('staged-add.txt').oldPath, null);
  assert.equal(files.get('中文 new.txt').untracked, true);
  assert.ok(!files.has('ignored.txt')); assert.ok(!files.has('cached-delete.txt'));
  assert.equal(await git.resolve('HEAD'), base);
  assert.equal(await git.exec(['ls-files', '--stage', '-z']), index);
  assert.equal(await git.exec(['status', '--porcelain=v1', '-z']), status);
  assert.throws(() => git.worktreePath('../outside.txt'), /outside/);
  assert.throws(() => git.worktreePath(cwd), /Invalid/);
  await fs.writeFile(path.join(cwd, 'cached-delete.txt'), 'changed after index deletion\n');
  const refreshed = await git.worktreeCompare('HEAD');
  assert.equal(refreshed.files.find(file => file.newPath === 'cached-delete.txt').status, 'M');
  // An unsaved buffer matching the selected snapshot overrides a different disk version.
  const bufferMatches = await git.worktreeCompare('HEAD', [{ file: 'tracked.txt', text: 'tracked.txt\n' }]);
  assert.ok(!bufferMatches.files.some(file => file.newPath === 'tracked.txt'));
  const remoteResult = await git.worktreeCompare('refs/remotes/origin/selected');
  assert.equal(remoteResult.left, selected);
  assert.equal(remoteResult.files.find(file => file.oldPath === 'branch-only.txt').status, 'D');
});

test('working tree UI uses a collapsible file tree, filters original indexes, and refreshes', () => {
  const result = { worktree: true, ref: 'feature', currentLabel: 'Working Tree', left: 'a'.repeat(40), right: null,
    files: [{ status: 'M', oldPath: 'root.txt', newPath: 'root.txt' },
      { status: 'A', oldPath: null, newPath: 'src/中文.txt' }] };
  const { nodes, messages, receive } = domHarness(result);
  assert.equal(nodes.histories.children.length, 0); assert.equal(nodes.histories.style.display, 'none');
  assert.equal(nodes.toggle.textContent, 'Refresh'); assert.match(nodes.note.textContent, /unsaved/);
  const [search, count, tree] = nodes['branch-files'].children;
  assert.equal(tree.children[0].tag, 'details'); assert.equal(tree.children[0].open, true);
  search.value = '中文'; search.oninput();
  assert.match(count.textContent, /1 shown/);
  tree.children[0].children[1].children[0].children[0].onclick();
  assert.equal(messages.at(-1).scope, 'worktree'); assert.equal(messages.at(-1).index, 1);
  nodes.toggle.onclick(); assert.equal(messages.at(-1).type, 'refresh'); assert.equal(nodes.toggle.disabled, true);
  receive({ data: { type: 'worktree', result: { ...result, files: [] } } });
  assert.equal(nodes.toggle.disabled, false); assert.match(tree.children[0].textContent, /No file differences/);
});

test('working tree panel refreshes only host data, rejects invalid indexes, and cleans up', async () => {
  let receive, close; const sent = [], diffs = [];
  const result = { worktree: true, ref: 'main', currentLabel: 'Working Tree', left: 'a'.repeat(40), right: null,
    files: [{ status: 'M', oldPath: 'a.txt', newPath: 'a.txt' }] };
  const next = { ...result, files: [{ status: 'A', oldPath: null, newPath: 'b.txt' }] };
  const disposable = { dispose() {} };
  const panel = { webview: { onDidReceiveMessage: fn => { receive = fn; return disposable; }, postMessage: async m => sent.push(m) },
    onDidDispose: fn => { close = fn; return disposable; } };
  openWorkingTree({ window: { createWebviewPanel: () => panel }, ViewColumn: { Active: -1 }, ThemeIcon: class { constructor(id) { this.id = id; } } },
    { subscriptions: [] }, result, async () => next, async file => diffs.push(file));
  assert.equal(panel.iconPath.id, 'git-compare');
  await receive({ type: 'diff', scope: 'worktree', index: 0, generation: 0, newPath: '../outside.txt' });
  assert.equal(diffs[0].newPath, 'a.txt'); assert.equal(diffs[0].worktree, true);
  await receive({ type: 'diff', scope: 'worktree', index: -1, generation: 0 }); assert.equal(diffs.length, 1);
  await receive({ type: 'diff', scope: 'branch', index: 0 }); assert.equal(diffs.length, 1);
  await receive({ type: 'refresh' }); assert.deepEqual(sent.at(-1).result, { ...next, generation: 1 });
  await receive({ type: 'diff', scope: 'worktree', index: 0, generation: 0 }); assert.equal(diffs.length, 1); // Stale list.
  await receive({ type: 'diff', scope: 'worktree', index: 0, generation: 1 }); assert.equal(diffs.at(-1).newPath, 'b.txt');
  close(); await receive({ type: 'diff', scope: 'worktree', index: 0, generation: 1 }); assert.equal(diffs.length, 2);
});

test('panel pagination accepts only valid messages and restores active comparison', async () => {
  const left = 'a'.repeat(40), right = 'b'.repeat(40), extra = 'c'.repeat(40);
  const result = { ref: 'feature', currentLabel: 'main', left, right, files: [],
    selected: { total: 2, commits: [{ hash: left, subject: 'one' }] }, current: { total: 0, commits: [] } };
  let receive, closed, activate, active, disposed = false;
  const sent = [], calls = [];
  const panel = {
    webview: { onDidReceiveMessage: fn => { receive = fn; return { dispose() {} }; }, postMessage: async m => sent.push(m) },
    onDidDispose: fn => { closed = fn; return { dispose() {} }; },
    onDidChangeViewState: fn => { activate = fn; return { dispose() {} }; },
    dispose: () => { if (!disposed) { disposed = true; closed(); } }
  };
  const git = { uniqueCommits: async (...args) => { calls.push(args); return { commits: [{ hash: extra }], total: 2 }; } };
  openComparison({ window: { createWebviewPanel: () => panel }, ViewColumn: { Active: -1 }, ThemeIcon: class { constructor(id) { this.id = id; } } },
    { subscriptions: [] }, git, result, () => assert.fail('invalid diff'), r => { active = r; }, () => { active = null; });
  assert.equal(panel.iconPath.id, 'git-compare');
  await receive({ type: 'more', side: '__proto__' }); assert.equal(calls.length, 0);
  await receive({ type: 'more', side: 'selected' });
  assert.deepEqual(calls[0], [left, right, 1]); assert.equal(result.selected.commits.length, 2);
  assert.equal(sent.at(-1).type, 'page');
  await receive({ type: 'more', side: 'selected' }); assert.equal(calls.length, 1);
  activate({ webviewPanel: { active: true } }); assert.equal(active, result);
  panel.dispose(); assert.equal(active, null);
  await receive({ type: 'more', side: 'selected' }); assert.equal(calls.length, 1);
});
