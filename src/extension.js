'use strict';

const path = require('node:path');
const vscode = require('vscode');
const { configureLocale, t } = require('./i18n');
const { RepoRegistry } = require('./model/repoModel');
const { BranchesProvider } = require('./views/branchesProvider');
const { BranchActivation } = require('./views/branchActivation');
const { GraphController } = require('./panel/graphController');
const { HistoryDocuments, SCHEME } = require('./panel/historyDocuments');
const { HEADS } = require('./git/actions');
const { RESET_MODES } = require('./git/historyActions');
const { SelectedChanges } = require('./git/selectedChanges');
const { orderRefs } = require('./git/parse');
const { ALL } = require('./panel/historyState');
const { BranchError, errorText, shortOid } = require('./util/format');

function activate(context) {
  configureLocale(vscode.env.language);
  const registry = new RepoRegistry(context);
  const branches = new BranchesProvider(registry);
  const tree = vscode.window.createTreeView('git-branch.branches', { treeDataProvider: branches });
  const branchActivation = new BranchActivation();
  const documents = new HistoryDocuments();
  const ui = new WorkbenchActions(registry);
  const history = new GraphController(context, registry, documents, ui);
  ui.history = history;
  let activeRepo = registry.active;
  context.subscriptions.push(registry, branches, tree, history, documents,
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, documents),
    vscode.window.registerWebviewViewProvider('git-branch.log', history, { webviewOptions: { retainContextWhenHidden: true } }),
    tree.onDidChangeSelection(({ selection }) => branchActivation.selectionChanged(selection[0])),
    tree.onDidChangeVisibility(() => branchActivation.reset()),
    registry.onChange(() => {
      if (activeRepo !== registry.active) branchActivation.reset();
      activeRepo = registry.active;
      tree.description = registry.repositories.size > 1 ? activeRepo?.name : undefined;
      branches.refresh();
    }));
  void vscode.commands.executeCommand('setContext', 'git-branch.tagsVisible', registry.showTags);
  const register = (id, action) => context.subscriptions.push(vscode.commands.registerCommand(`git-branch.${id}`, async node => {
    try { return await action(node); }
    catch (error) { await ui.report(error, registry.active); }
  }));
  register('refresh', () => registry.refresh());
  register('selectRepository', () => ui.chooseRepository());
  register('showTags', () => ui.setTags(true));
  register('hideTags', () => ui.setTags(false));
  register('openLog', () => history.show());
  register('activateRef', node => {
    const nativeDoubleClick = vscode.workspace.getConfiguration('workbench.list').get('openMode') === 'doubleClick';
    if (branchActivation.activate(node, nativeDoubleClick)) return ui.openHistory(node);
  });
  register('openHistory', node => { branchActivation.reset(); return ui.openHistory(node); });
  register('find', () => ui.find());
  register('create', () => ui.create());
  register('createFrom', node => node && ui.create(node));
  register('checkout', node => ui.checkout(node));
  register('checkoutRemote', node => ui.checkout(node));
  register('checkoutUpdate', node => ui.checkoutUpdate(node));
  register('pull', node => ui.update(node));
  register('push', node => ui.push(node));
  register('compare', () => ui.chooseComparison());
  register('compareWithCurrent', node => ui.compareWithCurrent(node));
  register('compareWith', node => ui.compareWith(node));
  register('compareWorktree', node => ui.compareWorktree(node));
  register('mergeIntoCurrent', node => ui.integrate(node, 'merge', false));
  register('rebaseCurrent', node => ui.integrate(node, 'rebase', false));
  register('pullMerge', node => ui.integrate(node, 'merge', true));
  register('pullRebase', node => ui.integrate(node, 'rebase', true));
  register('newWorktree', node => ui.newWorktree(node));
  register('copyBranchName', node => ui.copyBranchName(node));
  register('renameBranch', node => ui.renameBranch(node));
  register('deleteBranch', node => ui.deleteBranch(node));
  register('copyRevision', context => history.commitCommand('copyRevision', context));
  register('cherryPick', context => history.commitCommand('cherryPick', context));
  register('checkoutRevision', context => history.commitCommand('checkoutRevision', context));
  register('compareLocal', context => history.commitCommand('compareLocal', context));
  register('reset', context => history.commitCommand('reset', context));
  register('revert', context => history.commitCommand('revert', context));
  register('undo', context => history.commitCommand('undo', context));
  register('editMessage', context => history.commitCommand('editMessage', context));
  register('squash', context => history.commitCommand('squash', context));
  register('drop', context => history.commitCommand('drop', context));
  register('newBranch', context => history.commitCommand('newBranch', context));
  register('newTag', context => history.commitCommand('newTag', context));
  register('editSource', context => history.fileCommand('editSource', context));
  register('openRepositoryVersion', context => history.fileCommand('openRepositoryVersion', context));
  register('applyFiles', context => history.fileCommand('applyFiles', context));
  if (vscode.workspace.isTrusted) void registry.connect();
  else registry.unavailable(t('repo.untrusted'));
}

class WorkbenchActions {
  constructor(registry) { this.registry = registry; }

  async report(error, repo) {
    const notify = error.warning ? vscode.window.showWarningMessage : vscode.window.showErrorMessage;
    const action = error.terminal && repo ? [t('repo.openTerminal')] : [];
    if (await notify(`Git Branch: ${errorText(error)}`, ...action) === action[0] && action.length) {
      vscode.window.createTerminal({ name: `Git · ${repo.name}`, cwd: repo.root }).show();
    }
  }

  async chooseRepository() {
    const items = this.registry.choices();
    if (!items.length) throw new BranchError(this.registry.noRepositoryMessage);
    const selected = await vscode.window.showQuickPick(items, { title: t('repo.pickGit'), matchOnDetail: true });
    if (selected) await this.registry.select(selected.id);
    return selected ? this.registry.active : undefined;
  }

  async repo(node) {
    let repo = this.registry.active;
    if (node) {
      if (!repo || node.repoId !== repo.id || typeof node.ref !== 'string') throw new BranchError(t('repo.refNotActive'));
    } else if (!repo && this.registry.repositories.size > 1) {
      repo = await this.chooseRepository();
      if (!repo) return undefined;
    }
    if (!repo) throw new BranchError(this.registry.noRepositoryMessage);
    if (!repo.snapshot || repo.error) await this.registry.refresh(repo);
    this.assertActive(repo);
    return repo;
  }

  assertActive(repo) {
    if (this.registry.active !== repo) throw new BranchError(t('repo.switchSelect'));
    if (repo.error) throw new BranchError(t('repo.readError', { detail: repo.error }), { warning: false });
    if (!repo.snapshot || !repo.actions) throw new BranchError(t('repo.notReady'));
  }

  async setTags(show) {
    await this.registry.setTags(show);
    await vscode.commands.executeCommand('setContext', 'git-branch.tagsVisible', show);
  }

  items(repo, { includeTags = false, localOnly = false, includeHead = false, includeAll = false } = {}) {
    const { snapshot } = repo;
    const items = [];
    const kindLabels = { local: t('branch.local'), remote: t('branch.remote'), tag: t('branch.tag') };
    if (includeAll) items.push({ ref: ALL, label: t('history.allBranches'), description: t('history.allBranchesDescription') });
    if (includeHead && snapshot.head.oid) items.push({ ref: 'HEAD', label: 'HEAD', description: shortOid(snapshot.head.oid) });
    items.push(...orderRefs(snapshot.allRefs, snapshot.head.ref).filter(item => item.oid && (!localOnly || item.kind === 'local')
      && (item.kind !== 'tag' || (includeTags && this.registry.showTags))).map(({ ref, name, kind, oid }) => ({
      ref, label: name,
      description: `${ref === snapshot.head.ref ? t('branch.current') : kindLabels[kind]} · ${shortOid(oid)}`
    })));
    return items;
  }

  async pickRef(repo, title, options = {}) {
    this.assertActive(repo);
    let items = this.items(repo, options).filter(item => item.ref !== options.exclude);
    if (options.preferred) items = [...items.filter(item => item.ref === options.preferred), ...items.filter(item => item.ref !== options.preferred)];
    if (!items.length) throw new BranchError(t('branch.noAvailable'));
    const picked = await vscode.window.showQuickPick(items, { title, matchOnDescription: true });
    this.assertActive(repo);
    return picked?.ref;
  }

  async openHistory(node) {
    const repo = await this.repo(node);
    if (!repo || !node) return;
    await this.applyRange(repo, node.ref);
  }

  async applyRange(repo, ref, show = true) {
    this.assertActive(repo);
    if (ref !== ALL && ref !== 'HEAD') {
      const record = repo.snapshot.byRef.get(ref);
      if (!record?.oid || (record.kind === 'tag' && !this.registry.showTags)) throw new BranchError(t('branch.unavailableRef'));
    }
    this.history.setRange(repo, ref);
    if (show) await this.history.show();
  }

  async find() {
    const repo = await this.repo();
    if (!repo) return;
    const ref = await this.pickRef(repo, t('branch.findRef'), { includeTags: true, includeHead: true });
    if (ref) await this.applyRange(repo, ref);
  }

  async chooseRange() {
    const repo = await this.repo();
    if (!repo) return;
    const ref = await this.pickRef(repo, t('history.pickRange'), { includeTags: true, includeHead: true, includeAll: true, preferred: this.history.range });
    if (ref) await this.applyRange(repo, ref, false);
  }

  checkEditors(repo) {
    this.assertActive(repo);
    const dirty = vscode.workspace.textDocuments.some(doc => {
      if (!doc.isDirty || doc.isUntitled || doc.uri.scheme !== repo.root.scheme || doc.uri.authority !== repo.root.authority) return false;
      const relative = path.relative(repo.root.fsPath, doc.uri.fsPath);
      return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    });
    if (dirty) throw new BranchError(t('repo.unsavedEditors'));
  }

  async askName(repo, title, value, validate) {
    this.assertActive(repo);
    const input = vscode.window.createInputBox();
    input.title = title;
    input.prompt = repo.name;
    input.value = value ?? '';
    if (value !== undefined) input.valueSelection = [value.length, value.length];
    input.ignoreFocusOut = true;
    const name = await new Promise(resolve => {
      let timer, revision = 0, accepted;
      const check = async accept => {
        const text = input.value;
        const checking = ++revision;
        let error;
        try {
          this.assertActive(repo);
          if (!text) throw new BranchError(t('branch.nameEmpty'));
          await validate(text);
          this.assertActive(repo);
        } catch (failure) {
          error = { message: errorText(failure), severity: vscode.InputBoxValidationSeverity.Error };
        }
        if (checking !== revision || text !== input.value) return;
        input.validationMessage = error;
        if (accept && !error) {
          accepted = text;
          input.hide();
        }
      };
      input.onDidChangeValue(() => {
        ++revision;
        clearTimeout(timer);
        input.validationMessage = undefined;
        timer = setTimeout(() => { void check(false); }, 120);
      });
      input.onDidAccept(() => {
        clearTimeout(timer);
        void check(true);
      });
      input.onDidHide(() => {
        ++revision;
        clearTimeout(timer);
        resolve(accepted);
      });
      input.show();
      // Paint a conflict for a prefilled name, even if the user has not typed yet.
      if (input.value) void check(false);
    }).finally(() => input.dispose());
    if (name !== undefined) this.assertActive(repo);
    return name;
  }

  async confirm(repo, title, lines, action) {
    this.assertActive(repo);
    return await vscode.window.showWarningMessage(title, {
      modal: true, detail: [t('repo.confirmLabel', { name: repo.name, path: repo.root.fsPath }), ...lines].join('\n')
    }, action) === action;
  }

  async run(repo, title, task, { notify = true } = {}) {
    try {
      this.assertActive(repo);
      const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: false },
        () => this.registry.write(repo, task));
      if (result.warning) void vscode.window.showWarningMessage(result.message);
      else if (notify) void vscode.window.showInformationMessage(result.message);
      return result;
    } catch (error) { await this.report(error, repo); }
  }

  async create(node) {
    const repo = await this.repo(node);
    if (!repo) return;
    if (!repo.snapshot.head.oid && !node) throw new BranchError(t('branch.firstCommit'));
    const startRef = node?.ref || await this.pickRef(repo, t('action.createStart'), { includeHead: true, preferred: 'HEAD' });
    if (!startRef) return;
    const actions = repo.actions;
    const tip = await actions.named(startRef);
    const startName = tip.ref === 'HEAD' ? tip.headRef?.slice(HEADS.length) : tip.name;
    const source = { name: tip.name, oid: shortOid(tip.oid) };
    const name = await this.askName(repo, t('action.createName', source), startName, value => actions.assertFree(value));
    if (!name) return;
    const result = await this.run(repo, t('action.creating', { name }), git => git.create({ name, tip }), { notify: false });
    if (result && !result.warning) await this.offerCheckout(repo, name, tip.oid);
  }

  async offerCheckout(repo, name, oid) {
    const checkout = t('action.checkoutButton');
    if (await vscode.window.showInformationMessage(t('action.checkoutCreated', { name, repo: repo.name }), checkout) !== checkout) return;
    this.checkEditors(repo);
    const plan = await repo.actions.prepareCheckout(HEADS + name);
    if (!plan.already && plan.tip.oid !== oid) throw new BranchError(t('git.changed', { what: t('git.changedBranchTip') }));
    await this.runCheckout(repo, plan);
  }

  async runCheckout(repo, plan) {
    if (plan.already) { void vscode.window.showInformationMessage(t('action.alreadyCheckedOut', { name: plan.name })); return; }
    await this.run(repo, t('action.checkingOut', { name: plan.name }), git => git.checkout(plan, () => this.checkEditors(repo)));
  }

  async checkout(node) {
    const repo = await this.repo(node);
    if (!repo) return;
    const ref = node?.ref || await this.pickRef(repo, t('action.checkoutPick'));
    if (!ref) return;
    this.assertActive(repo);
    const actions = repo.actions;
    const plan = ref.startsWith('refs/remotes/') ? await actions.prepareRemoteCheckout(ref) : await actions.prepareCheckout(ref);
    if (!plan.already) this.checkEditors(repo);
    await this.runCheckout(repo, plan);
  }

  async copyBranchName(node) {
    if (!node) return;
    const repo = await this.repo(node);
    const { name } = await repo.actions.named(node.ref);
    this.assertActive(repo);
    await vscode.env.clipboard.writeText(name);
    void vscode.window.showInformationMessage(t('action.branchCopied', { name }));
  }

  async renameBranch(node) {
    if (!node) return;
    const repo = await this.repo(node);
    const actions = repo.actions;
    const tip = await actions.branchToManage(node.ref, { rename: true });
    const name = await this.askName(repo, t('action.renameName', { name: tip.name }), tip.name, async value => {
      if (value !== tip.name) await actions.assertFree(value);
    });
    if (!name || name === tip.name) return;
    await this.run(repo, t('action.renaming', { name: tip.name }), git => git.renameBranch(tip, name));
  }

  async deleteBranch(node) {
    if (!node) return;
    const repo = await this.repo(node);
    if (node.ref.startsWith('refs/remotes/')) {
      const plan = await repo.actions.prepareRemoteDelete(node.ref);
      if (await this.confirm(repo, t('action.deleteRemoteConfirm'), [
        t('action.deleteRemoteLabel', { remote: plan.upstream.remote, ref: plan.upstream.source, oid: shortOid(plan.tip.oid) }),
        t('action.deleteRemotePolicy')
      ], t('action.deleteButton'))) await this.run(repo, t('action.deleting', { name: plan.tip.name }), git => git.deleteRemote(plan));
      return;
    }
    const tip = await repo.actions.branchToManage(node.ref);
    if (await this.confirm(repo, t('action.deleteConfirm'), [
      t('action.branchLabel', { name: tip.name, oid: shortOid(tip.oid) }), t('action.deleteMergedOnly')
    ], t('action.deleteButton'))) await this.run(repo, t('action.deleting', { name: tip.name }), git => git.deleteBranch(tip));
  }

  confirmStash(repo, name) {
    return this.confirm(repo, t('action.updateStashConfirm'), [
      t('action.updateStashBranch', { name }), t('action.pullPolicy')
    ], t('action.updateStashButton'));
  }

  async update(node) {
    const repo = await this.repo(node);
    if (!repo) return;
    const plan = await repo.actions.prepareUpdate(node?.ref);
    if (plan.work) this.checkEditors(repo);
    await this.run(repo, t('action.pulling', { name: plan.tip.name }),
      git => git.update(plan, () => this.checkEditors(repo), () => this.confirmStash(repo, plan.tip.name)));
  }

  async checkoutUpdate(node) {
    if (!node) return;
    const repo = await this.repo(node);
    this.checkEditors(repo);
    const plan = await repo.actions.prepareCheckoutUpdate(node.ref);
    const { tip } = plan.update;
    await this.run(repo, t('action.pulling', { name: tip.name }),
      git => git.checkoutAndUpdate(plan, () => this.checkEditors(repo), () => this.confirmStash(repo, tip.name)));
  }

  async integrate(node, mode, fetch) {
    if (!node) return;
    const repo = await this.repo(node);
    this.checkEditors(repo);
    const plan = await repo.actions.prepareIntegration(node.ref, mode, fetch);
    const rebase = mode === 'rebase';
    const title = fetch ? t(rebase ? 'command.pullRebase' : 'command.pullMerge') : t(rebase ? 'command.rebaseCurrent' : 'command.mergeIntoCurrent');
    await this.run(repo, `${title}…`, git => git.integrate(plan, () => this.checkEditors(repo), oid => this.confirm(repo, title, [
      t('action.integrationCurrentLabel', { name: plan.current.name, oid: shortOid(plan.current.oid) }),
      t('action.integrationSource', { name: plan.tip.name, oid: shortOid(oid) }), t('action.rebaseRewrite')
    ], t('action.rebaseButton'))));
  }

  async newWorktree(node) {
    if (!node) return;
    const repo = await this.repo(node);
    const actions = repo.actions;
    const plan = await actions.prepareWorktree(node.ref);
    const { tip } = plan;
    const name = plan.newBranch ? await this.askName(repo, t('action.worktreeBranch', { source: tip.name }),
      plan.suggestedName, value => actions.assertFree(value)) : tip.name;
    if (!name) return;
    const root = repo.root.fsPath;
    const suggestedPath = path.resolve(root, '..', `${path.basename(root)}-${name.replaceAll('/', '-')}`);
    const value = await this.askName(repo, t('action.worktreePath', { name }), suggestedPath, value => actions.worktreePath(value));
    if (!value) return;
    const target = await actions.worktreePath(value);
    await this.run(repo, t('action.worktreeCreating'), git => git.createWorktree(plan, target, name));
  }

  async push(node) {
    const repo = await this.repo(node);
    if (!repo) return;
    const ref = node?.ref || await this.pickRef(repo, t('action.pushPick'), { localOnly: true, preferred: repo.snapshot.head.ref });
    if (!ref) return;
    const actions = repo.actions;
    const tip = await actions.pushSource(ref);
    const remotes = await actions.remotes();
    if (!remotes.length) throw new BranchError(t('action.pushRemoteRequired'));
    const preset = actions.preferredPush(tip);
    const ordered = [...new Set([...(remotes.includes(preset?.remote) ? [preset.remote] : []), ...remotes])];
    const choice = await vscode.window.showQuickPick(ordered.map(label => ({ label, description: label === preset?.remote ? t('action.pushConfiguredUpstream') : undefined })), {
      title: t('action.pushPickRemote', { name: tip.name })
    });
    if (!choice) return;
    const remote = choice.label;
    const name = await this.askName(repo, t('action.pushTargetFrom', { remote, source: tip.name }), remote === preset?.remote ? preset.name : tip.name, value => actions.validateName(value));
    if (!name) return;
    let set = false;
    if (!preset || remote !== preset.remote || name !== preset.name) {
      const canTrack = await actions.pushTracking(remote, HEADS + name);
      if (canTrack) {
        const mode = await vscode.window.showQuickPick([
          { label: t('action.pushOnly'), setUpstream: false }, { label: t('action.pushAndTrack'), setUpstream: true }
        ], { title: t('action.pushModeTitle', { remote, name }) });
        if (!mode) return;
        set = mode.setUpstream;
      }
    }
    const plan = await actions.preparePush(tip, remote, name, set);
    await this.run(repo, t('action.pushing', { name: tip.name }), git => git.push(plan));
  }

  async historyCommit(kind, repo, head, rows, guard) {
    const oids = rows.map(row => row.oid);
    const [oid] = oids;
    const revision = shortOid(oid);
    const history = repo.actions.history;
    guard();
    if (kind === 'copyRevision') {
      await vscode.env.clipboard.writeText(oids.join('\n'));
      return;
    }
    if (kind === 'compareLocal') {
      await history.assertCommit(oid);
      guard();
      this.history.compareWorktree(repo, { name: revision, oid });
      return;
    }
    if (kind === 'newBranch' || kind === 'newTag') {
      const branch = kind === 'newBranch';
      const name = await this.askName(repo, t(branch ? 'action.historyBranchName' : 'action.historyTagName', { oid: revision }), undefined,
        value => branch ? repo.actions.assertFree(value) : history.assertTagName(value));
      if (!name) return;
      guard();
      const title = branch ? t('action.creating', { name }) : t('action.historyCreatingTag', { name });
      const result = await this.run(repo, title, git => git.history.newRef(branch ? 'branch' : 'tag', oid, name, guard), { notify: !branch });
      if (branch && result && !result.warning) await this.offerCheckout(repo, name, oid);
      return;
    }

    this.checkEditors(repo);
    const plan = await history.prepare(kind, kind === 'cherryPick' ? oids.reverse() : oids, head);
    guard();
    let mode, message;
    if (kind === 'reset') {
      const labels = [t('action.historyResetSoft'), t('action.historyResetMixed'), t('action.historyResetKeep'), t('action.historyResetHard')];
      const details = [t('action.historyResetSoftDetail'), t('action.historyResetMixedDetail'), t('action.historyResetKeepDetail'), t('action.historyResetHardDetail')];
      const selected = await vscode.window.showQuickPick(RESET_MODES.map((option, i) => ({ mode: option, label: labels[i], detail: details[i] })), {
        ignoreFocusOut: true, title: t('action.historyResetTitle', { repo: repo.name, branch: plan.branch.name, from: shortOid(head.oid), to: revision }),
        placeHolder: t('action.historyResetChoose')
      });
      if (!selected) return;
      mode = selected.mode;
    } else if (kind === 'editMessage') {
      message = await this.history.askCommitMessage(repo, head, oid, plan.commit.message);
      if (message === undefined || message === plan.commit.message) return;
    } else if (['undo', 'squash', 'drop'].includes(kind)) {
      const label = { undo: t('action.historyUndo'), squash: t('action.historySquash'), drop: t('action.historyDrop') }[kind];
      const policy = { undo: t('action.historyUndoPolicy'), squash: t('action.historySquashPolicy'), drop: t('action.historyDropPolicy') }[kind];
      if (!await this.confirm(repo, label, [t('history.editContext', { repo: repo.name, branch: plan.branch.name, oid: revision }), policy], label)) return;
    }
    guard();
    const result = await this.run(repo, t('action.historyRunning'), git => git.history.execute(plan, { mode, message, check: () => {
      guard();
      this.checkEditors(repo);
    } }));
    const input = repo.repository.inputBox;
    if (result?.draft && input?.value === '') input.value = result.draft;
  }

  async applyHistoryFiles(repo, head, files, guard) {
    this.checkEditors(repo);
    await this.run(repo, t('action.historyApplying'), git => new SelectedChanges(git).apply(files, head, () => {
      guard();
      this.checkEditors(repo);
    }));
  }

  async startComparison(repo, base, target) {
    const [left, right] = await Promise.all([repo.actions.named(base), repo.actions.named(target)]);
    this.assertActive(repo);
    this.history.compare(repo, left, right);
    await this.history.show();
  }

  async chooseComparison() {
    const repo = await this.repo();
    if (!repo) return;
    const base = await this.pickRef(repo, t('action.comparePickBase'), { preferred: repo.snapshot.head.ref });
    if (!base) return;
    const target = await this.pickRef(repo, t('action.comparePickTarget'), { exclude: base });
    if (target) await this.startComparison(repo, base, target);
  }

  async compareWithCurrent(node) {
    if (!node) return;
    const repo = await this.repo(node);
    const { ref } = await repo.reads.head();
    if (!ref) throw new BranchError(t('action.compareDetached'));
    if (ref === node.ref) throw new BranchError(t('action.compareSameBranch'));
    await this.startComparison(repo, ref, node.ref);
  }

  async compareWith(node) {
    if (!node) return;
    const repo = await this.repo(node);
    const base = await repo.actions.named(node.ref);
    const target = await this.pickRef(repo, t('action.comparePickWith', { name: base.name }), { exclude: base.ref });
    if (target) await this.startComparison(repo, base.ref, target);
  }

  async compareWorktree(node) {
    if (!node) return;
    const repo = await this.repo(node);
    const base = await repo.actions.named(node.ref);
    this.assertActive(repo);
    this.history.compareWorktree(repo, base);
    await this.history.show();
  }
}

module.exports = { activate };
