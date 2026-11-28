'use strict';

const { randomBytes } = require('node:crypto');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const { historyMessages, locale, t } = require('../i18n');
const { GraphLayout } = require('../graph/layout');
const { MAX_SELECTION, HistorySelection, historyTarget, combineChanges, mapWithLimit } = require('./historyState');
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
    this.compareSide = 'both';
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
      if (kind !== except) this.cancel(kind);
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
    this.hasMore = true;
    this.scanned = 0;
    this.pageError = undefined;
    this.selectionFiles = new Map();
    this.fileSelection.commit.clear();
    this.selectionPacket = undefined;
    if (!keepSnapshot) {
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
      this.repo = next;
      this.unavailable = !next?.snapshot || Boolean(next.error);
      this.comparison = undefined;
      this.compareSide = 'both';
      this.range = 'HEAD';
      this.filter = '';
      this.target = next?.snapshot ? historyTarget(next.snapshot, this.range, this.registry.showTags) : undefined;
      this.reset();
      return;
    }
    if (!next?.snapshot || next.error) {
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
    else this.send('meta', this.meta());
  }

  setRange(repo, range) {
    if (this.repo !== repo || !repo.snapshot) throw new BranchError(t('repo.switchedOrLoading'));
    const target = historyTarget(repo.snapshot, range, this.registry.showTags);
    if (this.comparison || target.range !== this.range) {
      this.target = target;
      this.range = target.range;
      this.comparison = undefined;
      this.compareSide = 'both';
      this.reset();
    }
  }

  setFilter(text) {
    const next = text.trim();
    if (next === this.filter) return;
    this.filter = next;
    this.reset(false, Boolean(this.comparison));
  }

  toggleCompareSide(side) {
    if (!this.comparison || (side !== 'left' && side !== 'right')) return;
    this.compareSide = this.compareSide === side ? 'both' : side;
    this.reset(Boolean(this.rows.length || this.restore), true);
  }

  async chooseColumns() {
    const items = Object.entries(COLUMN_LABELS).map(([key, label]) => ({ key, label: t(label), picked: this.commitColumns.includes(key) }));
    const chosen = await vscode.window.showQuickPick(items, { canPickMany: true, title: t('history.chooseColumns') });
    if (!chosen) return;
    this.commitColumns = items.filter(item => chosen.includes(item)).map(item => item.key);
    this.send('commitColumns', this.commitColumns);
    await this.context.workspaceState?.update(COMMIT_COLUMNS, this.commitColumns);
  }

  compare(repo, left, right) {
    if (this.repo !== repo) throw new BranchError(t('repo.switched'));
    this.comparison = { left, right };
    this.compareSide = 'both';
    this.reset();
  }

  compareWorktree(repo, left) {
    if (this.repo !== repo) throw new BranchError(t('repo.switched'));
    const head = repo.snapshot?.head;
    if (!head?.oid) throw new BranchError(t('branch.firstCommit'));
    // The working tree comparison is a branch comparison whose target tip is
    // HEAD plus one synthetic commit holding every uncommitted change.
    this.comparison = { left, right: { ref: head.ref, name: t('history.workingTree'), oid: head.oid }, workingTree: true };
    this.compareSide = 'both';
    this.reset();
  }

  async recompare() {
    const { repo, comparison } = this;
    if (!repo || !comparison) return;
    const right = comparison.right?.ref ? repo.actions.named(comparison.right.ref)
      : comparison.workingTree ? { ...comparison.right, oid: repo.snapshot.head.oid } : comparison.right;
    const [left, resolved] = await Promise.all([comparison.left.ref ? repo.actions.named(comparison.left.ref) : comparison.left, right]);
    if (repo !== this.repo || comparison !== this.comparison) return;
    this.comparison = comparison.workingTree ? { left, right: { ...comparison.right, ...resolved, name: t('history.workingTree') }, workingTree: true }
      : { left, right: resolved };
    this.reset();
  }

  exitComparison() {
    if (!this.comparison) return;
    this.comparison = undefined;
    this.compareSide = 'both';
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
      message: !repo ? this.registry.noRepositoryMessage : repo.error ? t('repo.readError', { detail: repo.error }) : !snapshot ? t('repo.reading') : undefined,
      compare: comparison ? {
        left: { label: comparison.left.name, oid: comparison.left.oid },
        right: { label: comparison.workingTree ? t('history.workingTree') : comparison.right.name, oid: comparison.right.oid },
        workingTree: Boolean(comparison.workingTree),
        stale: Boolean(snapshot && [comparison.left, comparison.right].some(ref => ref?.ref && snapshot.byRef.get(ref.ref)?.oid !== ref.oid))
      } : undefined,
      badges: [...refs]
    };
  }

  pageState() {
    return { hasMore: this.hasMore, loading: this.requests.has('page'), error: this.pageError, columns: this.layout.columns,
      filter: this.filter, compareSide: this.compareSide };
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
    if (!this.rows.length && this.hasMore && !this.pageError) void this.loadPage();
    if (this.comparison && (!this.comparePacket || this.comparePacket.loading)) void this.loadComparison();
    if (this.rows.length && (!this.selectionPacket || this.selectionPacket.loading)) void this.loadSelection();
  }

  async worktreeChanges(repo, signal) {
    // Deliberately uncached: the working tree can change without moving HEAD,
    // so a refresh must re-read it instead of reusing a stale file list.
    return repo.reads.worktreeFiles(repo.snapshot.head.oid, { signal });
  }

  async loadPage() {
    if (!this.canRead || !this.hasMore || this.requests.has('page')) return;
    const request = this.start('page');
    const { repo, comparison, target } = this;
    const first = this.rows.length === 0;
    this.pageError = undefined;
    this.send('page', this.pageState());
    try {
      const tips = comparison ? undefined : target?.tips;
      const { commits, hasMore, scanned } = await repo.reads.historyPage({ tips, compare: comparison,
        skip: this.rows.filter(row => !row.worktree).length, scan: this.scanned, limit: 120, filter: this.filter,
        compareSide: this.compareSide, signal: request.signal });
      if (!this.active('page', request)) return;
      const rows = commits.map(commit => ({ ...commit, shallowBoundary: repo.snapshot.shallowRoots?.has(commit.oid), graph: this.layout.append(commit) }));
      if (first && comparison?.workingTree && this.compareSide !== 'left') {
        const changes = await this.worktreeChanges(repo, request.signal);
        if (!this.active('page', request)) return;
        const subject = t('history.workingTreeCommit');
        const text = this.filter.trim().toLowerCase();
        if (changes.length && (!text || subject.toLowerCase().includes(text))) {
          rows.unshift(this.worktreeRow(repo, subject));
        }
      }
      this.rows.push(...rows);
      for (const row of rows) this.known.set(row.oid, row);
      this.hasMore = hasMore;
      this.scanned = scanned ?? this.rows.length;
      if (!hasMore && this.layout.byOid.size) {
        // Parents excluded from the completed range don't reserve a lane indefinitely.
        this.relayout();
        this.sendReset();
      } else this.send('append', rows);
      if (first) {
        this.selection.restore(this.restore, rows);
        this.restore = undefined;
        void this.loadSelection();
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

  worktreeRow(repo, subject) {
    const head = repo.snapshot.head;
    // No parents and no graph geometry: the synthetic row is not part of the commit DAG.
    return { oid: `worktree:${head.oid}`, worktree: true, parents: [], author: '', date: '', side: 'right',
      subject, shallowBoundary: false, graph: null };
  }

  /** Rebuilds lane geometry after the final page; synthetic rows carry no lanes. */
  relayout() {
    this.layout = new GraphLayout();
    for (const row of this.rows) if (!row.worktree) row.graph = this.layout.append(row, this.known);
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
            files = await this.worktreeChanges(repo, signal);
            files = files.map(file => ({ ...file, baseOid: repo.snapshot.head.oid, afterOid: oid }));
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
      const detail = multi ? undefined : focus.row.worktree
        ? { oid: focus.row.oid, message: t('history.workingTreeCommit'), author: '', parents: [repo.snapshot.head.oid], worktree: true }
        : { oid: focus.row.oid,
          ...(focus.commit || { message: focus.row.subject, author: focus.row.author, parents: focus.row.parents }),
          date: focus.row.date, shallowBoundary: focus.row.shallowBoundary };
      const failures = items.filter(item => item.error).map(item => `${shortOid(item.row.oid)} · ${item.error}`);
      const merged = multi ? await combineChanges(items.filter(item => item.files),
        oid => repo.reads.firstParentHistory(oid, { signal }), signal) : focus.files || [];
      if (!this.active('selection', request)) return;
      const parents = !multi && focus.parentGroups?.length
        ? await mapWithLimit(focus.parentGroups, 4, signal, async group => ({ ...group, subject: await this.parentSubject(repo, group.oid, signal) }))
        : [];
      if (!this.active('selection', request)) return;
      const caption = file => `${file.baseOid ? shortOid(file.baseOid) : t('history.emptyTree')} → ${shortOid(file.afterOid)}`;
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
    const [diff, counts, ancestor, changes] = await Promise.allSettled([
      // The File Diff pane always compares the base snapshot with the visible target:
      // the right tip, or the saved working tree for the synthetic Working Tree branch.
      comparison.workingTree ? repo.reads.worktreeFiles(left.oid, opts) : repo.reads.branchFiles(left.oid, right.oid, opts),
      repo.reads.divergence(left.oid, right.oid, opts), repo.reads.commonAncestor(left.oid, right.oid, opts),
      comparison.workingTree ? this.worktreeChanges(repo, request.signal) : Promise.resolve([])
    ]);
    if (!this.active('comparison', request)) return;
    const caption = comparison.workingTree ? `${shortOid(left.oid)} → ${t('history.workingTree')}`
      : `${shortOid(left.oid)} → ${shortOid(right.oid)}`;
    const worktreeCommit = comparison.workingTree && changes.status === 'fulfilled' && changes.value.length > 0;
    const counted = counts.status === 'fulfilled' ? counts.value : undefined;
    if (counted && worktreeCommit) counted.right += 1;
    publish({
      files: diff.status === 'fulfilled' ? diff.value.map(file => this.toClient(file, this.snapshotFiles, caption)) : undefined,
      error: diff.status === 'rejected' ? errorText(diff.reason) : undefined,
      graphError: counts.status === 'rejected' ? errorText(counts.reason) : ancestor.status === 'rejected' ? errorText(ancestor.reason) : undefined,
      counts: counted,
      same: !worktreeCommit && left.oid === right.oid,
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

  actionContext(context, area) {
    const { repo, generation, selectionRevision: revision } = this;
    const head = repo?.snapshot?.head;
    const check = () => {
      if (!this.canRead || this.registry.active !== repo || !vscode.workspace.isTrusted || context?.webview !== 'git-branch.log' ||
        context.gbArea !== area || context.gbGeneration !== generation || this.generation !== generation || context.gbRepo !== repo.id ||
        context.gbRevision !== revision || this.selectionRevision !== revision || (head?.ref || '') !== context.gbHeadRef ||
        (head?.oid || '') !== context.gbHeadOid || repo.snapshot.head.ref !== head?.ref || repo.snapshot.head.oid !== head?.oid) {
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
    if (rows.some(row => row.worktree) && (rows.length > 1 || kind !== 'copyRevision')) throw new BranchError(t('history.worktreeNotACommit'));
    if (rows.length > MAX_SELECTION && kind !== 'copyRevision') throw new BranchError(t('history.selectionLimit', { count: MAX_SELECTION }));
    return this.ui.historyCommit(kind, repo, head, rows, check);
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
    const apply = kind === 'applyFiles';
    if (kind === 'selectFile') {
      this.fileSelection[source] = new Set([token]);
      return this.send('fileSelection', { source, ids: [token] });
    }
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
      if (this.active('commitMenu', request) && repo.snapshot.head.ref === head?.ref && repo.snapshot.head.oid === head?.oid) {
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

  askCommitMessage(repo, head, oid, value) {
    this.finishEdit();
    const packet = { id: randomBytes(16).toString('hex'), value, label: t('history.editContext', {
      repo: repo.name, branch: head.ref.slice('refs/heads/'.length), oid: shortOid(oid)
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
      case 'chooseRange': return this.ui.chooseRange();
      case 'chooseColumns': return this.chooseColumns();
      case 'refresh': {
        await this.registry.refresh();
        // In a comparison, Refresh also re-pins the endpoints, replacing "Compare Again".
        if (this.comparison) return this.recompare();
        if (message.generation === this.generation) this.reset(true);
        return;
      }
      case 'setFilter':
        if (typeof message.text === 'string') return this.setFilter(message.text);
        return;
      case 'toggleCompareSide': return this.toggleCompareSide(message.side);
      case 'loadMore': return this.loadPage();
      case 'selectAllCommits':
        if (this.selection.selectAll(this.rows, message.focusedOid)) return this.loadSelection();
        return;
      case 'clearCommits':
        if (this.selection.selected.size) {
          this.selection.clear();
          return this.loadSelection();
        }
        return;
      case 'select': {
        const { oid, mode } = message;
        if (!this.known.has(oid) || !['replace', 'toggle', 'range', 'extend'].includes(mode)) return;
        if (!this.selection.select(oid, mode, this.rows)) {
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
        if (!this.comparison || this.comparison.workingTree) return;
        this.comparison = { left: this.comparison.right, right: this.comparison.left };
        this.reset(true);
        return;
      case 'recompare': return this.recompare();
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
  <div class="filters" role="search">
    <input id="filter-text" class="control filter-text" type="search" spellcheck="false" autocomplete="off"
      placeholder="${htmlText('history.filterText')}" aria-label="${htmlText('history.filterText')}" title="${htmlText('history.filterTextHint')}">
  </div>
  <button id="refresh" class="control icon" type="button" aria-label="${htmlText('command.refresh')}" title="${htmlText('command.refresh')}"><span class="codicon codicon-refresh" aria-hidden="true"></span><span class="refresh-label">${htmlText('command.refresh')}</span></button>
  <div id="compare-bar" class="compare-bar" hidden>
    <span id="direction" class="direction"></span>
    <button id="compare-refresh" class="control icon" type="button" aria-label="${htmlText('history.refresh')}" title="${htmlText('history.refresh')}"><span class="codicon codicon-refresh" aria-hidden="true"></span><span class="icon-label refresh-label">${htmlText('history.refresh')}</span></button>
    <button id="swap" class="control icon" type="button" aria-label="${htmlText('history.swap')}" title="${htmlText('history.swap')}"><span class="codicon codicon-arrow-swap" aria-hidden="true"></span><span class="icon-label swap-label">${htmlText('history.swap')}</span></button>
    <button id="exit-compare" class="control icon" type="button" aria-label="${htmlText('history.exitCompare')}" title="${htmlText('history.exitCompare')}"><span class="codicon codicon-close" aria-hidden="true"></span><span class="icon-label exit-label">${htmlText('history.exitCompare')}</span></button>
  </div>
</header>
<div id="notices" class="notices" role="status" hidden></div>
<nav class="compact-nav" aria-label="${htmlText('history.navigation')}">
  <button data-pane="log" aria-pressed="true" type="button">${htmlText('history.graph')}</button>
  <button data-pane="files" aria-pressed="false" type="button">${htmlText('history.files')}</button>
  <button data-pane="details" aria-pressed="false" type="button">${htmlText('history.details')}</button>
</nav>
<main id="panes" class="panes" data-pane="log">
  <section class="log-pane" aria-label="${htmlText('history.graph')}">
    <div class="pane-header log-header">
      <span id="log-title" title="${htmlText('history.selectionHint')}">${htmlText('history.graph')}</span>
      <div id="compare-counts" class="compare-counts" role="group" aria-label="${htmlText('history.distinct')}" hidden>
        <button id="compare-left" class="compare-filter left" type="button" aria-pressed="false"><span id="compare-left-label">${htmlText('history.baseOnly')}</span></button>
        <button id="compare-right" class="compare-filter right" type="button" aria-pressed="false"><span id="compare-right-label">${htmlText('history.targetOnly')}</span></button>
      </div>
      <button id="commit-columns" class="control icon column-picker" type="button" aria-label="${htmlText('history.chooseColumns')}" title="${htmlText('history.chooseColumns')}"><span class="codicon codicon-settings-gear" aria-hidden="true"></span><span class="columns-label">${htmlText('history.columns')}</span></button>
    </div>
    <div id="commits-scroll" class="scroll log-scroll" tabindex="-1">
      <div id="top-spacer"></div><div id="commits" role="listbox" aria-label="${htmlText('history.commitList')}" aria-multiselectable="true"></div><div id="bottom-spacer"></div>
      <div id="log-status" class="log-status" role="status"></div>
    </div>
  </section>
  <div id="splitter" class="splitter" aria-hidden="true"></div>
  <section class="right-pane" aria-label="${htmlText('history.filesAndDetails')}">
    <div id="file-pane" class="file-pane">
      <div class="pane-header file-header">
        <div id="file-tabs" class="file-tabs" hidden>
          <button id="commit-tab" type="button" aria-pressed="false">${htmlText('history.commitFiles')}</button>
          <button id="snapshot-tab" type="button" aria-pressed="true">${htmlText('history.fileDiff')}</button>
        </div>
        <span id="file-title">${htmlText('history.commitFiles')}</span><span id="file-count" class="pill"></span>
        <button id="file-tab-toggle" class="control icon file-tab-toggle" type="button" hidden aria-label="${htmlText('history.switchFileTab')}" title="${htmlText('history.switchFileTab')}"><span class="codicon codicon-list-selection" aria-hidden="true"></span><span class="icon-label toggle-label">${htmlText('history.switchFileTab')}</span></button>
        <button id="file-layout" class="control icon file-layout" type="button" aria-label="${htmlText('history.viewTree')}" title="${htmlText('history.viewTree')}"><span class="codicon codicon-list-tree" aria-hidden="true"></span><span class="icon-label layout-label">${htmlText('history.viewTree')}</span></button>
      </div>
      <div id="files" class="scroll files" tabindex="-1" data-patch-limit="${MAX_PATCH_FILES}" aria-label="${htmlText('history.changedFiles')}"></div>
    </div>
    <details id="details" class="details" open>
      <summary>${htmlText('history.commitDetails')}</summary>
      <div id="detail-content" class="detail-content"></div>
    </details>
  </section>
</main>
<dialog id="edit-dialog" class="edit-dialog" aria-labelledby="edit-title">
  <form id="edit-form">
    <h2 id="edit-title">${htmlText('history.editTitle')}</h2>
    <p id="edit-context" class="muted"></p>
    <p class="edit-warning">${htmlText('history.editWarning')}</p>
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
<script nonce="${nonce}" src="${asset('graph.js')}"></script>
</body>
</html>`;
  }
}

module.exports = { GraphController };
