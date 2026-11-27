'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');
const test = require('node:test');
const { compileFunction } = require('node:vm');
const { t: message } = require('../src/i18n');

class Emitter {
  listeners = new Set();
  event = listener => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };
  fire(value) { for (const listener of this.listeners) listener(value); }
  dispose() { this.listeners.clear(); }
}

function uri(relative, authority = '') {
  const fsPath = path.resolve(relative);
  return { scheme: authority ? 'vscode-remote' : 'file', authority, fsPath, toString: () => `${authority}:${fsPath}` };
}

function setup(t, folders, initial = [], saved) {
  const opened = new Emitter();
  const closed = new Emitter();
  const foldersChanged = new Emitter();
  const toFolders = roots => roots?.map(uri => ({ uri }));
  const workspace = { workspaceFolders: toFolders(folders), onDidChangeWorkspaceFolders: foldersChanged.event };
  const vscode = { EventEmitter: Emitter, workspace };
  const filename = require.resolve('../src/model/repoModel');
  const load = createRequire(filename);
  const module = { exports: {} };
  compileFunction(readFileSync(filename, 'utf8'), ['require', 'module'], { filename })(
    id => id === 'vscode' ? vscode : load(id), module);
  const selectedKey = 'git-branch.selectedRepository';
  const store = new Map(saved ? [[selectedKey, saved.toString()]] : []);
  const registry = new module.exports.RepoRegistry({ workspaceState: {
    get: (key, fallback) => store.get(key) ?? fallback,
    update: async (key, value) => { store.set(key, value); }
  } });
  t.after(() => registry.dispose());
  // Test selection and notifications without starting Git subprocesses.
  registry.refresh = async () => {};
  const repository = rootUri => ({ rootUri, state: { onDidChange: new Emitter().event } });
  registry.attach({ getAPI: () => ({ git: { path: 'git' }, state: 'initialized', repositories: initial.map(repository),
    onDidOpenRepository: opened.event, onDidCloseRepository: closed.event }) }, true);
  return { registry, store, selectedKey, open: root => opened.fire(repository(root)), close: rootUri => closed.fire({ rootUri }),
    changeFolders: roots => { workspace.workspaceFolders = toFolders(roots); foldersChanged.fire(); } };
}

test('a workspace-root repository supersedes a nested repository discovered first', t => {
  const main = uri('work/project');
  const nested = uri('work/project/subproject');
  const { registry, store, open } = setup(t, [main], [nested]);
  assert.equal(registry.active.root, nested);
  open(main);
  assert.equal(registry.active.root, main);
  assert.deepEqual(registry.choices().filter(item => item.description === message('repo.active')).map(item => item.id), [main.toString()]);
  assert.equal(store.size, 0, 'a default must not become a saved manual selection');
});

test('multiple root repositories follow workspace order, including when the first root opens late', t => {
  const first = uri('work/z-first');
  const second = uri('work/a-second');
  const nonGit = uri('work/no-repo');
  const { registry, open, close } = setup(t, [nonGit, first, second], [second]);
  assert.equal(registry.active.root, second);
  open(first);
  assert.equal(registry.active.root, first);
  close(first);
  assert.equal(registry.active.root, second);
});

test('a saved or new manual choice takes precedence over the automatic default', async t => {
  const main = uri('work/project');
  const nested = uri('work/project/subproject');
  const { registry, store, selectedKey, open, close } = setup(t, [main], [nested], nested);
  open(main);
  assert.equal(registry.active.root, nested);
  close(nested);
  assert.equal(registry.active.root, main);
  open(nested);
  assert.equal(registry.active.root, nested);
  await registry.select(main.toString());
  assert.equal(store.get(selectedKey), main.toString());
  assert.equal(registry.active.root, main);
});

test('without an exact workspace root, a sole repository is automatic and multiple repositories require a choice', t => {
  const folder = uri('work');
  const main = uri('work/project');
  const samePathElsewhere = uri('work', 'ssh-remote+other');
  const { registry, open, close } = setup(t, [folder], [main]);
  assert.equal(registry.active.root, main);
  open(samePathElsewhere);
  assert.equal(registry.active, undefined);
  assert.equal(registry.noRepositoryMessage, message('repo.choose'));
  close(main);
  close(samePathElsewhere);
  assert.equal(registry.noRepositoryMessage, message('repo.noOpen'));
});

test('changing workspace folders re-evaluates the default and notifies its consumers', t => {
  const folder = uri('work');
  const nested = uri('work/project');
  const other = uri('other');
  const { registry, changeFolders } = setup(t, [folder], [nested, other]);
  assert.equal(registry.active, undefined);
  const observed = [];
  registry.onChange(() => observed.push(registry.active?.id));
  changeFolders([folder, other]);
  assert.deepEqual(observed, [other.toString()]);
});
