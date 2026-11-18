'use strict';
const vscode = require('vscode');
const path = require('node:path');
const { GitOperations } = require('./git-operations');

// ─── Helpers ────────────────────────────────────────────────────────────────

function shortHash(hash) {
  return hash ? hash.slice(0, 7) : '';
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

// ─── Branch Tree ────────────────────────────────────────────────────────────

class BranchTreeProvider {
  constructor(git) {
    this.git = git;
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChange.event;
  }

  refresh() { this._onDidChange.fire(); }

  getTreeItem(element) {
    if (element.kind === 'category') {
      const item = new vscode.TreeItem(element.label, element.expanded
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed);
      item.contextValue = 'gb-category';
      return item;
    }
    if (element.kind === 'remote-group') {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Collapsed);
      item.contextValue = 'gb-remote-group';
      item.iconPath = new vscode.ThemeIcon('cloud');
      return item;
    }
    // branch or tag leaf
    const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
    item.description = shortHash(element.hash);
    item.tooltip = element.ref || element.label;
    if (element.kind === 'tag') {
      item.iconPath = new vscode.ThemeIcon('tag');
      item.contextValue = 'gb-tag';
    } else if (element.current) {
      item.iconPath = new vscode.ThemeIcon('star-full');
      item.contextValue = 'gb-current';
    } else if (element.remote) {
      item.iconPath = new vscode.ThemeIcon('git-branch');
      item.contextValue = 'gb-remote';
    } else {
      item.iconPath = new vscode.ThemeIcon('git-branch');
      item.contextValue = 'gb-local';
    }
    return item;
  }

  async getChildren(element) {
    if (!element) return this.getRootNodes();
    if (element.kind === 'category') return element.children || [];
    if (element.kind === 'remote-group') return element.children || [];
    return [];
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
        current: b.current, remote: false
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
          ref: b.name, hash: b.hash, current: false, remote: true
        });
      }
      const remoteChildren = [...groups.entries()].map(([name, children]) => ({
        kind: 'remote-group', label: name, children
      }));
      const remoteNode = { kind: 'category', label: 'Remote', expanded: false, children: remoteChildren };

      // Tags
      const tagChildren = tags.map(t => ({
        kind: 'tag', label: t.name, ref: t.name, hash: t.hash
      }));
      const tagNode = { kind: 'category', label: 'Tags', expanded: false, children: tagChildren };

      return [localNode, remoteNode, tagNode];
    } catch (err) {
      vscode.window.showErrorMessage(`Git Branch: ${err.message}`);
      return [];
    }
  }
}

// ─── Comparison Tree ────────────────────────────────────────────────────────

class ComparisonTreeProvider {
  constructor() {
    this.comparison = null;
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChange.event;
  }

  setComparison(comparison) {
    this.comparison = comparison;
    this._onDidChange.fire();
  }

  clear() {
    this.comparison = null;
    this._onDidChange.fire();
  }

  getTreeItem(file) {
    const name = file.newPath || file.oldPath;
    const item = new vscode.TreeItem(name, vscode.TreeItemCollapsibleState.None);
    item.description = file.status;
    item.tooltip = `${file.status}: ${file.oldPath || '(absent)'} → ${file.newPath || '(absent)'}`;
    item.iconPath = new vscode.ThemeIcon('diff');
    item.command = {
      command: 'git-branch.openDiff',
      title: 'Open Diff',
      arguments: [{ ...file, left: this.comparison.left, right: this.comparison.right, ref: this.comparison.ref }]
    };
    return item;
  }

  getChildren() {
    return this.comparison ? this.comparison.files : [];
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

  const branchTree = new BranchTreeProvider(git);
  const comparisonTree = new ComparisonTreeProvider();

  // Views
  const branchView = vscode.window.createTreeView('git-branch.branches', {
    treeDataProvider: branchTree,
    showCollapseAll: true
  });
  const comparisonView = vscode.window.createTreeView('git-branch.comparison', {
    treeDataProvider: comparisonTree,
    showCollapseAll: true
  });

  // Content provider for snapshot diffs
  const snapshotScheme = 'git-branch-snapshot';
  const contentProvider = {
    async provideTextDocumentContent(uri) {
      const { hash, file } = JSON.parse(uri.query);
      return git.content(hash, file);
    }
  };

  function snapshotUri(hash, filePath) {
    return vscode.Uri.from({
      scheme: snapshotScheme,
      path: '/' + (filePath || 'empty'),
      query: JSON.stringify({ hash, file: filePath })
    });
  }

  // ── Commands ──

  context.subscriptions.push(
    branchView, comparisonView,
    vscode.workspace.registerTextDocumentContentProvider(snapshotScheme, contentProvider),

    vscode.commands.registerCommand('git-branch.refresh', () => {
      branchTree.refresh();
    }),

    vscode.commands.registerCommand('git-branch.create', async () => {
      try {
        await configureGitExecutable(git);
        const name = await vscode.window.showInputBox({
          title: 'Create Branch',
          prompt: 'New branch name',
          ignoreFocusOut: true,
          validateInput: v => git.validateName(v)
        });
        if (!name) return;
        await git.create(name);
        branchTree.refresh();
        vscode.window.showInformationMessage(`Branch created: ${name}`);
      } catch (err) {
        vscode.window.showErrorMessage(`Create branch failed: ${err.message}`);
      }
    }),

    vscode.commands.registerCommand('git-branch.checkout', async node => {
      if (!node?.ref) return;
      try {
        await configureGitExecutable(git);
        await git.checkout(node);
        branchTree.refresh();
        vscode.window.showInformationMessage(`Checked out: ${node.label}`);
      } catch (err) {
        vscode.window.showErrorMessage(`Checkout failed: ${err.message}`);
      }
    }),

    vscode.commands.registerCommand('git-branch.compare', async node => {
      if (!node?.ref) return;
      try {
        await configureGitExecutable(git);
        const qualified = node.remote ? `refs/remotes/${node.ref}` : `refs/heads/${node.ref}`;
        const result = await git.compare(qualified);
        result.ref = node.ref;
        comparisonTree.setComparison(result);
        comparisonView.description = `${node.ref} → HEAD (${shortHash(result.left)} → ${shortHash(result.right)})`;
        comparisonView.message = result.files.length
          ? 'Left: selected branch commit; Right: current HEAD commit. Click a file to diff.'
          : 'No file differences between the selected branch and current HEAD.';
        await vscode.commands.executeCommand('setContext', 'git-branch.hasComparison', true);
        await vscode.commands.executeCommand('git-branch.comparison.focus');
      } catch (err) {
        vscode.window.showErrorMessage(`Compare failed: ${err.message}`);
      }
    }),

    vscode.commands.registerCommand('git-branch.rename', async node => {
      if (!node || !['gb-local', 'gb-current'].includes(node.contextValue)) {
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
      if (!node?.ref) return;
      try {
        await configureGitExecutable(git);
        const qualified = node.remote ? `refs/remotes/${node.ref}` : node.ref;
        const confirmation = await vscode.window.showWarningMessage(
          `Merge '${node.label}' into current branch?`,
          { modal: true }, 'Merge'
        );
        if (confirmation !== 'Merge') return;
        await git.integrate('merge', qualified);
        branchTree.refresh();
        vscode.window.showInformationMessage(`Merged '${node.label}' into current branch.`);
      } catch (err) {
        vscode.window.showErrorMessage(`Merge failed: ${err.message}`);
      }
    }),

    vscode.commands.registerCommand('git-branch.rebase', async node => {
      if (!node?.ref) return;
      try {
        await configureGitExecutable(git);
        const qualified = node.remote ? `refs/remotes/${node.ref}` : node.ref;
        const confirmation = await vscode.window.showWarningMessage(
          `Rebase current branch onto '${node.label}'?`,
          { modal: true }, 'Rebase'
        );
        if (confirmation !== 'Rebase') return;
        await git.integrate('rebase', qualified);
        branchTree.refresh();
        vscode.window.showInformationMessage(`Rebased current branch onto '${node.label}'.`);
      } catch (err) {
        vscode.window.showErrorMessage(`Rebase failed: ${err.message}`);
      }
    }),

    vscode.commands.registerCommand('git-branch.delete', async node => {
      if (!node || node.contextValue !== 'gb-local') {
        vscode.window.showInformationMessage('Only local branches can be deleted here.');
        return;
      }
      try {
        await configureGitExecutable(git);
        const confirmation = await vscode.window.showWarningMessage(
          `Delete local branch '${node.label}'? (safe delete, refuses if not merged)`,
          { modal: true }, 'Delete'
        );
        if (confirmation !== 'Delete') return;
        await git.remove(node.label);
        branchTree.refresh();
        vscode.window.showInformationMessage(`Branch deleted: ${node.label}`);
      } catch (err) {
        vscode.window.showErrorMessage(`Delete failed: ${err.message}`);
      }
    }),

    vscode.commands.registerCommand('git-branch.openDiff', async file => {
      if (!file) return;
      try {
        const title = `${path.basename(file.newPath || file.oldPath)} (${file.ref} ↔ HEAD)`;
        await vscode.commands.executeCommand(
          'vscode.diff',
          snapshotUri(file.left, file.oldPath),
          snapshotUri(file.right, file.newPath),
          title,
          { preview: true }
        );
      } catch (err) {
        vscode.window.showErrorMessage(`Open diff failed: ${err.message}`);
      }
    }),

    vscode.commands.registerCommand('git-branch.clearComparison', () => {
      comparisonTree.clear();
      comparisonView.description = undefined;
      comparisonView.message = undefined;
      vscode.commands.executeCommand('setContext', 'git-branch.hasComparison', false);
    })
  );

  // Watch for Git changes to auto-refresh
  try {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(root, '.git/{HEAD,refs/**,index}')
    );
    watcher.onDidChange(() => branchTree.refresh());
    watcher.onDidCreate(() => branchTree.refresh());
    watcher.onDidDelete(() => branchTree.refresh());
    context.subscriptions.push(watcher);
  } catch { /* watcher is optional */ }
}

function deactivate() {}

module.exports = { activate, deactivate };
