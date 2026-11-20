'use strict';
const vscode = require('vscode');
const path = require('node:path');
const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const { GitOperations } = require('./git-operations');
const { formatGitDate } = require('./date-format');
// Comparisons are hosted in the native Branches tree.

// ─── Helpers ────────────────────────────────────────────────────────────────

function shortHash(hash) {
  return hash ? hash.slice(0, 7) : '';
}

function isBranchNode(node) {
  return node?.kind === 'branch' && typeof node.ref === 'string' && !!node.ref &&
    typeof node.remote === 'boolean';
}

/** Branches and tags both resolve to a single commit, so both can host diff sessions. */
function isDiffableRef(node) {
  return isBranchNode(node) || (node?.kind === 'tag' && typeof node.ref === 'string' && !!node.ref && !node.diffSession);
}

function qualifiedRef(node) {
  if (typeof node?.rawRef === 'string' && node.rawRef) return node.rawRef;
  if (node?.kind === 'tag') return `refs/tags/${node.ref}`;
  if (!isBranchNode(node)) throw new Error('Right-click a branch to perform this operation.');
  return `${node.remote ? 'refs/remotes/' : 'refs/heads/'}${node.ref}`;
}

/** Turn a configured remote URL into a browsable web base, or undefined. */
function remoteWebBase(url) {
  if (typeof url !== 'string' || !url.trim()) return undefined;
  const value = url.trim();
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):([^:]+)$/.exec(value);
  if (!value.includes('://') && scp) return `https://${scp[1]}/${scp[2].replace(/\.git$/, '')}`;
  try {
    const parsed = new URL(value);
    if (!['https:', 'http:', 'ssh:', 'git:', 'git+ssh:'].includes(parsed.protocol)) return undefined;
    const pathname = parsed.pathname.replace(/\.git$/, '').replace(/\/+$/, '');
    if (!pathname || pathname === '/') return undefined;
    return `https://${parsed.hostname}${pathname}`;
  } catch { return undefined; }
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
const commitDecorationScheme = 'git-branch-merge-commit';
const worktreeDecorations = {
  provideFileDecoration(uri) {
    if (uri.scheme === commitDecorationScheme) return {
      tooltip: 'Merge commit', color: new vscode.ThemeColor('descriptionForeground'), propagate: false
    };
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

function changeSummary(files, stats) {
  const count = files.length;
  if (!stats) return `${count} ${count === 1 ? 'file' : 'files'} changed; line statistics unavailable`;
  return `${count} ${count === 1 ? 'file' : 'files'} changed, ${stats.insertions} insertions(+), ${stats.deletions} deletions(-)`
    + (stats.binaryFiles ? `; ${stats.binaryFiles} binary ${stats.binaryFiles === 1 ? 'file' : 'files'} (line counts unavailable)` : '')
    + (stats.unsupportedFiles ? `; ${stats.unsupportedFiles} submodule/special files (line counts unavailable)` : '');
}

function commitHover(commit, details, error) {
  const data = details || commit;
  const hover = new vscode.MarkdownString();
  hover.supportThemeIcons = true;
  const hash = shortHash(data.hash);
  hover.appendText(`${data.author} · ${formatGitDate(data.date)} · ${hash || 'Unknown'}`);
  if (hash) {
    const args = encodeURIComponent(JSON.stringify([hash]));
    hover.appendMarkdown(` [$(copy)](command:git-branch.copyCommitHash?${args} "Copy short commit hash")`);
  }
  const summary = details ? changeSummary(details.files, details.stats) : 'File statistics unavailable';
  // Compact native hover: omit spacer rows, but preserve every nonblank message line.
  const messageLines = (details ? details.message : commit.subject).split(/\r?\n/)
    .filter(line => line.trim().length > 0);
  const lines = [summary,
    ...messageLines, ...(error ? [`Commit details unavailable: ${error.message}`] : [])];
  for (const line of lines) {
    hover.appendMarkdown('  \n');
    hover.appendText(line);
  }
  hover.isTrusted = { enabledCommands: ['git-branch.copyCommitHash'] };
  hover.supportHtml = false;
  return hover;
}

function reverseDiffData(result) {
  return {
    ...(result.stats ? { stats: { ...result.stats, insertions: result.stats.deletions, deletions: result.stats.insertions } } : {}),
    files: result.files.map(file => ({
      ...file, oldPath: file.newPath, newPath: file.oldPath,
      status: file.status === 'A' ? 'D' : file.status === 'D' ? 'A' : file.status
    }))
  };
}

function reverseWorktreeResult(result) {
  return { ...result, ...reverseDiffData(result), reversed: !result.reversed,
    ...(!result.worktree ? { left: result.right, right: result.left } : {}) };
}

// ─── Branch Tree ────────────────────────────────────────────────────────────

class BranchTreeProvider {
  constructor(git) {
    this.git = git;
    this.workingTrees = new Map();
    this.comparisons = new Map();
    this.branchHistories = new Map();
    this.nextOpenedOrder = 0;
    this.lastWorkingTreeKey = null;
    this.savedSettings = {};
    this.groupSettings = {};
    this.expandedGroups = {};
    this.remoteUrls = new Map();
    this.disposed = false;
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChange.event;
  }

  settingsFor(key) {
    const saved = this.savedSettings[key] || {};
    return { layout: ['list', 'tree'].includes(saved.layout) ? saved.layout : 'list',
      sort: ['name', 'path', 'status'].includes(saved.sort) ? saved.sort : 'path' };
  }

  refresh() { this._onDidChange.fire(); }
  dispose() { this.disposed = true; this.branchHistories.clear(); this._onDidChange.dispose(); }

  commitEntry(key) { return this.comparisons.get(key) || this.branchHistories.get(key); }

  historyChildren(entry, parent) {
    const children = entry.history.commits.map(commit => ({ kind: 'compare-commit', commit,
      key: entry.key, entry, parent }));
    if (entry.history.commits.length < entry.history.total) children.push({
      kind: 'branch-history-more', key: entry.key, entry, parent
    });
    return children;
  }

  async branchChildren(node) {
    const ref = qualifiedRef(node), key = `history:${ref}`;
    let requestEntry;
    try {
      const hash = await this.git.resolve(ref);
      if (this.disposed) return [];
      let entry = this.branchHistories.get(key);
      if (!entry || entry.hash !== hash) {
        entry = { key, hash, node, settings: { layout: 'list', sort: 'path' } };
        this.branchHistories.set(key, entry);
      }
      requestEntry = entry;
      if (!entry.history) {
        entry.pending ||= this.git.branchHistory(hash);
        entry.history = await entry.pending;
      }
      if (this.branchHistories.get(key) !== entry) return [];
      return this.historyChildren(entry, node);
    } catch (error) {
      // Failed loads are retryable by expanding again or refreshing the tree.
      const entry = this.branchHistories.get(key);
      if (this.disposed || (requestEntry && entry !== requestEntry)) return [];
      if (!requestEntry || !requestEntry.history) this.branchHistories.delete(key);
      vscode.window.showErrorMessage(`Load branch commits failed: ${error.message}`);
      return [];
    }
  }

  async loadBranchHistory(node) {
    const entry = this.branchHistories.get(node?.key);
    if (!entry || entry !== node.entry || !entry.history || entry.loading) return;
    entry.loading = true;
    try {
      const page = await this.git.branchHistory(entry.hash, entry.history.commits.length);
      if (this.branchHistories.get(entry.key) !== entry) return;
      entry.history.commits.push(...page.commits);
      this.refresh();
    } catch (error) {
      if (this.branchHistories.get(entry.key) === entry) vscode.window.showErrorMessage(`Load branch commits failed: ${error.message}`);
    } finally { entry.loading = false; }
  }

  setWorkingTree(node, result, openedOrder) {
    const key = node.diffKey || qualifiedRef(node);
    if (this.workingTrees.get(key)?.result.reversed) result = reverseWorktreeResult(result);
    const previous = this.workingTrees.get(key);
    this.workingTrees.set(key, { key, node, result,
      openedOrder: previous?.openedOrder ?? openedOrder ?? this.nextOpenedOrder++,
      settings: previous?.settings || this.settingsFor(key) });
    this.lastWorkingTreeKey = key;
    this.refresh();
  }

  workingTreeFor(node) {
    if (node && !isDiffableRef(node)) return undefined;
    return this.workingTrees.get(node ? node.diffKey || qualifiedRef(node) : this.lastWorkingTreeKey);
  }

  clearWorkingTree(key) {
    this.workingTrees.delete(key);
    if (this.lastWorkingTreeKey === key) this.lastWorkingTreeKey = [...this.workingTrees.keys()].at(-1) || null;
    this.refresh();
  }

  /** Only offer real working files within the repository, never snapshots or directories. */
  async workingFileUri(file) {
    try {
      const absolute = this.git.worktreePath(file.newPath || file.oldPath);
      const real = await fs.realpath(absolute);
      const root = await fs.realpath(this.git.cwd);
      this.git.worktreePath(path.relative(root, real));
      if (!(await fs.stat(real)).isFile()) return undefined;
      return vscode.Uri.file(absolute);
    } catch { return undefined; }
  }

  async commitFileChildren(entry, parent, directory = '', details) {
    const children = this.diffChildren(entry, parent, directory, details);
    // Bound filesystem probes when a commit changes many files.
    for (let start = 0; start < children.length; start += 32) {
      await Promise.all(children.slice(start, start + 32).map(async child => {
        if (child.kind === 'compare-file') child.workingFileUri = await this.workingFileUri(child.file);
      }));
    }
    return this.commitEntry(entry.key) === entry ? children : [];
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
      item.iconPath = new vscode.ThemeIcon('git-compare');
      item.contextValue = `gb-compare-session-${element.entry.settings.layout}-${element.entry.settings.sort}`;
      const total = result.selected.total + result.current.total;
      item.description = total ? `${total} ${total === 1 ? 'commit' : 'commits'}` : 'Commits';
      item.tooltip = `${result.ref}: ${result.selected.total} exclusive commits\n${result.currentLabel}: ${result.current.total} exclusive commits`;
      return item;
    }
    if (element.kind === 'compare-side') {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Expanded);
      item.tooltip = `${element.label}\n${element.history.total} exclusive commits`;
      item.id = `${element.key}:${element.side}`;
      item.description = `${element.history.total} commits`;
      item.iconPath = new vscode.ThemeIcon('git-branch', new vscode.ThemeColor(element.side === 'selected'
        ? 'gitDecoration.addedResourceForeground' : 'gitDecoration.modifiedResourceForeground'));
      item.contextValue = 'gb-compare-side';
      return item;
    }
    if (element.kind === 'compare-commit') {
      const item = new vscode.TreeItem(element.commit.subject, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = `${element.key}:${element.parent.side || 'history'}:${element.commit.hash}`;
      item.description = `${element.commit.author} · ${formatGitDate(element.commit.date)}`;
      const merge = element.commit.merge || element.commit.parents?.length > 1;
      item.iconPath = merge ? new vscode.ThemeIcon('git-merge', new vscode.ThemeColor('descriptionForeground'))
        : new vscode.ThemeIcon('git-commit');
      if (merge) item.resourceUri = vscode.Uri.from({ scheme: commitDecorationScheme, path: '/' + element.commit.hash });
      // Full messages and file statistics are loaded lazily when the hover resolves.
      item.contextValue = 'gb-commit';
      return item;
    }
    if (element.kind === 'branch-history-more') {
      const item = new vscode.TreeItem('Load more commits', vscode.TreeItemCollapsibleState.None);
      item.contextValue = 'gb-history-more';
      item.iconPath = new vscode.ThemeIcon('chevron-down');
      item.command = { command: 'git-branch.loadBranchHistory', title: 'Load more commits', arguments: [element] };
      return item;
    }
    if (element.kind === 'compare-more') {
      const item = new vscode.TreeItem('Load more commits', vscode.TreeItemCollapsibleState.None);
      item.contextValue = 'gb-compare-more';
      item.iconPath = new vscode.ThemeIcon('chevron-down');
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
      item.contextValue = element.workingFileUri ? 'gb-compare-file-openable' : 'gb-compare-file';
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
      const item = new vscode.TreeItem('No differences', vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon('check');
      return item;
    }
    if (element.kind === 'root') {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Expanded);
      item.id = 'root';
      item.contextValue = 'gb-root';
      item.iconPath = new vscode.ThemeIcon('repo');
      const hover = new vscode.MarkdownString();
      hover.supportThemeIcons = true;
      hover.appendText(element.label);
      hover.appendMarkdown('  \n');
      hover.appendText(this.git.cwd);
      const args = encodeURIComponent(JSON.stringify([element.label]));
      hover.appendMarkdown(` [$(copy)](command:git-branch.copyText?${args} "Copy repository name")`);
      hover.isTrusted = { enabledCommands: ['git-branch.copyText'] };
      item.tooltip = hover;
      return item;
    }
    if (element.kind === 'category') {
      const saved = this.expandedGroups?.[element.label];
      const expanded = typeof saved === 'boolean' ? saved
        : typeof this.expansion === 'boolean' ? this.expansion : !!element.expanded;
      const item = new vscode.TreeItem(element.label, expanded
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed);
      // Encode the current sort in the context value so the anchored Sort menu can
      // show a ✓ on the active option, exactly like the Diff session menu.
      const order = this.sortOrder(element.label);
      item.contextValue = (element.comparisonsGroup ? 'gb-comparisons-group'
        : element.label === 'Local' ? 'gb-category-local'
          : element.label === 'Remote' ? 'gb-category-remote' : 'gb-category-tags')
        + (order ? `-sort-${order}` : '');
      item.iconPath = new vscode.ThemeIcon(element.comparisonsGroup ? 'compare-changes'
        : element.label === 'Tags' ? 'tag' : element.label === 'Remote' ? 'cloud' : 'repo');
      if (element.comparisonsGroup) {
        item.id = 'comparisons-group';
        item.tooltip = 'File and commit comparisons';
      }
      return item;
    }
    if (element.kind === 'remote-group') {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Collapsed);
      item.contextValue = 'gb-remote-group';
      item.iconPath = new vscode.ThemeIcon('cloud');
      item.tooltip = element.url ? `${element.label}\n${element.url}` : element.label;
      return item;
    }
    // Each compared branch/tag independently expands to its working-tree differences.
    const showingWorktree = element.diffSession && isDiffableRef(element) && this.workingTreeFor(element);
    const item = new vscode.TreeItem(element.diffSession && element.remote ? element.ref : element.label, showingWorktree
      ? vscode.TreeItemCollapsibleState.Expanded : isBranchNode(element) && !element.diffSession
        ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    item.id = element.diffKey || `${element.diffSession ? 'diff-' : ''}${element.kind}:${element.remote ? 'remote' : 'local'}:${element.ref}`;
    const tracking = element.upstream ? element.upstream.replace(/^refs\/(heads|remotes)\//, '') : 'Not configured';
    const details = [
      `${element.kind === 'tag' ? 'Tag' : 'Branch'} name: ${element.ref || element.label}`,
      ...(isBranchNode(element) ? [
        `Last commit: ${element.commitAuthor || 'Unknown'} · ${formatGitDate(element.commitDate)} · ${shortHash(element.hash) || 'Unknown'}`
      ] : [
        `Hash: ${element.hash || 'Unknown'}`,
        `Last commit: ${formatGitDate(element.commitDate)}`
      ])
    ];
    if (isBranchNode(element) && !element.remote) details.push(`Tracking branch: ${tracking}`);
    item.tooltip = details.join('\n');
    if (element.kind === 'tag') {
      item.contextValue = 'gb-tag';
      item.iconPath = new vscode.ThemeIcon('tag');
    } else if (element.current) {
      item.contextValue = 'gb-current';
    } else if (element.remote) {
      item.contextValue = 'gb-remote';
    } else {
      item.contextValue = 'gb-local';
    }
    if (!showingWorktree && isBranchNode(element)) {
      item.iconPath = element.current && !element.remote
        ? new vscode.ThemeIcon('git-branch', new vscode.ThemeColor('charts.yellow'))
        : new vscode.ThemeIcon('git-branch');
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
      item.iconPath = new vscode.ThemeIcon('diff-multiple');
      item.description = `${count} ${count === 1 ? 'file' : 'files'}`;
      item.contextValue = `gb-diff-session-${showingWorktree.settings.layout}-${showingWorktree.settings.sort}`;
      item.tooltip = `Left: ${leftLabel}\nRight: ${rightLabel}\n${changeSummary(showingWorktree.result.files, showingWorktree.result.stats)}`;
    }
    // Keep all fields in one Markdown paragraph with hard line breaks. appendText
    // on a multiline string creates paragraph gaps. Copy links target branch names
    // and short commit hashes only, never the full tooltip text.
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
      if (!showingWorktree && isBranchNode(element) && index === 1 && element.hash) {
        const args = encodeURIComponent(JSON.stringify([shortHash(element.hash)]));
        hover.appendMarkdown(` [$(copy)](command:git-branch.copyCommitHash?${args} "Copy short commit hash")`);
      }
    });
    hover.isTrusted = { enabledCommands: !showingWorktree && isBranchNode(element)
      ? ['git-branch.copyBranchName', 'git-branch.copyCommitHash'] : ['git-branch.copyBranchName'] };
    hover.supportHtml = false;
    item.tooltip = hover;
    return item;
  }

  commitDetailsFor(entry, hash) {
    entry.details ||= new Map();
    let pending = entry.details.get(hash);
    if (!pending) {
      pending = this.git.commitDetails(hash).catch(error => {
        // Evict only this request; an older failure must not remove a newer retry.
        if (entry.details.get(hash) === pending) entry.details.delete(hash);
        throw error;
      });
      entry.details.set(hash, pending);
    }
    return pending;
  }

  async resolveTreeItem(item, element, token) {
    if (element.kind !== 'compare-commit' || token?.isCancellationRequested || this.commitEntry(element.key) !== element.entry) return item;
    let details;
    try { details = await this.commitDetailsFor(element.entry, element.commit.hash); }
    catch (error) {
      if (token?.isCancellationRequested || this.commitEntry(element.key) !== element.entry) return item;
      item.tooltip = commitHover(element.commit, undefined, error);
      return item;
    }
    if (token?.isCancellationRequested || this.commitEntry(element.key) !== element.entry) return item;
    item.tooltip = commitHover(element.commit, details);
    return item;
  }

  async getChildren(element) {
    if (!element) return this.getRootNodes();
    if (element.kind === 'root') return element.children || [];
    if (element.comparisonsGroup) {
      const entries = [
        ...[...this.workingTrees.values()].map(entry => ({ order: entry.openedOrder,
          node: { ...entry.node, diffSession: true, parent: element } })),
        ...[...this.comparisons.values()].map(entry => ({ order: entry.openedOrder,
          node: { kind: 'compare-session', key: entry.key, entry, parent: element } }))
      ];
      const order = this.groupSettings.Comparisons?.order;
      const label = node => node.kind === 'compare-session' ? node.entry.result.ref
        : node.diffSession ? `${node.ref} ↔ Working Tree` : node.label;
      const sorted = order === 'name'
        ? entries.sort((a, b) => label(a.node).localeCompare(label(b.node)))
        : entries.sort((a, b) => a.order - b.order);
      return sorted.map(item => item.node);
    }
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
      if (this.commitEntry(element.key) !== element.entry) return [];
      try {
        const details = await this.commitDetailsFor(element.entry, element.commit.hash);
        if (this.commitEntry(element.key) !== element.entry) return [];
        return this.commitFileChildren(element.entry, element, '', details);
      } catch (error) {
        if (this.commitEntry(element.key) !== element.entry) return [];
        vscode.window.showErrorMessage(`Load commit failed: ${error.message}`);
        return [];
      }
    }
    if (element.kind === 'compare-folder') {
      return this.commitEntry(element.key) === element.entry
        ? this.commitFileChildren(element.entry, element, element.directory, element.details) : [];
    }
    if (element.kind === 'category') return element.children || [];
    if (element.kind === 'remote-group') return element.children || [];
    if (element.kind === 'worktree-folder') {
      const active = this.workingTrees.get(element.key);
      return active?.result === element.result ? this.diffChildren(active, element, element.directory) : [];
    }
    const comparison = element.diffSession && isDiffableRef(element) && this.workingTreeFor(element);
    if (comparison) {
      return comparison.result.files.length ? this.diffChildren(comparison, element)
        : [{ kind: 'worktree-empty', key: comparison.key, parent: element }];
    }
    if (isBranchNode(element) && !element.diffSession) return this.branchChildren(element);
    return [];
  }

  async getParent(element) {
    if (element.parent) return element.parent;
    if (element.kind?.startsWith('worktree-')) return this.workingTrees.get(element.key)?.node;
    const roots = await this.getRootNodes();
    const root = roots.find(node => node.kind === 'root');
    if (!root) return undefined;
    if (element.kind === 'root') return undefined;
    if (element.kind === 'category') return root;
    for (const group of root.children) {
      for (const child of group.children || []) {
        if (child === element) return group;
        if (child.kind === 'remote-group' && child.children.includes(element)) return child;
      }
    }
    return undefined;
  }

  /** The four groups live under one root node; menus and reveal need them flat. */
  async groups() {
    const roots = await this.getRootNodes();
    return roots.flatMap(node => node.kind === 'root' ? node.children || [] : [node]);
  }

  async getRootNodes() {
    try {
      const [{ current, branches }, tags] = await Promise.all([
        this.git.branches(),
        this.git.tags()
      ]);

      // Drop cached histories whose branch was deleted, renamed or moved.
      const tips = new Map(branches.map(branch => [`history:${branch.ref}`, branch.hash]));
      for (const [key, entry] of this.branchHistories) {
        if (tips.get(key) !== entry.hash) this.branchHistories.delete(key);
      }

      // Local
      const locals = branches.filter(b => !b.remote).map(b => ({
        kind: 'branch', label: b.name, ref: b.name, hash: b.hash,
        commitDate: b.commitDate, commitAuthor: b.commitAuthor, upstream: b.upstream,
        ahead: b.ahead, behind: b.behind, trackingMissing: b.trackingMissing,
        current: b.current, primary: b.primary, remote: false
      }));
      const localNode = { kind: 'category', label: 'Local', expanded: true, children: locals };

      // Remote — grouped by remote name
      const remotes = branches.filter(b => b.remote);
      if (remotes.length) {
        try { this.remoteUrls = new Map((await this.git.remotes()).map(remote => [remote.name, remote.url])); }
        catch { /* keep previous URLs; grouping still works without them */ }
      } else this.remoteUrls = new Map();
      const groups = new Map();
      for (const b of remotes) {
        const remoteName = b.name.split('/')[0];
        if (!groups.has(remoteName)) groups.set(remoteName, []);
        groups.get(remoteName).push({
          kind: 'branch', label: b.name.slice(remoteName.length + 1),
          ref: b.name, hash: b.hash, current: false, primary: b.primary, remote: true,
          commitDate: b.commitDate, commitAuthor: b.commitAuthor, upstream: b.upstream
        });
      }
      const remoteChildren = [...groups.entries()].map(([name, children]) => ({
        kind: 'remote-group', label: name, url: this.remoteUrls.get(name), children
      }));
      const remoteNode = { kind: 'category', label: 'Remote', expanded: false, children: remoteChildren };

      // Tags
      const tagChildren = tags.map(t => ({
        kind: 'tag', label: t.name, ref: t.name, hash: t.hash, commitDate: t.commitDate
      }));
      const tagNode = { kind: 'category', label: 'Tags', expanded: false, children: tagChildren };

      const children = [localNode, remoteNode, tagNode];
      if (this.workingTrees.size || this.comparisons.size) children.push({
        kind: 'category', label: 'Comparisons', comparisonsGroup: true, expanded: true, children: []
      });
      this.sortGroups(children);
      return [{ kind: 'root', label: await this.rootLabel(), expanded: true, children }];
    } catch (err) {
      vscode.window.showErrorMessage(`Git Branch: ${err.message}`);
      return [];
    }
  }

  /** Repository folder name, matching the built-in Git view. */
  async rootLabel() {
    return path.basename(this.git.cwd) || 'Branches';
  }

  /** Apply the persisted sort order to every group; comparisons stay by open order. */
  sortGroups(groups) {
    const byName = (a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' });
    const byDate = (a, b) => String(b.commitDate || '').localeCompare(String(a.commitDate || ''))
      || byName(a, b);
    for (const group of groups) {
      if (!group.children || group.comparisonsGroup) continue;
      const order = this.groupSettings[group.label]?.order;
      if (group.label === 'Remote') {
        group.children.sort(byName);
        for (const remote of group.children) {
          if (order === 'date') remote.children.sort(byDate);
          else remote.children.sort(byName);
        }
        continue;
      }
      if (order === 'date') group.children.sort(byDate);
      else group.children.sort(byName);
    }
  }

  /** Expand or collapse the whole tree; VS Code only offers collapse natively. */
  setExpansion(state) {
    this.expansion = state;
    this.expandedGroups = {};
    this.refresh();
  }

  /** Expand/collapse one group; VS Code's own collapse-all must not be undone by it. */
  setGroupExpansion(group, state) {
    if (!group) { this.setExpansion(state); return; }
    this.expandedGroups = { ...this.expandedGroups, [group]: state };
    this.expansion = undefined;
    this.refresh();
  }

  /** Menu label showing the current sort of one group. */
  sortOrder(group) {
    if (group === 'Comparisons') return this.groupSettings.Comparisons?.order || 'opened';
    return this.groupSettings[group]?.order || 'name';
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
  const savedSort = context.workspaceState?.get('git-branch.groupSort');
  if (savedSort && typeof savedSort === 'object' && !Array.isArray(savedSort)) branchTree.groupSettings = { ...savedSort };
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
    // Reserve order before asynchronous Git work, not when it finishes.
    const openedOrder = branchTree.workingTrees.get(key)?.openedOrder ?? branchTree.nextOpenedOrder++;
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
    branchTree.setWorkingTree(node, result, openedOrder);
    await vscode.commands.executeCommand('git-branch.branches.focus');
    const group = (await branchTree.groups()).find(item => item.comparisonsGroup);
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
  /** Compare/Diff accept branches and tags; tags only as a single or pair ref. */
  const selectedRefs = (node, nodes) => {
    const items = selection(node, nodes);
    return items.length && items.every(item => isDiffableRef(item)) ? items : [];
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
    const openedOrder = branchTree.comparisons.get(key)?.openedOrder ?? branchTree.nextOpenedOrder++;
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
      Object.assign(result, reverseDiffData(result));
    }
    const entry = { key, leftNode, rightNode, result, reversed: !!previous?.reversed,
      openedOrder: previous?.openedOrder ?? openedOrder,
      settings: previous?.settings || branchTree.settingsFor(key) };
    branchTree.comparisons.set(key, entry);
    if (!worktreeSessions.has(key)) worktreeSessions.set(key, { id: randomUUID(), closed: false });
    lastComparison = result;
    branchTree.refresh();
    await vscode.commands.executeCommand('git-branch.branches.focus');
    const parent = (await branchTree.groups()).find(item => item.comparisonsGroup);
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

  /** Shared helpers for the group, root and tag menus. */
  async function copyToClipboard(text) {
    if (typeof text !== 'string' || !text) return;
    try { await vscode.env.clipboard.writeText(text); }
    catch (error) { vscode.window.showErrorMessage(`Copy failed: ${error.message}`); }
  }

  async function quickPickRemote(title) {
    const remotes = await git.remotes();
    if (!remotes.length) {
      vscode.window.showInformationMessage('No remote configured. Add a Git remote first.');
      return undefined;
    }
    if (remotes.length === 1) return remotes[0].name;
    const picked = await vscode.window.showQuickPick(
      remotes.map(item => ({ label: item.name, description: item.url, remote: item.name })),
      { title, placeHolder: 'Select a remote', ignoreFocusOut: true });
    return picked?.remote;
  }

  /** Host-aware branch page URL; falls back to the repository page. */
  function branchWebUrl(base, branch) {
    if (!base || !branch) return base;
    const host = new URL(base).hostname;
    const encoded = branch.split('/').map(encodeURIComponent).join('/');
    if (/(^|\.)gitlab\./i.test(host)) return `${base}/-/tree/${encoded}`;
    if (/(^|\.)bitbucket\./i.test(host)) return `${base}/src/${encoded}`;
    if (/(^|\.)(gitee|gitea)\./i.test(host)) return `${base}/src/branch/${encoded}`;
    return `${base}/tree/${encoded}`;
  }

  async function openOnRemote(node) {
    try {
      await configureGitExecutable(git);
      let remoteName;
      let branchName;
      // The root menu opens the repository page itself, without a branch path.
      const repositoryOnly = !node || node.kind === 'root';
      if (node?.kind === 'remote-group') remoteName = node.label;
      else if (node?.kind === 'branch' && node.remote) {
        remoteName = node.ref.split('/')[0];
        branchName = node.ref.slice(remoteName.length + 1);
      } else if (node?.kind === 'branch' && !node.remote) {
        branchName = node.ref;
        const configured = node.upstream?.startsWith('refs/remotes/')
          ? node.upstream.slice('refs/remotes/'.length) : undefined;
        remoteName = configured ? configured.split('/')[0] : undefined;
      } else if (node?.kind === 'tag') branchName = undefined;
      else if (!repositoryOnly) return;
      if (!remoteName) remoteName = await quickPickRemote('Open on Remote');
      if (!remoteName) return;
      const remote = (await git.remotes()).find(item => item.name === remoteName);
      const base = remoteWebBase(remote?.url);
      if (!base) {
        vscode.window.showInformationMessage(`Remote '${remoteName}' has no browsable URL.`);
        return;
      }
      let target = base;
      if (node?.kind === 'tag' && node.ref) {
        const host = new URL(base).hostname;
        const encoded = encodeURIComponent(node.ref);
        target = /(^|\.)gitlab\./i.test(host) ? `${base}/-/tags/${encoded}`
          : /(^|\.)bitbucket\./i.test(host) ? `${base}/src/?at=refs%2Ftags%2F${encoded}`
            : `${base}/releases/tag/${encoded}`;
      } else if (branchName) target = branchWebUrl(base, branchName);
      await vscode.env.openExternal(vscode.Uri.parse(target));
    } catch (error) { vscode.window.showErrorMessage(`Open on Remote failed: ${error.message}`); }
  }

  async function fetchRemote(options = {}) {
    const { prune = false, all = false, node } = options;
    try {
      await configureGitExecutable(git);
      let name = typeof node?.label === 'string' && node.kind === 'remote-group' ? node.label : undefined;
      if (!name && !all) name = await quickPickRemote(prune ? 'Prune Deleted Branches' : 'Fetch');
      if (!name && !all) return;
      await git.fetch(name, { prune });
      branchTree.refresh();
      vscode.window.showInformationMessage(`${prune ? 'Pruned' : 'Fetched'}: ${name || 'all remotes'}`);
    } catch (error) { vscode.window.showErrorMessage(`Fetch failed: ${error.message}`); }
  }

  async function removeRemoteGroup(node) {
    const name = node?.label;
    if (typeof name !== 'string' || !name) {
      vscode.window.showInformationMessage('Right-click a remote group to remove it.');
      return;
    }
    const confirmation = await vscode.window.showWarningMessage(`Remove remote '${name}'?`, {
      modal: true,
      detail: `The remote configuration and refs/remotes/${name}/* are removed from this repository. Commits on the server are untouched.`
    }, 'Remove Remote');
    if (confirmation !== 'Remove Remote') return;
    try {
      await configureGitExecutable(git);
      await git.removeRemoteConfig(name);
      branchTree.refresh();
      vscode.window.showInformationMessage(`Remote removed: ${name}`);
    } catch (error) { vscode.window.showErrorMessage(`Remove remote failed: ${error.message}`); }
  }

  async function pushAllTags() {
    try {
      await configureGitExecutable(git);
      const name = await quickPickRemote('Push All Tags');
      if (!name) return;
      const confirmation = await vscode.window.showWarningMessage(`Push all local tags to '${name}'?`, {
        modal: true,
        detail: 'Existing remote tags with a different commit are rejected. Nothing is forced.'
      }, 'Push Tags');
      if (confirmation !== 'Push Tags') return;
      await git.pushAllTags(name);
      vscode.window.showInformationMessage(`Tags pushed: ${name}`);
    } catch (error) { vscode.window.showErrorMessage(`Push tags failed: ${error.message}`); }
  }

  async function pushSingleTag(node) {
    if (node?.kind !== 'tag' || !node.ref) {
      vscode.window.showInformationMessage('Right-click a tag to push it.');
      return;
    }
    try {
      await configureGitExecutable(git);
      const name = await quickPickRemote(`Push Tag '${node.ref}'`);
      if (!name) return;
      const result = await git.pushTag(node.ref, name);
      vscode.window.showInformationMessage(`Pushed: ${result}`);
    } catch (error) { vscode.window.showErrorMessage(`Push tag failed: ${error.message}`); }
  }

  async function createTag(node) {
    try {
      await configureGitExecutable(git);
      let start = 'HEAD';
      let label = 'HEAD';
      if (node?.commit?.hash) { start = node.commit.hash; label = shortHash(start); }
      else if (node?.kind === 'tag' && node.ref) { start = `refs/tags/${node.ref}`; label = node.ref; }
      else if (isBranchNode(node)) { start = qualifiedRef(node); label = node.ref; }
      else {
        const picked = await pickStartPoint();
        if (!picked) return;
        start = picked.start;
        label = picked.label;
      }
      const name = await vscode.window.showInputBox({ title: `Create Tag (at ${label})`,
        prompt: `Tag name (at ${label})`, ignoreFocusOut: true });
      if (!name) return;
      await git.createTag(name, start);
      branchTree.refresh();
      vscode.window.showInformationMessage(`Tag created: ${name} (at ${label})`);
    } catch (error) { vscode.window.showErrorMessage(`Create tag failed: ${error.message}`); }
  }

  async function deleteTag(node) {
    if (node?.kind !== 'tag' || !node.ref) {
      vscode.window.showInformationMessage('Right-click a tag to delete it.');
      return;
    }
    const confirmation = await vscode.window.showWarningMessage(`Delete local tag '${node.ref}'?`,
      { modal: true, detail: 'The remote tag is not removed automatically.' }, 'Delete Tag');
    if (confirmation !== 'Delete Tag') return;
    try {
      await configureGitExecutable(git);
      await git.removeTag(node.ref);
      branchTree.refresh();
      vscode.window.showInformationMessage(`Tag deleted: ${node.ref}`);
    } catch (error) { vscode.window.showErrorMessage(`Delete tag failed: ${error.message}`); }
  }

  async function deleteRemoteTag(node) {
    if (node?.kind !== 'tag' || !node.ref) {
      vscode.window.showInformationMessage('Right-click a tag to delete it remotely.');
      return;
    }
    try {
      await configureGitExecutable(git);
      const name = await quickPickRemote(`Delete Remote Tag '${node.ref}'`);
      if (!name) return;
      const confirmation = await vscode.window.showWarningMessage(`Delete tag '${node.ref}' on '${name}'?`,
        { modal: true, detail: 'Only the remote tag is removed; the local tag is kept.' }, 'Delete Remote Tag');
      if (confirmation !== 'Delete Remote Tag') return;
      await git.removeRemoteTag(node.ref, name);
      branchTree.refresh();
      vscode.window.showInformationMessage(`Remote tag deleted: ${name}/${node.ref}`);
    } catch (error) { vscode.window.showErrorMessage(`Delete remote tag failed: ${error.message}`); }
  }

  async function pullBranch(node) {
    try {
      await configureGitExecutable(git);
      const unsaved = (vscode.workspace.textDocuments || []).some(doc => doc.isDirty && doc.uri.scheme === 'file');
      const status = await git.pull(node, unsaved);
      branchTree.refresh();
      vscode.window.showInformationMessage(`Pull: ${node.ref} — ${status}`);
    } catch (error) {
      branchTree.refresh();
      vscode.window.showErrorMessage(`Pull failed: ${error.message}`);
    }
  }

  /** Apply one group's sort choice; persisted in workspace state (D13 = A). */
  async function setGroupSort(group, property, value) {
    if (typeof group !== 'string' || !group) return;
    branchTree.groupSettings[group] = { ...(branchTree.groupSettings[group] || {}), [property]: value };
    branchTree.refresh();
    try { await context.workspaceState?.update('git-branch.groupSort', { ...branchTree.groupSettings }); }
    catch (error) { vscode.window.showErrorMessage(`Save sort order failed: ${error.message}`); }
  }

  /** The group a menu was opened on; only category rows carry a sortable label. */
  function sortTarget(node, property, value) {
    const group = node?.kind === 'category' ? node.label : undefined;
    if (!group) return;
    return setGroupSort(group, property, value);
  }

  async function copyBranchList(node) {
    const children = node?.children || [];
    // Remote groups nest branches one level deeper; copy the branch names, not the remote names.
    const names = children.flatMap(item => item.children?.length ? item.children : [item]);
    await copyToClipboard(names.map(item => item.ref || item.label).filter(Boolean).join('\n'));
  }

  async function copyBranchRef(node) {
    if (node?.kind === 'tag' && node.ref) return copyToClipboard(`refs/tags/${node.ref}`);
    if (!isBranchNode(node)) return;
    await copyToClipboard(`${node.remote ? 'refs/remotes/' : 'refs/heads/'}${node.ref}`);
  }

  /** Copy a branch/tag name (or the label of a plain row) verbatim. */
  async function copyNodeName(node) {
    if (typeof node?.ref === 'string' && node.ref) return copyToClipboard(node.ref);
    if (typeof node?.label === 'string' && node.label) return copyToClipboard(node.label);
  }

  async function copyNodeHash(node) {
    const hash = node?.commit?.hash || node?.hash;
    if (hash) await copyToClipboard(shortHash(hash));
  }

  async function copyRemoteUrl(node) {
    if (node?.kind === 'remote-group') return copyToClipboard(node.url || node.label);
    if (node?.kind !== 'branch' || !node.remote) return;
    const name = node.ref.split('/')[0];
    const remote = (await git.remotes()).find(item => item.name === name);
    if (remote?.url) await copyToClipboard(remote.url);
  }

  /** Root node copies: repository name and repository path. */
  async function copyRepository(node) {
    if (node?.kind !== 'root') return;
    const choice = await vscode.window.showQuickPick([
      { label: 'Repository Name', value: node.label },
      { label: 'Repository Path', value: git.cwd }
    ], { title: 'Copy Repository', placeHolder: 'Select what to copy', ignoreFocusOut: true });
    if (choice) await copyToClipboard(choice.value);
  }

  /** Comparison session copies: name, left ref, right ref. */
  async function copyComparison(node) {
    const entry = node?.kind === 'compare-session' ? branchTree.comparisons.get(node.key) : undefined;
    if (!entry) return;
    const result = entry.result;
    const choice = await vscode.window.showQuickPick([
      { label: 'Comparison Name', value: `${result.ref} ↔ ${result.currentLabel}` },
      { label: 'Left Ref', value: result.ref },
      { label: 'Right Ref', value: result.currentLabel }
    ], { title: 'Copy Comparison', placeHolder: 'Select what to copy', ignoreFocusOut: true });
    if (choice) await copyToClipboard(choice.value);
  }

  async function refreshAllComparisons() {
    const entries = [...branchTree.comparisons.values()];
    for (const entry of entries) {
      try { await showCompare(entry.leftNode, entry.rightNode, entry.key); }
      catch (error) { vscode.window.showErrorMessage(`Refresh comparison failed: ${error.message}`); }
    }
  }

  async function closeAllComparisons() {
    for (const entry of [...branchTree.comparisons.values()]) {
      await vscode.commands.executeCommand('git-branch.closeCompare', { key: entry.key });
    }
    for (const key of [...branchTree.workingTrees.keys()]) {
      worktreeRequests.delete(key);
      branchTree.clearWorkingTree(key);
      const session = worktreeSessions.get(key);
      if (!session) continue;
      session.closed = true;
      worktreeSessions.delete(key);
      try { await closeSessionTabs(session); }
      catch (error) { vscode.window.showErrorMessage(`Close comparison tabs failed: ${error.message}`); }
    }
  }

  async function updateAll() {
    const groups = await branchTree.groups();
    const local = groups.find(group => group.label === 'Local');
    const items = (local?.children || []).filter(item => item.upstream);
    if (!items.length) { vscode.window.showInformationMessage('No local branch has a tracking branch to update.'); return; }
    await updateBranches(items[0], items);
  }

  /** Compare two or more selected commits: oldest parent → newest commit (D1 = A). */
  async function compareSelectedCommits(node, nodes) {
    const items = selection(node, nodes).filter(item => item?.commit?.hash);
    if (items.length < 2) {
      vscode.window.showInformationMessage('Select two or more commits to compare.');
      return;
    }
    const ordered = [...items].sort((a, b) => String(a.commit.date).localeCompare(String(b.commit.date)));
    const oldest = ordered[0].commit, newest = ordered[ordered.length - 1].commit;
    const left = { kind: 'tag', label: shortHash(newest.hash), ref: shortHash(newest.hash),
      hash: newest.hash, commitDate: newest.date, rawRef: newest.hash };
    const right = { kind: 'tag', label: `${shortHash(oldest.hash)}^`, ref: `${shortHash(oldest.hash)}^`,
      hash: oldest.hash, commitDate: oldest.date, rawRef: `${oldest.hash}^` };
    try {
      await showCompare(left, right, `commits:${oldest.hash}:${newest.hash}`);
    } catch (error) { vscode.window.showErrorMessage(`Compare failed: ${error.message}`); }
  }

  async function checkoutTag(node) {
    if (node?.kind !== 'tag' || !node.hash) {
      vscode.window.showInformationMessage('Right-click a tag to check it out.');
      return;
    }
    const confirmation = await vscode.window.showWarningMessage(
      `Check out tag '${node.ref}' (detached HEAD)?`, { modal: true,
        detail: 'HEAD becomes detached at the tag commit. Create a branch before committing new work.' }, 'Checkout Tag');
    if (confirmation !== 'Checkout Tag') return;
    try {
      await configureGitExecutable(git);
      await git.checkoutDetached(node.hash);
      branchTree.refresh();
      vscode.window.showInformationMessage(`Checked out tag: ${node.ref} (detached HEAD)`);
    } catch (error) {
      branchTree.refresh();
      vscode.window.showErrorMessage(`Checkout failed: ${error.message}`);
    }
  }

  async function cherryPickCommits(node, nodes) {
    const items = selection(node, nodes).filter(item => item?.commit?.hash);
    if (!items.length) { vscode.window.showInformationMessage('Select one or more commits to cherry-pick.'); return; }
    const ordered = [...items].sort((a, b) => String(a.commit.date).localeCompare(String(b.commit.date)));
    const confirmation = await vscode.window.showWarningMessage(
      `Cherry-pick ${ordered.length} commit(s) onto the current branch?`, { modal: true,
        detail: ordered.map(item => shortHash(item.commit.hash)).join('\n') }, 'Cherry-Pick');
    if (confirmation !== 'Cherry-Pick') return;
    for (const item of ordered) {
      try {
        await configureGitExecutable(git);
        await git.cherryPick(item.commit.hash);
        branchTree.refresh();
      } catch (error) {
        branchTree.refresh();
        vscode.window.showErrorMessage(`Cherry-pick failed: ${error.message}`);
        return;
      }
    }
    vscode.window.showInformationMessage(`Cherry-picked ${ordered.length} commit(s).`);
  }

  async function copyPaths(node, absolute) {
    const filePath = node?.file?.newPath || node?.file?.oldPath || node?.directory;
    if (!filePath) return;
    await copyToClipboard(absolute ? git.worktreePath(filePath.replace(/\/$/, '')) : filePath);
  }

  /** Open every file diff inside one comparison folder, with a guard for large folders. */
  async function openFolderDiffs(node) {
    const entry = node?.key ? branchTree.commitEntry(node.key) || branchTree.workingTrees.get(node.key) : undefined;
    if (!entry || !node.directory) return;
    const files = (entry.details || entry.result).files
      .filter(file => (file.newPath || file.oldPath).startsWith(node.directory));
    if (!files.length) return;
    if (files.length > 10) {
      const choice = await vscode.window.showWarningMessage(`Open ${files.length} file diffs from '${node.directory}'?`,
        { modal: true }, 'Open All');
      if (choice !== 'Open All') return;
    }
    for (const file of files) {
      try {
        if (entry.result) {
          const [leftLabel, rightLabel] = worktreeLabels(entry.result);
          await openDiff({ ...file, left: entry.result.left, right: entry.result.right,
            ref: entry.result.worktree ? entry.result.ref : leftLabel, rightLabel,
            worktree: !!entry.result.worktree, reversed: !!entry.result.reversed }, worktreeSessions.get(entry.key));
        } else {
          await openDiff({ ...file, left: entry.details.left, right: entry.details.right,
            ref: entry.details.left ? shortHash(entry.details.left) : 'Empty tree',
            rightLabel: shortHash(entry.details.right) }, worktreeSessions.get(entry.key));
        }
      } catch (error) { vscode.window.showErrorMessage(`Open diff failed: ${error.message}`); }
    }
  }

  /** Open one side of a commit diff as a read-only snapshot document. */
  async function openRevision(node, side) {
    if (node?.kind !== 'compare-file' || !node.details) return;
    const filePath = side === 'left' ? (node.file.oldPath || node.file.newPath) : (node.file.newPath || node.file.oldPath);
    const hash = side === 'left' ? node.details.left : node.details.right;
    if (!filePath || !hash) {
      vscode.window.showInformationMessage(side === 'left' ? 'This file does not exist in the left revision.'
        : 'This file does not exist in the right revision.');
      return;
    }
    try {
      await vscode.commands.executeCommand('vscode.open',
        snapshotUri(hash, filePath, worktreeSessions.get(node.key)), { preview: false });
    } catch (error) { vscode.window.showErrorMessage(`Open revision failed: ${error.message}`); }
  }
  async function openCommitOnRemote(node) {
    const hash = node?.commit?.hash || node?.hash;
    if (!hash) return;
    try {
      await configureGitExecutable(git);
      const name = await quickPickRemote('Open Commit on Remote');
      if (!name) return;
      const remote = (await git.remotes()).find(item => item.name === name);
      const base = remoteWebBase(remote?.url);
      if (!base) { vscode.window.showInformationMessage(`Remote '${name}' has no browsable URL.`); return; }
      const host = new URL(base).hostname;
      const path = /(^|\.)gitlab\./i.test(host) ? `/-/commit/${hash}`
        : /(^|\.)bitbucket\./i.test(host) ? `/commits/${hash}` : `/commit/${hash}`;
      await vscode.env.openExternal(vscode.Uri.parse(base + path));
    } catch (error) { vscode.window.showErrorMessage(`Open on Remote failed: ${error.message}`); }
  }

  /** Groups and the root carry no ref: ask which branch/tag/HEAD is the start point. */
  async function pickStartPoint() {
    const [{ current, branches }, tags] = await Promise.all([git.branches(), git.tags()]);
    const currentName = current ? current.replace(/^refs\/heads\//, '') : undefined;
    const items = [];
    if (currentName) items.push({ label: currentName, description: 'Current branch (HEAD)', start: 'HEAD', name: currentName });
    items.push({ label: 'HEAD', description: 'Detached or current commit', start: 'HEAD', name: currentName || '' });
    for (const branch of branches) {
      if (branch.symbolic) continue;
      items.push({ label: branch.name, description: `${branch.remote ? 'Remote' : 'Local'}${branch.current ? ' · Current' : ''}`,
        start: branch.remote ? `refs/remotes/${branch.name}` : `refs/heads/${branch.name}`,
        name: branch.remote ? branch.name.slice(branch.name.indexOf('/') + 1) : branch.name });
    }
    for (const tag of tags) items.push({ label: tag.name, description: 'Tag', start: `refs/tags/${tag.name}`, name: tag.name });
    return vscode.window.showQuickPick(items, {
      title: 'Create Branch — select start point',
      placeHolder: 'Branch, tag or commit to create from',
      matchOnDescription: true,
      ignoreFocusOut: true
    });
  }

  async function createBranch(node, checkout) {
    try {
      await configureGitExecutable(git);
      // A branch/tag node names the start point; groups and the root ask explicitly.
      let startPoint, startLabel, suggestedName;
      if (isBranchNode(node) || (node?.kind === 'tag' && !!node.ref)) {
        startPoint = qualifiedRef(node);
        startLabel = node.ref;
        suggestedName = node.remote ? node.ref.slice(node.ref.indexOf('/') + 1) : node.ref;
      } else if (node?.kind === 'commit' || node?.commit?.hash) {
        startPoint = node.commit?.hash || node.hash;
        startLabel = shortHash(startPoint);
        suggestedName = '';
      } else {
        const picked = await pickStartPoint();
        if (!picked) return;
        startPoint = picked.start;
        startLabel = picked.label;
        suggestedName = picked.name;
      }
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
      const completed = `Branch created: ${name} (from ${startLabel})`;
      if (checkout) {
        try {
          await git.checkout({ ref: name, remote: false });
          branchTree.refresh();
          vscode.window.showInformationMessage(`Branch created and checked out: ${name} (from ${startLabel})`);
        } catch (err) {
          branchTree.refresh();
          vscode.window.showErrorMessage(`Branch '${name}' was created, but checkout failed: ${err.message}`);
        }
        return;
      }
      const choice = await vscode.window.showInformationMessage(completed, 'Checkout');
      if (choice === 'Checkout') {
        try {
          await git.checkout({ ref: name, remote: false });
          branchTree.refresh();
          vscode.window.showInformationMessage(`Checked out: ${name}`);
        } catch (err) {
          vscode.window.showErrorMessage(`Checkout failed: ${err.message}`);
        }
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
    vscode.commands.registerCommand('git-branch.copyCommitHash', async text => {
      if (typeof text !== 'string' || !/^[a-f0-9]{7,64}$/.test(text)) return;
      try { await vscode.env.clipboard.writeText(text); }
      catch (err) { vscode.window.showErrorMessage(`Copy failed: ${err.message}`); }
    }),
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

    vscode.commands.registerCommand('git-branch.copyText', async text => {
      if (typeof text !== 'string' || !text || text.length > 65536) return;
      await copyToClipboard(text);
    }),
    vscode.commands.registerCommand('git-branch.copyBranchList', copyBranchList),
    vscode.commands.registerCommand('git-branch.copyBranchRef', copyBranchRef),
    vscode.commands.registerCommand('git-branch.copyNodeName', copyNodeName),
    vscode.commands.registerCommand('git-branch.copyRepository', copyRepository),
    vscode.commands.registerCommand('git-branch.copyComparison', copyComparison),
    vscode.commands.registerCommand('git-branch.copyRemoteUrl', copyRemoteUrl),
    vscode.commands.registerCommand('git-branch.openRepositoryOnRemote', () => openOnRemote()),
    vscode.commands.registerCommand('git-branch.openOnRemote', node => openOnRemote(node)),
    vscode.commands.registerCommand('git-branch.openCommitOnRemote', openCommitOnRemote),
    vscode.commands.registerCommand('git-branch.fetch', node => fetchRemote({ node })),
    vscode.commands.registerCommand('git-branch.fetchAll', () => fetchRemote({ all: true })),
    vscode.commands.registerCommand('git-branch.prune', node => fetchRemote({ node, prune: true })),
    vscode.commands.registerCommand('git-branch.removeRemote', removeRemoteGroup),
    vscode.commands.registerCommand('git-branch.fetchTags', async () => {
      try {
        await configureGitExecutable(git);
        const name = await quickPickRemote('Fetch Tags');
        if (!name) return;
        await git.fetchTags(name);
        branchTree.refresh();
        vscode.window.showInformationMessage(`Tags fetched: ${name}`);
      } catch (error) { vscode.window.showErrorMessage(`Fetch tags failed: ${error.message}`); }
    }),
    vscode.commands.registerCommand('git-branch.pushAllTags', pushAllTags),
    vscode.commands.registerCommand('git-branch.pushTag', pushSingleTag),
    vscode.commands.registerCommand('git-branch.createTag', createTag),
    vscode.commands.registerCommand('git-branch.deleteTag', deleteTag),
    vscode.commands.registerCommand('git-branch.deleteRemoteTag', deleteRemoteTag),
    vscode.commands.registerCommand('git-branch.pull', pullBranch),
    vscode.commands.registerCommand('git-branch.expandAll', node => {
      if (node?.kind === 'category' && !node.comparisonsGroup) branchTree.setGroupExpansion(node.label, true);
      else branchTree.setExpansion(true);
    }),
    vscode.commands.registerCommand('git-branch.collapseAll', node => {
      if (node?.kind === 'category' && !node.comparisonsGroup) branchTree.setGroupExpansion(node.label, false);
      else branchTree.setExpansion(false);
    }),
    ...[['groupSortName', 'name'], ['groupSortDate', 'date'], ['groupSortOpened', 'opened']]
      .flatMap(([command, value]) => [command, `${command}.current`].map(id =>
        vscode.commands.registerCommand(`git-branch.${id}`, node => sortTarget(node, 'order', value)))),

    vscode.commands.registerCommand('git-branch.update', updateBranches),
    vscode.commands.registerCommand('git-branch.push', async (node, nodes) => {
      const items = selectedBranches(node, nodes);
      if (items.length !== 1 || items[0].remote) {
        vscode.window.showInformationMessage('Select one local branch to push.');
        return;
      }
      try {
        await configureGitExecutable(git);
        const target = await git.pushTarget(items[0]);
        let remote;
        if (target.publish) {
          if (target.remotes.length === 1) remote = target.remotes[0];
          else {
            const choice = await vscode.window.showQuickPick(target.remotes.map(name => ({
              label: name, remote: name, description: `Publish ${items[0].ref}`
            })), { title: `Push ${items[0].ref}`, placeHolder: 'Select a remote for the new branch' });
            if (!choice) return;
            remote = choice.remote;
          }
        }
        const result = await git.push(items[0], remote);
        branchTree.refresh();
        vscode.window.showInformationMessage(`Pushed: ${result}`);
      } catch (error) { vscode.window.showErrorMessage(`Push failed: ${error.message}`); }
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

    vscode.commands.registerCommand('git-branch.compare', async (node, nodes) => {
      const items = selectedRefs(node, nodes);
      if (!items.length || items.length > 2) {
        vscode.window.showInformationMessage('Select one or two branches or tags to compare.');
        return;
      }
      try {
        if (items.length === 1 && isBranchNode(items[0]) && !items[0].remote && items[0].ref === await git.current()) {
          vscode.window.showInformationMessage('Select a different branch to compare with current.');
          return;
        }
        await showCompare(items[0], items[1]);
      } catch (err) { vscode.window.showErrorMessage(`Compare failed: ${err.message}`); }
    }),

    vscode.commands.registerCommand('git-branch.worktree', async (node, nodes) => {
      const items = selectedRefs(node, nodes);
      if (!items.length || items.length > 2) {
        vscode.window.showInformationMessage('Select one or two branches or tags to show differences.');
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
    vscode.commands.registerCommand('git-branch.compareCommits', compareSelectedCommits),
    vscode.commands.registerCommand('git-branch.checkoutCommit', async node => {
      const hash = node?.commit?.hash;
      if (!hash) return;
      const confirmation = await vscode.window.showWarningMessage(
        `Check out commit ${shortHash(hash)} (detached HEAD)?`, { modal: true,
          detail: 'HEAD becomes detached. Create a branch before committing new work.' }, 'Checkout Commit');
      if (confirmation !== 'Checkout Commit') return;
      try {
        await configureGitExecutable(git);
        await git.checkoutDetached(hash);
        branchTree.refresh();
        vscode.window.showInformationMessage(`Checked out commit: ${shortHash(hash)} (detached HEAD)`);
      } catch (error) {
        branchTree.refresh();
        vscode.window.showErrorMessage(`Checkout failed: ${error.message}`);
      }
    }),
    vscode.commands.registerCommand('git-branch.cherryPick', cherryPickCommits),
    vscode.commands.registerCommand('git-branch.checkoutTag', checkoutTag),
    vscode.commands.registerCommand('git-branch.updateAll', updateAll),
    vscode.commands.registerCommand('git-branch.refreshAllComparisons', refreshAllComparisons),
    vscode.commands.registerCommand('git-branch.closeAllComparisons', closeAllComparisons),
    vscode.commands.registerCommand('git-branch.copyPath', node => copyPaths(node, false)),
    vscode.commands.registerCommand('git-branch.copyAbsolutePath', node => copyPaths(node, true)),
    vscode.commands.registerCommand('git-branch.openFolderDiffs', openFolderDiffs),
    vscode.commands.registerCommand('git-branch.openRevisionLeft', node => openRevision(node, 'left')),
    vscode.commands.registerCommand('git-branch.openRevisionRight', node => openRevision(node, 'right')),
    vscode.commands.registerCommand('git-branch.copyCommitFullHash', node => {
      const hash = node?.commit?.hash || node?.hash;
      if (hash) return copyToClipboard(hash);
    }),
    vscode.commands.registerCommand('git-branch.copyCommitMessage', node => {
      const message = node?.commit?.subject || node?.commit?.message;
      if (message) return copyToClipboard(message);
    }),
    vscode.commands.registerCommand('git-branch.openWorktreeFile', async node => {
      const filePath = node?.file?.newPath || node?.file?.oldPath;
      if (!filePath) return;
      try { await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(git.worktreePath(filePath)), { preview: false }); }
      catch (error) { vscode.window.showErrorMessage(`Open file failed: ${error.message}`); }
    }),
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
      const next = { ...entry, reversed: !entry.reversed, result: { ...result, ...reverseDiffData(result),
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
    vscode.commands.registerCommand('git-branch.loadBranchHistory', node => branchTree.loadBranchHistory(node)),
    vscode.commands.registerCommand('git-branch.openCommitWorkingFile', async element => {
      if (element?.kind !== 'compare-file' || branchTree.commitEntry(element.key) !== element.entry ||
          !element.details?.files.includes(element.file)) return;
      try {
        // Recheck at click time: the working tree may have changed since expansion.
        const uri = await branchTree.workingFileUri(element.file);
        if (branchTree.commitEntry(element.key) !== element.entry) return;
        if (!uri) {
          branchTree.refresh();
          vscode.window.showInformationMessage('This file is no longer available in the working tree.');
          return;
        }
        await vscode.commands.executeCommand('vscode.open', uri, { preview: false });
      } catch (error) { vscode.window.showErrorMessage(`Open working tree file failed: ${error.message}`); }
    }),
    vscode.commands.registerCommand('git-branch.openCompareDiff', async element => {
      if (element?.kind !== 'compare-file' || branchTree.commitEntry(element.key) !== element.entry || !element.details.files.includes(element.file)) return;
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
      if (!items.length) {
        vscode.window.showInformationMessage('Select local or remote branches to delete.');
        return;
      }
      const remoteItems = items.filter(item => item.remote);
      const localItems = items.filter(item => !item.remote);
      if (items.length === 1 && localItems.length) {
        try {
          await configureGitExecutable(git);
          if (await git.current() === localItems[0].ref) {
            vscode.window.showInformationMessage('Cannot delete the current branch. Check out another branch first.');
            return;
          }
        } catch (error) { vscode.window.showErrorMessage(`Delete failed: ${error.message}`); return; }
      }
      const confirmation = await vscode.window.showWarningMessage(
        remoteItems.length === items.length && items.length === 1
          ? `Delete remote branch '${items[0].ref}'?`
          : remoteItems.length ? `Delete ${items.length} branch(es), including ${remoteItems.length} remote branch(es)?`
            : `Delete ${items.length} local branch(es)?`,
        { modal: true, detail: `${items.map(item => item.ref).join('\n')}\n\n${remoteItems.length
          ? 'Remote branches will be deleted on their configured remotes. Corresponding local branches are not deleted automatically; you will be asked separately. '
          : ''}${localItems.length
          ? 'Local deletion is safe first; unmerged branches require individual Force Delete confirmation.'
          : ''}` }, 'Delete');
      if (confirmation !== 'Delete') return;
      const deleted = [], failed = [], skipped = [];
      // Locals already acted on (deleted, kept after a prompt or skipped) are
      // never offered again by the corresponding-local prompt.
      const handledLocals = new Set();
      const deleteLocal = async item => {
        handledLocals.add(item.ref);
        await configureGitExecutable(git);
        if (await git.current() === item.ref) {
          skipped.push(`${item.ref}: current branch`);
          return false;
        }
        const originalHash = await git.resolve(`refs/heads/${item.ref}`);
        try { await git.remove(item.ref); }
        catch (error) {
          if (!error.unmergedBranch) throw error;
          const force = await vscode.window.showWarningMessage(
            `Branch '${item.ref}' is not fully merged. Force delete it?`,
            { modal: true, detail: 'Local-only commits may become inaccessible. Cancelling skips only this branch.' }, 'Force Delete');
          if (force !== 'Force Delete') { skipped.push(`${item.ref}: cancelled`); return false; }
          if (await git.resolve(`refs/heads/${item.ref}`) !== originalHash) {
            throw new Error('Branch changed during confirmation; review and retry.');
          }
          await git.remove(item.ref, true);
        }
        deleted.push(item.ref);
        return true;
      };
      const removedRemotes = [];
      for (const item of remoteItems) {
        try {
          await configureGitExecutable(git);
          await git.removeRemote(item);
          deleted.push(item.ref);
          removedRemotes.push(item);
        } catch (error) { failed.push(`${item.ref}: ${error.message}`); }
        finally { branchTree.refresh(); }
      }
      for (const item of localItems) {
        try { await deleteLocal(item); }
        catch (error) { failed.push(`${item.ref}: ${error.message}`); }
        finally { branchTree.refresh(); }
      }
      // Only ask about locals after the remote deletion actually succeeded;
      // a failed network operation must not remove local history.
      if (removedRemotes.length) {
        try {
          await configureGitExecutable(git);
          const candidates = new Map();
          for (const item of removedRemotes) {
            for (const local of await git.correspondingLocals(item)) {
              if (!handledLocals.has(local.ref)) candidates.set(local.ref, local);
            }
          }
          const current = await git.current();
          const currentNames = [...candidates.values()].filter(item => item.ref === current).map(item => item.ref);
          for (const name of currentNames) skipped.push(`${name}: current branch; corresponding local kept`);
          const actionable = [...candidates.values()].filter(item => item.ref !== current);
          if (actionable.length) {
            const choice = await vscode.window.showWarningMessage(
              `Delete ${actionable.length} corresponding local branch(es)?`,
              { modal: true, detail: `${actionable.map(item => `${item.ref}${item.tracksDeletedRemote ? ' (tracked the deleted remote branch)' : ' (same name)'}`).join('\n')}\n\nThe current branch is never deleted. Local-only commits still require Force Delete confirmation.` },
              'Delete Local Branches', 'Keep Local Branches');
            if (choice === 'Delete Local Branches') {
              for (const item of actionable) {
                try { await deleteLocal(item); }
                catch (error) { failed.push(`${item.ref}: ${error.message}`); }
                finally { branchTree.refresh(); }
              }
            } else {
              for (const item of actionable) skipped.push(`${item.ref}: corresponding local kept`);
            }
          }
        } catch (error) { failed.push(`Corresponding local branches: ${error.message}`); }
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
          title: `Open Diff (${comparison.ref} ↔ ${comparison.currentLabel})`,
          placeHolder: 'Select a file to diff'
        });
        if (!picked) return;
        // The picker can outlive a refresh, swap or close. Never reopen an orphaned snapshot.
        if (![...branchTree.comparisons.values()].some(entry => entry.result === comparison)) {
          vscode.window.showInformationMessage('Comparison changed or closed. Run Open Diff again.');
          return;
        }
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
