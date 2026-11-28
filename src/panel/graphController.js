'use strict';

const { randomBytes } = require('node:crypto');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const { comparisonGroups } = require('../../media/historyRows');
const { historyMessages, locale, t } = require('../i18n');
const { GraphLayout } = require('../graph/layout');
const { HEADS, sameHead } = require('../git/refs');
const { MAX_SELECTION, WORKTREE, HistorySelection, historyTarget, resolveComparisonEndpoint, comparisonRef, combineChanges, mapWithLimit } = require('./historyState');
const { editableFileSide, repositoryVersion, canApply, MAX_PATCH_FILES } = require('../git/selectedChanges');
const { regularMode, safeWorktreeFile } = require('../git/worktreePaths');
const { BranchError, errorText, shortOid } = require('../util/format');

const FILE_LAYOUT = 'git-branch.filesLayout';
const COMMIT_COLUMNS = 'git-branch.historyColumns';
const COLUMN_LABELS = { author: 'history.author', hash: 'history.columnHash', date: 'history.columnDate' };
const DEFAULT_COLUMNS = ['author', 'date'];

const HTML_ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = value => value.replace(/[&<>"']/g, char => HTML_ENTITIES[char]);
const htmlText = key => escapeHtml(t(key));

function reverseWorktreeChange(file) {
  const { old, new: next, status } = file;
  const { path, pathKey } = old || next;
  return { ...file, old: next, new: old, path, pathKey,
    status: status === 'A' ? 'D' : status === 'D' ? 'A' : status, worktreeBefore: true };
}

function installedCodiconFont(appRoot) {
  if (!appRoot) return '';
  // Webviews do not inherit the workbench font. Read only the installed Codicon font,
  // without exposing the installation directory as a Webview resource root.
  for (const relative of ['out/media/codicon.ttf', 'out/vs/base/browser/ui/codicons/codicon/codicon.ttf']) {
    try { return readFileSync(path.join(appRoot, relative)).toString('base64'); }
    catch { /* The layout varies by VS Code version. */ }
  }
  // Some builds ship Codicons in the built-in Simple Browser stylesheet instead.
  try {
    const css = readFileSync(path.join(appRoot, 'extensions/simple-browser/media/codicon.css'), 'utf8');
    return /url\(["']?data:font\/ttf;base64,([A-Za-z0-9+/]+=*)["']?\)/.exec(css)?.[1] ?? '';
  } catch { return ''; }
}

class GraphController {
  constructor(context, registry, documents, ui) {
    this.context = context;
    this.registry = registry;
    this.documents = documents;
    this.ui = ui;
    this.range = 'HEAD';
    this.filter = '';
    this.collapsedGroups = new Set();
    const savedColumns = context.workspaceState?.get(COMMIT_COLUMNS);
    const visibleColumns = Array.isArray(savedColumns) ? savedColumns : DEFAULT_COLUMNS;
    this.commitColumns = Object.keys(COLUMN_LABELS).filter(key => visibleColumns.includes(key));
    this.generation = 0;
    this.selectionRevision = 0;
    this.requests = new Map();
    this.viewSubs = [];
    this.changeId = 0;
    this.fileSelection = { commit: new Set(), snapshot: new Set() };
    this.filesLayout = context.workspaceState?.get(FILE_LAYOUT) === 'tree' ? 'tree' : 'list';
    this.registrySub = registry.onChange(() => this.repoChanged());
    this.reset();
    this.repoChanged();
  }

  get visible() { return Boolean(this.view?.visible && this.ready); }
  get canRead() { return Boolean(this.visible && this.repo?.snapshot && !this.repo.error); }

  resolveWebviewView(view) {
    this.releaseView();
    this.view = view;
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    this.viewSubs.push(
      view.webview.onDidReceiveMessage(message => {
        if (this.view === view) void this.onMessage(message).catch(error => this.ui.report(error, this.repo));
      }),
      view.onDidChangeVisibility(() => { if (this.visible) this.resume(); else this.pause(); }),
      view.onDidDispose(() => { if (this.view === view) this.releaseView(); })
    );
    view.webview.html = this.html(view.webview, media);
  }

  async show() {
    if (this.view) this.view.show(false);
    else await vscode.commands.executeCommand('git-branch.log.focus');
  }

  releaseView() {
    this.ready = false;
    this.view = undefined;
    for (const subscription of this.viewSubs.splice(0)) subscription.dispose();
    this.cancelEndpointPick();
    this.pause();
  }

  dispose() { this.releaseView(); this.registrySub.dispose(); }

  send(type, payload) {
    if (!this.visible) return;
    void Promise.resolve(this.view.webview.postMessage({ type, generation: this.generation, repoId: this.repo?.id, payload })).catch(() => {});
  }

  start(kind) {
    this.cancel(kind);
    const request = new AbortController();
    this.requests.set(kind, request);
    return request;
  }

  active(kind, request) { return this.requests.get(kind) === request && !request.signal.aborted; }

  cancel(kind) {
    this.requests.get(kind)?.abort();
    this.requests.delete(kind);
  }

  pause(except) {
    for (const kind of this.requests.keys()) {
      if (kind !== except && !(except === 'comparison' && kind === 'worktree')) this.cancel(kind);
    }
    this.finishEdit();
  }

  finishEdit(value) {
    const previous = this.editPrompt;
    if (!previous) return;
    this.editPrompt = undefined;
    previous.resolve(value);
    this.send('editPrompt', null);
  }

  reset(keepSelection = false, keepSnapshot = false) {
    // Commit filters do not change the pinned endpoints or their file diff.
    this.pause(keepSnapshot ? 'comparison' : undefined);
    this.generation++;
    this.keepSnapshot = keepSnapshot;
    this.restore = keepSelection ? this.restore ?? this.selection?.asPacket() : undefined;
    this.selection = new HistorySelection();
    this.rows = [];
    this.known = new Map();
    this.layout = new GraphLayout();
    this.sideLayouts = { left: new GraphLayout(), right: new GraphLayout() };
    this.hasMore = true;
    this.pageLoaded = false;
    this.historyWorktreeVersion = undefined;
    this.scanned = 0;
    this.pageError = undefined;
    this.selectionFiles = new Map();
    this.fileSelection.commit.clear();
    this.selectionPacket = undefined;
    if (!keepSnapshot) {
      this.worktreeSnapshot = undefined;
      this.snapshotFiles = new Map();
      this.fileSelection.snapshot.clear();
      this.comparePacket = undefined;
    }
    this.sendReset();
    if (this.canRead) void this.loadPage();
    if (this.canRead && this.comparison && (!this.comparePacket || this.comparePacket.loading)) void this.loadComparison();
  }

  repoChanged() {
    const next = this.registry.active;
    if (next !== this.repo) {
      this.cancelEndpointPick();
      this.repo = next;
      this.unavailable = !next?.snapshot || Boolean(next.error);
      this.comparison = undefined;
      this.collapsedGroups.clear();
      this.range = 'HEAD';
      this.filter = '';
      this.target = next?.snapshot ? historyTarget(next.snapshot, this.range, this.registry.showTags) : undefined;
      this.reset();
      return;
    }
    if (!next?.snapshot || next.error) {
      this.cancelEndpointPick();
      this.pause();
      this.unavailable = true;
      this.sendReset();
      return;
    }
    const recovered = this.unavailable;
    this.unavailable = false;
    const previous = this.target;
    this.target = historyTarget(next.snapshot, this.range, this.registry.showTags);
    this.range = this.target.range;
    if ((!this.comparison && previous?.key !== this.target.key) || (this.comparison && previous?.shallow !== this.target.shallow)) {
      this.reset(previous?.range === this.target.range);
    } else if (recovered) this.resume();
    else {
      this.send('meta', this.meta());
      void this.syncHistoryWorktree();
    }
  }

  setRange(repo, range) {
    if (this.repo !== repo || !repo.snapshot) throw new BranchError(t('repo.switchedOrLoading'));
    const target = historyTarget(repo.snapshot, range, this.registry.showTags);
    if (this.comparison || this.endpointPick || target.range !== this.range) {
      this.cancelEndpointPick();
      this.target = target;
      this.range = target.range;
      this.comparison = undefined;
      this.collapsedGroups.clear();
      this.reset();
    }
  }

  setFilter(text) {
    const next = text.trim();
    if (next === this.filter) return;
    this.filter = next;
    this.reset(false, Boolean(this.comparison));
  }

  toggleComparisonGroup(side) {
    if (!this.comparison || (side !== 'left' && side !== 'right') || this.comparePacket?.counts?.[side] === 0) return;
    if (this.collapsedGroups.delete(side)) {
      this.send('groupVisibility', [...this.collapsedGroups]);
      return;
    }
    this.collapsedGroups.add(side);
    this.send('groupVisibility', [...this.collapsedGroups]);
    // Hidden commits must not be included in selection-based operations on visible rows.
    if (this.selection.retain(oid => this.known.get(oid)?.side !== side)) return this.loadSelection();
  }

  async chooseColumns() {
    const items = Object.entries(COLUMN_LABELS).map(([key, label]) => ({ key, label: t(label), picked: this.commitColumns.includes(key) }));
    const chosen = await vscode.window.showQuickPick(items, { canPickMany: true, title: t('history.chooseColumns') });
    if (!chosen) return;
    this.commitColumns = items.filter(item => chosen.includes(item)).map(item => item.key);
    this.send('commitColumns', this.commitColumns);
    await this.context.workspaceState?.update(COMMIT_COLUMNS, this.commitColumns);
  }

  comparisonBase() {
    const snapshot = this.repo?.snapshot;
    const ref = snapshot?.byRef.get(this.range);
    if (ref?.oid && (ref.kind === 'local' || ref.kind === 'remote')) return { ref: ref.ref, label: ref.name };
    // All Branches and tags are history ranges, not comparison branches.
    const head = snapshot?.head;
    if (head?.oid) return { ref: head.ref || 'HEAD', label: head.ref ? head.ref.slice(HEADS.length) : t('branch.headDetached') };
  }

  cancelEndpointPick() {
    const previous = this.endpointPick;
    this.endpointPick = undefined;
    previous?.request.abort();
  }

  async pickComparisonEndpoint(side) {
    if (!this.canRead || this.endpointPick) return;
    const { repo, comparison } = this;
    const base = !comparison && side === 'right' ? this.comparisonBase() : undefined;
    if (!comparison && !base) return;
    const request = new AbortController();
    const pick = this.endpointPick = { base, request };
    const { signal } = request;
    const current = comparisonRef(comparison?.[side]);
    const peer = comparison?.[side === 'left' ? 'right' : 'left'];
    const exclude = base?.ref ?? comparisonRef(peer);
    this.send('meta', this.meta());
    try {
      const ref = await this.ui.pickComparisonRef(repo, side, { exclude, current, signal });
      if (signal.aborted || !ref || ref === current || ref === exclude) return;
      const [endpoint, resolvedBase] = await Promise.all([
        resolveComparisonEndpoint(repo, ref), base && resolveComparisonEndpoint(repo, base.ref)
      ]);
      const left = resolvedBase ?? (side === 'left' ? endpoint : peer);
      const right = side === 'right' ? endpoint : peer;
      if (!signal.aborted) this.compare(repo, left, right);
    } catch (error) {
      if (!signal.aborted) throw error;
    } finally {
      if (this.endpointPick === pick) {
        this.endpointPick = undefined;
        this.send('meta', this.meta());
      }
    }
  }

  compare(repo, left, right) {
    if (this.repo !== repo) throw new BranchError(t('repo.switched'));
    this.cancelEndpointPick();
    this.comparison = { left, right };
    this.collapsedGroups.clear();
    this.reset();
  }

  async compareWorktree(repo, left, check) {
    const right = await resolveComparisonEndpoint(repo, WORKTREE);
    check?.();
    this.compare(repo, left, right);
  }

  async recompare() {
    const { repo, comparison, generation } = this;
    if (!repo || !comparison) return;
    const resolve = endpoint => {
      const ref = comparisonRef(endpoint);
      return ref ? resolveComparisonEndpoint(repo, ref) : endpoint;
    };
    const [left, right] = await Promise.all([resolve(comparison.left), resolve(comparison.right)]);
    if (repo !== this.repo || comparison !== this.comparison || generation !== this.generation || this.endpointPick) return;
    this.comparison = { left, right };
    this.reset(true);
  }

  exitComparison() {
    const picking = Boolean(this.endpointPick);
    this.cancelEndpointPick();
    if (!this.comparison) {
      if (picking) this.send('meta', this.meta());
      return;
    }
    this.comparison = undefined;
    this.collapsedGroups.clear();
    this.reset();
  }

  meta() {
    const { repo, comparison } = this;
    const snapshot = repo?.snapshot;
    const refs = new Map();
    for (const ref of snapshot?.allRefs ?? []) {
      if (!ref.oid || (ref.kind === 'tag' && !this.registry.showTags)) continue;
      if (!refs.has(ref.oid)) refs.set(ref.oid, []);
      const list = refs.get(ref.oid);
      const badge = { kind: ref.kind, name: ref.name, current: ref.ref === snapshot.head.ref };
      if (badge.current) list.unshift(badge); else list.push(badge);
    }
    if (snapshot?.head.oid && !snapshot.head.ref) {
      const badges = refs.get(snapshot.head.oid) || [];
      refs.set(snapshot.head.oid, [{ kind: 'head', name: 'HEAD', current: true }, ...badges]);
    }
    return {
      repository: repo?.name, repositoryPath: repo?.root.fsPath, repositoryCount: this.registry.repositories.size,
      range: this.target?.label || 'HEAD', rangeKey: this.range, shallow: Boolean(snapshot?.shallow), head: snapshot?.head,
      canCompare: Boolean(this.comparisonBase()), pickingEndpoint: Boolean(this.endpointPick),
      compareDraft: this.endpointPick?.base?.label,
      message: !repo ? this.registry.noRepositoryMessage : repo.error ? t('repo.readError', { detail: repo.error }) : !snapshot ? t('repo.reading') : undefined,
      compare: comparison ? {
        left: this.comparisonLabel(comparison.left), right: this.comparisonLabel(comparison.right),
        collapsed: [...this.collapsedGroups],
        workingTree: Boolean(comparison.left.worktree || comparison.right.worktree),
        stale: Boolean(snapshot && [comparison.left, comparison.right].some(endpoint => endpoint.worktree
          ? snapshot.head.oid !== endpoint.oid : endpoint.ref && snapshot.byRef.get(endpoint.ref)?.oid !== endpoint.oid))
      } : undefined,
      badges: [...refs]
    };
  }

  comparisonLabel(endpoint) {
    return { label: endpoint.name, oid: endpoint.oid, ...(endpoint.worktree ? { worktree: true } : {}) };
  }

  pageState() {
    return { hasMore: this.hasMore, loading: this.requests.has('page'), error: this.pageError,
      columns: Math.max(this.layout.columns, this.sideLayouts.left.columns, this.sideLayouts.right.columns),
      filter: this.filter };
  }

  sendReset() {
    this.send('reset', { meta: this.meta(), rows: this.rows, page: this.pageState(), filesLayout: this.filesLayout,
      commitColumns: this.commitColumns, keepSnapshot: this.keepSnapshot,
      selection: this.selectionPacket || { ...this.selection.asPacket(), revision: this.selectionRevision }, comparison: this.comparePacket,
      editPrompt: this.editPrompt?.packet });
  }

  resume() {
    this.sendReset();
    if (!this.canRead) return;
    if (!this.pageLoaded && this.hasMore && !this.pageError) void this.loadPage();
    else void this.syncHistoryWorktree();
    if (this.comparison && (!this.comparePacket || this.comparePacket.loading)) void this.loadComparison();
    if (this.rows.length && (!this.selectionPacket || this.selectionPacket.loading)) void this.loadSelection();
  }

  async worktreeChanges(repo, oid, version = this.comparison ?? repo.snapshot) {
    const current = this.worktreeSnapshot;
    if (current?.repo === repo && current.oid === oid && current.version === version && !current.request.signal.aborted) return current.pending;
    const request = this.start('worktree');
    const pending = Promise.resolve().then(() => repo.reads.worktreeFiles(oid, { signal: request.signal }));
    const snapshot = this.worktreeSnapshot = { repo, oid, version, request, pending };
    try { return await pending; }
    catch (error) {
      if (this.worktreeSnapshot === snapshot) this.worktreeSnapshot = undefined;
      throw error;
    } finally {
      if (this.active('worktree', request)) this.requests.delete('worktree');
    }
  }

  async readWorktreeRow(repo, oid, version, side) {
    if (!oid) return;
    const subject = t('history.workingTreeCommit');
    if (!subject.toLowerCase().includes(this.filter.toLowerCase())) return;
    const changes = await this.worktreeChanges(repo, oid, version);
    // The virtual node attaches to the pinned HEAD, not to an arbitrary visible commit.
    if (changes.length) return { oid: `worktree:${oid}`, baseOid: oid, worktree: true, parents: [oid], side, subject };
  }

  async syncHistoryWorktree() {
    const { repo, target, comparison, generation } = this;
    const snapshot = repo?.snapshot;
    if (!this.canRead || comparison || !target?.worktreeOid || !this.pageLoaded || this.historyWorktreeVersion === snapshot) return;
    // Status notifications can change local files without moving HEAD or invalidating a loaded page.
    const row = await this.readWorktreeRow(repo, target.worktreeOid, snapshot).catch(() => null);
    if (row === null || !this.canRead || this.generation !== generation || repo.snapshot !== snapshot || this.historyWorktreeVersion === snapshot) return;
    this.historyWorktreeVersion = snapshot;
    const previous = this.rows[0]?.worktree ? this.rows[0] : undefined;
    const changed = Boolean(previous) !== Boolean(row);
    const wasSelected = this.selection.selected.has(previous?.oid);
    if (changed) {
      if (row) {
        this.rows.unshift(row);
        this.known.set(row.oid, row);
      } else {
        this.rows.shift();
        this.known.delete(previous.oid);
      }
      this.relayout();
      if (wasSelected) {
        this.selection.restore(this.selection.asPacket(), this.rows);
        this.selectionPacket = undefined;
      }
      this.sendReset();
    }
    if (wasSelected) void this.loadSelection();
  }

  layoutFor(row) { return this.sideLayouts[row.side] || this.layout; }

  displayRows() {
    if (!this.comparison) return this.rows;
    return comparisonGroups(this.rows, [...this.collapsedGroups]).flatMap(group => group.collapsed ? [] : group.rows);
  }

  async loadPage() {
    if (!this.canRead || !this.hasMore || this.requests.has('page')) return;
    const request = this.start('page');
    const { repo, comparison, target } = this;
    const snapshot = repo.snapshot;
    const first = !this.pageLoaded;
    this.pageError = undefined;
    this.send('page', this.pageState());
    try {
      const tips = comparison ? undefined : target?.tips;
      const { commits, hasMore, scanned } = await repo.reads.historyPage({ tips, compare: comparison,
        skip: this.rows.filter(row => !row.worktree).length, scan: this.scanned, limit: 120, filter: this.filter, signal: request.signal });
      if (!this.active('page', request)) return;
      const rows = [];
      if (first) {
        const side = comparison?.left.worktree ? 'left' : comparison?.right.worktree ? 'right' : undefined;
        const oid = comparison ? side && comparison[side].oid : target?.worktreeOid;
        // A failed local diff must not prevent valid Git history from loading.
        const row = await this.readWorktreeRow(repo, oid, comparison ?? snapshot, side).catch(() => undefined);
        if (!this.active('page', request)) return;
        if (row) rows.push(row);
        if (!comparison) this.historyWorktreeVersion = snapshot;
      }
      for (const commit of commits) rows.push({ ...commit, shallowBoundary: snapshot.shallowRoots?.has(commit.oid) });
      for (const row of rows) row.graph = this.layoutFor(row).append(row);
      this.rows.push(...rows);
      for (const row of rows) this.known.set(row.oid, row);
      this.pageLoaded = true;
      this.hasMore = hasMore;
      this.scanned = scanned ?? this.rows.filter(row => !row.worktree).length;
      if (!hasMore && [this.layout, ...Object.values(this.sideLayouts)].some(layout => layout.byOid.size)) {
        // Parents excluded from the completed range don't reserve a lane indefinitely.
        this.relayout();
        this.sendReset();
      } else this.send('append', rows);
      if (first) {
        this.selection.restore(this.restore, this.displayRows());
        this.restore = undefined;
        void this.loadSelection();
        void this.syncHistoryWorktree();
      }
    } catch (error) {
      if (this.active('page', request)) this.pageError = errorText(error);
    } finally {
      if (this.active('page', request)) {
        this.requests.delete('page');
        this.send('page', this.pageState());
      }
    }
  }

  /** Rebuilds lane geometry, retaining unknown parents while more pages may contain them. */
  relayout() {
    this.layout = new GraphLayout();
    this.sideLayouts = { left: new GraphLayout(), right: new GraphLayout() };
    const known = this.hasMore ? undefined : this.known;
    for (const row of this.rows) row.graph = this.layoutFor(row).append(row, known);
  }

  async readCommit(repo, oid, signal) {
    let commit = repo.commitCache.get(oid);
    if (!commit) {
      commit = await repo.reads.commit(oid, { signal });
      repo.commitCache.set(oid, commit);
    }
    return commit;
  }

  async readFiles(repo, oid, commit, signal, includeParents) {
    const grouped = includeParents && commit.parents.length > 1;
    const key = `${repo.snapshot.shallow}:${oid}`;
    const groupKey = `${key}:parents`;
    let files = repo.filesCache.get(key);
    let parentGroups = grouped ? repo.filesCache.get(groupKey) : [];
    if (grouped && (!files || !parentGroups)) {
      ({ files, parentGroups } = await repo.reads.commitFileDetails(oid, commit, { signal }, true));
      if (parentGroups.reduce((total, group) => total + group.files.length, 0) < 3000) repo.filesCache.set(groupKey, parentGroups);
    } else if (!files) files = await repo.reads.commitFiles(oid, commit, { signal });
    // Do not retain huge changesets in the history cache.
    if (files.length < 3000) repo.filesCache.set(key, files);
    return { files: files.map(file => ({ ...file, baseOid: commit.parents[0], afterOid: oid })), parentGroups };
  }

  async parentSubject(repo, oid, signal) {
    const row = this.known.get(oid);
    if (row) return row.subject;
    try {
      const { message } = await this.readCommit(repo, oid, signal);
      return message.trimStart().split(/\r?\n\s*\r?\n/, 1)[0].replace(/\r?\n/g, ' ');
    } catch (error) {
      if (signal.aborted) throw error;
      return '';
    }
  }

  toClient(file, tokens, caption) {
    const id = String(++this.changeId);
    tokens.set(id, { ...file, caption });
    return { id, path: file.path, pathKey: file.pathKey,
      from: file.status === 'R' || file.status === 'C' ? file.old?.path : undefined,
      status: file.status, submodule: file.old?.mode === '160000' || file.new?.mode === '160000',
      ambiguous: file.ambiguous, includesGap: file.includesGap, apply: canApply(file), parentGroup: file.parentGroup,
      repositoryVersion: Boolean(repositoryVersion(file) && repositoryVersion(file).mode !== '160000'),
      sourceCandidate: regularMode(editableFileSide(file)?.mode)
    };
  }

  async loadSelection() {
    this.cancel('diff');
    this.selectionFiles.clear();
    this.fileSelection.commit.clear();
    this.cancel('commitMenu');
    const revision = ++this.selectionRevision;
    const state = this.selection.asPacket();
    const publish = packet => {
      this.selectionPacket = { ...state, revision, ...packet };
      this.send('selection', this.selectionPacket);
    };
    const { repo } = this;
    if (!this.canRead || !state.focus || state.selected.length > MAX_SELECTION) {
      this.cancel('selection');
      publish(state.selected.length > MAX_SELECTION ? { selectionOverLimit: MAX_SELECTION } : {});
      return;
    }
    const request = this.start('selection');
    const { signal } = request;
    const selected = state.selected.length === 1 ? state.selected : this.rows.filter(row => this.selection.selected.has(row.oid)).map(row => row.oid);
    const multi = selected.length > 1;
    let processed = 0;
    publish({ loading: true, total: selected.length, processed });
    try {
      const items = await mapWithLimit(selected, 4, signal, async oid => {
        const row = this.known.get(oid);
        let commit, files, parentGroups, error;
        try {
          if (row?.worktree) {
            files = await this.worktreeChanges(repo, row.baseOid);
            files = files.map(file => ({ ...file, baseOid: row.baseOid, afterOid: oid }));
          } else {
            commit = await this.readCommit(repo, oid, signal);
            ({ files, parentGroups } = await this.readFiles(repo, oid, commit, signal, !multi));
          }
        } catch (failure) { if (signal.aborted) throw failure; error = errorText(failure); }
        if (this.active('selection', request)) publish({ loading: true, total: selected.length, processed: ++processed });
        return { row, commit, files, parentGroups, error };
      });
      if (!this.active('selection', request)) return;
      const focus = items.find(item => item.row.oid === state.focus);
      const detail = multi || focus.row.worktree ? undefined : { oid: focus.row.oid,
          ...(focus.commit || { message: focus.row.subject, author: focus.row.author, parents: focus.row.parents }),
          date: focus.row.date, shallowBoundary: focus.row.shallowBoundary };
      const label = oid => oid.startsWith('worktree:') ? t('history.workingTree') : shortOid(oid);
      const failures = items.filter(item => item.error).map(item => `${label(item.row.oid)} · ${item.error}`);
      const merged = multi ? await combineChanges(items.filter(item => item.files),
        oid => repo.reads.firstParentHistory(oid, { signal }), signal) : focus.files || [];
      if (!this.active('selection', request)) return;
      const parents = !multi && focus.parentGroups?.length
        ? await mapWithLimit(focus.parentGroups, 4, signal, async group => ({ ...group, subject: await this.parentSubject(repo, group.oid, signal) }))
        : [];
      if (!this.active('selection', request)) return;
      const caption = file => `${file.baseOid ? label(file.baseOid) : t('history.emptyTree')} → ${label(file.afterOid)}`;
      const files = merged.map(file => this.toClient({ ...file, partial: failures.length > 0 }, this.selectionFiles, caption(file)));
      const parentGroups = parents.map(({ oid, subject, files }) => ({ oid, subject, files: files.map(file => {
        const change = { ...file, baseOid: oid, afterOid: focus.row.oid, parentGroup: oid };
        return this.toClient(change, this.selectionFiles, caption(change));
      }) }));
      publish({ detail, failures, files, parentGroups, total: selected.length });
    } catch (error) {
      if (this.active('selection', request)) publish({ failures: [errorText(error)] });
    } finally {
      if (this.active('selection', request)) this.requests.delete('selection');
    }
  }

  async loadComparison() {
    const { repo, comparison } = this;
    if (!this.canRead || !comparison || this.requests.has('comparison')) return;
    this.snapshotFiles.clear();
    this.fileSelection.snapshot.clear();
    const request = this.start('comparison');
    const publish = packet => { this.comparePacket = packet; this.send('comparison', packet); };
    publish({ loading: true });
    const { left, right } = comparison;
    const opts = { signal: request.signal };
    const side = left.worktree ? 'left' : right.worktree ? 'right' : undefined;
    const other = side === 'left' ? right : left;
    const local = side ? this.worktreeChanges(repo, comparison[side].oid, comparison) : Promise.resolve([]);
    const fileDiff = !side ? repo.reads.branchFiles(left.oid, right.oid, opts)
      : left.oid === right.oid ? local : repo.reads.worktreeFiles(other.oid, opts);
    const [diff, counts, ancestor, changes] = await Promise.allSettled([
      fileDiff, repo.reads.divergence(left.oid, right.oid, opts), repo.reads.commonAncestor(left.oid, right.oid, opts), local
    ]);
    if (!this.active('comparison', request)) return;
    const label = endpoint => endpoint.worktree ? endpoint.name : shortOid(endpoint.oid);
    const caption = `${label(left)} → ${label(right)}`;
    const counted = counts.status === 'fulfilled' ? { ...counts.value } : undefined;
    if (counted && side && changes.status === 'fulfilled' && changes.value.length) counted[side]++;
    publish({
      files: diff.status === 'fulfilled' ? diff.value.map(file => this.toClient(left.worktree ? reverseWorktreeChange(file) : file, this.snapshotFiles, caption)) : undefined,
      error: diff.status === 'rejected' ? errorText(diff.reason) : undefined,
      graphError: [counts, ancestor, changes].map(result => result.status === 'rejected' ? errorText(result.reason) : undefined).find(Boolean),
      counts: counted,
      same: left.oid === right.oid && diff.status === 'fulfilled' && !diff.value.length,
      common: ancestor.status === 'fulfilled' ? ancestor.value : undefined
    });
    this.requests.delete('comparison');
  }

  async openDiff(token) {
    if (!this.canRead || typeof token !== 'string' || !/^\d+$/.test(token)) return;
    const tokens = this.selectionFiles.has(token) ? this.selectionFiles : this.snapshotFiles;
    const change = tokens.get(token);
    const repo = this.repo;
    if (!change || change.ambiguous || !repo) return;
    const request = this.start('diff');
    const current = () => this.active('diff', request) && tokens.get(token) === change && this.registry.active === repo;
    try { await this.documents.open(repo, change, request.signal, current); }
    catch (error) { if (current()) throw error; }
    finally { if (this.active('diff', request)) this.requests.delete('diff'); }
  }

  actionContext(context, area, followSelection = true) {
    const { repo, generation, selectionRevision: revision } = this;
    const head = repo?.snapshot?.head;
    const check = () => {
      const webview = context?.webview ?? context?.webviewId;
      if (!this.canRead || this.registry.active !== repo || !vscode.workspace.isTrusted || webview !== 'git-branch.log' ||
        context.gbArea !== area || context.gbGeneration !== generation || this.generation !== generation || context.gbRepo !== repo.id ||
        context.gbRevision !== revision || (followSelection && this.selectionRevision !== revision) || (head?.ref || '') !== context.gbHeadRef ||
        (head?.oid || '') !== context.gbHeadOid || !sameHead(repo.snapshot.head, head)) {
        throw new BranchError(t('history.staleAction'));
      }
    };
    check();
    return { repo, head, check };
  }

  commitRows(oid) {
    if (!this.known.has(oid)) return [];
    if (!this.selection.selected.has(oid)) return [this.known.get(oid)];
    return this.rows.filter(row => this.selection.selected.has(row.oid));
  }

  async commitCommand(kind, context) {
    if (context?.gbArea !== 'commit') return;
    const { repo, head, check } = this.actionContext(context, 'commit');
    const rows = this.commitRows(context.gbOid);
    if (!rows.length || (rows.length > 1 && !['copyRevision', 'cherryPick', 'revert'].includes(kind))) throw new BranchError(t('history.staleAction'));
    if (rows.some(row => row.worktree)) throw new BranchError(t('history.worktreeNotACommit'));
    if (rows.length > MAX_SELECTION && kind !== 'copyRevision') throw new BranchError(t('history.selectionLimit', { count: MAX_SELECTION }));
    return this.ui.historyCommit(kind, repo, head, rows, check);
  }

  async worktreeCommand(kind, context) {
    if (context?.gbArea !== 'worktree') return;
    const { repo, head, check } = this.actionContext(context, 'worktree', false);
    const row = this.known.get(context.gbOid);
    const { comparison } = this;
    const endpoint = comparison?.[row?.side];
    if (!row?.worktree || !head?.ref || row.baseOid !== head.oid || (comparison && !endpoint?.worktree)) {
      throw new BranchError(t('history.staleAction'));
    }
    if (this.localAction) return;
    const pending = this.localAction = Symbol();
    try {
      const result = await this.ui.localChanges(kind, repo, head, check);
      if (result && comparison && this.repo === repo && this.comparison === comparison && repo.snapshot?.head.oid) {
        // Refresh the changed worktree without silently moving the other, pinned endpoint.
        this.comparison = { ...comparison, [row.side]: { ...endpoint, oid: repo.snapshot.head.oid } };
        this.reset(true);
      }
    } finally {
      if (this.localAction === pending) this.localAction = undefined;
    }
  }

  fileTokens(source) {
    return source === 'commit' ? this.selectionFiles : source === 'snapshot' ? this.snapshotFiles : undefined;
  }

  async fileCommand(kind, context) {
    if (context?.gbArea !== 'file') return;
    const { repo, head, check } = this.actionContext(context, 'file');
    const { gbSource: source, gbToken: token } = context;
    const tokens = this.fileTokens(source);
    const change = tokens?.get(token);
    if (!change || change.ambiguous) throw new BranchError(t('history.staleAction'));
    if (kind === 'showDiff') return this.openDiff(token);
    const apply = kind === 'applyFiles';
    const selection = () => this.fileSelection[source].has(token) ? [...this.fileSelection[source]] : [token];
    const selected = this.fileSelection[source];
    if (apply && selected.has(token) && selected.size > MAX_PATCH_FILES) {
      throw new BranchError(t('git.historyPatchFileLimit', { count: MAX_PATCH_FILES }));
    }
    const ids = apply ? selection() : [token];
    if (apply && ids.join(',') !== context.gbFiles) throw new BranchError(t('history.staleAction'));
    const chosen = ids.map(id => tokens.get(id));
    if (chosen.some(file => !file)) throw new BranchError(t('history.staleAction'));
    const guard = () => {
      check();
      if (this.fileTokens(source) !== tokens || tokens.get(token) !== change || (apply &&
        (selection().join(',') !== context.gbFiles || ids.some((id, i) => tokens.get(id) !== chosen[i])))) throw new BranchError(t('history.staleAction'));
    };
    if (kind === 'editSource') return this.documents.openSource(repo, change, guard);
    if (kind === 'openRepositoryVersion') return this.documents.openVersion(repo, change, guard);
    if (apply) {
      if (chosen.some(file => file.parentGroup !== change.parentGroup)) throw new BranchError(t('history.mixedParentChanges'));
      return this.ui.applyHistoryFiles(repo, head, chosen, guard);
    }
  }

  async probeCommitMenu(oid) {
    const rows = this.commitRows(oid), { repo, selectionRevision: revision } = this;
    const head = repo?.snapshot?.head;
    if (!this.canRead || !rows.length || rows.length > MAX_SELECTION || rows.some(row => row.worktree) || !repo.actions?.history) return;
    const request = this.start('commitMenu');
    try {
      const actions = await repo.actions.history.eligibility(rows, head, request.signal);
      if (this.active('commitMenu', request) && sameHead(repo.snapshot.head, head)) {
        this.send('commitMenu', { oid, revision, head, actions });
      }
    } catch { /* Menu probes are advisory; execution performs its own checks. */ }
    finally { if (this.active('commitMenu', request)) this.requests.delete('commitMenu'); }
  }

  async probeFileMenu(source, token) {
    const tokens = this.fileTokens(source), file = tokens?.get(token), repo = this.repo;
    const side = editableFileSide(file || {});
    if (!this.canRead || !regularMode(side?.mode)) return;
    const request = this.start('fileMenu');
    let editSource = false;
    try { editSource = Boolean((await safeWorktreeFile(repo.root.fsPath, side.pathKey, { allowMissing: true })).stat); }
    catch { /* Missing, special or outside the current working tree. */ }
    if (this.active('fileMenu', request)) {
      if (tokens.get(token) === file) this.send('fileMenu', { token, editSource });
      this.requests.delete('fileMenu');
    }
  }

  askCommitMessage(repo, head, oid, value, mode = 'edit') {
    this.finishEdit();
    const text = mode === 'commit' ? { title: t('history.worktreeCommitButton'), submit: t('history.worktreeCommitButton'),
      warning: t('history.worktreeCommitPolicy') } : mode === 'amend' ? { title: t('history.worktreeAmendButton'),
      submit: t('history.worktreeAmendButton'), warning: t('history.worktreeAmendPolicy') } :
      { title: t('history.editTitle'), submit: t('history.rewriteCommit'), warning: t('history.editWarning') };
    const packet = { id: randomBytes(16).toString('hex'), value, ...text, label: t('history.editContext', {
      repo: repo.name, branch: head.ref.slice(HEADS.length), oid: shortOid(oid)
    }) };
    return new Promise(resolve => {
      this.editPrompt = { packet, resolve };
      this.send('editPrompt', packet);
    });
  }

  async onMessage(message) {
    if (!message || typeof message !== 'object' || !this.view) return;
    if (message.type === 'ready') {
      this.ready = true;
      this.fileSelection.commit.clear();
      this.fileSelection.snapshot.clear();
      if (this.visible) this.resume();
      return;
    }
    if (!this.visible || message.generation !== this.generation || message.repoId !== this.repo?.id) return;
    switch (message.type) {
      case 'chooseRepository': return this.ui.chooseRepository();
      case 'chooseRange': return this.comparison || this.endpointPick ? this.pickComparisonEndpoint('left') : this.ui.chooseRange();
      case 'chooseTarget':
        if (this.comparison) return this.pickComparisonEndpoint('right');
        return;
      case 'startComparison':
        if (!this.comparison) return this.pickComparisonEndpoint('right');
        return;
      case 'chooseColumns': return this.chooseColumns();
      case 'refresh': {
        if (this.endpointPick) return;
        const { repo, comparison } = this;
        await this.registry.refresh();
        // In a comparison, Refresh also re-pins the endpoints, replacing "Compare Again".
        if (repo !== this.repo || comparison !== this.comparison || this.endpointPick) return;
        if (comparison) return this.recompare();
        if (message.generation === this.generation) this.reset(true);
        return;
      }
      case 'setFilter':
        if (typeof message.text === 'string') return this.setFilter(message.text);
        return;
      case 'toggleComparisonGroup': return this.toggleComparisonGroup(message.side);
      case 'loadMore': return this.loadPage();
      case 'selectAllCommits':
        if (this.selection.selectAll(this.displayRows(), message.focusedOid)) return this.loadSelection();
        return;
      case 'clearCommits':
        if (this.selection.selected.size) {
          this.selection.clear();
          return this.loadSelection();
        }
        return;
      case 'select': {
        const { oid, mode } = message;
        const row = this.known.get(oid);
        if (!row || (this.comparison && this.collapsedGroups.has(row.side)) || !['replace', 'toggle', 'range', 'extend'].includes(mode)) return;
        if (!this.selection.select(oid, mode, this.displayRows())) {
          void vscode.window.showWarningMessage(t('history.selectionLimit', { count: MAX_SELECTION }));
          return;
        }
        return this.loadSelection();
      }
      case 'retrySelection': return this.loadSelection();
      case 'retryComparison': return this.loadComparison();
      case 'filesLayout': {
        if (!['tree', 'list'].includes(message.layout)) return;
        this.filesLayout = message.layout;
        return this.context.workspaceState?.update(FILE_LAYOUT, message.layout);
      }
      case 'selectFiles': {
        const { source, ids } = message;
        const tokens = this.fileTokens(source);
        if (!tokens || !Array.isArray(ids) || ids.length > tokens.size || !ids.every(id => tokens.has(id))) return;
        this.fileSelection[source] = new Set(ids);
        return;
      }
      case 'probeCommitMenu': return this.probeCommitMenu(message.oid);
      case 'probeFileMenu': return this.probeFileMenu(message.source, message.token);
      case 'finishEdit': {
        if (!this.editPrompt || message.id !== this.editPrompt.packet.id) return;
        this.finishEdit(typeof message.value === 'string' ? message.value : undefined);
        return;
      }
      case 'openDiff': return this.openDiff(message.token);
      case 'swap':
        if (!this.comparison || this.endpointPick) return;
        this.comparison = { left: this.comparison.right, right: this.comparison.left };
        this.collapsedGroups = new Set([...this.collapsedGroups].map(side => side === 'left' ? 'right' : 'left'));
        this.reset(true);
        return;
      case 'exitComparison': return this.exitComparison();
      default: return undefined;
    }
  }

  html(webview, media) {
    const asset = name => webview.asWebviewUri(vscode.Uri.joinPath(media, name));
    const nonce = randomBytes(18).toString('base64');
    const messages = escapeHtml(JSON.stringify(historyMessages()));
    const font = installedCodiconFont(vscode.env.appRoot);
    return `<!doctype html>
<html lang="${locale()}" data-messages="${messages}"${font ? ` data-codicon-font="${font}"` : ''}>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; img-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${asset('graph.css')}">
<title>${htmlText('view.history')}</title>
</head>
<body>
<header id="toolbar" class="toolbar" aria-label="${htmlText('history.toolbar')}">
  <button id="repo" class="control repo" type="button" title="${htmlText('repo.pick')}">${htmlText('repo.pick')} ▾</button>
  <button id="range" class="control range" type="button" title="${htmlText('history.pickRange')}">${escapeHtml(this.target?.label || 'HEAD')} ▾</button>
  <button id="target" class="control range" type="button" title="${htmlText('history.selectTarget')}" hidden>${htmlText('history.selectTarget')} ▾</button>
  <div class="filters" role="search">
    <input id="filter-text" class="control filter-text" type="search" spellcheck="false" autocomplete="off"
      placeholder="${htmlText('history.filterPlaceholder')}" aria-label="${htmlText('history.filterText')}" title="${htmlText('history.filterTextHint')}">
  </div>
  <button id="refresh" class="control icon" type="button" aria-label="${htmlText('command.refresh')}" title="${htmlText('command.refresh')}"><span class="codicon codicon-refresh" aria-hidden="true"></span><span class="refresh-label">${htmlText('command.refresh')}</span></button>
  <button id="start-compare" class="control icon" type="button" aria-label="${htmlText('history.startCompare')}" title="${htmlText('history.startCompare')}"><span class="codicon codicon-git-compare" aria-hidden="true"></span><span class="icon-label">${htmlText('history.startCompare')}</span></button>
  <div id="compare-bar" class="compare-bar" hidden>
    <button id="swap" class="control icon" type="button" aria-label="${htmlText('history.swap')}" title="${htmlText('history.swap')}"><span class="codicon codicon-arrow-swap" aria-hidden="true"></span><span class="icon-label swap-label">${htmlText('history.swap')}</span></button>
    <button id="exit-compare" class="control icon" type="button" aria-label="${htmlText('history.exitCompare')}" title="${htmlText('history.exitCompare')}"><span class="codicon codicon-close" aria-hidden="true"></span><span class="icon-label exit-label">${htmlText('history.exitCompare')}</span></button>
  </div>
  <button id="commit-columns" class="control icon" type="button" aria-label="${htmlText('history.chooseColumns')}" title="${htmlText('history.chooseColumns')}"><span class="codicon codicon-ellipsis" aria-hidden="true"></span><span class="columns-label">${htmlText('history.columns')}</span></button>
</header>
<div id="notices" class="notices" role="status" hidden></div>
<nav class="compact-nav" aria-label="${htmlText('history.navigation')}">
  <button data-pane="log" aria-pressed="true" type="button">${htmlText('history.graph')}</button>
  <button data-pane="files" aria-pressed="false" type="button">${htmlText('history.files')}</button>
  <button data-pane="details" aria-pressed="false" type="button">${htmlText('history.details')}</button>
</nav>
<main id="panes" class="panes" data-pane="log">
  <section class="log-pane" aria-label="${htmlText('history.graph')}">
    <div id="commits-scroll" class="scroll log-scroll" tabindex="-1" aria-description="${htmlText('history.selectionHint')}">
      <div id="top-spacer"></div><div id="commits" role="listbox" aria-label="${htmlText('history.commitList')}" aria-multiselectable="true"></div><div id="bottom-spacer"></div>
      <div id="log-status" class="log-status" role="status"></div>
    </div>
  </section>
  <div id="splitter" class="splitter" aria-hidden="true"></div>
  <section class="right-pane" aria-label="${htmlText('history.filesAndDetails')}">
    <div id="file-pane" class="file-pane">
      <div class="pane-header file-header">
        <div id="file-tabs" class="file-tabs" role="tablist" aria-label="${htmlText('history.changedFiles')}">
          <button id="commit-tab" class="file-tab" type="button" role="tab" aria-controls="files" aria-selected="true">${htmlText('history.commitFiles')}</button>
          <button id="snapshot-tab" class="file-tab" type="button" role="tab" aria-controls="files" aria-selected="false" tabindex="-1" hidden>${htmlText('history.fileDiff')}</button>
        </div>
        <span id="file-count" class="pill"></span>
        <button id="file-layout" class="control icon file-layout" type="button" aria-label="${htmlText('history.viewTree')}" title="${htmlText('history.viewTree')}"><span class="codicon codicon-list-tree" aria-hidden="true"></span><span class="icon-label layout-label">${htmlText('history.viewTree')}</span></button>
      </div>
      <div id="files" class="scroll files" role="tabpanel" tabindex="-1" data-patch-limit="${MAX_PATCH_FILES}" aria-labelledby="commit-tab"></div>
      <footer id="snapshot-caption" class="snapshot-caption mono" hidden></footer>
    </div>
    <section id="details" class="details" aria-labelledby="detail-title">
      <h2 class="detail-heading"><button id="detail-title" class="detail-toggle" type="button" aria-expanded="true" aria-controls="detail-content"><span class="codicon codicon-chevron-down" aria-hidden="true"></span>${htmlText('history.commitDetails')}</button></h2>
      <div id="detail-content" class="detail-content scroll" tabindex="0"></div>
    </section>
  </section>
</main>
<dialog id="edit-dialog" class="edit-dialog" aria-labelledby="edit-title">
  <form id="edit-form">
    <h2 id="edit-title">${htmlText('history.editTitle')}</h2>
    <p id="edit-context" class="muted"></p>
    <p id="edit-warning" class="edit-warning">${htmlText('history.editWarning')}</p>
    <label for="edit-message">${htmlText('history.editMessage')}</label>
    <textarea id="edit-message" rows="6" maxlength="131072" required></textarea>
    <div class="edit-actions">
      <button id="cancel-edit" class="control" type="button">${htmlText('history.cancel')}</button>
      <button id="submit-edit" class="control primary" type="submit">${htmlText('history.rewriteCommit')}</button>
    </div>
  </form>
</dialog>
<script nonce="${nonce}" src="${asset('translate.js')}"></script>
<script nonce="${nonce}" src="${asset('commitTime.js')}"></script>
<script nonce="${nonce}" src="${asset('historyRows.js')}"></script>
<script nonce="${nonce}" src="${asset('graph.js')}"></script>
</body>
</html>`;
  }
}

module.exports = { GraphController };
