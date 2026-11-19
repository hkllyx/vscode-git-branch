'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { GitOperations, parseDiff } = require('../src/git-operations');

test('NUL parsing preserves unicode, spaces, tabs, newlines and renamed/deleted paths', () => {
  assert.deepEqual(parseDiff('A\0中文 file.txt\0D\0gone\0R100\0old\tname\0new\nname\0'), [
    { status: 'A', oldPath: null, newPath: '中文 file.txt' },
    { status: 'D', oldPath: 'gone', newPath: null },
    { status: 'R100', oldPath: 'old\tname', newPath: 'new\nname' }
  ]);
});

test('real repository: branches, compare, rename, delete, merge, rebase', async t => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'git-branch-test-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const git = new GitOperations(cwd);

  // Setup
  await git.exec(['init', '-b', 'main']);
  await git.exec(['config', 'user.email', 'test@example.invalid']);
  await git.exec(['config', 'user.name', 'Test']);
  await fs.writeFile(path.join(cwd, 'old file.txt'), 'original\n');
  await fs.writeFile(path.join(cwd, 'delete.txt'), 'delete\n');
  await git.exec(['add', '.']);
  await git.exec(['commit', '-m', 'base']);

  // Branches listing
  const { current, branches } = await git.branches();
  assert.equal(current, 'refs/heads/main');
  assert.equal(branches.length, 1);
  assert.equal(branches[0].name, 'main');
  assert.equal(branches[0].current, true);
  assert.equal(branches[0].remote, false);

  // Current
  assert.equal(await git.current(), 'main');

  // Create branch from a specific branch (not HEAD)
  await git.create('feature');
  const after = await git.branches();
  assert.equal(after.branches.length, 2);

  // Create from a specific branch ref
  await git.exec(['switch', 'feature']);
  await fs.writeFile(path.join(cwd, 'feature-only.txt'), 'feature\n');
  await git.exec(['add', '.']);
  await git.exec(['commit', '-m', 'feature commit']);
  await git.exec(['switch', 'main']);
  // Create from feature while on main — new branch should point to feature's commit
  const featureHash = await git.resolve('feature');
  await git.create('from-feature', 'feature');
  assert.equal(await git.resolve('from-feature'), featureHash);
  // Current branch is still main
  assert.equal(await git.current(), 'main');

  // Make changes on feature
  await git.exec(['switch', 'feature']);
  await fs.rename(path.join(cwd, 'old file.txt'), path.join(cwd, '中文 new.txt'));
  await fs.unlink(path.join(cwd, 'delete.txt'));
  await fs.writeFile(path.join(cwd, 'added.txt'), 'new\n');
  await fs.writeFile(path.join(cwd, 'binary.bin'), Buffer.from([0, 1, 2]));
  await git.exec(['add', '-A']);
  await git.exec(['commit', '-m', 'changes']);

  // Compare feature with HEAD (feature is HEAD now, so no diff)
  const selfCompare = await git.compare('refs/heads/feature');
  assert.equal(selfCompare.files.length, 0);

  // Switch back to main and compare
  await git.exec(['switch', 'main']);
  const result = await git.compare('refs/heads/feature');
  assert.equal(result.files.length, 5);
  const rename = result.files.find(f => f.status.startsWith('R'));
  assert.equal(rename.oldPath, '中文 new.txt');
  assert.equal(rename.newPath, 'old file.txt');

  // Content
  assert.equal(await git.content(result.left, '中文 new.txt'), 'original\n');
  assert.equal(await git.content(result.right, 'delete.txt'), 'delete\n');
  assert.equal(await git.content(result.left, null), '');
  assert.match(await git.content(result.left, 'binary.bin'), /Binary file/);

  // Uncommitted changes don't affect snapshot
  await fs.writeFile(path.join(cwd, 'added.txt'), 'uncommitted\n');
  assert.equal(await git.content(result.left, 'added.txt'), 'new\n');

  // Rename
  await git.rename('feature', 'feature/renamed');
  assert.equal(await git.resolve('feature/renamed'), result.left);

  // Rename current branch
  await git.rename('main', 'main-renamed');
  assert.equal((await git.exec(['branch', '--show-current'])).trim(), 'main-renamed');

  // Rename validation
  await assert.rejects(git.rename('feature/renamed', 'main-renamed'));
  await assert.rejects(git.rename('feature/renamed', '-bad'));
  await assert.rejects(git.rename('feature/renamed', ' bad '));
  await assert.rejects(git.rename('feature/renamed', '@{-1}'));

  // Delete (safe) — refuses unmerged branch
  await git.exec(['switch', 'main-renamed']);
  await assert.rejects(git.remove('feature/renamed'), /not fully merged/);
  // Force delete for test cleanup
  await git.exec(['branch', '-D', '--', 'feature/renamed']);
  const afterDelete = await git.branches();
  assert.equal(afterDelete.branches.length, 2); // main-renamed + from-feature

  // Merge
  await git.create('merge-src');
  await git.exec(['switch', 'merge-src']);
  await fs.writeFile(path.join(cwd, 'merge.txt'), 'merge\n');
  await git.exec(['add', '.']);
  await git.exec(['commit', '-m', 'merge commit']);
  await git.exec(['switch', 'main-renamed']);
  await git.integrate('merge', 'refs/heads/merge-src');
  assert.ok(await fs.stat(path.join(cwd, 'merge.txt')));

  // Rebase
  await git.exec(['switch', 'merge-src']);
  await fs.writeFile(path.join(cwd, 'rebase.txt'), 'rebase\n');
  await git.exec(['add', '.']);
  await git.exec(['commit', '-m', 'rebase commit']);
  await git.exec(['switch', 'main-renamed']);
  await fs.writeFile(path.join(cwd, 'main2.txt'), 'main2\n');
  await git.exec(['add', '.']);
  await git.exec(['commit', '-m', 'main2']);
  await git.exec(['switch', 'merge-src']);
  await git.integrate('rebase', 'refs/heads/main-renamed');
  assert.ok(await fs.stat(path.join(cwd, 'main2.txt')));

  // Tags
  await git.exec(['tag', 'v1.0']);
  const tags = await git.tags();
  assert.equal(tags.length, 1);
  assert.equal(tags[0].name, 'v1.0');

  // Dirty tree blocks merge/rebase
  await fs.writeFile(path.join(cwd, 'dirty.txt'), 'dirty\n');
  await assert.rejects(git.integrate('merge', 'refs/heads/main-renamed'));
});

test('checkout accepts actual tree nodes and rejects missing refs before executing Git', async t => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'git-branch-checkout-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const git = new GitOperations(cwd);
  await git.exec(['init', '-b', 'main']);
  await git.exec(['config', 'user.email', 'test@example.invalid']);
  await git.exec(['config', 'user.name', 'Test']);
  await git.exec(['commit', '--allow-empty', '-m', 'initial']);
  await git.create('feature/local');
  // Shape emitted by BranchTreeProvider: there is no `name` field.
  await git.checkout({ kind: 'branch', label: 'feature/local', ref: 'feature/local', remote: false });
  assert.equal(await git.current(), 'feature/local');
  await git.checkout({ ref: 'refs/heads/main', remote: false });
  assert.equal(await git.current(), 'main');
  await git.checkout({ name: 'feature/local', remote: false });
  assert.equal(await git.current(), 'feature/local');
  await git.exec(['remote', 'add', 'origin', cwd]);
  await git.exec(['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*']);
  const hash = await git.resolve('HEAD');
    await git.create('feature/remote');
    await git.exec(['update-ref', 'refs/remotes/origin/feature/remote', hash]);
  await git.checkout({ kind: 'branch', label: 'feature/remote', ref: 'origin/feature/remote', remote: true });
  assert.equal(await git.current(), 'feature/remote');
  assert.equal((await git.exec(['config', 'branch.feature/remote.remote'])).trim(), 'origin');
  await git.checkout({ ref: 'main', remote: false });
  await git.checkout({ ref: 'origin/feature/remote', remote: true });
  assert.equal(await git.current(), 'feature/remote'); // Reuse tracking branch, do not recreate.
    await git.create('full-ref');
    await git.exec(['update-ref', 'refs/remotes/origin/full-ref', hash]);
  await git.checkout({ ref: 'refs/remotes/origin/full-ref', remote: true });
  assert.equal(await git.current(), 'full-ref');
  await git.exec(['update-ref', 'refs/remotes/origin/main', hash]);
    await git.checkout({ ref: 'origin/main', remote: true });
    assert.equal(await git.current(), 'main'); // Same-name branch is updated and tracked.
    await git.create('second-tracker');
    await git.exec(['config', 'branch.second-tracker.remote', 'origin']);
    await git.exec(['config', 'branch.second-tracker.merge', 'refs/heads/feature/remote']);
    await git.checkout({ ref: 'origin/feature/remote', remote: true });
    assert.equal(await git.current(), 'feature/remote'); // Prefer same-name over other trackers.
    await assert.rejects(git.checkout({ ref: 'missing', remote: false }));
    assert.equal(await git.current(), 'feature/remote');
  const invalid = new GitOperations(cwd);
  let executed = false;
  invalid.exec = async () => { executed = true; };
  for (const node of [undefined, {}, { ref: '' }, { ref: '-bad' }]) {
    await assert.rejects(invalid.checkout(node), /valid branch/);
  }
  assert.equal(executed, false);
});

test('manifest: commands, views, menus are wired', async () => {
  const manifest = require('../package.json');
  const cmds = manifest.contributes.commands.map(c => c.command);
  for (const command of ['git-branch.closeCompare', 'git-branch.closeWorktree']) {
    const item = manifest.contributes.commands.find(c => c.command === command);
    assert.deepEqual(item.icon, { light: 'media/close-small-light.svg', dark: 'media/close-small.svg' });
    for (const asset of Object.values(item.icon)) {
      const svg = await fs.readFile(path.join(__dirname, '..', asset), 'utf8');
      assert.match(svg, /viewBox="0 0 16 16"/);
      assert.match(svg, /m4\.5 4\.5 7 7m0-7-7 7/);
    }
  }
  for (const item of manifest.contributes.commands) {
    assert.ok(!item.title.includes('...') && !item.title.includes('…'));
    assert.ok(!/\bBranches?\b/i.test(item.title));
  }
  const title = id => manifest.contributes.commands.find(c => c.command === `git-branch.${id}`).title;
  assert.equal(title('create'), 'Create');
  assert.equal(title('rename'), 'Rename');
  assert.equal(title('delete'), 'Delete');
  assert.equal(title('createAndCheckout'), 'Create and Checkout');
  assert.equal(title('rebase'), 'Rebase Current onto Target');
  assert.ok(cmds.includes('git-branch.compare'));
  assert.ok(cmds.includes('git-branch.rename'));
  assert.ok(cmds.includes('git-branch.checkout'));
  assert.ok(cmds.includes('git-branch.create'));
  assert.ok(cmds.includes('git-branch.merge'));
  assert.ok(cmds.includes('git-branch.rebase'));
  assert.ok(cmds.includes('git-branch.delete'));
  assert.ok(cmds.includes('git-branch.refresh'));
  assert.equal(title('setTracking'), 'Set Tracking');
  const trackingMenu = manifest.contributes.menus['view/item/context'].find(item => item.command === 'git-branch.setTracking');
  assert.equal(trackingMenu.when, 'view == git-branch.branches && !git-branch.multiSelection && viewItem =~ /^gb-(local|current)$/');
  assert.equal(title('update'), 'Update (Fetch & Pull)');
  assert.equal(title('refreshWorktree'), 'Refresh Diff');
  assert.equal(title('swapWorktree'), 'Swap Comparison');
  assert.equal(title('closeWorktree'), 'Close Diff');
  for (const [id, order] of [['refreshWorktree', 1], ['closeWorktree', 2], ['refreshCompare', 1], ['closeCompare', 2]]) {
    const item = manifest.contributes.menus['view/item/context'].find(menu => menu.command === `git-branch.${id}`);
    assert.equal(item.group, `inline@${order}`);
    assert.match(item.when, /viewItem =~ \/\^gb-(diff|compare)-session-\//);
  }
  assert.ok(!manifest.contributes.menus['view/item/context'].some(menu => /swap/.test(menu.command || '')));

  const views = manifest.contributes.views.scm;
  assert.equal(manifest.contributes.viewsContainers, undefined);
  assert.deepEqual(Object.keys(manifest.contributes.views), ['scm']);
  assert.equal(views.length, 1);
  // The ⋯ button is an inline submenu: VS Code renders it as a dropdown anchored to the button (not a centered QuickPick).
  assert.deepEqual(manifest.contributes.submenus, [{ id: 'git-branch.diffMore', label: 'More Actions', icon: '$(ellipsis)' }]);
  const moreMenu = manifest.contributes.menus['view/item/context'].find(item => item.submenu === 'git-branch.diffMore');
  assert.equal(moreMenu.group, 'inline@3');
  assert.ok(moreMenu.when.includes('viewItem =~ /^gb-(diff|compare)-session-/'));
  assert.ok(!manifest.contributes.menus['view/item/context'].some(item => item.when.includes('gb-comparisons-group')));
  assert.ok(!manifest.contributes.menus['view/item/context'].some(item => item.command === 'git-branch.diffMore'));
  const diffMoreMenu = manifest.contributes.menus['git-branch.diffMore'];
  assert.equal(diffMoreMenu.length, 12);
  for (const id of ['diffList', 'diffTree', 'diffSortName', 'diffSortPath', 'diffSortStatus']) {
    assert.ok(cmds.includes(`git-branch.${id}`));
    assert.ok(cmds.includes(`git-branch.${id}.current`));
    // Options live inside the anchored submenu, not as right-click rows.
    assert.ok(!manifest.contributes.menus['view/item/context'].some(item => item.command === `git-branch.${id}`));
    const base = diffMoreMenu.find(item => item.command === `git-branch.${id}`);
    const current = diffMoreMenu.find(item => item.command === `git-branch.${id}.current`);
    assert.ok(base && current);
    assert.equal(base.group, current.group); // Same slot so the ✓ variant replaces the base in place.
    assert.ok(base.when.startsWith('!('));
    assert.ok(current.when.startsWith('viewItem =~'));
    // Left-align the full title, treating ✓ as text, without placeholder padding.
    const baseCmd = manifest.contributes.commands.find(c => c.command === `git-branch.${id}`);
    const currentCmd = manifest.contributes.commands.find(c => c.command === `git-branch.${id}.current`);
    assert.equal(baseCmd.title, baseCmd.title.trimStart());
    assert.doesNotMatch(baseCmd.title, /[\u2060\u2007]/);
    assert.ok(currentCmd.title.startsWith('\u2713 '));
    assert.equal(baseCmd.title, currentCmd.title.slice(2));
    assert.equal(baseCmd.icon, undefined); // This dropdown does not render command codicons.
    assert.equal(currentCmd.icon, undefined);
    // Both variants are menu-only; keep them out of the command palette.
    for (const variant of [id, `${id}.current`]) {
      assert.ok(manifest.contributes.menus.commandPalette.some(item => item.command === `git-branch.${variant}` && item.when === 'false'));
    }
  }
  assert.ok(views.some(v => v.id === 'git-branch.branches'));
  assert.ok(!views.some(v => v.id === 'git-branch.comparison'));
  assert.ok(cmds.includes('git-branch.openDiff'));
  const titleMenu = manifest.contributes.menus['view/title'];
  assert.deepEqual(titleMenu.map(item => item.command), ['git-branch.refresh']);
  const createMenu = manifest.contributes.menus['view/item/context'].find(item => item.command === 'git-branch.create');
  const menuPattern = new RegExp(createMenu.when.split(' =~ /')[1].slice(0, -1));
  for (const value of ['gb-local', 'gb-current', 'gb-remote', 'gb-tag']) assert.ok(menuPattern.test(value));
  for (const value of ['gb-category', 'gb-remote-group', 'gb-diff-session']) assert.ok(!menuPattern.test(value));
  const compareMenu = manifest.contributes.menus['view/item/context'].find(item => item.command === 'git-branch.compare');
  const comparePattern = new RegExp(compareMenu.when.split(' =~ /')[1].slice(0, -1));
  for (const value of ['gb-local', 'gb-remote']) assert.ok(comparePattern.test(value));
  for (const value of ['gb-current', 'gb-tag', 'gb-category', 'gb-remote-group', 'gb-diff-session']) assert.ok(!comparePattern.test(value));
  assert.ok(cmds.includes('git-branch.worktree'));
  const worktreeMenu = manifest.contributes.menus['view/item/context'].find(item => item.command === 'git-branch.worktree');
  const worktreePattern = new RegExp(worktreeMenu.when.split(' =~ /')[1].slice(0, -1));
  for (const value of ['gb-local', 'gb-current', 'gb-remote']) assert.ok(worktreePattern.test(value));
  for (const value of ['gb-tag', 'gb-category', 'gb-remote-group', 'gb-diff-session']) assert.ok(!worktreePattern.test(value));

  // Current branches use the same branch glyph, highlighted without coloring text.
  const bundle = await fs.readFile(path.join(__dirname, '../src/extension.js'), 'utf8');
  assert.ok(!bundle.includes('git.branchCompare'));
  assert.ok(!bundle.includes('star-full'));
  assert.ok(!bundle.includes('highlights:'));
  assert.ok(bundle.includes("new vscode.ThemeIcon('git-branch', new vscode.ThemeColor('charts.yellow'))"));
  assert.ok(bundle.includes("new vscode.ThemeIcon('tag')"));
  assert.ok(bundle.includes("new vscode.ThemeIcon('git-compare')"));
  assert.ok(!bundle.includes("'current-primary'"));
  assert.ok(bundle.includes('gb-current'));
  assert.ok(bundle.includes('gb-local'));
  assert.ok(bundle.includes('gb-remote'));
});
