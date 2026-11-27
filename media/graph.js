/* global acquireVsCodeApi */
(() => {
  'use strict';

  const vscode = acquireVsCodeApi();
  const html = document.documentElement;
  const t = globalThis.gitBranchCreateTranslator(JSON.parse(html.dataset.messages));
  const $ = id => document.getElementById(id);
  const scroll = $('commits-scroll');
  const commits = $('commits');
  const files = $('files');
  const panes = $('panes');
  const splitter = $('splitter');
  const tabs = [...document.querySelectorAll('.compact-nav button')];
  const ROW = 28; // Must match --row-height in graph.css.
  const LANE = 12;
  const DRAW_LANES = 14;
  const FILE_BATCH = 200;
  const FILE_SELECTION_LIMIT = 200;
  const commitTime = globalThis.gitBranchCreateCommitTimeFormatter(html.lang);
  const STATUS = {
    A: t('history.statusAdded'), C: t('history.statusCopied'), D: t('history.statusDeleted'), M: t('history.statusModified'),
    R: t('history.statusRenamed'), T: t('history.statusTypeChange'), U: t('history.statusConflict'),
    X: t('history.statusUnknown'), B: t('history.statusRewritten')
  };
  const state = { generation: 0, rows: [], rowsByOid: new Map(), known: new Set(), meta: {}, badges: new Map(), page: {}, selection: {},
    directories: new Map(), commitMenus: new Map(), fileMenus: new Map(), filesLayout: 'list',
    selectedFiles: { commit: new Set(), snapshot: new Set() }, anchors: {}, snapshot: false, limit: FILE_BATCH, pageIntent: false };

  function el(tag, cls, text, title) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    if (title) node.title = title;
    return node;
  }

  function button(cls, label, action, title) {
    const control = el('button', cls, label, title);
    control.type = 'button';
    control.addEventListener('click', action);
    return control;
  }

  const short = oid => oid.slice(0, 8);
  const press = (node, value) => node.setAttribute('aria-pressed', String(Boolean(value)));
  const countText = (key, count) => t(`${key}${count === 1 ? 'One' : 'Other'}`, { count });
  const send = (type, data) => {
    if (state.generation) vscode.postMessage({ type, generation: state.generation, repoId: state.repoId, ...data });
  };
  function sameRemoteTips(left, right) {
    const signature = badges => JSON.stringify([...badges].flatMap(([oid, list]) => list.filter(item => item.kind === 'remote')
      .map(({ name }) => [name, oid])).sort());
    return signature(left) === signature(right);
  }

  function svgNode(tag, attrs) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    return node;
  }

  function graph(row) {
    const { column, color, incoming, through, edges } = row.graph;
    const columns = Math.max(1, Math.min(DRAW_LANES, state.page.columns || 1));
    const width = columns * LANE + 5, mid = ROW / 2;
    const x = lane => 8 + lane * LANE;
    const svg = svgNode('svg', { class: 'graph', width, height: ROW, 'aria-hidden': 'true' });
    const path = (d, laneColor, dashed = false) => svg.append(svgNode('path', { d, class: `edge lane-${laneColor}${dashed ? ' boundary' : ''}` }));
    for (const lane of through) {
      // A pending parent must not produce a line across unrelated rows.
      if (state.known.has(lane.oid)) path(`M${x(lane.column)},0 V${ROW}`, lane.color);
    }
    if (column >= DRAW_LANES) {
      const marker = svgNode('text', { x: width - 8, y: mid + 4, class: 'lane-overflow' });
      marker.textContent = '⋯';
      const hint = svgNode('title', {});
      hint.textContent = t('history.laneOverflow');
      svg.append(hint, marker);
      return svg;
    }
    const start = x(column);
    if (incoming) path(`M${start},0 V${mid}`, color);
    if (row.shallowBoundary) path(`M${start},${mid + 4} v8`, color, true);
    for (const edge of edges) {
      const end = x(edge.column);
      if (!state.known.has(edge.oid) || edge.column >= DRAW_LANES) {
        const stub = start + Math.sign(end - start) * 4;
        path(`M${start},${mid} Q${start},${mid + 6} ${stub},${ROW - 2}`, edge.color, true);
      } else if (end === start) path(`M${start},${mid} V${ROW}`, edge.color);
      else path(`M${start},${mid} C${start},${mid + 7} ${end},${mid + 7} ${end},${ROW}`, edge.color);
    }
    svg.append(svgNode('circle', { cx: start, cy: mid, r: 3.6, class: `dot lane-${color}${row.parents.length > 1 ? ' merge-dot' : ''}` }));
    return svg;
  }

  function baseContext(gbArea) {
    return { gbArea, gbGeneration: state.generation, gbRepo: state.repoId, gbRevision: state.selection.revision,
      gbHeadRef: state.meta.head?.ref || '', gbHeadOid: state.meta.head?.oid || '', preventDefaultContextMenuItems: true };
  }

  let probeTimer, pendingProbe;
  function probe(type, data) {
    const request = { type, data, generation: state.generation, revision: state.selection.revision };
    clearTimeout(probeTimer);
    pendingProbe = request;
    probeTimer = setTimeout(() => {
      if (pendingProbe === request && request.generation === state.generation && request.revision === state.selection.revision) send(type, data);
    }, 45);
  }

  function rowContext(line, getContext, requestProbe) {
    const update = () => { line.dataset.vscodeContext = JSON.stringify(getContext()); };
    update();
    line.addEventListener('contextmenu', update);
    line.addEventListener('pointerenter', requestProbe);
    line.addEventListener('focusin', requestProbe);
  }

  function commitActionContext(row) {
    const active = state.selection.selected?.includes(row.oid);
    const selected = active ? state.selection.selected : [row.oid];
    const single = selected.length === 1;
    const head = state.meta.head;
    const local = Boolean(head?.ref && head.oid);
    const plain = selected.every(oid => {
      const candidate = state.rowsByOid.get(oid);
      return candidate && !candidate.shallowBoundary && candidate.parents.length < 2;
    });
    const current = head?.oid === row.oid;
    const explicitlyRemote = state.badges.get(row.oid)?.some(item => item.kind === 'remote');
    const actions = state.commitMenus.get(active ? 'selected' : row.oid);
    // We know HEAD belongs to the current branch even before the hover probe.
    // Older rows need verified ancestry before enabling a history rewrite.
    const rewrite = Boolean(local && single && plain && !explicitlyRemote && (actions?.rewrite ?? current));
    return { ...baseContext('commit'), gbOid: row.oid, gbCommitSingle: single, gbCanReset: local && single && !current,
      gbCanPick: local && plain && (actions?.cherryPick ?? !selected.includes(head?.oid)),
      gbCanRevert: local && plain && (actions?.revert ?? (single && current)),
      gbCanRewrite: rewrite, gbCanUndo: rewrite && current && row.parents.length === 1, gbCanDrop: rewrite && row.parents.length === 1 };
  }

  function commitRow(row, index, selected) {
    const subject = row.subject || t('history.noSubject');
    const focused = row.oid === state.selection.focus;
    const isSelected = selected.has(row.oid);
    const time = commitTime(row.date);
    const line = el('div', `commit-row${focused ? ' focused' : ''}${isSelected ? ' selected' : ''}`);
    line.dataset.oid = row.oid;
    line.setAttribute('role', 'presentation');
    const summary = button('commit-subject', '', event => {
      const additive = event.ctrlKey || event.metaKey;
      const mode = event.shiftKey ? (additive ? 'extend' : 'range') : additive ? 'toggle' : 'replace';
      send('select', { oid: row.oid, mode });
    });
    summary.setAttribute('role', 'option');
    summary.setAttribute('aria-selected', String(isSelected));
    summary.setAttribute('aria-posinset', index + 1);
    summary.setAttribute('aria-setsize', state.page.hasMore ? -1 : state.rows.length);
    const badges = state.badges.get(row.oid) || [];
    const side = row.side && t(row.side === 'left' ? 'history.baseOnly' : 'history.targetOnly');
    summary.title = [subject, `${row.oid} · ${row.author}`, time.title, side, badges.map(item => item.name).join(' · ')].filter(Boolean).join('\n');
    summary.append(graph(row), el('span', 'subject ellipsis', subject));
    if (badges.length) {
      const strip = el('span', 'badges');
      for (const item of badges.slice(0, 2)) strip.append(el('span', `badge ${item.kind}${item.current ? ' current' : ''}`, item.name));
      if (badges.length > 2) strip.append(el('span', 'pill', `+${badges.length - 2}`));
      summary.append(strip);
    }
    if (side) summary.append(el('span', `side ${row.side}`, side));
    summary.append(el('span', 'author ellipsis', row.author || ''), el('span', 'date mono', time.label),
      el('span', 'hash mono', short(row.oid)));
    line.append(summary);
    rowContext(line, () => commitActionContext(row), () => {
      const key = state.selection.selected?.includes(row.oid) ? 'selected' : row.oid;
      if (!state.commitMenus.has(key)) probe('probeCommitMenu', { oid: row.oid });
    });
    return line;
  }

  let painted = '';
  let frame = 0;
  function renderRows(force = false) {
    if (!scroll.clientHeight) { painted = ''; return; }
    const count = state.meta.message ? 0 : state.rows.length;
    const start = Math.min(count, Math.max(0, Math.floor(scroll.scrollTop / ROW) - 8));
    const end = Math.min(count, Math.ceil((scroll.scrollTop + scroll.clientHeight) / ROW) + 8);
    const key = `${start}:${end}`;
    if (!force && painted === key) return;
    painted = key;
    const focused = document.activeElement?.closest('.commit-row');
    const oid = focused?.dataset.oid;
    const selected = new Set(state.selection.selected);
    const fragment = document.createDocumentFragment();
    let restore;
    for (let i = start; i < end; i++) {
      const line = commitRow(state.rows[i], i, selected);
      if (state.rows[i].oid === oid) restore = line.querySelector('.commit-subject');
      fragment.append(line);
    }
    $('top-spacer').style.height = `${start * ROW}px`;
    $('bottom-spacer').style.height = `${(count - end) * ROW}px`;
    commits.replaceChildren(fragment);
    if (restore) restore.focus({ preventScroll: true });
    else if (focused) scroll.focus({ preventScroll: true });
  }

  function requestPage() {
    if (state.pageIntent || state.page.loading || !state.page.hasMore || state.meta.message) return;
    state.pageIntent = true;
    send('loadMore');
  }

  function onViewport() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      renderRows();
      if (scroll.clientHeight && state.rows.length && !state.page.error &&
          scroll.scrollTop + scroll.clientHeight >= (state.rows.length - 8) * ROW) requestPage();
    });
  }

  let authorKey = '';
  function renderAuthors() {
    const select = $('filter-author');
    const authors = state.page.authors || [];
    const current = state.page.filter?.author || '';
    const key = JSON.stringify([authors, current]);
    if (key === authorKey) return;
    authorKey = key;
    const entries = current && !authors.includes(current) ? [...authors, current] : authors;
    select.replaceChildren(el('option', '', t('history.filterAuthorAll')));
    select.firstChild.value = '';
    for (const name of entries) {
      const option = el('option', '', name);
      option.value = name;
      select.append(option);
    }
    select.value = current;
    select.hidden = entries.length === 0;
  }

  let filterTimer;
  function sendFilter(delay = 0) {
    clearTimeout(filterTimer);
    const text = $('filter-text').value;
    const author = $('filter-author').value;
    const run = () => send('setFilter', { text, author });
    if (delay) filterTimer = setTimeout(run, delay);
    else run();
  }

  function renderHeader() {
    const { meta, comparison } = state;
    const ready = Boolean(meta.repository && !meta.message);
    const mode = meta.compare;
    $('repo').textContent = `${meta.repository || t('repo.pick')} ▾`;
    $('repo').title = meta.repositoryPath || t('repo.pick');
    $('repo').disabled = !meta.repositoryCount;
    $('range').textContent = `${meta.range || t('history.allBranches')} ▾`;
    $('range').title = meta.range || t('history.pickRange');
    $('range').disabled = !ready;
    $('range').hidden = Boolean(mode);
    $('filter-text').disabled = !ready;
    $('filter-author').disabled = !ready;
    renderAuthors();
    $('refresh').disabled = !meta.repository;
    $('compare-bar').hidden = !mode;
    $('log-title').textContent = t(mode && !mode.workingTree ? 'history.distinct' : 'history.graph');
    $('swap').disabled = $('recompare').disabled = !ready;
    $('swap').hidden = Boolean(mode?.workingTree);
    $('snapshot-tab').textContent = t(mode?.workingTree ? 'history.workingTreeFiles' : 'history.snapshotFiles');
    $('file-tabs').hidden = !mode;
    $('file-title').hidden = Boolean(mode);
    const counts = $('compare-counts');
    counts.replaceChildren();
    if (mode) {
      const target = mode.workingTree ? mode.right.label : `${mode.right.label} (${mode.right.oid})`;
      $('direction').title = `${mode.left.label} (${mode.left.oid}) → ${target}`;
      $('direction').replaceChildren(el('span', 'side left ellipsis', t('history.baseLabel', { name: mode.left.label })), el('span', '', '→'),
        el('span', 'side right ellipsis', t('history.targetLabel', { name: mode.right.label })));
      if (comparison?.counts) counts.append(el('span', 'side left', t('history.baseCount', { count: comparison.counts.left })),
        el('span', 'side right', t('history.targetCount', { count: comparison.counts.right })));
    }
    const notices = [meta.shallow && t('history.shallow'), mode?.stale && t('history.stale'),
      mode && comparison?.common === false && t(meta.shallow ? 'history.noLocalAncestor' : 'history.noAncestor'),
      comparison?.graphError && t('history.partialCompare', { detail: comparison.graphError })].filter(Boolean);
    $('notices').hidden = !notices.length;
    $('notices').textContent = notices.join('  ');
  }

  function renderLogStatus() {
    const { page, meta, rows, comparison } = state;
    const status = $('log-status');
    status.replaceChildren();
    if (meta.message) status.textContent = meta.message;
    else if (page.error) status.append(el('span', 'error', page.error), button('link', t('history.retry'), requestPage));
    else if (page.loading || !state.generation) status.textContent = t('history.loadingCommits');
    else if (page.hasMore) status.append(button('link', t('history.loadMoreCommits'), requestPage));
    else if (!rows.length) {
      const filtered = Boolean(page.filter?.text || page.filter?.author);
      if (filtered) status.textContent = t('history.filteredEmpty');
      else status.textContent = meta.compare && !meta.compare.workingTree
        ? t(comparison?.same ? 'history.sameTip' : 'history.noUniqueCommits') : t('history.noCommitsInRange');
    }
    else if (meta.compare && comparison?.common) status.textContent = t('history.sharedExcluded');
    else status.textContent = countText('history.commitCount', rows.length);
  }

  function fileActionContext(file, source) {
    const selected = state.selectedFiles[source];
    const set = selected.has(file.id) ? [...selected] : [file.id];
    return { ...baseContext('file'), gbToken: file.id, gbSource: source, gbFiles: set.join(','),
      gbCanEditSource: state.fileMenus.get(file.id) ?? file.sourceCandidate, gbCanOpenVersion: file.repositoryVersion,
      gbCanApplyFiles: set.every(id => state.renderedFiles.get(id)?.apply) };
  }

  function selectFile(event, file, source) {
    const additive = event.ctrlKey || event.metaKey;
    const selected = state.selectedFiles[source];
    const next = new Set(additive ? selected : []);
    if (event.shiftKey) {
      const visible = [...files.querySelectorAll('.file-row')].filter(row => !row.closest('details:not([open])')).map(row => row.dataset.fileId);
      const end = visible.indexOf(file.id);
      const start = visible.indexOf(state.anchors[source]);
      if (start < 0 || end < 0) next.add(file.id);
      else for (let i = Math.min(start, end); i <= Math.max(start, end); i++) next.add(visible[i]);
    } else {
      if (additive && selected.has(file.id)) next.delete(file.id);
      else next.add(file.id);
    }
    if (next.size > FILE_SELECTION_LIMIT) { send('fileSelectionLimit'); return; }
    if (!event.shiftKey || !state.anchors[source]) state.anchors[source] = file.id;
    state.selectedFiles[source] = next;
    send('selectFiles', { source, ids: [...next] });
    for (const row of files.querySelectorAll('.file-row')) {
      const active = next.has(row.dataset.fileId);
      row.classList.toggle('selected', active);
      press(row, active);
    }
    if (!additive && !event.shiftKey && !file.ambiguous) send('openDiff', { token: file.id });
  }

  function fileRow(file, source, compactName) {
    const path = file.from ? `${file.from} → ${file.path}` : file.path;
    const label = STATUS[file.status] || t('history.statusChange');
    const note = file.ambiguous ? t('history.cannotCombine') : file.includesGap ? t('history.includesUnselected') : '';
    const row = button('file-row', '', event => selectFile(event, file, source), [label, path, note].filter(Boolean).join(' · '));
    row.dataset.fileId = file.id;
    const selected = state.selectedFiles[source].has(file.id);
    row.classList.toggle('selected', selected);
    press(row, selected);
    row.append(el('span', `file-status status-${file.status}`, file.status, label));
    row.append(el('span', 'file-name mono ellipsis', file.from ? path : compactName || file.path));
    if (file.submodule) row.append(el('span', 'submodule', t('history.submodule')));
    if (note) row.append(el('span', 'file-note ellipsis', note));
    if (!file.ambiguous) {
      const arrow = el('span', 'file-arrow', '↗');
      arrow.setAttribute('aria-hidden', 'true');
      row.append(arrow);
    }
    row.setAttribute('aria-label', file.ambiguous ? `${path} · ${note}` : t('history.openDiffLabel', { status: label, path, commit: '' }));
    rowContext(row, () => fileActionContext(file, source), () => {
      if (file.sourceCandidate && !state.fileMenus.has(file.id)) probe('probeFileMenu', { source, token: file.id });
    });
    return row;
  }

  function fileTree(root, list, source) {
    const tree = { dirs: new Map(), files: [] };
    list.forEach(file => {
      const raw = atob(file.pathKey).split('/');
      const names = file.path.split('/');
      let folder = tree;
      for (let i = 0; i < raw.length - 1; i++) {
        if (!folder.dirs.has(raw[i])) folder.dirs.set(raw[i], {
          name: names[i], key: `${source}:${btoa(raw.slice(0, i + 1).join('/'))}`, dirs: new Map(), files: []
        });
        folder = folder.dirs.get(raw[i]);
      }
      folder.files.push({ file, name: names.at(-1) });
    });
    const fill = (container, folder) => {
      for (const dir of folder.dirs.values()) {
        const entry = el('details', 'file-folder');
        const summary = el('summary');
        summary.append(el('span', 'file-name ellipsis', dir.name, dir.name));
        const children = el('div', 'file-children');
        entry.append(summary, children);
        entry.open = state.directories.get(dir.key) ?? true;
        fill(children, dir);
        entry.addEventListener('toggle', () => { if (entry.isConnected) state.directories.set(dir.key, entry.open); });
        container.append(entry);
      }
      for (const { file, name } of folder.files) container.append(fileRow(file, source, name));
    };
    fill(root, tree);
  }

  function renderFiles() {
    const { selection, comparison, meta } = state;
    const snapshot = Boolean(meta.compare && state.snapshot);
    const workingTree = Boolean(meta.compare?.workingTree);
    const multi = !snapshot && selection.selected?.length > 1;
    const packet = snapshot ? comparison : selection;
    const list = packet?.files || [];
    const merge = !snapshot && !multi && packet?.mergeGroups;
    const currentTab = snapshot ? 'snapshot' : 'commit';
    const shown = list.slice(0, state.limit);
    state.renderedFiles = new Map(shown.map(item => [item.id, item]));
    for (const group of merge?.groups || []) for (const file of group.files) state.renderedFiles.set(file.id, file);
    $('file-layout').textContent = t(state.filesLayout === 'tree' ? 'history.viewList' : 'history.viewTree');
    $('file-layout').disabled = Boolean(meta.message);
    press($('commit-tab'), !snapshot);
    press($('snapshot-tab'), snapshot);
    $('file-count').textContent = meta.message ? '' : multi
      ? t('history.combinedSummary', { selected: selection.selected.length, count: list.length })
      : merge ? countText('history.fileCount', merge.groups.reduce((sum, group) => sum + group.files.length, 0))
        : (packet?.files ? countText('history.fileCount', list.length) : '');
    const root = document.createDocumentFragment();
    const status = (text, retry, cls = 'muted') => root.append(el('div', `empty ${cls}`, text),
      ...(retry ? [button('link retry', t('history.retry'), () => send(retry))] : []));
    if (meta.message) status(t('history.waitForRepository'));
    else {
      if (snapshot) root.append(el('div', 'snapshot-caption mono',
        `${short(meta.compare.left.oid)} → ${workingTree ? meta.compare.right.label : short(meta.compare.right.oid)}`));
      if (packet?.loading || (snapshot && !packet)) status(multi
        ? t('history.loadingSelection', { processed: packet.processed, total: packet.total }) : t('history.loadingFiles'));
      else if (snapshot && packet?.error) status(packet.error, 'retryComparison', 'error');
      else {
        if (!snapshot && packet?.failures?.length) status(t('history.partialSelection', { detail: packet.failures.join('\n') }), 'retrySelection', 'error');
        if (merge) mergeGroups(root, merge, currentTab);
        else if (list.length) {
          if (state.filesLayout === 'tree') fileTree(root, shown, currentTab);
          else for (const item of shown) root.append(fileRow(item, currentTab));
          if (state.limit < list.length) root.append(button('link retry', t('history.moreFiles'), () => { state.limit += FILE_BATCH; renderFiles(); }));
        } else if (!packet?.failures?.length) {
          if (snapshot) status(t(workingTree ? 'history.noWorktreeChanges' : 'history.noSnapshotChanges'));
          else if (multi) status(t('history.noSelectedChanges'));
          else status(t(selection.focus ? 'history.noCommitChanges' : 'history.chooseCommit'));
        }
        if (snapshot) root.append(el('div', 'empty muted', t(workingTree ? 'history.worktreeNote' : 'history.snapshotNote')));
      }
    }
    const offset = files.dataset.tab === currentTab ? files.scrollTop : 0;
    files.replaceChildren(root);
    files.dataset.tab = currentTab;
    files.scrollTop = offset;
  }

  /**
   * Mirrors IntelliJ's merge-commit tree: for a clean merge (nothing introduced
   * relative to the first parent) a "No merged conflicts" tag node is shown, then
   * a collapsible "Changes to <hash> <subject>" node per parent that has changes.
   */
  function mergeGroups(root, merge, source) {
    if (merge.clean) root.append(el('div', 'merge-group-label clean', t('history.noMergedConflicts')));
    for (const group of merge.groups) {
      const entry = el('details', 'file-folder merge-group');
      const summary = el('summary');
      summary.append(el('span', 'file-name ellipsis', t('history.changesTo',
        { oid: group.short, subject: group.subject ? ` ${group.subject}` : '' })));
      summary.append(el('span', 'pill', countText('history.fileCount', group.files.length)));
      const children = el('div', 'file-children');
      entry.append(summary, children);
      entry.open = state.directories.get(`merge:${group.oid}`) ?? true;
      if (state.filesLayout === 'tree') fileTree(children, group.files, source);
      else for (const file of group.files) children.append(fileRow(file, source));
      entry.addEventListener('toggle', () => { if (entry.isConnected) state.directories.set(`merge:${group.oid}`, entry.open); });
      root.append(entry);
    }
  }

  function renderDetail() {
    const box = $('detail-content');
    const { detail, loading, focus, selected } = state.selection;
    const multi = (selected?.length || 0) > 1;
    $('details').hidden = multi;
    const detailTab = tabs.find(tab => tab.dataset.pane === 'details');
    detailTab.hidden = multi;
    if (multi && panes.dataset.pane === 'details') setPane('files');
    box.replaceChildren();
    if (multi) return;
    if (!detail || state.meta.message) {
      box.append(el('p', 'muted', t(focus && loading && !state.meta.message ? 'history.loadingDetails' : 'history.chooseCommit')));
      return;
    }
    const props = el('dl', 'detail-meta');
    const time = commitTime(detail.date);
    for (const [key, value, cls, title] of [
      ['history.commit', detail.oid, 'mono'], ['history.author', detail.author || '—'],
      ['history.time', time.label, 'mono', time.title],
      ['history.parents', detail.parents.join('\n') || t(detail.shallowBoundary ? 'history.parentsMissing' : 'history.noParents'), 'mono']
    ]) props.append(el('dt', '', t(key)), el('dd', cls, value, title));
    box.append(el('pre', 'message', detail.message || t('history.noMessage')), props);
    if (detail.parents.length > 1) box.append(el('p', 'muted', t('history.firstParentNote')));
  }

  function setPane(pane) {
    panes.dataset.pane = pane;
    if (pane === 'details') $('details').open = true;
    tabs.forEach(control => press(control, control.dataset.pane === pane));
    onViewport();
  }

  const editDialog = $('edit-dialog');
  const editMessage = $('edit-message');
  let editId;
  function renderEdit(packet) {
    if (!packet) {
      editId = undefined;
      editMessage.value = '';
      if (editDialog.open) editDialog.close();
      return;
    }
    if (editId === packet.id) return;
    editId = packet.id;
    $('edit-context').textContent = packet.label;
    editMessage.value = packet.value;
    $('submit-edit').disabled = !editMessage.value.trim();
    if (!editDialog.open) editDialog.showModal();
    editMessage.focus();
  }

  function finishEdit(save) {
    if (!editId) return;
    send('finishEdit', { id: editId, value: save ? editMessage.value : undefined });
    renderEdit();
  }

  $('edit-form').addEventListener('submit', event => { event.preventDefault(); if (editMessage.value.trim()) finishEdit(true); });
  $('cancel-edit').addEventListener('click', () => finishEdit(false));
  editDialog.addEventListener('cancel', event => { event.preventDefault(); finishEdit(false); });
  editMessage.addEventListener('input', () => { $('submit-edit').disabled = !editMessage.value.trim(); });

  function clearFileSelection(source) {
    state.selectedFiles[source].clear();
    delete state.anchors[source];
  }

  for (const [id, intent] of Object.entries({ repo: 'chooseRepository', range: 'chooseRange', refresh: 'refresh',
    swap: 'swap', recompare: 'recompare', 'exit-compare': 'exitComparison' })) {
    $(id).addEventListener('click', () => send(intent));
  }
  $('filter-text').addEventListener('input', () => sendFilter(220));
  $('filter-text').addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); sendFilter(); }
    else if (event.key === 'Escape' && $('filter-text').value) { event.preventDefault(); $('filter-text').value = ''; sendFilter(); }
  });
  $('filter-author').addEventListener('change', () => sendFilter());
  $('file-layout').addEventListener('click', () => {
    state.filesLayout = state.filesLayout === 'tree' ? 'list' : 'tree';
    send('filesLayout', { layout: state.filesLayout });
    renderFiles();
  });
  for (const [id, snapshot] of [['commit-tab', false], ['snapshot-tab', true]]) $(id).addEventListener('click', () => {
    if (state.snapshot === snapshot) return;
    state.snapshot = snapshot;
    state.limit = FILE_BATCH;
    for (const source of ['commit', 'snapshot']) {
      clearFileSelection(source);
      send('selectFiles', { source, ids: [] });
    }
    renderFiles();
  });
  tabs.forEach(control => control.addEventListener('click', () => setPane(control.dataset.pane)));
  scroll.addEventListener('scroll', onViewport, { passive: true });
  new ResizeObserver(onViewport).observe(scroll);

  splitter.addEventListener('pointerdown', event => {
    if (event.button === 0) { splitter.setPointerCapture(event.pointerId); event.preventDefault(); }
  });
  splitter.addEventListener('pointermove', event => {
    if (!splitter.hasPointerCapture(event.pointerId)) return;
    const { left, width } = panes.getBoundingClientRect();
    const position = Math.max(260, Math.min(width - 250, event.clientX - left));
    panes.style.setProperty('--split', `${position / width * 100}%`);
  });

  window.addEventListener('message', ({ data: packet }) => {
    if (!packet || !Number.isInteger(packet.generation)) return;
    const { type, payload, generation, repoId } = packet;
    if (type === 'reset') {
      if (generation < state.generation) return;
      if (generation !== state.generation || repoId !== state.repoId) {
        const nextMode = payload.meta.compare;
        if (!state.meta.compare || !nextMode || state.repoId !== repoId || nextMode.workingTree !== state.meta.compare.workingTree
          || nextMode.workingTree) state.snapshot = Boolean(nextMode);
        state.directories.clear();
        state.commitMenus.clear();
        state.fileMenus.clear();
        clearFileSelection('commit');
        clearFileSelection('snapshot');
        state.limit = FILE_BATCH;
        scroll.scrollTop = files.scrollTop = 0;
        painted = '';
        setPane(nextMode?.workingTree ? 'files' : 'log');
      }
      Object.assign(state, payload, { generation, repoId, pageIntent: false, comparison: payload.comparison });
      state.badges = new Map(payload.meta.badges);
      state.rowsByOid = new Map(state.rows.map(row => [row.oid, row]));
      state.known = new Set(state.rowsByOid.keys());
      // A filter reset reuses the same generation only through `page` updates, so
      // keep the inputs in sync when the host rewrites them on repo/range change.
      if (payload.page?.filter) $('filter-text').value = payload.page.filter.text || '';
      authorKey = '';
      renderEdit(payload.editPrompt);
    } else {
      if (generation !== state.generation || repoId !== state.repoId) return;
      switch (type) {
        case 'append':
          for (const row of payload) { state.rows.push(row); state.known.add(row.oid); state.rowsByOid.set(row.oid, row); }
          break;
        case 'meta': {
          const sameHead = state.meta.head?.ref === payload.head?.ref && state.meta.head?.oid === payload.head?.oid;
          const refs = new Map(payload.badges);
          if (!sameHead || !sameRemoteTips(state.badges, refs)) state.commitMenus.clear();
          state.meta = payload;
          state.badges = refs;
          // Worktree changes can make a previously missing path available.
          state.fileMenus.clear();
          break;
        }
        case 'page': state.page = payload; state.pageIntent = false; break;
        case 'comparison':
          for (const file of state.comparison?.files ?? []) state.fileMenus.delete(file.id);
          state.comparison = payload;
          clearFileSelection('snapshot');
          if (state.snapshot) state.limit = FILE_BATCH;
          break;
        case 'selection': {
          if (payload.revision < state.selection.revision) return;
          if (payload.revision !== state.selection.revision) {
            for (const file of state.selection.files ?? []) state.fileMenus.delete(file.id);
            state.commitMenus.clear();
            clearFileSelection('commit');
            if (!state.snapshot) state.limit = FILE_BATCH;
          }
          state.selection = payload;
          if (payload.focus && !payload.loading && !state.commitMenus.has('selected')) probe('probeCommitMenu', { oid: payload.focus });
          break;
        }
        case 'commitMenu':
          if (payload.revision === state.selection.revision && payload.head?.ref === state.meta.head?.ref && payload.head?.oid === state.meta.head?.oid) {
            const key = state.selection.selected?.includes(payload.oid) ? 'selected' : payload.oid;
            state.commitMenus.set(key, payload.actions);
          }
          return;
        case 'fileMenu': state.fileMenus.set(payload.token, payload.editSource); return;
        case 'editPrompt': renderEdit(payload); return;
        default: return;
      }
    }
    renderHeader();
    renderRows(true);
    renderLogStatus();
    if (type === 'reset' || type === 'meta' || (type === 'selection' && !state.snapshot) || (type === 'comparison' && state.snapshot)) renderFiles();
    if (type === 'reset' || type === 'meta' || type === 'selection') renderDetail();
    onViewport();
  });

  renderHeader();
  renderLogStatus();
  vscode.postMessage({ type: 'ready' });
})();
