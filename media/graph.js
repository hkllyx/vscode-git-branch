/* global acquireVsCodeApi */
(() => {
  'use strict';

  const vscode = acquireVsCodeApi();
  const html = document.documentElement;
  const t = globalThis.gitBranchCreateTranslator(JSON.parse(html.dataset.messages));
  if (html.dataset.codiconFont) {
    const encoded = html.dataset.codiconFont;
    delete html.dataset.codiconFont;
    try {
      // A binary FontFace needs no URL request from the Webview's restricted origin.
      const bytes = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
      const font = new FontFace('Git Branch Codicon', bytes);
      void font.load().then(loaded => {
        document.fonts.add(loaded);
        html.classList.add('has-codicons');
      }, () => { /* Keep the fallback symbols. */ });
    } catch { /* Keep the fallback symbols if the host font is unreadable. */ }
  }
  const $ = id => document.getElementById(id);
  const scroll = $('commits-scroll');
  const commits = $('commits');
  const files = $('files');
  const panes = $('panes');
  const splitter = $('splitter');
  const paneControls = [...document.querySelectorAll('.compact-nav button')];
  const fileTabs = [$('commit-tab'), $('snapshot-tab')];
  const ROW = 28; // Must match --row-height in graph.css.
  const LANE = 12;
  const DRAW_LANES = 14;
  const FILE_BATCH = 200;
  const FILE_PATCH_LIMIT = Number(files.dataset.patchLimit);
  const commitTime = globalThis.gitBranchFormatCommitTime;
  const STATUS = {
    A: t('history.statusAdded'), C: t('history.statusCopied'), D: t('history.statusDeleted'), M: t('history.statusModified'),
    R: t('history.statusRenamed'), T: t('history.statusTypeChange'), U: t('history.statusConflict'),
    X: t('history.statusUnknown'), B: t('history.statusRewritten')
  };
  const state = { generation: 0, rows: [], entries: [], rowsByOid: new Map(), known: new Set(), meta: {}, badges: new Map(), page: {}, selection: {},
    selectedCommits: new Set(), filesById: new Map(),
    directories: new Map(), parentViews: new Map(), commitMenus: new Map(), fileMenus: new Map(), filesLayout: 'list', commitColumns: [],
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

  function codicon(name, className) {
    const icon = el('span', `codicon codicon-${name} ${className}`);
    icon.setAttribute('aria-hidden', 'true');
    return icon;
  }

  function svgNode(tag, attrs) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    return node;
  }

  function graph(row, laneLimit) {
    if (!row.graph) {
      // Synthetic rows (Working Tree changes) are not part of the commit DAG.
      return svgNode('svg', { class: 'graph', width: LANE + 5, height: ROW, 'aria-hidden': 'true' });
    }
    const { column, color, incoming, through, edges } = row.graph;
    const columns = Math.max(1, Math.min(laneLimit, state.page.columns || 1));
    const width = columns * LANE + 5, mid = ROW / 2;
    const x = lane => 8 + lane * LANE;
    const svg = svgNode('svg', { class: 'graph', width, height: ROW, 'aria-hidden': 'true' });
    const path = (d, laneColor, dashed = false) => svg.append(svgNode('path', { d, class: `edge lane-${laneColor}${dashed ? ' boundary' : ''}` }));
    for (const lane of through) {
      // A pending parent must not produce a line across unrelated rows.
      if (lane.column < laneLimit && state.known.has(lane.oid)) path(`M${x(lane.column)},0 V${ROW}`, lane.color);
    }
    if (column >= laneLimit) {
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
      if (!state.known.has(edge.oid) || edge.column >= laneLimit) {
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
    // The synthetic Working Tree row is not a Git object, so history rewrite commands do not apply.
    if (row.worktree) return { ...baseContext('none') };
    const active = state.selectedCommits.has(row.oid);
    const selected = active ? state.selection.selected : [row.oid];
    if (selected.some(oid => state.rowsByOid.get(oid)?.worktree)) return baseContext('none');
    const single = selected.length === 1;
    const head = state.meta.head;
    const local = Boolean(head?.ref && head.oid);
    const plain = !(active && state.selection.selectionOverLimit) && selected.every(oid => {
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

  function commitRow(row, index, size, selected, laneLimit) {
    const subject = row.subject || t('history.noSubject');
    const focused = row.oid === state.selection.focus;
    const isSelected = selected.has(row.oid);
    const time = row.worktree ? { label: '', precise: '' } : commitTime(row.date);
    const line = el('div', `commit-row${focused ? ' focused' : ''}${isSelected ? ' selected' : ''}${row.worktree ? ' worktree-row' : ''}`);
    line.dataset.oid = row.oid;
    line.setAttribute('role', 'presentation');
    const summary = button('commit-subject', '', event => {
      const additive = event.ctrlKey || event.metaKey;
      const mode = event.shiftKey ? (additive ? 'extend' : 'range') : additive ? 'toggle' : 'replace';
      if (state.meta.compare) showFileTab(false);
      send('select', { oid: row.oid, mode });
    });
    summary.setAttribute('role', 'option');
    summary.setAttribute('aria-selected', String(isSelected));
    summary.setAttribute('aria-posinset', index + 1);
    summary.setAttribute('aria-setsize', size);
    const badges = state.badges.get(row.oid) || [];
    const author = row.worktree ? '' : row.author || '—';
    const hash = row.worktree ? '' : short(row.oid);
    summary.title = row.worktree ? `${subject}\n${t('history.worktreeNotACommit')}`
      : `${subject}\n${author}  ·  ${hash}  ·  ${time.precise}`;
    const message = el('span', 'commit-message');
    message.append(el('span', 'subject ellipsis', subject));
    if (badges.length) {
      const badge = codicon('tag', `ref-badge${badges.some(item => item.current) ? ' current' : ''}`);
      badge.title = badges.map(item => item.name).join('\n');
      message.append(badge);
    }
    summary.append(graph(row, laneLimit), message);
    const values = { author, hash, date: time.label };
    for (const key of state.commitColumns) summary.append(el('span', `${key} ellipsis${key === 'author' ? '' : ' mono'}`, values[key]));
    line.append(summary);
    rowContext(line, () => commitActionContext(row), () => {
      const active = state.selectedCommits.has(row.oid);
      if (row.worktree || (active && state.selection.selectionOverLimit)) return;
      if (!state.commitMenus.has(active ? 'selected' : row.oid)) probe('probeCommitMenu', { oid: row.oid });
    });
    return line;
  }

  /** Comparison rows are grouped by side; collapsing only removes entries from the presentation. */
  function buildEntries() {
    if (!state.meta.compare) {
      const size = state.page.hasMore ? -1 : state.rows.length;
      state.entries = state.rows.map((row, index) => ({ row, index, size }));
      return;
    }
    const groups = { left: [], right: [] };
    for (const row of state.rows) groups[row.side]?.push(row);
    const entries = [];
    for (const side of ['left', 'right']) {
      const rows = groups[side];
      // An unfiltered side may have commits on later pages; show its heading as soon as the count is known.
      if (!rows.length && !(!state.page.filter && state.page.hasMore && state.comparison?.counts?.[side] > 0)) continue;
      entries.push({ side });
      if (state.meta.compare.collapsed.includes(side)) continue;
      const size = state.page.hasMore ? -1 : rows.length;
      for (const [index, row] of rows.entries()) entries.push({ row, side, index, size });
    }
    state.entries = entries;
  }

  function sectionLabel(side) {
    return `${state.meta.compare[side].label} ${t('history.branchOnlySuffix')}`;
  }

  function sectionRow(side) {
    const label = sectionLabel(side);
    const expanded = !state.meta.compare.collapsed.includes(side);
    const line = button(`commit-section ${side}`, '', () => send('toggleComparisonGroup', { side }), label);
    line.dataset.section = side;
    line.setAttribute('aria-expanded', String(expanded));
    line.setAttribute('aria-label', label);
    const branch = el('span', 'section-label');
    branch.append(el('span', 'ellipsis', state.meta.compare[side].label), el('span', '', ` ${t('history.branchOnlySuffix')}`));
    line.append(codicon(expanded ? 'chevron-down' : 'chevron-right', 'section-chevron'), branch);
    return line;
  }

  let painted = '';
  let frame = 0;
  function renderRows(force = false) {
    if (!scroll.clientHeight) { painted = ''; return; }
    const count = state.meta.message ? 0 : state.entries.length;
    const start = Math.min(count, Math.max(0, Math.floor(scroll.scrollTop / ROW) - 8));
    const end = Math.min(count, Math.ceil((scroll.scrollTop + scroll.clientHeight) / ROW) + 8);
    const width = scroll.clientWidth;
    const key = `${start}:${end}:${width}`;
    if (!force && painted === key) return;
    painted = key;
    const laneLimit = Math.max(1, Math.min(DRAW_LANES, Math.floor((width * .25 - 5) / LANE)));
    commits.dataset.columns = state.commitColumns.join(' ');
    const focused = document.activeElement?.closest('.commit-row, .commit-section');
    const oid = focused?.dataset.oid;
    const section = focused?.dataset.section;
    const fragment = document.createDocumentFragment();
    const comparing = Boolean(state.meta.compare);
    commits.setAttribute('role', comparing ? 'group' : 'listbox');
    if (comparing) commits.removeAttribute('aria-multiselectable');
    else commits.setAttribute('aria-multiselectable', 'true');
    let restore, group, side;
    for (let i = start; i < end; i++) {
      const entry = state.entries[i];
      if (!entry.row) {
        const heading = sectionRow(entry.side);
        if (entry.side === section) restore = heading;
        fragment.append(heading);
        continue;
      }
      const line = commitRow(entry.row, entry.index, entry.size, state.selectedCommits, laneLimit);
      if (entry.row.oid === oid) restore = line.querySelector('.commit-subject');
      if (!entry.side) fragment.append(line);
      else {
        if (entry.side !== side) {
          side = entry.side;
          group = el('div');
          group.setAttribute('role', 'listbox');
          group.setAttribute('aria-label', sectionLabel(side));
          group.setAttribute('aria-multiselectable', 'true');
          fragment.append(group);
        }
        group.append(line);
      }
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
      // Folding short groups should not eagerly scan the remaining history just to fill the viewport.
      const canScrollForMore = !state.meta.compare?.collapsed.length || state.entries.length * ROW > scroll.clientHeight;
      if (scroll.clientHeight && state.rows.length && canScrollForMore && !state.page.error &&
          scroll.scrollTop + scroll.clientHeight >= (state.entries.length - 8) * ROW) requestPage();
    });
  }

  const filterInput = $('filter-text');
  let filterTimer, composingFilter = false;
  function sendFilter(delay = 0) {
    clearTimeout(filterTimer);
    const run = () => {
      filterTimer = undefined;
      if (!filterInput.disabled && filterInput.value.trim() !== state.page.filter) send('setFilter', { text: filterInput.value });
    };
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
    $('range').textContent = `${meta.range || 'HEAD'} ▾`;
    $('range').title = meta.range || t('history.pickRange');
    $('range').disabled = !ready;
    $('range').hidden = Boolean(mode);
    filterInput.disabled = !ready;
    $('commit-columns').disabled = !state.generation;
    const refresh = $('refresh');
    refresh.disabled = !meta.repository;
    const before = mode ? $('swap') : $('compare-bar');
    if (refresh.nextElementSibling !== before) before.before(refresh);
    $('compare-bar').hidden = !mode;
    $('log-title').textContent = t(mode ? 'history.distinct' : 'history.graph');
    $('swap').disabled = !ready;
    if (mode) {
      const label = endpoint => endpoint.worktree ? endpoint.label : `${endpoint.label} (${endpoint.oid})`;
      $('direction').title = `${label(mode.left)} → ${label(mode.right)}`;
      $('direction').replaceChildren(el('span', 'side left ellipsis', t('history.baseLabel', { name: mode.left.label })), el('span', '', '→'),
        el('span', 'side right ellipsis', t('history.targetLabel', { name: mode.right.label })));
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
      if (meta.compare && comparison?.same) status.textContent = t('history.sameTip');
      else if (page.filter) status.textContent = t('history.filteredEmpty');
      else status.textContent = t(meta.compare ? 'history.noUniqueCommits' : 'history.noCommitsInRange');
    }
    else status.textContent = countText('history.commitCount', rows.length);
  }

  function fileActionContext(file, source) {
    const selected = state.selectedFiles[source];
    const set = selected.has(file.id) ? selected : new Set([file.id]);
    const batch = set.size <= FILE_PATCH_LIMIT ? [...set] : [];
    return { ...baseContext('file'), gbToken: file.id, gbSource: source, gbFiles: batch.join(','),
      gbCanEditSource: state.fileMenus.get(file.id) ?? file.sourceCandidate, gbCanOpenVersion: file.repositoryVersion,
      gbCanApplyFiles: batch.length > 0 && batch.every(id => {
        const candidate = state.filesById.get(id);
        return candidate?.apply && candidate.parentGroup === file.parentGroup;
      }) };
  }

  function updateFileSelection(source, next) {
    state.selectedFiles[source] = next;
    send('selectFiles', { source, ids: [...next] });
    for (const row of files.querySelectorAll('.file-row')) {
      const active = next.has(row.dataset.fileId);
      row.classList.toggle('selected', active);
      press(row, active);
    }
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
    if (!event.shiftKey || !state.anchors[source]) state.anchors[source] = file.id;
    updateFileSelection(source, next);
  }

  function fileRow(file, source, inTree = false) {
    const path = file.from ? `${file.from} → ${file.path}` : file.path;
    const separator = file.path.lastIndexOf('/');
    const name = file.path.slice(separator + 1);
    const label = STATUS[file.status] || t('history.statusChange');
    const note = file.ambiguous ? t('history.cannotCombine') : file.includesGap ? t('history.includesUnselected') : '';
    const row = button('file-row', '', event => selectFile(event, file, source), [label, path, note].filter(Boolean).join(' · '));
    row.dataset.fileId = file.id;
    // A single click only moves the selection; the Diff opens on double click.
    row.addEventListener('dblclick', () => { if (!file.ambiguous) send('openDiff', { token: file.id }); });
    const selected = state.selectedFiles[source].has(file.id);
    row.classList.toggle('selected', selected);
    press(row, selected);
    row.append(el('span', `file-status status-${file.status}`, file.status, label));
    const fileLabel = el('span', 'file-label');
    fileLabel.append(el('span', 'file-name ellipsis', name));
    if (!inTree && separator >= 0) fileLabel.append(el('span', 'file-directory ellipsis', file.path.slice(0, separator)));
    row.append(fileLabel);
    if (file.submodule) row.append(el('span', 'submodule', t('history.submodule')));
    if (note) row.append(codicon('warning', 'file-warning'));
    const diffLabel = t('history.openDiffLabel', { status: label, path, commit: '' });
    row.setAttribute('aria-label', [file.ambiguous ? path : diffLabel, note].filter(Boolean).join(' · '));
    rowContext(row, () => fileActionContext(file, source), () => {
      if (file.sourceCandidate && !state.fileMenus.has(file.id)) probe('probeFileMenu', { source, token: file.id });
    });
    return row;
  }

  function fileTree(root, list, source, scope) {
    const tree = { dirs: new Map(), files: [] };
    list.forEach(file => {
      const raw = atob(file.pathKey).split('/');
      const names = file.path.split('/');
      let folder = tree;
      for (let i = 0; i < raw.length - 1; i++) {
        if (!folder.dirs.has(raw[i])) folder.dirs.set(raw[i], {
          name: names[i], key: `${source}:${scope}:${btoa(raw.slice(0, i + 1).join('/'))}`, dirs: new Map(), files: []
        });
        folder = folder.dirs.get(raw[i]);
      }
      folder.files.push(file);
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
      for (const file of folder.files) container.append(fileRow(file, source, true));
    };
    fill(root, tree);
  }

  function renderFileBatch(root, list, source, scope, limit, showMore) {
    const shown = list.slice(0, limit);
    if (state.filesLayout === 'tree') fileTree(root, shown, source, scope);
    else for (const file of shown) root.append(fileRow(file, source));
    if (shown.length < list.length) root.append(button('link retry', t('history.moreFiles'), showMore));
  }

  function renderParentGroup(root, group) {
    const { oid, subject, files: list } = group;
    const view = state.parentViews.get(oid) || { open: false, limit: FILE_BATCH };
    state.parentViews.set(oid, view);
    const entry = el('details', 'file-folder parent-group');
    const summary = el('summary');
    const title = t('history.changesToParent', { parent: [short(oid), subject].filter(Boolean).join(' ') });
    summary.append(el('span', 'file-name ellipsis', title, title));
    const children = el('div', 'file-children');
    entry.append(summary, children);
    entry.open = view.open;
    const fill = () => {
      children.replaceChildren();
      renderFileBatch(children, list, 'commit', oid, view.limit, () => { view.limit += FILE_BATCH; fill(); });
    };
    if (entry.open) fill();
    entry.addEventListener('toggle', () => {
      if (!entry.isConnected) return;
      view.open = entry.open;
      if (entry.open && !children.hasChildNodes()) fill();
    });
    root.append(entry);
  }

  // Both history modes share one tab strip and panel; only File Diff is comparison-specific.
  function renderFileTabs(comparing, snapshot) {
    const activeTab = fileTabs[Number(snapshot)];
    const restoreFocus = !comparing && document.activeElement === fileTabs[1];
    fileTabs[1].hidden = !comparing;
    for (const tab of fileTabs) {
      tab.setAttribute('aria-selected', String(tab === activeTab));
      tab.tabIndex = tab === activeTab ? 0 : -1;
    }
    files.setAttribute('aria-labelledby', activeTab.id);
    if (restoreFocus) activeTab.focus();
  }

  function renderFiles() {
    const { selection, comparison, meta } = state;
    const snapshot = Boolean(meta.compare && state.snapshot);
    const workingTree = Boolean(meta.compare?.workingTree);
    const multi = !snapshot && selection.selected?.length > 1;
    const packet = snapshot ? comparison : selection;
    const list = packet?.files || [];
    const merge = !snapshot && !multi && selection.detail?.parents.length > 1;
    const currentTab = snapshot ? 'snapshot' : 'commit';
    const parentGroups = merge ? selection.parentGroups || [] : [];
    state.filesById = new Map(list.map(file => [file.id, file]));
    for (const group of parentGroups) for (const file of group.files) state.filesById.set(file.id, file);
    const active = document.activeElement;
    const restoreFocus = active !== files && files.contains(active);
    const focusedFile = active?.dataset.fileId;
    const layoutLabel = t(state.filesLayout === 'tree' ? 'history.viewList' : 'history.viewTree');
    $('file-layout').title = layoutLabel;
    $('file-layout').setAttribute('aria-label', layoutLabel);
    $('file-layout').querySelector('.layout-label').textContent = layoutLabel;
    $('file-layout').querySelector('.codicon').className = `codicon codicon-${state.filesLayout === 'tree' ? 'list-flat' : 'list-tree'}`;
    $('file-layout').disabled = Boolean(meta.message);
    renderFileTabs(Boolean(meta.compare), snapshot);
    $('file-count').textContent = meta.message || packet?.selectionOverLimit ? '' : multi
      ? t('history.combinedSummary', { selected: selection.selected.length, count: list.length })
      : (packet?.files ? countText('history.fileCount', list.length) : '');
    const root = document.createDocumentFragment();
    const status = (text, retry, cls = 'muted') => root.append(el('div', `empty ${cls}`, text),
      ...(retry ? [button('link retry', t('history.retry'), () => send(retry))] : []));
    if (meta.message) status(t('history.waitForRepository'));
    else {
      if (snapshot) {
        const label = endpoint => endpoint.worktree ? endpoint.label : short(endpoint.oid);
        root.append(el('div', 'snapshot-caption mono', `${label(meta.compare.left)} → ${label(meta.compare.right)}`));
      }
      if (packet?.loading || (snapshot && !packet)) status(multi
        ? t('history.loadingSelection', { processed: packet.processed, total: packet.total }) : t('history.loadingFiles'));
      else if (snapshot && packet?.error) status(packet.error, 'retryComparison', 'error');
      else if (!snapshot && packet?.selectionOverLimit) status(t('history.combinedSelectionLimit', {
        selected: selection.selected.length, count: packet.selectionOverLimit
      }));
      else {
        if (!snapshot && packet?.failures?.length) status(t('history.partialSelection', { detail: packet.failures.join('\n') }), 'retrySelection', 'error');
        if (list.length) {
          renderFileBatch(root, list, currentTab, '', state.limit, () => { state.limit += FILE_BATCH; renderFiles(); });
        } else if (!packet?.failures?.length) {
          if (snapshot) status(t(workingTree ? 'history.noWorktreeChanges' : 'history.noSnapshotChanges'));
          else if (multi) status(t('history.noSelectedChanges'));
          else status(t(merge ? 'history.noMergedConflicts' : selection.focus ? 'history.noCommitChanges' : 'history.chooseCommit'));
        }
        for (const group of parentGroups) renderParentGroup(root, group);
        if (snapshot) root.append(el('div', 'empty muted', t(workingTree ? 'history.worktreeNote' : 'history.snapshotNote')));
      }
    }
    const offset = files.dataset.tab === currentTab ? files.scrollTop : 0;
    files.replaceChildren(root);
    files.dataset.tab = currentTab;
    files.scrollTop = offset;
    if (restoreFocus) {
      const row = focusedFile && files.querySelector(`[data-file-id="${CSS.escape(focusedFile)}"]`);
      (row || files).focus({ preventScroll: true });
    }
  }

  function renderDetail() {
    const box = $('detail-content');
    const { detail, loading, focus, selected } = state.selection;
    const multi = (selected?.length || 0) > 1;
    const hidden = multi || Boolean(state.meta.compare && (state.snapshot || !detail));
    $('details').hidden = hidden;
    const detailTab = paneControls.find(tab => tab.dataset.pane === 'details');
    detailTab.hidden = hidden;
    if (hidden && panes.dataset.pane === 'details') setPane('files');
    box.replaceChildren();
    if (hidden) return;
    if (!detail || state.meta.message) {
      box.append(el('p', 'muted', t(focus && loading && !state.meta.message ? 'history.loadingDetails' : 'history.chooseCommit')));
      return;
    }
    const props = el('dl', 'detail-meta');
    for (const [key, value, cls] of [
      ['history.commit', detail.oid, 'mono'], ['history.author', detail.author || '—'],
      ['history.time', commitTime(detail.date).precise, 'mono'],
      ['history.parents', detail.parents.join('\n') || t(detail.shallowBoundary ? 'history.parentsMissing' : 'history.noParents'), 'mono']
    ]) props.append(el('dt', '', t(key)), el('dd', cls, value));
    box.append(el('pre', 'message', detail.message || t('history.noMessage')), props);
    if (detail.parents.length > 1) box.append(el('p', 'muted', t('history.mergeDiffNote')));
  }

  function setPane(pane) {
    panes.dataset.pane = pane;
    if (pane === 'details') $('details').open = true;
    paneControls.forEach(control => press(control, control.dataset.pane === pane));
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

  // Scope the platform Select All shortcut to the focused list, not the whole Webview.
  document.addEventListener('keydown', event => {
    const target = document.activeElement;
    if (event.defaultPrevented || event.isComposing || target?.isContentEditable || target?.closest('input, textarea, select, dialog')) return;
    const all = event.key.toLowerCase() === 'a' && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey;
    const clear = event.key === 'Escape' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
    if (!all && !clear) return;
    const inLog = scroll.contains(target), inFiles = files.contains(target);
    if (!inLog && !inFiles && !clear) return;
    window.getSelection()?.removeAllRanges();
    if (!inLog && !inFiles) return;
    event.preventDefault();
    // The Webview window forwards bubbled keys to the VS Code workbench, which can run Select All again.
    event.stopPropagation();
    if (event.repeat) return;
    if (inLog) {
      if (all && state.meta.compare) showFileTab(false);
      if (all) send('selectAllCommits', { focusedOid: target.closest('.commit-row')?.dataset.oid });
      else send('clearCommits');
    } else {
      const source = files.dataset.tab;
      if (!source) return;
      const anchor = all && target.closest('.file-row')?.dataset.fileId;
      if (anchor) state.anchors[source] = anchor;
      else delete state.anchors[source];
      updateFileSelection(source, new Set(all ? state.filesById.keys() : []));
    }
  });

  for (const list of [scroll, files]) list.addEventListener('click', event => {
    if (!event.target.closest('button, summary, a') && window.getSelection()?.isCollapsed) list.focus({ preventScroll: true });
  });

  for (const [id, intent] of Object.entries({ repo: 'chooseRepository', range: 'chooseRange', refresh: 'refresh',
    swap: 'swap', 'exit-compare': 'exitComparison', 'commit-columns': 'chooseColumns' })) {
    $(id).addEventListener('click', () => send(intent));
  }
  filterInput.addEventListener('input', event => { if (!event.isComposing) sendFilter(220); });
  filterInput.addEventListener('compositionstart', () => {
    composingFilter = true;
    clearTimeout(filterTimer);
    filterTimer = undefined;
  });
  filterInput.addEventListener('compositionend', () => { composingFilter = false; sendFilter(220); });
  filterInput.addEventListener('keydown', event => {
    if (event.isComposing) return;
    if (event.key === 'Enter') { event.preventDefault(); sendFilter(); }
    else if (event.key === 'Escape' && filterInput.value) { event.preventDefault(); filterInput.value = ''; sendFilter(); }
  });
  $('file-layout').addEventListener('click', () => {
    state.filesLayout = state.filesLayout === 'tree' ? 'list' : 'tree';
    send('filesLayout', { layout: state.filesLayout });
    renderFiles();
  });
  function showFileTab(snapshot) {
    if (state.snapshot === snapshot) return;
    state.snapshot = snapshot;
    state.limit = FILE_BATCH;
    for (const source of ['commit', 'snapshot']) {
      clearFileSelection(source);
      send('selectFiles', { source, ids: [] });
    }
    renderFiles();
    renderDetail();
  }

  for (const [index, tab] of fileTabs.entries()) {
    tab.addEventListener('click', () => showFileTab(index === 1));
    tab.addEventListener('keydown', event => {
      if (fileTabs[1].hidden || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      let next;
      if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = fileTabs.length - 1;
      else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') next = 1 - index;
      else return;
      event.preventDefault();
      event.stopPropagation();
      showFileTab(next === 1);
      fileTabs[next].focus();
    });
  }
  paneControls.forEach(control => control.addEventListener('click', () => setPane(control.dataset.pane)));
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
      const syncFilter = !state.generation || repoId !== state.repoId;
      if (generation !== state.generation || repoId !== state.repoId) {
        const nextMode = payload.meta.compare;
        const keepSnapshot = payload.keepSnapshot && state.repoId === repoId;
        if (!keepSnapshot) state.snapshot = Boolean(nextMode);
        for (const key of state.directories.keys()) {
          if (!keepSnapshot || !key.startsWith('snapshot:')) state.directories.delete(key);
        }
        state.parentViews.clear();
        state.commitMenus.clear();
        state.fileMenus.clear();
        clearFileSelection('commit');
        if (!keepSnapshot) clearFileSelection('snapshot');
        if (!keepSnapshot || !state.snapshot) {
          state.limit = FILE_BATCH;
          files.scrollTop = 0;
        }
        scroll.scrollTop = 0;
        painted = '';
        if (!keepSnapshot) setPane('log');
      }
      Object.assign(state, payload, { generation, repoId, pageIntent: false, comparison: payload.comparison });
      state.badges = new Map(payload.meta.badges);
      state.rowsByOid = new Map(state.rows.map(row => [row.oid, row]));
      state.known = new Set(state.rowsByOid.keys());
      buildEntries();
      state.selectedCommits = new Set(state.selection.selected);
      if (syncFilter) {
        clearTimeout(filterTimer);
        filterTimer = undefined;
        filterInput.value = payload.page.filter;
      } else if (!composingFilter && !filterTimer && filterInput.value.trim() !== payload.page.filter) {
        // A reset may be acknowledging an older query while the user is typing.
        sendFilter(220);
      }
      renderEdit(payload.editPrompt);
    } else {
      if (generation !== state.generation || repoId !== state.repoId) return;
      switch (type) {
        case 'append':
          for (const row of payload) { state.rows.push(row); state.known.add(row.oid); state.rowsByOid.set(row.oid, row); }
          buildEntries();
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
        case 'page': {
          const sizeChanged = state.page.hasMore !== payload.hasMore;
          state.page = payload;
          state.pageIntent = false;
          if (sizeChanged) buildEntries();
          break;
        }
        case 'groupVisibility':
          if (!state.meta.compare) return;
          state.meta.compare.collapsed = payload;
          buildEntries();
          renderRows(true);
          onViewport();
          return;
        case 'commitColumns': state.commitColumns = payload; renderRows(true); return;
        case 'comparison':
          for (const file of state.comparison?.files ?? []) state.fileMenus.delete(file.id);
          state.comparison = payload;
          buildEntries();
          clearFileSelection('snapshot');
          if (state.snapshot) state.limit = FILE_BATCH;
          break;
        case 'selection': {
          if (payload.revision < state.selection.revision) return;
          if (payload.revision !== state.selection.revision) {
            for (const file of state.selection.files ?? []) state.fileMenus.delete(file.id);
            for (const group of state.selection.parentGroups ?? []) {
              for (const file of group.files) state.fileMenus.delete(file.id);
            }
            state.parentViews.clear();
            state.commitMenus.clear();
            clearFileSelection('commit');
            if (!state.snapshot) state.limit = FILE_BATCH;
          }
          state.selection = payload;
          state.selectedCommits = new Set(payload.selected);
          if (payload.focus && !payload.loading && !payload.selectionOverLimit && !state.commitMenus.has('selected')) probe('probeCommitMenu', { oid: payload.focus });
          break;
        }
        case 'commitMenu':
          if (payload.revision === state.selection.revision && payload.head?.ref === state.meta.head?.ref && payload.head?.oid === state.meta.head?.oid) {
            const key = state.selectedCommits.has(payload.oid) ? 'selected' : payload.oid;
            state.commitMenus.set(key, payload.actions);
          }
          return;
        case 'fileMenu': state.fileMenus.set(payload.token, payload.editSource); return;
        case 'fileSelection': {
          const { source, ids } = payload;
          if (!state.selectedFiles[source]) return;
          state.selectedFiles[source] = new Set(ids);
          state.anchors[source] = ids[0];
          if (files.dataset.tab !== source) return;
          for (const row of files.querySelectorAll('.file-row')) {
            const active = state.selectedFiles[source].has(row.dataset.fileId);
            row.classList.toggle('selected', active);
            press(row, active);
          }
          return;
        }
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
