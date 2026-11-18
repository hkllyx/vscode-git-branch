'use strict';
const { randomBytes } = require('node:crypto');

function comparisonHtml(result) {
  const nonce = randomBytes(18).toString('base64');
  const data = JSON.stringify(result).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Branch comparison</title>
<style nonce="${nonce}">
*{box-sizing:border-box}body{margin:0;color:var(--vscode-editor-foreground);background:var(--vscode-editor-background);font:var(--vscode-font-size) var(--vscode-font-family)}
button,input{font:inherit;color:inherit}button{cursor:pointer;border:1px solid var(--vscode-widget-border);background:var(--vscode-button-secondaryBackground);padding:5px 10px;border-radius:3px}button:hover{background:var(--vscode-button-secondaryHoverBackground)}button:focus-visible,input:focus-visible{outline:1px solid var(--vscode-focusBorder)}button:disabled{opacity:.5;cursor:default}
header{padding:12px 16px;border-bottom:1px solid var(--vscode-panel-border);display:flex;gap:14px;align-items:center;flex-wrap:wrap}h1{font-size:15px;margin:0;overflow-wrap:anywhere}header small{color:var(--vscode-descriptionForeground)}
main{height:calc(100vh - 87px);min-height:400px;display:grid;grid-template-rows:1fr 1fr}.direction{min-height:0;display:grid;grid-template-columns:minmax(340px,60%) minmax(260px,40%);border-bottom:1px solid var(--vscode-panel-border)}.history,.inspector{min-width:0;min-height:0;display:flex;flex-direction:column}.history{border-right:1px solid var(--vscode-panel-border)}.toolbar{padding:8px;display:flex;gap:8px;align-items:center;border-bottom:1px solid var(--vscode-panel-border)}input{width:100%;padding:5px 8px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,transparent)}.banner{padding:8px 12px;background:var(--vscode-textBlockQuote-background);border-left:3px solid var(--vscode-textLink-foreground);overflow-wrap:anywhere}.list{flex:1;overflow:auto;min-height:0}.commit{width:100%;display:grid;grid-template-columns:minmax(120px,1fr) 105px 130px 65px;gap:10px;text-align:left;border:0;border-radius:0;padding:7px 12px;background:transparent}.commit span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.commit .hash{font-family:var(--vscode-editor-font-family);color:var(--vscode-descriptionForeground)}.commit.active{background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground)}.empty{padding:24px;color:var(--vscode-descriptionForeground);text-align:center}.footer{padding:6px 12px;color:var(--vscode-descriptionForeground);display:flex;justify-content:space-between;align-items:center}.files{flex:1;min-height:0;overflow:auto}.file{display:flex;text-align:left;gap:10px;width:100%;border:0;border-radius:0;background:transparent;padding:7px 12px}.file span:last-child{overflow-wrap:anywhere}.status{font-weight:bold;min-width:30px;color:var(--vscode-gitDecoration-modifiedResourceForeground)}.status.A{color:var(--vscode-gitDecoration-addedResourceForeground)}.status.D{color:var(--vscode-gitDecoration-deletedResourceForeground)}.details{max-height:42%;min-height:70px;overflow:auto;padding:12px;border-top:1px solid var(--vscode-panel-border);white-space:pre-wrap;overflow-wrap:anywhere;font-family:var(--vscode-editor-font-family);font-size:12px}.inspector-title{padding:8px 12px;border-bottom:1px solid var(--vscode-panel-border);color:var(--vscode-descriptionForeground)}#branch-files{display:none;padding:12px;max-height:calc(100vh - 90px);overflow:auto}#error{color:var(--vscode-errorForeground);padding:0 16px}#note{padding:6px 16px;color:var(--vscode-descriptionForeground);font-size:11px}@media(max-width:800px){.commit{grid-template-columns:minmax(100px,1fr) 80px 65px}.commit .date{display:none}.direction{grid-template-columns:55% 45%}}
/* Compact rows scale with the inherited VS Code UI font; no fixed pixel height. */
.commit,.file{padding:2px 12px;line-height:1.4;align-items:center}
.file span:last-child{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;overflow-wrap:normal}
.file .status{flex-shrink:0}
.worktree-tree{padding-top:8px}.worktree-tree summary{cursor:pointer;padding:2px 8px;line-height:1.4;overflow-wrap:anywhere}.folder-children{padding-left:14px}
</style></head><body>
<header><h1 id="title"></h1><small id="tips"></small><button id="toggle">Branch file differences</button></header>
<div id="note">Immutable commit snapshots • working-tree changes excluded • merge commit changes are against first parent</div>
<div id="error" role="alert"></div><main id="histories"></main><section id="branch-files"></section>
<script nonce="${nonce}">(${comparisonClient.toString()})(${data});</script></body></html>`;
}

// Runs only inside the Webview. Repository-controlled strings always use textContent.
function comparisonClient(data) {
  const api = acquireVsCodeApi();
  const state = api.getState() || { searches: {}, selected: {}, mode: 'history' };
  const containers = {};
  const details = {};
  const loading = new Set();
  const title = `${data.ref} ↔ ${data.currentLabel}`;
  document.getElementById('title').textContent = title;
  document.getElementById('tips').textContent = `${data.left.slice(0, 7)} ↔ ${data.worktree ? 'live files' : data.right.slice(0, 7)}`;
  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  function save() { api.setState(state); }
  function files(container, rows, scope, hash) {
    container.replaceChildren();
    if (!rows.length) { container.append(element('div', 'No file differences.', 'empty')); return; }
    rows.forEach((file, index) => {
      const button = element('button', undefined, 'file');
      const label = /^[RC]/.test(file.status) ? `${file.oldPath} → ${file.newPath}` : file.newPath || file.oldPath;
      const displayLabel = scope === 'worktree' && !/^[RC]/.test(file.status)
        ? (file.newPath || file.oldPath).split('/').at(-1) : label;
      button.append(element('span', file.status, `status ${file.status[0]}`), element('span', displayLabel));
      button.title = `${label}\nOpen side-by-side diff`;
      button.onclick = () => api.postMessage({ type: 'diff', scope, hash, index: file.originalIndex ?? index,
        ...(scope === 'worktree' ? { generation: data.generation } : {}) });
      container.append(button);
    });
  }
  if (data.worktree) {
    document.getElementById('histories').style.display = 'none';
    const area = document.getElementById('branch-files'); area.style.display = 'block';
    document.getElementById('note').textContent = 'Selected branch snapshot ↔ live working files (staged, unstaged, untracked and unsaved editor changes). Refresh to update the file list.';
    const refresh = document.getElementById('toggle'); refresh.textContent = 'Refresh';
    refresh.onclick = () => { refresh.disabled = true; api.postMessage({ type: 'refresh' }); };
    const search = element('input'); search.type = 'search'; search.placeholder = 'Filter files by path';
    search.setAttribute('aria-label', 'Filter working tree files');
    const count = element('div', undefined, 'footer'), tree = element('div', undefined, 'worktree-tree');
    area.append(search, count, tree);
    function renderTree() {
      const query = (search.value || '').toLowerCase();
      const rows = data.files.map((file, originalIndex) => ({ ...file, originalIndex }))
        .filter(file => `${file.oldPath || ''} ${file.newPath || ''}`.toLowerCase().includes(query));
      count.textContent = `${rows.length} shown / ${data.files.length} changed files • click a file to open Diff`;
      tree.replaceChildren();
      if (!rows.length) { tree.append(element('div', data.files.length ? 'No matching files.' : 'No file differences.', 'empty')); return; }
      const root = { folders: new Map(), files: [] };
      for (const file of rows) {
        const parts = (file.newPath || file.oldPath).split('/'); parts.pop();
        let folder = root;
        for (const part of parts) {
          if (!folder.folders.has(part)) folder.folders.set(part, { folders: new Map(), files: [] });
          folder = folder.folders.get(part);
        }
        folder.files.push(file);
      }
      function renderFolder(folder, container) {
        for (const [name, child] of folder.folders) {
          const group = element('details'); group.open = true;
          group.append(element('summary', name));
          const children = element('div', undefined, 'folder-children');
          renderFolder(child, children); group.append(children); container.append(group);
        }
        for (const file of folder.files) {
          const row = element('div'); files(row, [file], 'worktree'); container.append(row);
        }
      }
      renderFolder(root, tree);
    }
    search.oninput = renderTree; renderTree();
    window.addEventListener('message', event => {
      const message = event.data;
      if (message.type === 'worktree') {
        data = message.result; renderTree(); refresh.disabled = false;
        document.getElementById('tips').textContent = `${data.left.slice(0, 7)} ↔ live files`;
        document.getElementById('error').textContent = '';
      } else if (message.type === 'error') {
        refresh.disabled = false; document.getElementById('error').textContent = message.message;
      }
    });
    return;
  }

  function showDetails(side, detail) {
    if (state.selected[side] !== detail.hash) return;
    details[detail.hash] = detail;
    const area = containers[side];
    area.inspectorTitle.textContent = `${detail.files.length} changed file(s) • click a file to open Diff`;
    files(area.files, detail.files, 'commit', detail.hash);
    area.details.textContent = `${detail.hash}\n${detail.author} <${detail.email}>\n${detail.date}\nParents: ${detail.parents.join(', ') || '(root commit)'}\n\n${detail.message}`;
  }
  function select(side, hash) {
    state.selected[side] = hash; save(); renderList(side);
    const area = containers[side];
    area.files.replaceChildren(element('div', 'Loading commit changes…', 'empty'));
    area.details.textContent = '';
    if (details[hash]) showDetails(side, details[hash]);
    else api.postMessage({ type: 'commit', side, hash });
  }
  function renderList(side) {
    const area = containers[side], page = data[side];
    const query = (state.searches[side] || '').toLowerCase();
    const visible = page.commits.filter(c => `${c.subject} ${c.author} ${c.date} ${c.hash}`.toLowerCase().includes(query));
    area.list.replaceChildren();
    visible.forEach(commit => {
      const row = element('button', undefined, `commit${state.selected[side] === commit.hash ? ' active' : ''}`);
      row.title = `${commit.subject}\n${commit.author} • ${commit.date}\n${commit.hash}`;
      row.append(element('span', commit.subject), element('span', commit.author),
        element('span', commit.date.replace('T', ' ').slice(0, 16), 'date'), element('span', commit.hash.slice(0, 7), 'hash'));
      row.onclick = () => select(side, commit.hash);
      area.list.append(row);
    });
    if (!visible.length) area.list.append(element('div', page.total === 0
      ? `${area.other} contains all commits from ${area.own}.` : 'No matching commits in loaded history.', 'empty'));
    area.count.textContent = `${visible.length} shown / ${page.commits.length} loaded / ${page.total} unique commits`;
    area.more.hidden = page.commits.length >= page.total;
    area.more.disabled = loading.has(side);
  }
  ['selected', 'current'].forEach(side => {
    const own = side === 'selected' ? data.ref : data.currentLabel;
    const other = side === 'selected' ? data.currentLabel : data.ref;
    const section = element('section', undefined, 'direction');
    const history = element('div', undefined, 'history');
    const toolbar = element('div', undefined, 'toolbar');
    const search = element('input'); search.type = 'search'; search.placeholder = 'Filter by message, hash, author or date';
    search.setAttribute('aria-label', `Filter commits unique to ${own}`); search.value = state.searches[side] || '';
    search.oninput = () => { state.searches[side] = search.value; save(); renderList(side); };
    toolbar.append(search);
    const list = element('div', undefined, 'list'), footer = element('div', undefined, 'footer');
    const count = element('span'), more = element('button', 'Load more');
    more.onclick = () => { loading.add(side); renderList(side); api.postMessage({ type: 'more', side }); };
    footer.append(count, more);
    history.append(toolbar, element('div', `Commits in ${own} that do not exist in ${other}`, 'banner'), list, footer);
    const inspector = element('div', undefined, 'inspector');
    const inspectorTitle = element('div', 'Select a commit to view changes', 'inspector-title');
    const fileArea = element('div', undefined, 'files'); fileArea.append(element('div', 'Select a commit to view changes', 'empty'));
    const detailArea = element('div', 'Commit details', 'details');
    inspector.append(inspectorTitle, fileArea, detailArea); section.append(history, inspector);
    document.getElementById('histories').append(section);
    containers[side] = { list, count, more, files: fileArea, details: detailArea, inspectorTitle, own, other };
    renderList(side);
    if (state.selected[side]) select(side, state.selected[side]);
  });
  files(document.getElementById('branch-files'), data.files, 'branch');
  function mode() {
    const showFiles = state.mode === 'files';
    document.getElementById('histories').style.display = showFiles ? 'none' : 'grid';
    document.getElementById('branch-files').style.display = showFiles ? 'block' : 'none';
    document.getElementById('toggle').textContent = showFiles ? 'Unique commits' : `Branch file differences (${data.files.length})`;
  }
  document.getElementById('toggle').onclick = () => { state.mode = state.mode === 'files' ? 'history' : 'files'; save(); mode(); };
  mode();
  window.addEventListener('message', event => {
    const message = event.data;
    if (message.type === 'detail' && containers[message.side]) showDetails(message.side, message.detail);
    if (message.type === 'page' && containers[message.side]) {
      data[message.side] = message.page; loading.delete(message.side); renderList(message.side);
    }
    if (message.type === 'error') {
      document.getElementById('error').textContent = message.message;
      loading.clear(); ['selected', 'current'].forEach(renderList);
    }
  });
}

/** Isolated immutable comparison panel. Never trust hashes/paths sent by its webview. */
function openComparison(vscode, context, git, result, openDiff, onActive, onClose) {
  const panel = vscode.window.createWebviewPanel('git-branch.compare', `Compare: ${result.ref} ↔ ${result.currentLabel}`,
    vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [], retainContextWhenHidden: true });
  panel.iconPath = new vscode.ThemeIcon('git-compare');
  const cache = new Map();
  const loading = new Set();
  let disposed = false;
  const listener = panel.webview.onDidReceiveMessage(async message => {
    if (disposed || !message || typeof message !== 'object') return;
    try {
      if (message.type === 'more') {
        const side = message.side;
        if (!['selected', 'current'].includes(side) || loading.has(side)) return;
        const page = result[side];
        if (page.commits.length >= page.total) return;
        loading.add(side);
        try {
          const next = await git.uniqueCommits(side === 'selected' ? result.left : result.right,
            side === 'selected' ? result.right : result.left, page.commits.length);
          if (disposed) return;
          page.commits.push(...next.commits);
          await panel.webview.postMessage({ type: 'page', side, page });
        } finally { loading.delete(side); }
      } else if (message.type === 'commit') {
        const side = message.side;
        if (!['selected', 'current'].includes(side) || !result[side].commits.some(c => c.hash === message.hash)) return;
        if (!cache.has(message.hash)) {
          const detail = await git.commitDetails(message.hash);
          if (disposed) return;
          cache.set(message.hash, detail);
        }
        if (!disposed) await panel.webview.postMessage({ type: 'detail', side, detail: cache.get(message.hash) });
      } else if (message.type === 'diff') {
        const source = message.scope === 'branch' ? result : message.scope === 'commit' ? cache.get(message.hash) : undefined;
        if (!source || !Number.isSafeInteger(message.index) || message.index < 0 || !source.files[message.index]) return;
        await openDiff({ ...source.files[message.index], left: source.left, right: source.right,
          ref: message.scope === 'branch' ? result.ref : source.left?.slice(0, 7) || '(empty tree)',
          rightLabel: message.scope === 'branch' ? result.currentLabel : message.hash.slice(0, 7) });
      }
    } catch (error) {
      if (!disposed) await panel.webview.postMessage({ type: 'error', message: error.message });
    }
  });
  const activeListener = panel.onDidChangeViewState(event => { if (event.webviewPanel.active) onActive(result); });
  const closeListener = panel.onDidDispose(() => {
    disposed = true; cache.clear(); listener.dispose(); activeListener.dispose(); closeListener.dispose(); onClose(result);
  });
  context.subscriptions.push(panel);
  panel.webview.html = comparisonHtml(result);
  onActive(result);
  return panel;
}

/** Working-tree list is refreshable; paths and snapshot hashes are taken only from host results. */
function openWorkingTree(vscode, context, result, reload, openDiff) {
  const panel = vscode.window.createWebviewPanel('git-branch.worktree', `Working Tree Diff: ${result.ref}`,
    vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [], retainContextWhenHidden: true });
  panel.iconPath = new vscode.ThemeIcon('git-compare');
  let disposed = false, refreshing = false, generation = 0;
  result = { ...result, generation };
  const listener = panel.webview.onDidReceiveMessage(async message => {
    if (disposed || !message || typeof message !== 'object') return;
    try {
      if (message.type === 'refresh' && !refreshing) {
        refreshing = true;
        try {
          const next = await reload();
          if (disposed) return;
          result = { ...next, generation: ++generation };
          await panel.webview.postMessage({ type: 'worktree', result });
        } finally { refreshing = false; }
      } else if (message.type === 'diff' && message.scope === 'worktree') {
        // Do not open a stale index while refresh is replacing the file list.
        if (refreshing || message.generation !== result.generation || !Number.isSafeInteger(message.index) || message.index < 0 || !result.files[message.index]) return;
        await openDiff({ ...result.files[message.index], left: result.left, right: null,
          ref: `${result.ref} ${result.left.slice(0, 7)}`, rightLabel: 'Working Tree', worktree: true });
      }
    } catch (error) {
      if (!disposed) await panel.webview.postMessage({ type: 'error', message: error.message });
    }
  });
  const closeListener = panel.onDidDispose(() => { disposed = true; listener.dispose(); closeListener.dispose(); });
  context.subscriptions.push(panel);
  panel.webview.html = comparisonHtml(result);
  return panel;
}

module.exports = { comparisonHtml, comparisonClient, openComparison, openWorkingTree };
