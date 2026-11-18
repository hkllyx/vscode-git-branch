'use strict';
const vscode = require('vscode');
const path = require('node:path');
const { GitOperations } = require('./git-operations');
const { openComparison, openWorkingTree } = require('./comparison-view');

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
        commitDate: b.commitDate, upstream: b.upstream,
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
          ref: b.name, hash: b.hash, current: false, remote: true,
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

      return [localNode, remoteNode, tagNode];
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
  let lastComparison = null;

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

  function snapshotUri(hash, filePath) {
    return vscode.Uri.from({
      scheme: snapshotScheme,
      path: '/' + (filePath || 'empty'),
      query: JSON.stringify({ hash, file: filePath })
    });
  }

  async function openDiff(file) {
    const title = `${path.basename(file.newPath || file.oldPath)} (${file.ref} ↔ ${file.rightLabel || 'HEAD'})`;
    const right = file.worktree && file.newPath
      ? vscode.Uri.file(git.worktreePath(file.newPath)) : snapshotUri(file.right, file.newPath);
    await vscode.commands.executeCommand('vscode.diff',
      snapshotUri(file.left, file.oldPath), right, title,
      { preview: false, viewColumn: vscode.ViewColumn.Active });
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
        await configureGitExecutable(git);
        const ref = qualifiedRef(node);
        const reload = async () => {
          const dirtyDocuments = (vscode.workspace.textDocuments || [])
            .filter(doc => doc.isDirty && doc.uri.scheme === 'file')
            .map(doc => ({ file: path.relative(root, doc.uri.fsPath).split(path.sep).join('/'), text: doc.getText() }));
          const result = await git.worktreeCompare(ref, dirtyDocuments);
          result.ref = node.ref;
          return result;
        };
        openWorkingTree(vscode, context, await reload(), reload, openDiff);
      } catch (err) {
        vscode.window.showErrorMessage(`Working tree comparison failed: ${err.message}`);
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
  context.subscriptions.push({ dispose() { disposed = true; lastComparison = null; } });
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
