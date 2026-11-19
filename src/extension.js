'use strict';
const vscode = require('vscode');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { GitOperations } = require('./git-operations');
const { openComparison } = require('./comparison-view');

// ─── Helpers ────────────────────────────────────────────────────────────────

function shortHash(hash) {
  return hash ? hash.slice(0, 7) : '';
}

function isBranchNode(node) {
  return node?.kind === 'branch' && typeof node.ref === 'string' && !!node.ref &&
    typeof node.remote === 'boolean';
}

function qualifiedRef(node) {
  if (node?.kind === 'tag') return `refs/tags/${node.ref}`;
  if (!isBranchNode(node)) throw new Error('Right-click a branch to perform this operation.');
  return `${node.remote ? 'refs/remotes/' : 'refs/heads/'}${node.ref}`;
}

async function configureGitExecutable(git) {
  try {
    const ext = vscode.extensions.getExtension('vscode.git');
    if (!ext) return;
    if (!ext.isActive) await ext.activate();
    const api = ext.exports.getAPI(1);
    if (api?.git?.path) git.executable = api.git.path;
  } catch { /* fall back to 'git' on PATH */ }
}

// Dedicated resource scheme prevents built-in Git decorations (relative to HEAD)
// from overriding our status (relative to the selected branch).
const worktreeDecorationScheme = 'git-branch-worktree-file';
const worktreeStatuses = {
  M: ['Modified', 'gitDecoration.modifiedResourceForeground'],
  A: ['Added', 'gitDecoration.addedResourceForeground'],
  D: ['Deleted', 'gitDecoration.deletedResourceForeground'],
  R: ['Renamed', 'gitDecoration.renamedResourceForeground'],
  C: ['Copied', 'gitDecoration.addedResourceForeground'],
  T: ['Type changed', 'gitDecoration.modifiedResourceForeground'],
  U: ['Unmerged', 'gitDecoration.conflictingResourceForeground']
};
const worktreeDecorations = {
  provideFileDecoration(uri) {
    if (uri.scheme !== worktreeDecorationScheme || !Object.hasOwn(worktreeStatuses, uri.query)) return undefined;
    const status = worktreeStatuses[uri.query];
    if (!status) return undefined;
    return { badge: uri.query, tooltip: status[0], color: new vscode.ThemeColor(status[1]), propagate: false };
  }
};

// ─── Branch Tree ────────────────────────────────────────────────────────────

class BranchTreeProvider {
  constructor(git) {
    this.git = git;
    this.workingTrees = new Map();
    this.lastWorkingTreeKey = null;
    this.diffLayout = 'list';
    this.diffSort = 'path';
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChange.event;
  }

  refresh() { this._onDidChange.fire(); }
  dispose() { this._onDidChange.dispose(); }

  setWorkingTree(node, result) {
    const key = qualifiedRef(node);
    this.workingTrees.set(key, { key, node, result });
    this.lastWorkingTreeKey = key;
    this.refresh();
  }

  workingTreeFor(node) {
    if (node && !isBranchNode(node)) return undefined;
    return this.workingTrees.get(node ? qualifiedRef(node) : this.lastWorkingTreeKey);
  }

  clearWorkingTree(key) {
    this.workingTrees.delete(key);
    if (this.lastWorkingTreeKey === key) this.lastWorkingTreeKey = [...this.workingTrees.keys()].at(-1) || null;
    this.refresh();
  }

  diffChildren(comparison, parent, directory = '') {
    const { result, key } = comparison;
    const files = [...result.files].sort((a, b) => {
      const ap = a.newPath || a.oldPath;
      const bp = b.newPath || b.oldPath;
      const primary = this.diffSort === 'name' ? path.posix.basename(ap).localeCompare(path.posix.basename(bp))
        : this.diffSort === 'status' ? a.status.localeCompare(b.status) : 0;
      return primary || ap.localeCompare(bp);
    });
    if (this.diffLayout === 'list') return files.map(file => ({ kind: 'worktree-file', file, result, key, parent }));
    const children = [];
    const folders = new Set();
    for (const file of files) {
      const filePath = file.newPath || file.oldPath;
      if (!filePath.startsWith(directory)) continue;
      const rest = filePath.slice(directory.length);
      const slash = rest.indexOf('/');
      if (slash < 0) children.push({ kind: 'worktree-file', file, result, key, parent });
      else {
        const name = rest.slice(0, slash);
        if (!folders.has(name)) {
          folders.add(name);
          children.push({ kind: 'worktree-folder', label: name, directory: directory + name + '/', key, result, parent });
        }
      }
    }
    return children.sort((a, b) => (a.kind === 'worktree-folder' ? 0 : 1) - (b.kind === 'worktree-folder' ? 0 : 1));
  }

  getTreeItem(element) {
    if (element.kind === 'worktree-folder') {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = `worktree-folder:${element.key}:${element.directory}`;
      item.iconPath = new vscode.ThemeIcon('folder');
      item.contextValue = 'gb-worktree-folder';
      return item;
    }
    if (element.kind === 'worktree-file') {
      const filePath = element.file.newPath || element.file.oldPath;
      const item = new vscode.TreeItem(path.posix.basename(filePath), vscode.TreeItemCollapsibleState.None);
      item.id = `worktree:${element.key}:${filePath}`;
      item.resourceUri = vscode.Uri.from({ scheme: worktreeDecorationScheme,
        path: '/' + filePath, query: element.file.status.slice(0, 1) });
      item.iconPath = new vscode.ThemeIcon('file');
      item.description = this.diffLayout === 'tree' || path.posix.dirname(filePath) === '.' ? '' : path.posix.dirname(filePath);
      item.tooltip = `${filePath}\nStatus: ${element.file.status}\n${element.result.ref} ↔ Working Tree`;
      item.contextValue = 'gb-worktree-file';
      item.command = { command: 'git-branch.openWorktreeDiff', title: 'Open Diff', arguments: [element] };
      return item;
    }
    if (element.kind === 'worktree-empty') {
      return new vscode.TreeItem('No differences with Working Tree', vscode.TreeItemCollapsibleState.None);
    }
    if (element.kind === 'category') {
      const item = new vscode.TreeItem(element.label, element.expanded
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed);
      item.contextValue = element.diffGroup ? 'gb-diff-group' : 'gb-category';
      if (element.diffGroup) {
        item.id = 'worktree-diff-group';
        item.tooltip = 'Working Tree comparisons. Use the ⋯ button to change layout and sorting.';
      }
      return item;
    }
    if (element.kind === 'remote-group') {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Collapsed);
      item.contextValue = 'gb-remote-group';
      return item;
    }
    // Each compared branch independently expands to its working-tree differences.
    const showingWorktree = element.diffSession && isBranchNode(element) && this.workingTreeFor(element);
    const item = new vscode.TreeItem(element.diffSession && element.remote ? element.ref : element.label, showingWorktree
      ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
    item.id = `${element.diffSession ? 'diff-' : ''}${element.kind}:${element.remote ? 'remote' : 'local'}:${element.ref}`;
    const tracking = element.kind === 'tag' ? 'Not applicable (tag)'
      : element.remote ? 'Not applicable (remote branch)'
      : element.upstream ? element.upstream.replace(/^refs\/(heads|remotes)\//, '') : 'Not configured';
    item.tooltip = [
      `${element.kind === 'tag' ? 'Tag' : 'Branch'} name: ${element.ref || element.label}`,
      `Hash: ${element.hash || 'Unknown'}`,
      `Last commit: ${element.commitDate ? element.commitDate.replace('T', ' ') : 'Unknown'}`,
      `Tracking branch: ${tracking}`
    ].join('\n');
    if (element.kind === 'tag') {
      item.contextValue = 'gb-tag';
    } else if (element.current) {
      item.contextValue = 'gb-current';
    } else if (element.remote) {
      item.contextValue = 'gb-remote';
    } else {
      item.contextValue = 'gb-local';
    }
    if (!showingWorktree && isBranchNode(element)) {
      if (element.current || element.primary) {
        const icon = element.current && element.primary ? 'current-primary' : element.current ? 'current-branch' : 'primary-branch';
        item.iconPath = vscode.Uri.file(path.join(__dirname, '..', 'media', `${icon}.svg`));
      }
      item.tooltip += `\nCurrent branch: ${element.current ? 'Yes' : 'No'}\nDefault branch: ${element.primary ? 'Yes (remote HEAD or main/master fallback)' : 'No'}`;
      if (!element.remote && element.upstream) {
        if (element.trackingMissing) {
          item.tooltip += '\nTracking status: upstream ref is missing locally; counts unavailable (not in sync)';
        } else if (Number.isInteger(element.ahead) && Number.isInteger(element.behind)) {
          const differences = [];
          if (element.behind > 0) differences.push(`${element.behind}↓`);
          if (element.ahead > 0) differences.push(`${element.ahead}↑`);
          if (differences.length) item.description = differences.join(' ');
          item.tooltip += `\nTracking status: ${element.ahead} ahead, ${element.behind} behind ${tracking} (commits; local refs only)`;
        }
      }
    }
    if (showingWorktree) {
      const count = showingWorktree.result.files.length;
      // Comparison session, not a branch: compare-style label/icon and no branch context menu.
      item.label = `${item.label} ↔ Working Tree`;
      item.description = `${count} ${count === 1 ? 'file' : 'files'}`;
      item.contextValue = 'gb-diff-session';
      item.tooltip += `\nWorking Tree Diff: ${count} changed ${count === 1 ? 'file' : 'files'} (selected branch ↔ working tree)`;
    }
    return item;
  }

  async getChildren(element) {
    if (!element) return this.getRootNodes();
    if (element.kind === 'category' && element.diffGroup) return [...this.workingTrees.values()].map(entry => ({ ...entry.node, diffSession: true, parent: element }));
    if (element.kind === 'category') return element.children || [];
    if (element.kind === 'remote-group') return element.children || [];
    if (element.kind === 'worktree-folder') {
      const active = this.workingTrees.get(element.key);
      return active?.result === element.result ? this.diffChildren(active, element, element.directory) : [];
    }
    const comparison = element.diffSession && isBranchNode(element) && this.workingTreeFor(element);
    if (comparison) {
      return comparison.result.files.length ? this.diffChildren(comparison, element)
        : [{ kind: 'worktree-empty', key: comparison.key, parent: element }];
    }
    return [];
  }

  async getParent(element) {
    if (element.parent) return element.parent;
    if (element.kind?.startsWith('worktree-')) return this.workingTrees.get(element.key)?.node;
    const roots = await this.getRootNodes();
    for (const root of roots) {
      for (const child of root.children) {
        if (child.kind === element.kind && child.ref === element.ref && child.remote === element.remote && child.label === element.label) return root;
        if (child.kind === 'remote-group' && child.children.some(n => n.ref === element.ref && n.remote === element.remote)) return child;
      }
    }
    return undefined;
  }

  async getRootNodes() {
    try {
      const [{ current, branches }, tags] = await Promise.all([
        this.git.branches(),
        this.git.tags()
      ]);

      // Local
      const locals = branches.filter(b => !b.remote).map(b => ({
        kind: 'branch', label: b.name, ref: b.name, hash: b.hash,
        commitDate: b.commitDate, upstream: b.upstream,
        ahead: b.ahead, behind: b.behind, trackingMissing: b.trackingMissing,
        current: b.current, primary: b.primary, remote: false
      }));
      const localNode = { kind: 'category', label: 'Local', expanded: true, children: locals };

      // Remote — grouped by remote name
      const remotes = branches.filter(b => b.remote);
      const groups = new Map();
      for (const b of remotes) {
        const remoteName = b.name.split('/')[0];
        if (!groups.has(remoteName)) groups.set(remoteName, []);
        groups.get(remoteName).push({
          kind: 'branch', label: b.name.slice(remoteName.length + 1),
          ref: b.name, hash: b.hash, current: false, primary: b.primary, remote: true,
          commitDate: b.commitDate, upstream: b.upstream
        });
      }
      const remoteChildren = [...groups.entries()].map(([name, children]) => ({
        kind: 'remote-group', label: name, children
      }));
      const remoteNode = { kind: 'category', label: 'Remote', expanded: false, children: remoteChildren };

      // Tags
      const tagChildren = tags.map(t => ({
        kind: 'tag', label: t.name, ref: t.name, hash: t.hash, commitDate: t.commitDate
      }));
      const tagNode = { kind: 'category', label: 'Tags', expanded: false, children: tagChildren };

      const roots = [localNode, remoteNode, tagNode];
      if (this.workingTrees.size) roots.push({ kind: 'category', label: 'Diff', diffGroup: true, expanded: true, children: [] });
      return roots;
    } catch (err) {
      vscode.window.showErrorMessage(`Git Branch: ${err.message}`);
      return [];
    }
  }
}

// ─── Activate ───────────────────────────────────────────────────────────────

function activate(context) {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    vscode.window.showWarningMessage('Git Branch: no workspace folder found.');
    return;
  }
  const root = workspaceFolder.uri.fsPath;
  const git = new GitOperations(root);
  git.ready = configureGitExecutable(git);

  const branchTree = new BranchTreeProvider(git);
  for (const [property, values] of [['diffLayout', ['list', 'tree']], ['diffSort', ['name', 'path', 'status']]]) {
    const saved = context.workspaceState?.get(`git-branch.${property}`);
    if (values.includes(saved)) branchTree[property] = saved;
  }
  // Drive the ⋯ submenu's ✓ current-item entries via when-clause context keys.
  const syncDiffContextKeys = () => {
    vscode.commands.executeCommand('setContext', 'git-branch.diffLayout', branchTree.diffLayout);
    vscode.commands.executeCommand('setContext', 'git-branch.diffSort', branchTree.diffSort);
  };
  syncDiffContextKeys();
  let lastComparison = null;
  const worktreeRequests = new Map();
  const worktreeSessions = new Map();

  async function closeSessionTabs(session) {
    const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => {
      if (!(tab.input instanceof vscode.TabInputTextDiff) || tab.input.original.scheme !== snapshotScheme) return false;
      try { return JSON.parse(tab.input.original.query).worktreeSession === session.id; }
      catch { return false; }
    });
    // Target exact comparison tabs across groups. VS Code keeps its normal unsaved-change prompts.
    if (tabs.length) return vscode.window.tabGroups.close(tabs, true);
    return true;
  }

  async function showWorkingTree(node) {
    const key = qualifiedRef(node);
    const request = Symbol();
    worktreeRequests.set(key, request);
    await configureGitExecutable(git);
    const dirtyDocuments = (vscode.workspace.textDocuments || [])
      .filter(doc => doc.isDirty && doc.uri.scheme === 'file')
      .map(doc => ({ file: path.relative(root, doc.uri.fsPath).split(path.sep).join('/'), text: doc.getText() }));
    const result = await git.worktreeCompare(key, dirtyDocuments);
    if (worktreeRequests.get(key) !== request) return;
    result.ref = node.ref;
    if (!worktreeSessions.has(key)) worktreeSessions.set(key, { id: randomUUID(), closed: false });
    branchTree.setWorkingTree(node, result);
    await vscode.commands.executeCommand('git-branch.branches.focus');
    const group = (await branchTree.getRootNodes()).find(item => item.diffGroup);
    await branchView.reveal({ ...node, diffSession: true, parent: group }, { expand: true, select: true, focus: false });
  }

  // Views
  const branchView = vscode.window.createTreeView('git-branch.branches', {
    treeDataProvider: branchTree,
    showCollapseAll: true
  });

  // Content provider for snapshot diffs
  const snapshotScheme = 'git-branch-snapshot';
  const snapshotProvider = {
    async provideTextDocumentContent(uri) {
      const { hash, file } = JSON.parse(uri.query);
      return git.content(hash, file);
    }
  };

  function snapshotUri(hash, filePath, session) {
    return vscode.Uri.from({
      scheme: snapshotScheme,
      path: '/' + (filePath || 'empty'),
      query: JSON.stringify({ hash, file: filePath, ...(session ? { worktreeSession: session.id } : {}) })
    });
  }

  async function openDiff(file, session) {
    if (session?.closed) return;
    const title = `${path.basename(file.newPath || file.oldPath)} (${file.ref} ↔ ${file.rightLabel || 'HEAD'})`;
    const right = file.worktree && file.newPath
      ? vscode.Uri.file(git.worktreePath(file.newPath)) : snapshotUri(file.right, file.newPath, session);
    await vscode.commands.executeCommand('vscode.diff',
      snapshotUri(file.left, file.oldPath, session), right, title,
      { preview: false, viewColumn: vscode.ViewColumn.Active });
    // Closing while vscode.diff was pending must not leave a late-opening tab behind.
    if (session?.closed) await closeSessionTabs(session);
  }

  async function createBranch(node, checkout) {
    try {
      await configureGitExecutable(git);
      // Group/title arguments do not specify a branch; default to current HEAD.
      const specified = isBranchNode(node) || (node?.kind === 'tag' && !!node.ref);
      const current = specified ? undefined : await git.current();
      const startPoint = specified ? qualifiedRef(node) : 'HEAD';
      const startLabel = specified ? node.ref : (current || 'HEAD (detached)');
      const name = await vscode.window.showInputBox({
        title: `${checkout ? 'Create and Checkout' : 'Create Branch'} (from ${startLabel})`,
        prompt: `New branch name (based on ${startLabel})`,
        ignoreFocusOut: true,
        validateInput: v => git.validateName(v)
      });
      if (!name) return;
      await git.create(name, startPoint);
      branchTree.refresh();
      if (!checkout) {
        vscode.window.showInformationMessage(`Branch created: ${name} (from ${startLabel})`);
        return;
      }
      try {
        await git.checkout({ ref: name, remote: false });
        branchTree.refresh();
        vscode.window.showInformationMessage(`Branch created and checked out: ${name} (from ${startLabel})`);
      } catch (err) {
        branchTree.refresh();
        vscode.window.showErrorMessage(`Branch '${name}' was created, but checkout failed: ${err.message}`);
      }
    } catch (err) {
      vscode.window.showErrorMessage(`Create branch failed: ${err.message}`);
    }
  }

  // ── Commands ──

  context.subscriptions.push(
    branchView, branchTree,
    ...[['diffList', 'diffLayout', 'list'], ['diffTree', 'diffLayout', 'tree'],
      ['diffSortName', 'diffSort', 'name'], ['diffSortPath', 'diffSort', 'path'], ['diffSortStatus', 'diffSort', 'status']]
      .flatMap(([command, property, value]) => [command, `${command}.current`].map(id =>
        vscode.commands.registerCommand(`git-branch.${id}`, async () => {
          branchTree[property] = value;
          await context.workspaceState?.update(`git-branch.${property}`, value);
          syncDiffContextKeys();
          branchTree.refresh();
        }))),
    vscode.window.registerFileDecorationProvider(worktreeDecorations),
    vscode.workspace.registerTextDocumentContentProvider(snapshotScheme, snapshotProvider),

    vscode.commands.registerCommand('git-branch.refresh', () => {
      branchTree.refresh();
    }),

    vscode.commands.registerCommand('git-branch.create', node => createBranch(node, false)),
    vscode.commands.registerCommand('git-branch.createAndCheckout', node => createBranch(node, true)),

    vscode.commands.registerCommand('git-branch.checkout', async node => {
      if (!isBranchNode(node)) {
        vscode.window.showInformationMessage('Right-click a branch to check it out.');
        return;
      }
      try {
          await configureGitExecutable(git);
          const repositoryPath = path.resolve(git.cwd);
          if (node.remote && vscode.workspace.textDocuments?.some(document => {
            if (!document.isDirty || document.uri.scheme !== 'file') return false;
            const relative = path.relative(repositoryPath, document.uri.fsPath);
            return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
          })) throw new Error('Save or revert your unsaved editor changes before checking out a remote branch.');
          const result = await git.checkout(node, async ({ name, remote, count }) => {
            const choice = await vscode.window.showWarningMessage(
              `Local branch '${name}' has ${count} commit(s) not in '${remote}'. Drop these local commits and check out the fetched remote version?`,
              { modal: true, detail: 'Drop Local Commits resets the local branch to the remote commit. Uncommitted file changes are not discarded.' },
              'Drop Local Commits'
            );
            return choice === 'Drop Local Commits';
          });
          branchTree.refresh();
          if (result === false) return;
          vscode.window.showInformationMessage(`Checked out: ${result || node.label}`);
      } catch (err) {
        vscode.window.showErrorMessage(`Checkout failed: ${err.message}`);
      }
    }),

    vscode.commands.registerCommand('git-branch.compare', async node => {
      if (!isBranchNode(node)) {
        vscode.window.showInformationMessage('Right-click a branch to compare it with current HEAD.');
        return;
      }
      try {
        await configureGitExecutable(git);
        const current = await git.current();
        // Recheck repository state: a stale tree node may now be current.
        if (!node.remote && node.ref === current) {
          vscode.window.showInformationMessage('Select a different branch to compare with current.');
          return;
        }
        const result = await git.branchComparison(qualifiedRef(node));
        result.ref = node.ref;
        result.currentLabel = current || `HEAD (detached ${shortHash(result.right)})`;
        openComparison(vscode, context, git, result, openDiff,
          active => { lastComparison = active; },
          closed => { if (lastComparison === closed) lastComparison = null; });
      } catch (err) {
        vscode.window.showErrorMessage(`Compare failed: ${err.message}`);
      }
    }),

    vscode.commands.registerCommand('git-branch.worktree', async node => {
      if (!isBranchNode(node)) {
        vscode.window.showInformationMessage('Right-click a branch to compare it with the working tree.');
        return;
      }
      try {
        await showWorkingTree(node);
      } catch (err) {
        vscode.window.showErrorMessage(`Working tree comparison failed: ${err.message}`);
      }
    }),

    vscode.commands.registerCommand('git-branch.refreshWorktree', async node => {
      const active = branchTree.workingTreeFor(node);
      if (!active) return;
      try { await showWorkingTree(active.node); }
      catch (err) { vscode.window.showErrorMessage(`Working tree comparison failed: ${err.message}`); }
    }),
    vscode.commands.registerCommand('git-branch.closeWorktree', async node => {
      const active = branchTree.workingTreeFor(node);
      if (node && !isBranchNode(node)) return;
      const key = active?.key || (node ? qualifiedRef(node) : branchTree.lastWorkingTreeKey);
      if (!key) return;
      worktreeRequests.delete(key);
      branchTree.clearWorkingTree(key);
      const session = worktreeSessions.get(key);
      if (!session) return;
      session.closed = true;
      worktreeSessions.delete(key);
      try {
        if (!await closeSessionTabs(session)) vscode.window.showInformationMessage('Some comparison tabs remain open because closing was cancelled.');
      } catch (err) { vscode.window.showErrorMessage(`Close comparison tabs failed: ${err.message}`); }
    }),
    vscode.commands.registerCommand('git-branch.openWorktreeDiff', async element => {
      const active = branchTree.workingTrees.get(element?.key);
      // Only accept files from the current host-generated list, never stale tree nodes.
      if (element?.kind !== 'worktree-file' || element.result !== active?.result || !active.result.files.includes(element.file)) return;
      try {
        await openDiff({ ...element.file, left: active.result.left, right: null,
            ref: active.result.ref, rightLabel: 'Working Tree', worktree: true }, worktreeSessions.get(active.key));
      } catch (err) { vscode.window.showErrorMessage(`Open diff failed: ${err.message}`); }
    }),

      vscode.commands.registerCommand('git-branch.setTracking', async node => {
        if (!isBranchNode(node) || node.remote || node.diffSession) {
          vscode.window.showInformationMessage('Right-click a local branch to set its tracking branch.');
          return;
        }
        try {
          await configureGitExecutable(git);
          const { branches } = await git.branches();
          const source = branches.find(branch => branch.ref === `refs/heads/${node.ref}`);
          if (!source) throw new Error('Local branch no longer exists. Refresh the branch list.');
          const items = [{ label: 'No Tracking', description: source.upstream ? 'Remove the current upstream' : 'Current', upstream: null },
            ...branches.filter(branch => branch.ref !== source.ref).map(branch => ({
              label: branch.name,
              description: `${branch.remote ? 'Remote' : 'Local'}${branch.ref === source.upstream ? ' · Current' : ''}`,
              upstream: branch.ref
            }))];
          const selected = await vscode.window.showQuickPick(items, {
            title: `Set Tracking — ${node.ref}`,
            placeHolder: 'Choose an upstream branch, or No Tracking to remove it',
            matchOnDescription: true,
            ignoreFocusOut: true
          });
          if (!selected) return;
          await git.setTracking(node.ref, selected.upstream);
          branchTree.refresh();
          vscode.window.showInformationMessage(selected.upstream === null
            ? `Tracking removed: ${node.ref}` : `Tracking set: ${node.ref} → ${selected.label}`);
        } catch (err) {
          branchTree.refresh();
          vscode.window.showErrorMessage(`Set tracking failed: ${err.message}`);
        }
      }),

      vscode.commands.registerCommand('git-branch.rename', async node => {
      if (node?.kind !== 'branch' || node.remote !== false || !node.ref) {
        vscode.window.showInformationMessage('Right-click a local branch to rename it.');
        return;
      }
      try {
        await configureGitExecutable(git);
        const newName = await vscode.window.showInputBox({
          title: 'Rename Branch (local only)',
          prompt: `Rename '${node.label}' to:`,
          value: node.label,
          ignoreFocusOut: true,
          validateInput: v => git.validateName(v)
        });
        if (!newName || newName === node.label) return;
        const confirmation = await vscode.window.showWarningMessage(
          `Rename local branch '${node.label}' to '${newName}'?`,
          { modal: true, detail: 'Remote branches are not changed. No force overwrite.' },
          'Rename'
        );
        if (confirmation !== 'Rename') return;
        await git.rename(node.label, newName);
        branchTree.refresh();
        vscode.window.showInformationMessage(`Branch renamed: ${node.label} → ${newName}`);
      } catch (err) {
        vscode.window.showErrorMessage(`Rename failed: ${err.message}`);
      }
    }),

    vscode.commands.registerCommand('git-branch.merge', async node => {
      if (!isBranchNode(node)) {
        vscode.window.showInformationMessage('Right-click a branch to merge it into current.');
        return;
      }
      try {
        await configureGitExecutable(git);
        const qualified = qualifiedRef(node);
        const confirmation = await vscode.window.showWarningMessage(
          `Merge '${node.label}' into current branch?`,
          { modal: true }, 'Merge'
        );
        if (confirmation !== 'Merge') return;
        await git.integrate('merge', qualified);
        branchTree.refresh();
        vscode.window.showInformationMessage(`Merged '${node.label}' into current branch.`);
      } catch (err) {
        branchTree.refresh();
        vscode.window.showErrorMessage(`Merge failed: ${err.message}\nIf Git reports conflicts, resolve and continue or abort the merge; no automatic rollback was performed.`);
      }
    }),

    vscode.commands.registerCommand('git-branch.rebase', async node => {
      if (!isBranchNode(node)) {
        vscode.window.showInformationMessage('Right-click a branch to rebase current onto it.');
        return;
      }
      try {
        await configureGitExecutable(git);
        const qualified = qualifiedRef(node);
        const confirmation = await vscode.window.showWarningMessage(
          `Rebase current branch onto '${node.label}'?`,
          { modal: true }, 'Rebase'
        );
        if (confirmation !== 'Rebase') return;
        await git.integrate('rebase', qualified);
        branchTree.refresh();
        vscode.window.showInformationMessage(`Rebased current branch onto '${node.label}'.`);
      } catch (err) {
        branchTree.refresh();
        vscode.window.showErrorMessage(`Rebase failed: ${err.message}\nIf Git reports conflicts, resolve and continue or abort the rebase; no automatic rollback was performed.`);
      }
    }),

    vscode.commands.registerCommand('git-branch.delete', async node => {
      if (node?.kind !== 'branch' || node.remote !== false || !node.ref) {
        vscode.window.showInformationMessage('Only local branches can be deleted here.');
        return;
      }
      try {
        await configureGitExecutable(git);
        if (await git.current() === node.ref) {
          vscode.window.showInformationMessage('Cannot delete the current branch. Check out another branch first.');
          return;
        }
        const originalHash = await git.resolve(`refs/heads/${node.ref}`);
        const confirmation = await vscode.window.showWarningMessage(
          `Delete local branch '${node.ref}'?`,
          { modal: true, detail: 'Safe deletion is attempted first. Unmerged branches require a separate Force Delete confirmation.' }, 'Delete'
        );
        if (confirmation !== 'Delete') return;
        try {
          await git.remove(node.ref);
        } catch (error) {
          if (!error.unmergedBranch) throw error;
          const force = await vscode.window.showWarningMessage(
            `Branch '${node.ref}' is not fully merged. Force delete it?`,
            { modal: true, detail: 'Commits only reachable through this branch may become inaccessible. This removes the local branch only; remote branches are unchanged.' },
            'Force Delete'
          );
          if (force !== 'Force Delete') return;
          if (await git.resolve(`refs/heads/${node.ref}`) !== originalHash) {
            throw new Error('Branch changed while confirmation was open. Retry deletion after reviewing it.');
          }
          // Git still refuses the current branch or a branch checked out in another worktree.
          await git.remove(node.ref, true);
        }
        branchTree.refresh();
        vscode.window.showInformationMessage(`Branch deleted: ${node.ref}`);
      } catch (err) {
        vscode.window.showErrorMessage(`Delete failed: ${err.message}`);
      }
    }),

    vscode.commands.registerCommand('git-branch.openDiff', async file => {
      const comparison = lastComparison;
      if (!file && !comparison?.files?.length) {
        vscode.window.showInformationMessage('No diff files available. Run Compare with Current first.');
        return;
      }
      if (!file && comparison?.files?.length) {
        const items = comparison.files.map(f => ({
          label: f.newPath || f.oldPath,
          description: f.status,
          file: { ...f, left: comparison.left, right: comparison.right, ref: comparison.ref, rightLabel: comparison.currentLabel }
        }));
        const picked = await vscode.window.showQuickPick(items, {
          title: `Open Diff (${comparison.ref} ↔ HEAD)`,
          placeHolder: 'Select a file to diff'
        });
        if (!picked) return;
        file = picked.file;
      }
      if (!file) return;
      try {
        await openDiff(file);
      } catch (err) {
        vscode.window.showErrorMessage(`Open diff failed: ${err.message}`);
      }
    })
  );

  let disposed = false;
  context.subscriptions.push({ dispose() {
    disposed = true; lastComparison = null;
    worktreeRequests.clear(); branchTree.workingTrees.clear(); worktreeSessions.clear();
  } });
  // Resolve actual Git directories: .git may be a file in worktrees, and refs may be packed.
  return (async () => {
    try {
      const gitDir = (await git.exec(['rev-parse', '--absolute-git-dir'])).trim();
      const commonDir = path.resolve(root, (await git.exec(['rev-parse', '--git-common-dir'])).trim());
      if (disposed) return;
      for (const directory of new Set([gitDir, commonDir])) {
        const watcher = vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(directory, '{HEAD,refs/**,packed-refs,index,config}')
        );
        watcher.onDidChange(() => branchTree.refresh());
        watcher.onDidCreate(() => branchTree.refresh());
        watcher.onDidDelete(() => branchTree.refresh());
        context.subscriptions.push(watcher);
      }
    } catch { /* Non-repository workspaces still offer manual refresh. */ }
  })();
}

function deactivate() {}

module.exports = { activate, deactivate };
