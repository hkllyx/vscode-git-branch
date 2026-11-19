'use strict';
const vscode = require('vscode');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { GitOperations } = require('./git-operations');
// Comparisons are hosted in the native Branches tree.

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

function worktreeLabels(result) {
  const labels = [result.ref, result.worktree ? 'Working Tree' : result.currentLabel];
  return result.reversed ? labels.reverse() : labels;
}

function reverseWorktreeResult(result) {
  return { ...result, reversed: !result.reversed,
    ...(!result.worktree ? { left: result.right, right: result.left } : {}),
    files: result.files.map(file => ({
    ...file, oldPath: file.newPath, newPath: file.oldPath,
    status: file.status === 'A' ? 'D' : file.status === 'D' ? 'A' : file.status
  })) };
}

// ─── Branch Tree ────────────────────────────────────────────────────────────

class BranchTreeProvider {
  constructor(git) {
    this.git = git;
    this.workingTrees = new Map();
    this.comparisons = new Map();
    this.lastWorkingTreeKey = null;
    this.savedSettings = {};
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChange.event;
  }

  settingsFor(key) {
    const saved = this.savedSettings[key] || {};
    return { layout: ['list', 'tree'].includes(saved.layout) ? saved.layout : 'list',
      sort: ['name', 'path', 'status'].includes(saved.sort) ? saved.sort : 'path' };
  }

  refresh() { this._onDidChange.fire(); }
  dispose() { this._onDidChange.dispose(); }

  setWorkingTree(node, result) {
    const key = node.diffKey || qualifiedRef(node);
    if (this.workingTrees.get(key)?.result.reversed) result = reverseWorktreeResult(result);
    const previous = this.workingTrees.get(key);
    this.workingTrees.set(key, { key, node, result, settings: previous?.settings || this.settingsFor(key) });
    this.lastWorkingTreeKey = key;
    this.refresh();
  }

  workingTreeFor(node) {
    if (node && !isBranchNode(node)) return undefined;
    return this.workingTrees.get(node ? node.diffKey || qualifiedRef(node) : this.lastWorkingTreeKey);
  }

  clearWorkingTree(key) {
    this.workingTrees.delete(key);
    if (this.lastWorkingTreeKey === key) this.lastWorkingTreeKey = [...this.workingTrees.keys()].at(-1) || null;
    this.refresh();
  }

  diffChildren(comparison, parent, directory = '', details) {
    const { result, key, settings } = comparison;
    const nodeData = details ? { details, entry: comparison } : { result };
    const fileKind = details ? 'compare-file' : 'worktree-file';
    const folderKind = details ? 'compare-folder' : 'worktree-folder';
    const files = [...(details || result).files].sort((a, b) => {
      const ap = a.newPath || a.oldPath;
      const bp = b.newPath || b.oldPath;
      const primary = settings.sort === 'name' ? path.posix.basename(ap).localeCompare(path.posix.basename(bp))
        : settings.sort === 'status' ? a.status.localeCompare(b.status) : 0;
      return primary || ap.localeCompare(bp);
    });
    if (settings.layout === 'list') return files.map(file => ({ kind: fileKind, file, ...nodeData, key, parent, layout: settings.layout }));
    const children = [];
    const folders = new Set();
    for (const file of files) {
      const filePath = file.newPath || file.oldPath;
      if (!filePath.startsWith(directory)) continue;
      const rest = filePath.slice(directory.length);
      const slash = rest.indexOf('/');
      if (slash < 0) children.push({ kind: fileKind, file, ...nodeData, key, parent, layout: settings.layout });
      else {
        const name = rest.slice(0, slash);
        if (!folders.has(name)) {
          folders.add(name);
          children.push({ kind: folderKind, label: name, directory: directory + name + '/', key, ...nodeData, parent });
        }
      }
    }
    return children.sort((a, b) => (a.kind === folderKind ? 0 : 1) - (b.kind === folderKind ? 0 : 1));
  }

  getTreeItem(element) {
    if (element.kind === 'compare-session') {
      const { result } = element.entry;
      const item = new vscode.TreeItem(`${result.ref} ↔ ${result.currentLabel}`, vscode.TreeItemCollapsibleState.Expanded);
      item.id = element.key;
      item.contextValue = `gb-compare-session-${element.entry.settings.layout}-${element.entry.settings.sort}`;
      const total = result.selected.total + result.current.total;
      item.description = total ? `· ${total} ${total === 1 ? 'commit' : 'commits'}` : 'Commits';
      item.tooltip = `Left: ${result.ref}\nRight: ${result.currentLabel}\nLeft only: ${result.selected.total} commits\nRight only: ${result.current.total} commits`;
      return item;
    }
    if (element.kind === 'compare-side') {
      const item = new vscode.TreeItem(`${element.side === 'selected' ? 'Left' : 'Right'} only`, vscode.TreeItemCollapsibleState.Expanded);
      item.tooltip = `${element.label}\n${element.history.total} exclusive commits`;
      item.id = `${element.key}:${element.side}`;
      item.description = `· ${element.history.total} commits`;
      item.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor(element.side === 'selected'
        ? 'gitDecoration.addedResourceForeground' : 'gitDecoration.modifiedResourceForeground'));
      item.contextValue = 'gb-compare-side';
      return item;
    }
    if (element.kind === 'compare-commit') {
      const item = new vscode.TreeItem(element.commit.subject, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = `${element.key}:${element.parent.side}:${element.commit.hash}`;
      item.description = `${shortHash(element.commit.hash)} · ${element.commit.author}`;
      item.tooltip = `${element.commit.subject}\n${element.commit.hash}\n${element.commit.author}\n${element.commit.date}\nFiles compare first parent → commit`;
      item.contextValue = 'gb-compare-commit';
      return item;
    }
    if (element.kind === 'compare-more') {
      const item = new vscode.TreeItem('Load more commits', vscode.TreeItemCollapsibleState.None);
      item.contextValue = 'gb-compare-more';
      item.command = { command: 'git-branch.loadCompare', title: 'Load more commits', arguments: [element.parent] };
      return item;
    }
    if (element.kind === 'compare-file') {
      const name = element.file.newPath || element.file.oldPath;
      const item = new vscode.TreeItem(path.posix.basename(name), vscode.TreeItemCollapsibleState.None);
      item.id = `${element.key}:${element.details.hash}:${name}`;
      item.description = element.layout === 'tree' || path.posix.dirname(name) === '.' ? '' : path.posix.dirname(name);
      item.iconPath = new vscode.ThemeIcon('file');
      item.resourceUri = vscode.Uri.from({ scheme: worktreeDecorationScheme, path: '/' + name, query: element.file.status[0] });
      item.tooltip = `${name}\nStatus: ${element.file.status}\nFirst parent → ${shortHash(element.details.hash)}`;
      item.contextValue = 'gb-compare-file';
      item.command = { command: 'git-branch.openCompareDiff', title: 'Open Diff', arguments: [element] };
      return item;
    }
    if (element.kind === 'worktree-folder' || element.kind === 'compare-folder') {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = `${element.kind}:${element.key}:${element.details?.hash || ''}:${element.directory}`;
      item.iconPath = new vscode.ThemeIcon('folder');
      item.contextValue = 'gb-comparison-folder';
      return item;
    }
    if (element.kind === 'worktree-file') {
      const filePath = element.file.newPath || element.file.oldPath;
      const item = new vscode.TreeItem(path.posix.basename(filePath), vscode.TreeItemCollapsibleState.None);
      item.id = `worktree:${element.key}:${filePath}`;
      item.resourceUri = vscode.Uri.from({ scheme: worktreeDecorationScheme,
        path: '/' + filePath, query: element.file.status.slice(0, 1) });
      item.iconPath = new vscode.ThemeIcon('file');
      item.description = element.layout === 'tree' || path.posix.dirname(filePath) === '.' ? '' : path.posix.dirname(filePath);
      item.tooltip = `${filePath}\nStatus: ${element.file.status}\n${worktreeLabels(element.result).join(' ↔ ')}`;
      item.contextValue = 'gb-worktree-file';
      item.command = { command: 'git-branch.openWorktreeDiff', title: 'Open Diff', arguments: [element] };
      return item;
    }
    if (element.kind === 'worktree-empty' || element.kind === 'compare-empty') {
      return new vscode.TreeItem('No differences', vscode.TreeItemCollapsibleState.None);
    }
    if (element.kind === 'category') {
      const item = new vscode.TreeItem(element.label, element.expanded
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed);
      item.contextValue = element.comparisonsGroup ? 'gb-comparisons-group' : 'gb-category';
      if (element.comparisonsGroup) {
        item.id = 'comparisons-group';
        item.tooltip = 'File and commit comparisons';
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
    item.id = element.diffKey || `${element.diffSession ? 'diff-' : ''}${element.kind}:${element.remote ? 'remote' : 'local'}:${element.ref}`;
    const tracking = element.upstream ? element.upstream.replace(/^refs\/(heads|remotes)\//, '') : 'Not configured';
    const details = [
      `${element.kind === 'tag' ? 'Tag' : 'Branch'} name: ${element.ref || element.label}`,
      `Hash: ${element.hash || 'Unknown'}`,
      `Last commit: ${element.commitDate ? element.commitDate.replace('T', ' ') : 'Unknown'}`
    ];
    if (isBranchNode(element) && !element.remote) details.push(`Tracking branch: ${tracking}`);
    item.tooltip = details.join('\n');
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
      if (!element.remote && element.upstream) {
        if (element.trackingMissing) {
          item.tooltip += '\nTracking status: upstream ref is missing locally; counts unavailable (not in sync)';
        } else if (Number.isInteger(element.ahead) && Number.isInteger(element.behind)) {
          const differences = [];
          if (element.behind > 0) differences.push(`${element.behind}↓`);
          if (element.ahead > 0) differences.push(`${element.ahead}↑`);
          if (differences.length) item.description = differences.join(' ');
          item.tooltip += `\nTracking status: ${element.ahead} ahead, ${element.behind} behind`;
        }
      }
    }
    if (showingWorktree) {
      const count = showingWorktree.result.files.length;
      // Comparison session, not a branch: compare-style label/icon and no branch context menu.
      const [leftLabel, rightLabel] = worktreeLabels(showingWorktree.result);
      item.label = `${leftLabel} ↔ ${rightLabel}`;
      item.description = `· ${count} ${count === 1 ? 'file' : 'files'}`;
      item.contextValue = `gb-diff-session-${showingWorktree.settings.layout}-${showingWorktree.settings.sort}`;
      item.tooltip = `Left: ${leftLabel}\nRight: ${rightLabel}\nChanged files: ${count}`;
    }
    // Keep all fields in one Markdown paragraph with hard line breaks. appendText
    // on a multiline string creates paragraph gaps. Only actual branch names get copy links.
    const hover = new vscode.MarkdownString();
    hover.supportThemeIcons = true;
    item.tooltip.split('\n').forEach((line, index) => {
      if (index > 0) hover.appendMarkdown('  \n');
      hover.appendText(line);
      const name = showingWorktree
        ? (showingWorktree.result.worktree
          ? (index === (showingWorktree.result.reversed ? 1 : 0) ? showingWorktree.result.ref : undefined)
          : index < 2 ? worktreeLabels(showingWorktree.result)[index] : undefined)
        : index === 0 && isBranchNode(element) ? element.ref || element.label
        : line.startsWith('Tracking branch:') && isBranchNode(element) && !element.remote && element.upstream ? tracking : undefined;
      if (name) {
        const args = encodeURIComponent(JSON.stringify([name]))
          .replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
        hover.appendMarkdown(` [$(copy)](command:git-branch.copyBranchName?${args} "Copy branch name")`);
      }
    });
    hover.isTrusted = { enabledCommands: ['git-branch.copyBranchName'] };
    hover.supportHtml = false;
    item.tooltip = hover;
    return item;
  }

  async getChildren(element) {
    if (!element) return this.getRootNodes();
    if (element.comparisonsGroup) return [
      ...[...this.workingTrees.values()].map(entry => ({ ...entry.node, diffSession: true, parent: element })),
      ...[...this.comparisons.values()].map(entry => ({ kind: 'compare-session', key: entry.key, entry, parent: element }))
    ];
    if (element.kind === 'compare-session') {
      if (this.comparisons.get(element.key) !== element.entry) return [];
      const sides = ['selected', 'current'].filter(side => element.entry.result[side].total > 0);
      if (!sides.length) return [{ kind: 'compare-empty', key: element.key, parent: element }];
      return sides.map(side => ({ kind: 'compare-side', key: element.key, entry: element.entry,
        side, label: side === 'selected' ? element.entry.result.ref : element.entry.result.currentLabel,
        history: element.entry.result[side], parent: element }));
    }
    if (element.kind === 'compare-side') {
      if (this.comparisons.get(element.key) !== element.entry) return [];
      const children = element.history.commits.map(commit => ({ kind: 'compare-commit', commit, key: element.key, entry: element.entry, parent: element }));
      if (element.history.commits.length < element.history.total) children.push({ kind: 'compare-more', parent: element });
      return children;
    }
    if (element.kind === 'compare-commit') {
      if (this.comparisons.get(element.key) !== element.entry) return [];
      element.entry.details ||= new Map();
      let pending = element.entry.details.get(element.commit.hash);
      if (!pending) {
        pending = this.git.commitDetails(element.commit.hash);
        element.entry.details.set(element.commit.hash, pending);
      }
      try {
        const details = await pending;
        if (this.comparisons.get(element.key) !== element.entry) return [];
        return this.diffChildren(element.entry, element, '', details);
      } catch (error) {
        element.entry.details.delete(element.commit.hash);
        vscode.window.showErrorMessage(`Load commit failed: ${error.message}`);
        return [];
      }
    }
    if (element.kind === 'compare-folder') {
      return this.comparisons.get(element.key) === element.entry
        ? this.diffChildren(element.entry, element, element.directory, element.details) : [];
    }
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
      if (this.workingTrees.size || this.comparisons.size) roots.push({ kind: 'category', label: 'Comparisons', comparisonsGroup: true, expanded: true, children: [] });
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
  // Encode settings in each session's contextValue so the anchored menu reflects
  // its target, even when a different tree item is selected.
  const savedSettings = context.workspaceState?.get('git-branch.comparisonSettings');
  if (savedSettings && typeof savedSettings === 'object' && !Array.isArray(savedSettings)) branchTree.savedSettings = { ...savedSettings };
  let lastComparison = null;
  const worktreeRequests = new Map();
  const worktreeSessions = new Map();

  function sessionTabs(session) {
    return vscode.window.tabGroups.all.flatMap(group => group.tabs.filter(tab => {
      if (!(tab.input instanceof vscode.TabInputTextDiff)) return false;
      return [tab.input.original, tab.input.modified].some(uri => {
        if (uri.scheme !== snapshotScheme) return false;
        try { return JSON.parse(uri.query).worktreeSession === session.id; }
        catch { return false; }
      });
    }).map(tab => ({ tab, group })));
  }

  async function closeSessionTabs(session) {
    const tabs = sessionTabs(session).map(entry => entry.tab);
    // Either side may carry the session marker after a swap. Keep normal unsaved-change prompts.
    if (tabs.length) return vscode.window.tabGroups.close(tabs, true);
    return true;
  }

  async function showWorkingTree(node) {
    const key = node.diffKey || qualifiedRef(node);
    if (worktreeSessions.get(key)?.swapping) return;
    const request = Symbol();
    worktreeRequests.set(key, request);
    await configureGitExecutable(git);
    const dirtyDocuments = (vscode.workspace.textDocuments || [])
      .filter(doc => doc.isDirty && doc.uri.scheme === 'file')
      .map(doc => ({ file: path.relative(root, doc.uri.fsPath).split(path.sep).join('/'), text: doc.getText() }));
    const result = node.diffTarget
      ? await git.compare(qualifiedRef(node), qualifiedRef(node.diffTarget))
      : await git.worktreeCompare(key, dirtyDocuments);
    if (node.diffTarget) result.currentLabel = node.diffTarget.ref;
    if (worktreeRequests.get(key) !== request) return;
    result.ref = node.ref;
    if (!worktreeSessions.has(key)) worktreeSessions.set(key, { id: randomUUID(), closed: false });
    branchTree.setWorkingTree(node, result);
    await vscode.commands.executeCommand('git-branch.branches.focus');
    const group = (await branchTree.getRootNodes()).find(item => item.comparisonsGroup);
    await branchView.reveal({ ...node, diffSession: true, parent: group }, { expand: true, select: true, focus: false });
  }

  // Views
  const branchView = vscode.window.createTreeView('git-branch.branches', {
    treeDataProvider: branchTree,
    showCollapseAll: true,
    canSelectMany: true
  });
  const selection = (node, nodes) => {
    const selected = Array.isArray(nodes) && nodes.length ? nodes
      : node ? [node] : (branchView.selection || []);
    return [...new Map(selected.map(item => [isBranchNode(item) ? `${item.remote}:${item.ref}:${item.diffSession || ''}` : item, item])).values()];
  };
  const selectedBranches = (node, nodes) => {
    const items = selection(node, nodes);
    return items.length && items.every(item => isBranchNode(item) && !item.diffSession) ? items : [];
  };
  const syncSelection = items => {
    vscode.commands.executeCommand('setContext', 'git-branch.multiSelection', items.length > 1);
    vscode.commands.executeCommand('setContext', 'git-branch.singleLocal', items.length === 1 && isBranchNode(items[0]) && !items[0].remote && !items[0].diffSession);
    vscode.commands.executeCommand('setContext', 'git-branch.twoBranches', items.length === 2 && items.every(item => isBranchNode(item) && !item.diffSession));
  };
  syncSelection(branchView.selection || []);
  if (branchView.onDidChangeSelection) context.subscriptions.push(branchView.onDidChangeSelection(event => syncSelection(event.selection)));

  const compareRequests = new Map();
  async function showCompare(leftNode, rightNode, existingKey) {
    const leftRef = qualifiedRef(leftNode), rightRef = rightNode ? qualifiedRef(rightNode) : 'HEAD';
    const key = existingKey || `compare:${JSON.stringify([leftRef, rightRef])}`;
    const request = Symbol();
    compareRequests.set(key, request);
    await configureGitExecutable(git);
    const result = await git.branchComparison(leftRef, rightRef);
    if (compareRequests.get(key) !== request) return;
    result.ref = leftNode.ref;
    result.currentLabel = rightNode?.ref || await git.current() || `HEAD (detached ${shortHash(result.right)})`;
    if (compareRequests.get(key) !== request) return;
    const previous = branchTree.comparisons.get(key);
    if (previous?.reversed) {
      [result.selected, result.current] = [result.current, result.selected];
      [result.left, result.right] = [result.right, result.left];
      [result.ref, result.currentLabel] = [result.currentLabel, result.ref];
    }
    const entry = { key, leftNode, rightNode, result, reversed: !!previous?.reversed,
      settings: previous?.settings || branchTree.settingsFor(key) };
    branchTree.comparisons.set(key, entry);
    if (!worktreeSessions.has(key)) worktreeSessions.set(key, { id: randomUUID(), closed: false });
    lastComparison = result;
    branchTree.refresh();
    await vscode.commands.executeCommand('git-branch.branches.focus');
    const parent = (await branchTree.getRootNodes()).find(item => item.comparisonsGroup);
    await branchView.reveal({ kind: 'compare-session', key, entry, parent }, { expand: true, select: true, focus: false });
  }

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
    if (session?.closed || session?.swapping) return;
    let original = snapshotUri(file.left, file.oldPath, session);
    let modified = file.worktree && file.newPath
      ? vscode.Uri.file(git.worktreePath(file.newPath)) : snapshotUri(file.right, file.newPath, session);
    let leftLabel = file.ref;
    let rightLabel = file.rightLabel || 'HEAD';
    if (file.worktree && file.reversed) {
      original = file.oldPath ? vscode.Uri.file(git.worktreePath(file.oldPath)) : snapshotUri(null, null, session);
      modified = snapshotUri(file.left, file.newPath, session);
      [leftLabel, rightLabel] = ['Working Tree', file.ref];
    }
    const title = `${path.basename(file.newPath || file.oldPath)} (${leftLabel} ↔ ${rightLabel})`;
    const opening = vscode.commands.executeCommand('vscode.diff', original, modified, title,
      { preview: false, viewColumn: vscode.ViewColumn.Active });
    if (session) { session.pending ||= new Set(); session.pending.add(opening); }
    try { await opening; }
    finally { session?.pending?.delete(opening); }
    // Closing while vscode.diff was pending must not leave a late-opening tab behind.
    if (session?.closed) await closeSessionTabs(session);
  }

  async function swapWorkingTree(node) {
    if (!isBranchNode(node)) return;
    const active = branchTree.workingTreeFor(node);
    const session = active && worktreeSessions.get(active.key);
    if (!session || session.closed || session.swapping) return;
    session.swapping = true;
    worktreeRequests.delete(active.key); // Cancel a pending refresh before taking the snapshot.
    let records = [], replacementsStarted = false;
    const restoreClosedTabs = async () => {
      for (const { tab, group } of records) {
        if (vscode.window.tabGroups.all.some(g => g.tabs.includes(tab))) continue;
        await vscode.commands.executeCommand('vscode.diff', tab.input.original, tab.input.modified,
          tab.label, { preview: false, preserveFocus: true, viewColumn: group.viewColumn || vscode.ViewColumn.Active });
      }
    };
    try {
      await Promise.allSettled([...(session.pending || [])]);
      records = sessionTabs(session);
      if (records.length && !await vscode.window.tabGroups.close(records.map(entry => entry.tab), true)) {
        await restoreClosedTabs();
        vscode.window.showInformationMessage('Swap cancelled. Comparison direction was not changed.');
        return;
      }
      const next = reverseWorktreeResult(active.result);
      const labels = worktreeLabels(next);
      replacementsStarted = true;
      for (const { tab, group } of records) {
        const original = tab.input.modified, modified = tab.input.original;
        const uriPath = uri => uri.scheme === snapshotScheme ? JSON.parse(uri.query).file : uri.fsPath;
        const filePath = uriPath(modified) || uriPath(original) || 'empty';
        await vscode.commands.executeCommand('vscode.diff', original, modified,
          `${path.basename(filePath)} (${labels.join(' ↔ ')})`,
          { preview: false, preserveFocus: true, viewColumn: group.viewColumn || vscode.ViewColumn.Active });
      }
      // Commit the direction only after every existing tab has been reopened successfully.
      active.result = next;
      branchTree.refresh();
    } catch (err) {
      try {
        if (replacementsStarted && !await closeSessionTabs(session)) throw new Error('Closing replacement tabs was cancelled.');
        await restoreClosedTabs();
      } catch (restoreError) {
        vscode.window.showErrorMessage(`Swap recovery failed: ${restoreError.message}. Close and reopen this comparison.`);
      }
      vscode.window.showErrorMessage(`Swap failed: ${err.message}`);
    } finally { session.swapping = false; }
  }

  async function createBranch(node, checkout) {
    try {
      await configureGitExecutable(git);
      // Group/title arguments do not specify a branch; default to current HEAD.
      const specified = isBranchNode(node) || (node?.kind === 'tag' && !!node.ref);
      const current = specified ? undefined : await git.current();
      const startPoint = specified ? qualifiedRef(node) : 'HEAD';
        const startLabel = specified ? node.ref : (current || 'HEAD (detached)');
        const suggestedName = specified
          ? (node.remote ? node.ref.slice(node.ref.indexOf('/') + 1) : node.ref)
          : (current || '');
        const name = await vscode.window.showInputBox({
          title: `${checkout ? 'Create and Checkout' : 'Create Branch'} (from ${startLabel})`,
          prompt: `New branch name (based on ${startLabel})`,
          value: suggestedName,
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

  let updating = false;
  async function updateBranches(node, nodes) {
    const items = selectedBranches(node, nodes);
    if (!items.length) { vscode.window.showInformationMessage('Select one or more branches to update.'); return; }
    if (updating) { vscode.window.showInformationMessage('An Update is already running.'); return; }
    updating = true;
    const succeeded = [], failed = [];
    try {
      for (const item of items) {
        try {
          await configureGitExecutable(git);
          const unsaved = (vscode.workspace.textDocuments || []).some(doc => {
            if (!doc.isDirty || doc.uri.scheme !== 'file') return false;
            const relative = path.relative(root, doc.uri.fsPath);
            return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
          });
          const status = await git.update(item, unsaved);
          succeeded.push(`${item.ref}: ${status}`);
        } catch (error) { failed.push(`${item.ref}: ${error.message}`); }
        finally { branchTree.refresh(); }
      }
      const summary = `Update: ${succeeded.length} succeeded, ${failed.length} failed.`;
      const details = [...succeeded, ...failed.map(text => `Failed: ${text}`)].join('\n');
      const choice = await vscode.window.showInformationMessage(summary, 'Details');
      if (choice === 'Details') await vscode.window.showInformationMessage(summary, { modal: true, detail: details });
    } finally { updating = false; }
  }

  // ── Commands ──

  context.subscriptions.push(
    branchView, branchTree,
    vscode.commands.registerCommand('git-branch.copyBranchName', async text => {
      if (typeof text !== 'string' || text.length > 65536) return;
      try { await vscode.env.clipboard.writeText(text); }
      catch (err) { vscode.window.showErrorMessage(`Copy failed: ${err.message}`); }
    }),
    ...[['diffList', 'layout', 'list'], ['diffTree', 'layout', 'tree'],
      ['diffSortName', 'sort', 'name'], ['diffSortPath', 'sort', 'path'], ['diffSortStatus', 'sort', 'status']]
      .flatMap(([command, property, value]) => [command, `${command}.current`].map(id =>
        vscode.commands.registerCommand(`git-branch.${id}`, async node => {
          const entry = node?.kind === 'compare-session' ? branchTree.comparisons.get(node.key)
            : node?.diffSession ? branchTree.workingTreeFor(node) : undefined;
          if (!entry) return;
          entry.settings = { ...entry.settings, [property]: value };
          branchTree.savedSettings[entry.key] = { ...entry.settings };
          branchTree.refresh();
          try { await context.workspaceState?.update('git-branch.comparisonSettings', { ...branchTree.savedSettings }); }
          catch (error) { vscode.window.showErrorMessage(`Save comparison settings failed: ${error.message}`); }
        }))),
    vscode.window.registerFileDecorationProvider(worktreeDecorations),
    vscode.workspace.registerTextDocumentContentProvider(snapshotScheme, snapshotProvider),

    vscode.commands.registerCommand('git-branch.refresh', () => {
      branchTree.refresh();
    }),

    vscode.commands.registerCommand('git-branch.update', updateBranches),
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

    vscode.commands.registerCommand('git-branch.compare', async (node, nodes) => {
      const items = selectedBranches(node, nodes);
      if (!items.length || items.length > 2) {
        vscode.window.showInformationMessage('Select one or two branches to compare.');
        return;
      }
      try {
        if (items.length === 1 && !items[0].remote && items[0].ref === await git.current()) {
          vscode.window.showInformationMessage('Select a different branch to compare with current.');
          return;
        }
        await showCompare(items[0], items[1]);
      } catch (err) { vscode.window.showErrorMessage(`Compare failed: ${err.message}`); }
    }),

    vscode.commands.registerCommand('git-branch.worktree', async (node, nodes) => {
      const items = selectedBranches(node, nodes);
      if (!items.length || items.length > 2) {
        vscode.window.showInformationMessage('Select one or two branches to show differences.');
        return;
      }
      try {
        const source = items.length === 2 ? { ...items[0], diffTarget: items[1],
          diffKey: `diff:${JSON.stringify(items.map(qualifiedRef))}` } : items[0];
        await showWorkingTree(source);
      } catch (err) { vscode.window.showErrorMessage(`Comparison failed: ${err.message}`); }
    }),
    vscode.commands.registerCommand('git-branch.compareSelected', (node, nodes) =>
      vscode.commands.executeCommand('git-branch.compare', node, nodes || branchView.selection)),
    vscode.commands.registerCommand('git-branch.diffSelected', (node, nodes) =>
      vscode.commands.executeCommand('git-branch.worktree', node, nodes || branchView.selection)),
    vscode.commands.registerCommand('git-branch.refreshCompare', async node => {
      const entry = branchTree.comparisons.get(node?.key);
      if (!entry) return;
      try { await showCompare(entry.leftNode, entry.rightNode, entry.key); }
      catch (error) { vscode.window.showErrorMessage(`Compare failed: ${error.message}`); }
    }),
    vscode.commands.registerCommand('git-branch.swapCompare', node => {
      const entry = branchTree.comparisons.get(node?.key);
      if (!entry) return;
      compareRequests.delete(entry.key);
      const result = entry.result;
      const next = { ...entry, reversed: !entry.reversed, result: { ...result,
        left: result.right, right: result.left, ref: result.currentLabel, currentLabel: result.ref,
        selected: result.current, current: result.selected } };
      branchTree.comparisons.set(entry.key, next);
      lastComparison = next.result;
      branchTree.refresh();
    }),
    vscode.commands.registerCommand('git-branch.closeCompare', async node => {
      const entry = branchTree.comparisons.get(node?.key);
      if (!entry) return;
      compareRequests.delete(entry.key);
      branchTree.comparisons.delete(entry.key);
      if (lastComparison === entry.result) lastComparison = null;
      branchTree.refresh();
      const session = worktreeSessions.get(entry.key);
      if (session) {
        session.closed = true;
        worktreeSessions.delete(entry.key);
        try { if (!await closeSessionTabs(session)) vscode.window.showInformationMessage('Some comparison tabs remain open because closing was cancelled.'); }
        catch (error) { vscode.window.showErrorMessage(`Close comparison failed: ${error.message}`); }
      }
    }),
    vscode.commands.registerCommand('git-branch.loadCompare', async node => {
      const entry = branchTree.comparisons.get(node?.key);
      if (!entry || entry !== node.entry || node.history.loading) return;
      node.history.loading = true;
      try {
        const result = entry.result;
        const page = await git.uniqueCommits(node.side === 'selected' ? result.left : result.right,
          node.side === 'selected' ? result.right : result.left, node.history.commits.length);
        if (branchTree.comparisons.get(node.key) !== entry) return;
        node.history.commits.push(...page.commits);
        branchTree.refresh();
      } catch (error) { vscode.window.showErrorMessage(`Load commits failed: ${error.message}`); }
      finally { node.history.loading = false; }
    }),
    vscode.commands.registerCommand('git-branch.openCompareDiff', async element => {
      if (element?.kind !== 'compare-file' || branchTree.comparisons.get(element.key) !== element.entry || !element.details.files.includes(element.file)) return;
      try { await openDiff({ ...element.file, left: element.details.left, right: element.details.right,
        ref: element.details.left ? shortHash(element.details.left) : 'Empty tree', rightLabel: shortHash(element.details.right) }, worktreeSessions.get(element.key)); }
      catch (error) { vscode.window.showErrorMessage(`Open diff failed: ${error.message}`); }
    }),

    vscode.commands.registerCommand('git-branch.refreshWorktree', async node => {
      const active = branchTree.workingTreeFor(node);
      if (!active) return;
      try { await showWorkingTree(active.node); }
      catch (err) { vscode.window.showErrorMessage(`Working tree comparison failed: ${err.message}`); }
    }),
      vscode.commands.registerCommand('git-branch.swapWorktree', swapWorkingTree),
      vscode.commands.registerCommand('git-branch.closeWorktree', async node => {
        const active = branchTree.workingTreeFor(node);
        if (active && worktreeSessions.get(active.key)?.swapping) return;
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
        const [leftLabel, rightLabel] = worktreeLabels(active.result);
        await openDiff({ ...element.file, left: active.result.left, right: active.result.right,
              ref: active.result.worktree ? active.result.ref : leftLabel, rightLabel,
              worktree: !!active.result.worktree, reversed: !!active.result.reversed }, worktreeSessions.get(active.key));
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

      vscode.commands.registerCommand('git-branch.rename', async (node, nodes) => {
      const items = selectedBranches(node, nodes);
      node = items.length === 1 ? items[0] : undefined;
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

    vscode.commands.registerCommand('git-branch.delete', async (node, nodes) => {
      const items = selectedBranches(node, nodes);
      if (!items.length || items.some(item => item.remote)) {
        vscode.window.showInformationMessage('Select only local branches to delete.');
        return;
      }
      if (items.length === 1) {
        try {
          await configureGitExecutable(git);
          if (await git.current() === items[0].ref) {
            vscode.window.showInformationMessage('Cannot delete the current branch. Check out another branch first.');
            return;
          }
        } catch (error) { vscode.window.showErrorMessage(`Delete failed: ${error.message}`); return; }
      }
      const confirmation = await vscode.window.showWarningMessage(
        `Delete ${items.length} local branch(es)?`,
        { modal: true, detail: `${items.map(item => item.ref).join('\n')}\n\nSafe deletion first; unmerged branches require individual Force Delete confirmation.` }, 'Delete');
      if (confirmation !== 'Delete') return;
      const deleted = [], failed = [], skipped = [];
      for (const item of items) {
        try {
          await configureGitExecutable(git);
          if (await git.current() === item.ref) {
            skipped.push(`${item.ref}: current branch`);
            continue;
          }
          const originalHash = await git.resolve(qualifiedRef(item));
          try { await git.remove(item.ref); }
          catch (error) {
            if (!error.unmergedBranch) throw error;
            const force = await vscode.window.showWarningMessage(
              `Branch '${item.ref}' is not fully merged. Force delete it?`,
              { modal: true, detail: 'Local-only commits may become inaccessible. Remote branches are unchanged. Cancelling skips only this branch.' }, 'Force Delete');
            if (force !== 'Force Delete') { skipped.push(`${item.ref}: cancelled`); continue; }
            if (await git.resolve(qualifiedRef(item)) !== originalHash) throw new Error('Branch changed during confirmation; review and retry.');
            await git.remove(item.ref, true);
          }
          deleted.push(item.ref);
        } catch (error) { failed.push(`${item.ref}: ${error.message}`); }
        finally { branchTree.refresh(); }
      }
      const summary = `Delete: ${deleted.length} succeeded, ${failed.length} failed, ${skipped.length} skipped.`;
      const details = [...deleted.map(name => `Deleted: ${name}`), ...failed.map(text => `Failed: ${text}`), ...skipped.map(text => `Skipped: ${text}`)].join('\n');
      const choice = await vscode.window.showInformationMessage(summary, 'Details');
      if (choice === 'Details') await vscode.window.showInformationMessage(summary, { modal: true, detail: details });
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
        const entry = [...branchTree.comparisons.values()].find(item => item.result === comparison);
        await openDiff(file, entry && worktreeSessions.get(entry.key));
      } catch (err) {
        vscode.window.showErrorMessage(`Open diff failed: ${err.message}`);
      }
    })
  );

  let disposed = false;
  context.subscriptions.push({ dispose() {
    disposed = true; lastComparison = null;
    for (const session of worktreeSessions.values()) session.closed = true;
    compareRequests.clear(); branchTree.comparisons.clear();
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
