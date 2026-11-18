'use strict';
const vscode = require('vscode');
const path = require('node:path');
const { GitOperations } = require('./git-operations');

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

// ─── Branch Tree ────────────────────────────────────────────────────────────

class BranchTreeProvider {
  constructor(git) {
    this.git = git;
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChange.event;
  }

  refresh() { this._onDidChange.fire(); }
  dispose() { this._onDidChange.dispose(); }

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

// ─── Compare Document Provider ──────────────────────────────────────────────

const COMPARE_SCHEME = 'git-branch-compare';

function renderComparison(result) {
  const lines = [];
  lines.push(`Branch Comparison: ${result.ref} → HEAD`);
  lines.push(`Left  (selected branch): ${result.left}`);
  lines.push(`Right (current HEAD):    ${result.right}`);
  lines.push('');
  if (!result.files.length) {
    lines.push('No file differences.');
    return lines.join('\n');
  }
  lines.push(`${result.files.length} file(s) changed:`);
  lines.push('');
  for (const f of result.files) {
    const statusLabel = {
      A: 'Added', D: 'Deleted', M: 'Modified',
      R: 'Renamed', C: 'Copied', T: 'Type changed'
    }[f.status[0]] || f.status;
    const name = f.newPath || f.oldPath;
    if (f.status.startsWith('R') || f.status.startsWith('C')) {
      lines.push(`  [${statusLabel}] ${f.oldPath} → ${f.newPath}`);
    } else {
      lines.push(`  [${statusLabel}] ${name}`);
    }
  }
  lines.push('');
  lines.push('Use "Git Branch: Open Diff" from the command palette to view individual file diffs.');
  return lines.join('\n');
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
  const comparisons = new Map();
  let lastComparison = null;
  let comparisonSequence = 0;

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

  // Content provider for comparison summary document
  const compareProvider = {
    provideTextDocumentContent(uri) {
      const result = comparisons.get(uri.query);
      return result ? renderComparison(result) : 'Comparison expired. Run Compare with Current again.';
    }
  };

  function snapshotUri(hash, filePath) {
    return vscode.Uri.from({
      scheme: snapshotScheme,
      path: '/' + (filePath || 'empty'),
      query: JSON.stringify({ hash, file: filePath })
    });
  }

  function compareUri(result) {
    return vscode.Uri.from({
      scheme: COMPARE_SCHEME,
      path: `/compare-${result.ref.replace(/[/\\]/g, '-')}.txt`,
      // A new immutable document for every comparison; no stale VS Code document cache.
      query: `${++comparisonSequence}:${result.left}:${result.right}`
    });
  }

  // ── Commands ──

  context.subscriptions.push(
    branchView, branchTree,
    vscode.workspace.registerTextDocumentContentProvider(snapshotScheme, snapshotProvider),
    vscode.workspace.registerTextDocumentContentProvider(COMPARE_SCHEME, compareProvider),

    vscode.commands.registerCommand('git-branch.refresh', () => {
      branchTree.refresh();
    }),

    vscode.commands.registerCommand('git-branch.create', async node => {
      try {
        await configureGitExecutable(git);
        // A category/view argument is not a selected branch. Fall back to current HEAD.
        const specified = isBranchNode(node) || (node?.kind === 'tag' && !!node.ref);
        const current = specified ? undefined : await git.current();
        const startPoint = specified ? qualifiedRef(node) : 'HEAD';
        const startLabel = specified ? node.ref : (current || 'HEAD (detached)');
        const name = await vscode.window.showInputBox({
          title: `Create Branch (from ${startLabel})`,
          prompt: `New branch name (based on ${startLabel})`,
          ignoreFocusOut: true,
          validateInput: v => git.validateName(v)
        });
        if (!name) return;
        await git.create(name, startPoint);
        branchTree.refresh();
        vscode.window.showInformationMessage(`Branch created: ${name} (from ${startLabel})`);
      } catch (err) {
        vscode.window.showErrorMessage(`Create branch failed: ${err.message}`);
      }
    }),

    vscode.commands.registerCommand('git-branch.checkout', async node => {
      if (!isBranchNode(node)) {
        vscode.window.showInformationMessage('Right-click a branch to check it out.');
        return;
      }
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
      if (!isBranchNode(node)) {
        vscode.window.showInformationMessage('Right-click a branch to compare it with current HEAD.');
        return;
      }
      try {
        await configureGitExecutable(git);
        const result = await git.compare(qualifiedRef(node));
        result.ref = node.ref;
        lastComparison = result;
        const uri = compareUri(result);
        comparisons.set(uri.query, result);
        try {
          const doc = await vscode.workspace.openTextDocument(uri);
          await vscode.window.showTextDocument(doc, { preview: false });
        } catch (error) {
          comparisons.delete(uri.query);
          throw error;
        }
      } catch (err) {
        vscode.window.showErrorMessage(`Compare failed: ${err.message}`);
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
        await git.exec(['show-ref', '--verify', `refs/heads/${node.ref}`]);
        const confirmation = await vscode.window.showWarningMessage(
          `Delete local branch '${node.ref}'? (safe delete, refuses if not merged)`,
          { modal: true }, 'Delete'
        );
        if (confirmation !== 'Delete') return;
        await git.remove(node.ref);
        branchTree.refresh();
        vscode.window.showInformationMessage(`Branch deleted: ${node.ref}`);
      } catch (err) {
        vscode.window.showErrorMessage(`Delete failed: ${err.message}`);
      }
    }),

    vscode.commands.registerCommand('git-branch.openDiff', async file => {
      const activeUri = vscode.window.activeTextEditor?.document.uri;
      const comparison = activeUri?.scheme === COMPARE_SCHEME
        ? comparisons.get(activeUri.query) : lastComparison;
      if (!file && !comparison?.files?.length) {
        vscode.window.showInformationMessage('No diff files available. Run Compare with Current first.');
        return;
      }
      if (!file && comparison?.files?.length) {
        const items = comparison.files.map(f => ({
          label: f.newPath || f.oldPath,
          description: f.status,
          file: { ...f, left: comparison.left, right: comparison.right, ref: comparison.ref }
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
    })
  );

  let disposed = false;
  context.subscriptions.push({ dispose() { disposed = true; comparisons.clear(); lastComparison = null; } });
  if (vscode.workspace.onDidCloseTextDocument) {
    context.subscriptions.push(vscode.workspace.onDidCloseTextDocument(document => {
      if (document.uri.scheme === COMPARE_SCHEME) comparisons.delete(document.uri.query);
    }));
  }
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
