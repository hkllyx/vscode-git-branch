'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const { t } = require('../i18n');
const { GitClient } = require('../git/gitClient');
const { GitReads } = require('../git/reads');
const { GitActions, WriteQueue } = require('../git/actions');
const { BranchError, errorText } = require('../util/format');

class Lru {
  constructor(limit) { this.limit = limit; this.entries = new Map(); }
  get(key) {
    if (!this.entries.has(key)) return undefined;
    const value = this.entries.get(key);
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }
  set(key, value) {
    this.entries.delete(key);
    this.entries.set(key, value);
    if (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value);
  }
}

const SELECTED = 'git-branch.selectedRepository';
const TAGS = 'git-branch.showTags';

class RepoRegistry {
  constructor(context) {
    this.store = context.workspaceState;
    this.preferred = this.store.get(SELECTED);
    this.showTags = this.store.get(TAGS, false) === true;
    this.repositories = new Map();
    this.queue = new WriteQueue();
    this.emitter = new vscode.EventEmitter();
    this.onChange = this.emitter.event;
    this.connection = [];
    this.instance = [];
    this.availability = t('repo.connecting');
  }

  get active() {
    const preferred = this.repositories.get(this.preferred);
    if (preferred) return preferred;
    // Workspace order wins over Git discovery order. Only exact folder roots count.
    for (const { uri } of vscode.workspace.workspaceFolders ?? []) {
      for (const repo of this.repositories.values()) {
        const { root } = repo;
        if (root.scheme === uri.scheme && root.authority === uri.authority && path.relative(uri.fsPath, root.fsPath) === '') {
          return repo;
        }
      }
    }
    return this.repositories.size === 1 ? this.repositories.values().next().value : undefined;
  }

  get noRepositoryMessage() {
    return this.repositories.size > 1 ? t('repo.choose') : this.availability || t('repo.noOpen');
  }

  choices() {
    const active = this.active;
    return [...this.repositories.values()].map(repo => ({
      id: repo.id, label: repo.name, detail: repo.root.fsPath,
      description: repo === active ? t('repo.active') : undefined
    }));
  }

  async connect() {
    const extension = vscode.extensions.getExtension('vscode.git');
    if (!extension) { this.unavailable(t('repo.gitMissingExtension')); return; }
    try {
      const exports = await extension.activate();
      if (this.disposed) return;
      if (!exports?.getAPI) { this.unavailable(t('repo.gitUnavailable')); return; }
      const attach = enabled => this.attach(exports, enabled);
      if (exports.onDidChangeEnablement) this.instance.push(exports.onDidChangeEnablement(attach));
      attach(exports.enabled !== false);
    } catch (error) {
      this.unavailable(t('repo.connectionError', { detail: errorText(error) }));
    }
  }

  attach(exports, enabled) {
    if (!enabled) { this.unavailable(t('repo.gitDisabled')); return; }
    this.disconnect();
    try {
      const api = exports.getAPI(1);
      if (!api.git?.path) { this.unavailable(t('repo.gitPathMissing')); return; }
      this.availability = api.state === 'uninitialized' ? t('repo.discovering') : '';
      this.connection.push(api.onDidOpenRepository(repository => {
        this.add(repository, api.git.path);
        this.changedRepositories();
      }), api.onDidCloseRepository(repository => {
        this.remove(repository.rootUri.toString());
        this.changedRepositories();
      }));
      this.connection.push(vscode.workspace.onDidChangeWorkspaceFolders(() => this.changedRepositories()));
      if (api.onDidChangeState) this.connection.push(api.onDidChangeState(state => {
        this.availability = state === 'uninitialized' ? t('repo.discovering') : '';
        this.changedRepositories();
      }));
      for (const repository of api.repositories) this.add(repository, api.git.path);
      this.changedRepositories();
    } catch (error) { this.unavailable(t('repo.builtinUnavailable', { detail: errorText(error) })); }
  }

  unavailable(message) {
    this.disconnect();
    this.availability = message;
    this.emitter.fire();
  }

  add(repository, executable) {
    const root = repository.rootUri;
    const id = root.toString();
    if (this.repositories.has(id)) return;
    const client = new GitClient(root.fsPath, executable);
    const repo = {
      id, root, name: path.basename(root.fsPath) || root.fsPath, repository, client,
      reads: new GitReads(client), subscriptions: [], commitCache: new Lru(160), filesCache: new Lru(56)
    };
    this.repositories.set(id, repo);
    repo.subscriptions.push(repository.state.onDidChange(() => this.schedule(repo)));
  }

  changedRepositories() {
    this.emitter.fire();
    const repo = this.active;
    if (repo) void this.refresh(repo);
  }

  remove(id) {
    const repo = this.repositories.get(id);
    if (!repo) return;
    this.repositories.delete(id);
    clearTimeout(repo.timer);
    repo.loading?.abort();
    for (const disposable of repo.subscriptions) disposable.dispose();
  }

  disconnect() {
    for (const disposable of this.connection.splice(0)) disposable.dispose();
    for (const id of this.repositories.keys()) this.remove(id);
  }

  async select(id) {
    const repo = this.repositories.get(id);
    if (!repo) throw new BranchError(t('repo.closed'));
    this.preferred = id;
    this.emitter.fire();
    await this.store.update(SELECTED, id);
    await this.refresh(repo);
  }

  async setTags(show) {
    if (this.showTags === show) return;
    this.showTags = show;
    this.emitter.fire();
    await this.store.update(TAGS, show);
    if (this.active) await this.refresh(this.active);
  }

  schedule(repo) {
    if (this.active !== repo) return;
    clearTimeout(repo.timer);
    repo.timer = setTimeout(() => { void this.refresh(repo); }, 180);
  }

  async initialize(repo) {
    if (repo.dirs) return;
    const dirs = await repo.reads.directories();
    const real = await fs.realpath(dirs.commonDir);
    if (this.repositories.get(repo.id) !== repo || repo.dirs) return;
    repo.queueKey = process.platform === 'win32' ? real.toLowerCase() : real;
    repo.dirs = dirs;
    repo.actions = new GitActions(repo.client, dirs);
    // This also covers linked worktrees and external fetch/checkout/config changes.
    for (const folder of new Set([dirs.gitDir, dirs.commonDir])) {
      for (const glob of ['{HEAD,config,config.worktree,packed-refs,shallow}', 'refs/{heads,remotes,tags}/**']) {
        const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(folder), glob));
        repo.subscriptions.push(watcher, watcher.onDidChange(() => this.schedule(repo)),
          watcher.onDidCreate(() => this.schedule(repo)), watcher.onDidDelete(() => this.schedule(repo)));
      }
    }
  }

  async refresh(repo = this.active) {
    if (!repo || this.repositories.get(repo.id) !== repo || this.disposed) return;
    clearTimeout(repo.timer);
    repo.loading?.abort();
    const request = new AbortController();
    if (repo !== this.active) return;
    repo.loading = request;
    try {
      await (repo.initializing ||= this.initialize(repo).finally(() => { repo.initializing = undefined; }));
      request.signal.throwIfAborted();
      const snapshot = await repo.reads.snapshot(repo.dirs, this.showTags, { signal: request.signal });
      if (repo.loading !== request || request.signal.aborted) return;
      repo.snapshot = snapshot;
      repo.error = undefined;
    } catch (error) {
      if (request.signal.aborted) return;
      repo.error = errorText(error);
    } finally {
      if (repo.loading === request) {
        repo.loading = undefined;
        if (!request.signal.aborted) this.emitter.fire();
      }
    }
  }

  async write(repo, task) {
    if (!repo.actions) throw new BranchError(t('repo.notReady'));
    return this.queue.run(repo.queueKey, async () => {
      if (this.active !== repo || this.repositories.get(repo.id) !== repo) throw new BranchError(t('repo.switchConfirm'));
      if (!vscode.workspace.isTrusted) throw new BranchError(t('repo.untrustedRun'));
      try { return await task(repo.actions); }
      finally {
        // VS Code's native Changes owns its own state; ask it to re-read after a mutation.
        if (this.repositories.get(repo.id) === repo) {
          void Promise.resolve(repo.repository.status()).catch(() => {});
          await this.refresh(repo);
        }
      }
    });
  }

  dispose() {
    this.disposed = true;
    this.disconnect();
    for (const disposable of this.instance.splice(0)) disposable.dispose();
    this.emitter.dispose();
  }
}

module.exports = { RepoRegistry };
