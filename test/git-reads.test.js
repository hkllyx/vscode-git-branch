'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture } = require('../test-support/gitFixture');
const { parseRawDiff } = require('../src/git/parse');
const { orderRefs } = require('../src/git/refs');
const { MAX_SELECTION, HistorySelection, historyTarget, combineChanges } = require('../src/panel/historyState');
const { GraphLayout } = require('../src/graph/layout');

const changes = async (repo, base) => repo.reads.commitFiles(base, await repo.reads.commit(base));

test('refs are full, flat, current-first, ignore symbolic aliases, and include tags on request', async t => {
  const f = await fixture(t);
  const repo = await f.repo('refs');
  const oid = await repo.commit('first', { 'file': 'a' });
  const tagOnly = await repo.commit('tag-only');
  await repo.git('tag', '-a', '-m', 'annotation', 'v1');
  await repo.git('tag', '-a', '-m', 'nested annotation', 'nested', 'v1');
  await repo.git('tag', 'not-a-commit', 'HEAD:file');
  await repo.git('reset', '--hard', oid);
  await repo.git('branch', 'feature/x/y');
  await repo.git('update-ref', 'refs/remotes/origin/main', oid);
  await repo.git('update-ref', 'refs/remotes/upstream/main', oid);
  await repo.git('update-ref', 'refs/remotes/origin/feature/x/y', oid);
  await repo.git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  const hidden = await repo.reads.snapshot(repo.dirs, false);
  assert.equal(hidden.allRefs.some(ref => ref.kind === 'tag'), false);
  const shown = await repo.reads.snapshot(repo.dirs, true);
  const ordered = orderRefs(shown.allRefs, shown.head.ref);
  assert.deepEqual(ordered.filter(ref => ref.kind === 'remote').map(ref => ref.name), ['origin/feature/x/y', 'origin/main', 'upstream/main']);
  assert.deepEqual(ordered.filter(ref => ref.kind === 'local').map(ref => ref.name), ['main', 'feature/x/y']);
  assert.equal(shown.byRef.get('refs/tags/v1').oid, tagOnly);
  assert.equal(shown.byRef.get('refs/tags/nested').oid, tagOnly);
  assert.equal(shown.byRef.get('refs/tags/not-a-commit').oid, undefined);
  assert.deepEqual(historyTarget(shown, 'all', true).tips, [oid]);
  assert.deepEqual(historyTarget(shown, 'refs/tags/v1', true).tips, [tagOnly]);
  assert.equal(historyTarget(shown, 'refs/tags/v1', false).range, 'HEAD');
});

test('snapshots include upstream divergence for every local branch, even when HEAD is detached', async t => {
  const f = await fixture(t);
  const repo = await f.repo('tracking-counts');
  const base = await repo.commit('base');
  const ours = await repo.commit('ours');
  const theirs = (await repo.git('commit-tree', `${base}^{tree}`, '-p', base, '-m', 'theirs')).trim();
  await repo.git('remote', 'add', 'origin', 'https://example.invalid/repo.git');
  for (const [name, tip, upstream] of [['ahead', ours, base], ['behind', base, ours], ['diverged', ours, theirs], ['equal', ours, ours], ['gone', ours, undefined]]) {
    await repo.git('branch', name, tip);
    if (upstream) await repo.git('update-ref', `refs/remotes/origin/${name}`, upstream);
    await repo.git('config', `branch.${name}.remote`, 'origin');
    await repo.git('config', `branch.${name}.merge`, `refs/heads/${name}`);
  }
  await repo.git('update-ref', 'refs/remotes/origin/main', base);
  await repo.git('branch', '--set-upstream-to=origin/main', 'main');
  await repo.git('branch', '--track', 'local-upstream', 'ahead');
  await repo.git('update-ref', 'refs/heads/local-upstream', base);
  await repo.git('branch', 'untracked');
  const expected = { main: { ahead: 1, behind: 0 }, ahead: { ahead: 1, behind: 0 }, behind: { ahead: 0, behind: 1 },
    diverged: { ahead: 1, behind: 1 }, equal: { ahead: 0, behind: 0 }, gone: undefined,
    'local-upstream': { ahead: 0, behind: 1 }, untracked: undefined };
  const check = async () => {
    const { allRefs } = await repo.reads.snapshot(repo.dirs, false);
    assert.deepEqual(Object.fromEntries(allRefs.filter(ref => ref.kind === 'local').map(({ name, trackingCount }) => [name, trackingCount])), expected);
    assert.ok(allRefs.filter(ref => ref.kind === 'remote').every(ref => ref.trackingCount === undefined));
  };
  await check();
  await repo.git('switch', '--detach', ours);
  await check();
  assert.equal((await repo.reads.refs({ ref: 'refs/heads/diverged' }))[0].trackingCount, undefined);
});

test('branches with the same tip use their own configured upstream, not HEAD or a same-named remote ref', async t => {
  const f = await fixture(t);
  const repo = await f.repo('per-branch-upstreams');
  const base = await repo.commit('base');
  const shared = await repo.commit('shared local tip');
  const next = (await repo.git('commit-tree', `${shared}^{tree}`, '-p', shared, '-m', 'next upstream commit')).trim();
  const trunk = (await repo.git('commit-tree', `${shared}^{tree}`, '-p', next, '-m', 'latest upstream commit')).trim();
  await repo.git('remote', 'add', 'origin', 'https://example.invalid/origin.git');
  await repo.git('remote', 'add', 'mirror', 'https://example.invalid/mirror.git');
  await repo.git('update-ref', 'refs/remotes/origin/main', base);
  await repo.git('update-ref', 'refs/remotes/origin/topic', shared);
  await repo.git('update-ref', 'refs/remotes/mirror/trunk', trunk);
  await repo.git('branch', '--set-upstream-to=origin/main', 'main');
  await repo.git('branch', 'topic', shared);
  await repo.git('branch', '--set-upstream-to=mirror/trunk', 'topic');

  async function check(headName, topicUpstream, topicCounts) {
    const { head, byRef } = await repo.reads.snapshot(repo.dirs, false);
    assert.equal(head.ref, `refs/heads/${headName}`);
    for (const [name, upstream, trackingCount] of [
      ['main', 'refs/remotes/origin/main', { ahead: 1, behind: 0 }], ['topic', topicUpstream, topicCounts]
    ]) {
      const branch = byRef.get(`refs/heads/${name}`);
      assert.equal(branch.oid, shared);
      assert.equal(branch.upstream.tracking, upstream);
      assert.deepEqual(branch.trackingCount, trackingCount);
      const native = (await repo.git('rev-list', '--left-right', '--count', `${name}...${name}@{upstream}`, '--')).trim();
      assert.equal(native, `${trackingCount.ahead}\t${trackingCount.behind}`);
    }
  }
  await check('main', 'refs/remotes/mirror/trunk', { ahead: 0, behind: 2 });
  await repo.git('switch', 'topic');
  await check('topic', 'refs/remotes/mirror/trunk', { ahead: 0, behind: 2 });
  await repo.git('switch', 'main');
  await repo.git('branch', '--set-upstream-to=origin/topic', 'topic');
  await check('main', 'refs/remotes/origin/topic', { ahead: 0, behind: 0 });
});

test('history pages keep stable tips and topo order while a branch moves', async t => {
  const f = await fixture(t);
  const repo = await f.repo('page');
  const root = await repo.commit('root');
  const second = await repo.commit('second');
  const third = await repo.commit('third');
  const top = await repo.reads.historyPage({ tips: [third], limit: 2 });
  assert.deepEqual(top.commits.map(row => row.oid), [third, second]);
  assert.equal(top.hasMore, true);
  await repo.commit('new after first page');
  const next = await repo.reads.historyPage({ tips: [third], limit: 2, skip: 2 });
  assert.deepEqual(next.commits.map(row => row.oid), [root]);
  assert.equal(next.hasMore, false);
  const layout = new GraphLayout();
  let pending;
  for (const row of [...top.commits, ...next.commits]) {
    const lane = layout.append(row);
    if (pending) assert.equal(lane.column, pending.column);
    pending = lane.edges[0];
  }
  assert.equal(layout.byOid.size, 0);
});

test('branch compare uses symmetric reachability and two independent final trees', async t => {
  const f = await fixture(t);
  const repo = await f.repo('compare');
  await repo.commit('root', { 'common': 'old', 'removed': 'before' });
  await repo.git('branch', 'topic');
  const base = await repo.commit('base-only', { 'common': 'base', 'base-new': 'only on base' });
  await repo.git('switch', 'topic');
  const target = await repo.commit('target-only', { 'common': 'target', 'removed': null });
  const left = { oid: base }, right = { oid: target };
  const { commits } = await repo.reads.historyPage({ compare: { left, right } });
  assert.deepEqual(Object.fromEntries(commits.map(row => [row.oid, row.side])), { [base]: 'left', [target]: 'right' });
  assert.deepEqual(await repo.reads.divergence(base, target), { left: 1, right: 1 });
  assert.equal(await repo.reads.commonAncestor(base, target), true);
  const visible = new Set(commits.map(row => row.oid));
  const graph = new GraphLayout();
  for (const row of commits) {
    const lane = graph.append(row, visible);
    assert.equal(lane.through.length, 0);
    assert.equal(lane.edges.length, 1);
    assert.equal(visible.has(lane.edges[0].oid), false);
  }
  const delta = await repo.reads.branchFiles(base, target);
  assert.deepEqual(delta.map(file => [file.status, file.path]), [['D', 'base-new'], ['M', 'common'], ['D', 'removed']]);
  const changed = delta.find(file => file.path === 'common');
  assert.equal(await repo.reads.blob(changed.old), 'base');
  assert.equal(await repo.reads.blob(changed.new), 'target');
  const reversed = await repo.reads.branchFiles(target, base);
  assert.deepEqual(reversed.map(file => file.status), ['A', 'M', 'A']);
  assert.deepEqual(await repo.reads.branchFiles(base, base), []);
  await repo.git('switch', '--orphan', 'unrelated');
  const otherRoot = await repo.commit('other root', { 'other': 'unrelated' });
  assert.equal(await repo.reads.commonAncestor(base, otherRoot), false);
});

test('comparison side limits run before pagination and compose with text filtering', async t => {
  const f = await fixture(t);
  const repo = await f.repo('compare-side-pages');
  await repo.commit('match shared');
  await repo.git('branch', 'target');
  const left = await repo.commit('match base only');
  await repo.git('switch', 'target');
  const older = await repo.commit('match older target');
  const hidden = await repo.commit('other target');
  const right = await repo.commit('match newest target');
  // Exercise the accelerated topo walk as well as the ordinary one: some Git
  // versions ignore --left-only/--right-only during a commit-graph topo walk.
  await repo.git('config', 'core.commitGraph', 'true');
  await repo.git('commit-graph', 'write', '--reachable');
  const compare = { left: { oid: left }, right: { oid: right } };
  const page = options => repo.reads.historyPage({ compare, limit: 1, ...options });
  const ids = result => result.commits.map(row => [row.oid, row.side]);

  const basePage = await page({ compareSide: 'left' });
  assert.deepEqual(ids(basePage), [[left, 'left']]);
  assert.equal(basePage.hasMore, false);
  const first = await page({ compareSide: 'right' });
  assert.deepEqual(ids(first), [[right, 'right']]);
  assert.equal(first.hasMore, true);
  const second = await page({ compareSide: 'right', skip: 1 });
  assert.deepEqual(ids(second), [[hidden, 'right']]);
  assert.equal(second.hasMore, true);
  const filtered = await page({ compareSide: 'right', filter: 'match' });
  assert.deepEqual(ids(filtered), [[right, 'right']]);
  assert.equal(filtered.scanned, 2);
  assert.equal(filtered.hasMore, true);
  const last = await page({ compareSide: 'right', filter: 'match', scan: filtered.scanned });
  assert.deepEqual(ids(last), [[older, 'right']]);
  assert.equal(last.hasMore, false);
  const empty = await page({ compare: { left: compare.right, right: compare.right }, compareSide: 'right' });
  assert.deepEqual(empty.commits, []);
  assert.equal(empty.hasMore, false);
});

test('working tree comparison shows saved tracked and non-ignored untracked changes, not just the index', async t => {
  const f = await fixture(t);
  const repo = await f.repo('worktree-diff');
  const base = await repo.commit('root', { '.gitignore': '*.ignored\n', 'a.txt': 'base', 'deleted.txt': 'before deletion', 'net-zero.txt': 'base' });
  await repo.git('branch', 'base');
  const head = await repo.commit('current commit', { 'committed.txt': 'only on current' });
  await repo.write('a.txt', 'staged content');
  await repo.write('staged-new.txt', 'published in the index');
  await repo.write('net-zero.txt', 'staged, then undone in the working tree');
  await repo.git('add', '--', 'a.txt', 'staged-new.txt', 'net-zero.txt');
  await repo.write('a.txt', 'disk content');
  await repo.write('net-zero.txt', 'base');
  await fs.unlink(path.join(repo.dir, 'deleted.txt'));
  await repo.write('local-only.txt', 'untracked');
  await repo.write('local-cache.ignored', 'ignored');
  await repo.write('intent-to-add.txt', 'not staged yet');
  await repo.git('add', '-N', 'intent-to-add.txt');
  const before = await repo.git('status', '--porcelain=v2');
  const files = await repo.reads.worktreeFiles(base);
  assert.deepEqual(files.map(file => [file.path, file.status]), [['a.txt', 'M'], ['committed.txt', 'A'], ['deleted.txt', 'D'],
    ['intent-to-add.txt', 'A'], ['staged-new.txt', 'A'], ['local-only.txt', 'A']]);
  assert.equal(await repo.reads.workingBlob(files.find(file => file.path === 'local-only.txt')), 'untracked');
  const item = files.find(file => file.path === 'a.txt');
  assert.equal(item.workingTree, true);
  assert.equal(await repo.reads.blob(item.old), 'base');
  assert.equal(await repo.reads.workingBlob(item), 'disk content');
  assert.equal(await repo.reads.workingBlob(files.find(file => file.path === 'deleted.txt')), '');
  assert.equal(await repo.git('show', ':a.txt'), 'staged content');
  assert.equal(await repo.git('status', '--porcelain=v2'), before);
  assert.deepEqual(await repo.reads.head(), { ref: 'refs/heads/main', oid: head });
});

test('working tree diff cannot open a path replaced by a junction or an out-of-tree path', async t => {
  const f = await fixture(t);
  const repo = await f.repo('worktree-diff');
  const base = await repo.commit('root', { 'dir/file.txt': 'base' });
  await repo.write('dir/file.txt', 'valid');
  const [file] = await repo.reads.worktreeFiles(base);
  assert.equal(await repo.reads.workingBlob(file), 'valid');
  const outside = path.join(f.root, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'file.txt'), 'not in the worktree');
  await fs.unlink(path.join(repo.dir, 'dir', 'file.txt'));
  await fs.rmdir(path.join(repo.dir, 'dir'));
  await fs.symlink(outside, path.join(repo.dir, 'dir'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(repo.reads.workingBlob(file), /Only regular files/);
  const unsafe = { ...file, new: { ...file.new, pathKey: Buffer.from('../outside/file.txt').toString('base64') } };
  await assert.rejects(repo.reads.workingBlob(unsafe), /cannot be read safely/);
});

test('changes use an empty tree for root, preserve renames and use real merge parents in the graph', async t => {
  const f = await fixture(t);
  const repo = await f.repo('files');
  const root = await repo.commit('root', { 'old path.txt': '内容', 'binary.bin': Buffer.from([0, 3, 4]), 'big.txt': 'x'.repeat(1024 * 1024 + 1) });
  const rootFiles = await changes(repo, root);
  assert.deepEqual(rootFiles.map(file => file.status), ['A', 'A', 'A']);
  assert.ok(rootFiles.every(file => file.old === undefined));
  await assert.rejects(repo.reads.blob(rootFiles.find(file => file.path === 'binary.bin').new), /binary/);
  await assert.rejects(repo.reads.blob(rootFiles.find(file => file.path === 'big.txt').new), /1 MiB/);
  await assert.rejects(repo.reads.blob({ mode: '160000', oid: root }), /Submodule pointer/);
  await repo.git('switch', '-c', 'topic');
  await repo.git('mv', 'old path.txt', '新 路径.txt');
  const rename = await repo.commit('rename');
  const [file] = await changes(repo, rename);
  assert.deepEqual([file.status, file.old.path, file.new.path], ['R', 'old path.txt', '新 路径.txt']);
  assert.equal(await repo.reads.blob(file.new), '内容');
  await repo.git('switch', 'main');
  const left = await repo.commit('main edit', { 'base-only.txt': 'main' });
  await repo.git('merge', '--no-ff', '-m', 'Merge topic', 'topic');
  const merge = await repo.head();
  const info = await repo.reads.commit(merge);
  assert.deepEqual(info.parents, [left, rename]);
  assert.deepEqual(await changes(repo, merge), []);
  const clean = await repo.reads.commitFileDetails(merge, info, undefined, true);
  assert.deepEqual(clean.files, []);
  assert.deepEqual(clean.parentGroups.map(group => group.oid), [left, rename]);
  const layout = new GraphLayout();
  const { commits } = await repo.reads.historyPage({ tips: [merge] });
  assert.deepEqual(layout.append(commits[0]).edges.map(lane => lane.oid), [left, rename]);
  for (const row of commits.slice(1)) layout.append(row);
  assert.equal(layout.byOid.size, 0);
});

test('shallow log boundaries are not treated as root commits', async t => {
  const f = await fixture(t);
  const initial = await f.repo('full');
  const root = await initial.commit('root', { 'file': 'a' });
  const tip = await initial.commit('step', { 'file': 'b' });
  const shallow = await f.repo('shallow', { url: initial.url, depth: 1 });
  const snapshot = await shallow.reads.snapshot(shallow.dirs, false);
  assert.equal(snapshot.shallowRoots.has(tip), true);
  assert.ok(snapshot.shallow);
  assert.equal((await shallow.reads.historyPage({ tips: [tip] })).commits.length, 1);
  assert.deepEqual((await shallow.reads.commit(tip)).parents, [root]);
  await assert.rejects(changes(shallow, tip), /parent commit .* is missing/);
});

test('an absent blob in a partial clone is not downloaded by browsing', async t => {
  const f = await fixture(t);
  const server = await f.repo('promisor');
  const a = await server.commit('old', { 'text': 'old blob' });
  await server.commit('new', { 'text': 'checked out blob' });
  await server.git('config', 'uploadpack.allowFilter', 'true');
  await server.git('config', 'uploadpack.allowAnySHA1InWant', 'true');
  const partial = await f.repo('partial', { url: server.url, filter: 'blob:none' });
  const [oldChange] = await changes(partial, a);
  const result = await partial.client.text(['cat-file', '--batch-check'], { input: `${oldChange.new.oid}\n` });
  assert.match(result, / missing$/m);
  await assert.rejects(partial.reads.blob(oldChange.new));
  assert.equal(await partial.client.text(['cat-file', '--batch-check'], { input: `${oldChange.new.oid}\n` }), result);
  // The fixture remote really can serve the blob; the read path actively avoided it.
  assert.equal(await partial.client.text(['cat-file', 'blob', oldChange.new.oid], { write: true }), 'old blob');
});

test('reads use full SHA-256 object IDs', async t => {
  const f = await fixture(t);
  const repo = await f.repo('sha256', { objectFormat: 'sha256' });
  const oid = await repo.commit('root', { 'file': 'sha256 data' });
  assert.equal(oid.length, 64);
  assert.equal((await repo.reads.historyPage({ tips: [oid] })).commits[0].oid, oid);
  const [file] = await changes(repo, oid);
  assert.equal(file.new.oid.length, 64);
  assert.equal(await repo.reads.blob(file.new), 'sha256 data');
});

async function combined(repo, oids) {
  const items = await Promise.all(oids.map(async oid => {
    const commit = await repo.reads.commit(oid);
    return { files: (await repo.reads.commitFiles(oid, commit)).map(file => ({ ...file, baseOid: commit.parents[0], afterOid: oid })) };
  }));
  return combineChanges(items, oid => repo.reads.firstParentHistory(oid));
}

test('non-adjacent selections merge the file endpoints, drop a net zero and exclude unrelated skipped files', async t => {
  const f = await fixture(t);
  const repo = await f.repo('multi');
  const a = await repo.commit('a', { 'joined': 'a', 'transient': 'want both add and delete' });
  await repo.commit('b', { 'excluded': 'not selected' });
  const c = await repo.commit('c', { 'joined': 'c', 'transient': null });
  const state = new HistorySelection();
  state.select(c, 'replace');
  state.select(a, 'toggle');
  assert.deepEqual(state.asPacket(), { focus: a, anchor: a, selected: [c, a] });
  const files = await combined(repo, [...state.selected]);
  assert.deepEqual(files.map(file => [file.path, file.status, file.baseOid, file.afterOid, file.includesGap]), [['joined', 'A', undefined, c, false]]);
  assert.equal(await repo.reads.blob(files[0].new), 'c');
});

test('a skipped commit changing the same file is flagged without including the skipped-only file', async t => {
  const f = await fixture(t);
  const repo = await f.repo('gap');
  const root = await repo.commit('root', { 'file.txt': 'root\n' });
  const first = await repo.commit('first', { 'file.txt': 'root\n1\n' });
  await repo.commit('skipped', { 'file.txt': 'root\n1\nunselected\n', 'debug.txt': 'skip' });
  const end = await repo.commit('end', { 'file.txt': 'root\n1\nunselected\n2\n' });
  const files = await combined(repo, [end, first]);
  assert.deepEqual(files.map(file => [file.path, file.includesGap, file.baseOid, file.afterOid]), [['file.txt', true, root, end]]);
  assert.equal(await repo.reads.blob(files[0].old), 'root\n');
  assert.equal(await repo.reads.blob(files[0].new), 'root\n1\nunselected\n2\n');
});

test('selected renames form one file path chain, and divergent edits to a common path keep the endpoint diff', async t => {
  const f = await fixture(t);
  const repo = await f.repo('renames');
  const root = await repo.commit('root', { 'original.txt': 'first line\nlong enough for rename detection\nlast line\n', 'same.txt': 'shared\n' });
  await repo.git('branch', 'parallel');
  await repo.git('mv', 'original.txt', 'middle.txt');
  const first = await repo.commit('first rename', { 'same.txt': 'on main\n' });
  await repo.git('mv', 'middle.txt', 'end.txt');
  const end = await repo.commit('second rename');
  const files = await combined(repo, [end, first]);
  assert.deepEqual(files.map(file => [file.old?.path, file.new?.path, file.status]), [['original.txt', 'end.txt', 'R'], ['same.txt', 'same.txt', 'M']]);
  assert.equal(files[0].baseOid, root);
  assert.equal(files[0].afterOid, end);
  await repo.git('switch', 'parallel');
  const other = await repo.commit('same path on another branch', { 'same.txt': 'different line\n' });
  const divergent = (await combined(repo, [end, other, first])).find(file => file.path === 'same.txt');
  // IntelliJ splices by path only, so a forked selection still yields a net diff
  // between the first "before" and the last "after" instead of an unmergeable row.
  assert.equal(divergent.status, 'M');
  assert.equal(divergent.ambiguous, undefined);
  assert.equal(divergent.includesGap, true);
  assert.equal(await repo.reads.blob(divergent.old), 'shared\n');
  assert.equal(await repo.reads.blob(divergent.new), 'different line\n');
});

test('shift selection follows loaded log order, keeps the anchor and leaves overflow unchanged', () => {
  const rows = Array.from({ length: 80 }, (_, i) => ({ oid: String(i) }));
  const state = new HistorySelection();
  state.select('3', 'replace');
  assert.ok(state.select('1', 'range', rows));
  assert.deepEqual(state.asPacket(), { focus: '1', anchor: '3', selected: ['1', '2', '3'] });
  state.select('4', 'range', rows);
  assert.deepEqual(state.asPacket(), { focus: '4', anchor: '3', selected: ['3', '4'] });
  state.select('7', 'extend', rows);
  assert.deepEqual([...state.selected], ['3', '4', '5', '6', '7']);
  assert.ok(state.select(String(3 + MAX_SELECTION - 1), 'range', rows));
  const limit = state.asPacket();
  assert.equal(state.select('79', 'range', rows), false);
  assert.equal(state.select('2', 'extend', rows), false);
  assert.equal(state.select('0', 'toggle'), false);
  assert.deepEqual(state.asPacket(), limit);
  state.select('3', 'replace');
  state.select('3', 'toggle');
  assert.deepEqual(state.asPacket(), { focus: undefined, anchor: undefined, selected: [] });
});

test('history reload restores only visible commits, without replacing an explicit empty selection', () => {
  const state = new HistorySelection();
  const rows = ['c', 'b', 'a'].map(oid => ({ oid }));
  state.restore(undefined, rows);
  assert.equal(state.focus, 'c');
  state.select('a', 'toggle');
  state.restore(state.asPacket(), rows.slice(0, 2));
  assert.deepEqual(state.asPacket(), { focus: 'c', anchor: 'c', selected: ['c'] });
  state.select('c', 'toggle');
  state.restore(state.asPacket(), rows);
  assert.deepEqual(state.asPacket(), { focus: undefined, anchor: undefined, selected: [] });
});

test('one history filter matches message body, author and hash without dropping matches at page boundaries', async t => {
  const f = await fixture(t);
  const repo = await f.repo('filter');
  const author = async (name, message, data) => {
    await repo.git('config', 'user.name', name);
    return repo.commit(message, data);
  };
  const one = await author('Alice', 'Add login form', { 'a.txt': '1' });
  const two = await author('Bob', 'Fix logout crash', { 'b.txt': '2' });
  const three = await author('Alice', 'Tweak copy\n\nUpdates the login page.', { 'c.txt': '3' });
  const tips = [three];
  const byText = await repo.reads.historyPage({ tips, filter: ' LOGIN ', limit: 1 });
  assert.deepEqual(byText.commits.map(row => row.oid), [three]);
  assert.equal(byText.commits[0].body, undefined);
  assert.equal(byText.hasMore, true);
  const next = await repo.reads.historyPage({ tips, filter: 'login', skip: 1, scan: byText.scanned, limit: 1 });
  assert.deepEqual(next.commits.map(row => row.oid), [one]);
  assert.equal(next.hasMore, false);
  const byAuthor = await repo.reads.historyPage({ tips, filter: 'alice' });
  assert.deepEqual(byAuthor.commits.map(row => row.oid), [three, one]);
  const byHash = await repo.reads.historyPage({ tips, filter: two.slice(0, 8).toUpperCase() });
  assert.deepEqual(byHash.commits.map(row => row.oid), [two]);
  const none = await repo.reads.historyPage({ tips, filter: 'nothing-matches' });
  assert.deepEqual(none.commits, []);
  assert.equal(none.hasMore, false);
});

test('merge files exclude ordinary imports and retain only paths changed against every parent', async t => {
  const f = await fixture(t);
  const repo = await f.repo('merge');
  await repo.commit('root', { 'conflict.txt': 'root\n', 'take-parent.txt': 'root\n' });
  await repo.git('switch', '-c', 'topic');
  const side = await repo.commit('side', { 'side.txt': 'side\n', 'conflict.txt': 'side\n', 'take-parent.txt': 'side\n' });
  await repo.git('switch', 'main');
  const main = await repo.commit('main', { 'main.txt': 'main\n', 'conflict.txt': 'main\n', 'take-parent.txt': 'main\n' });
  await assert.rejects(repo.git('merge', '--no-ff', '-m', 'merge topic', 'topic'));
  assert.deepEqual((await repo.reads.workingState(repo.dirs.gitDir)).conflicted, true);
  const merged = await repo.commit('Resolve topic merge', { 'conflict.txt': 'resolution\n', 'take-parent.txt': 'side\n' });
  const info = await repo.reads.commit(merged);
  assert.deepEqual(info.parents, [main, side]);
  const { files: [file, ...rest], parentGroups } = await repo.reads.commitFileDetails(merged, info, undefined, true);
  assert.deepEqual(rest, []);
  assert.deepEqual(parentGroups.map(({ oid, files }) => [oid, files.map(change => change.path)]), [
    [main, ['conflict.txt', 'side.txt', 'take-parent.txt']], [side, ['conflict.txt', 'main.txt']]
  ]);
  assert.equal(await repo.reads.blob(parentGroups[1].files[0].old), 'side\n');
  assert.equal(await repo.reads.blob(parentGroups[1].files[0].new), 'resolution\n');
  assert.deepEqual(await changes(repo, merged), [file]);
  assert.equal(file.path, 'conflict.txt');
  assert.equal(await repo.reads.blob(file.old), 'main\n');
  assert.equal(await repo.reads.blob(file.new), 'resolution\n');
  assert.deepEqual((await combined(repo, [merged, main])).map(file => file.path).sort(),
    ['conflict.txt', 'main.txt', 'take-parent.txt']);
  await assert.rejects(repo.reads.commitFiles(merged, { parents: [main, '0'.repeat(main.length)] }), /parent commit .* is missing/);
});

test('a forked 8-file selection yields the endpoint diff instead of an unmergeable row', async t => {
  const f = await fixture(t);
  const repo = await f.repo('fork');
  const names = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts', 'g.ts', 'h.ts'];
  const root = await repo.commit('root', Object.fromEntries(names.map(name => [name, 'root\n'])));
  await repo.git('switch', '-c', 'side');
  const sideCommit = await repo.commit('side work', Object.fromEntries(names.map(name => [name, 'side\n'])));
  await repo.git('switch', 'main');
  const mainCommit = await repo.commit('main work', Object.fromEntries(names.map(name => [name, 'main\n'])));
  await repo.git('merge', '--no-ff', '-m', 'merge side', 'side').catch(() => {});
  const tip = await repo.head();
  const files = await combined(repo, [mainCommit, tip, sideCommit]);
  assert.equal(files.some(file => file.ambiguous), false);
  assert.deepEqual(files.map(file => file.path), names);
  assert.ok(files.every(file => file.status === 'M'));
});

test('literal paths parsed from NUL records preserve file identity, even for ambiguous display strings', async () => {
  const one = '1'.repeat(64);
  const two = '2'.repeat(64);
  const three = '3'.repeat(64);
  const four = '4'.repeat(64);
  const lead = (a, b) => Buffer.from(`:100644 100644 ${a} ${b} M\0`);
  const raw = Buffer.concat([lead(one, two), Buffer.from('line\tbreak\0'), lead(three, four), Buffer.from('line\\x09break\0')]);
  const [first, second] = parseRawDiff(raw);
  assert.equal(first.path, second.path);
  assert.notEqual(first.pathKey, second.pathKey);
  assert.equal(first.old.pathKey, first.pathKey);
  const combined = await combineChanges([{ files: [first, second] }]);
  assert.equal(combined.length, 2);
  assert.deepEqual(combined.map(file => file.pathKey).sort(), [first.pathKey, second.pathKey].sort());
});
