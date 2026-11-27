'use strict';

const vscode = require('vscode');
const { t } = require('../i18n');
const { orderRefs } = require('../git/parse');
const { formatTracking, shortOid } = require('../util/format');

const COLLAPSED = vscode.TreeItemCollapsibleState.None;
const EXPANDED = vscode.TreeItemCollapsibleState.Expanded;

class BranchesProvider {
  constructor(registry) {
    this.registry = registry;
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.emitter.event;
  }

  refresh() { this.emitter.fire(undefined); }
  dispose() { this.emitter.dispose(); }

  getTreeItem(node) {
    const item = new vscode.TreeItem(node.label, node.section && node.count ? EXPANDED : COLLAPSED);
    item.id = JSON.stringify([node.repoId, node.section || node.ref || node.label]);
    item.description = node.description;
    item.tooltip = node.tooltip;
    item.contextValue = node.contextValue;
    if (node.icon) item.iconPath = new vscode.ThemeIcon(node.icon, node.color ? new vscode.ThemeColor(node.color) : undefined);
    if (node.ref && node.oid) {
      const summary = [node.tooltip, t('branch.doubleClickHistory')].filter(Boolean).join('\n');
      item.tooltip = summary;
      item.accessibilityInformation = { label: summary };
      item.command = { command: 'git-branch.activateRef', title: t('command.openHistory'), arguments: [node] };
    }
    if (node.choose) item.command = { command: 'git-branch.selectRepository', title: t('repo.pick') };
    return item;
  }

  getChildren(node) {
    const repo = this.registry.active;
    if (!node) return this.roots(repo);
    if (node.section && repo?.id === node.repoId && repo.snapshot) {
      return orderRefs(repo.snapshot.allRefs.filter(ref => ref.kind === node.section), repo.snapshot.head.ref)
        .map(ref => this.branch(repo, ref));
    }
    return [];
  }

  roots(repo) {
    if (!repo) return [{ label: this.registry.noRepositoryMessage, icon: 'info', choose: this.registry.repositories.size > 1 }];
    if (repo.error) return [{ repoId: repo.id, label: t('repo.readErrorLabel'), tooltip: repo.error, icon: 'warning' }];
    const snapshot = repo.snapshot;
    if (!snapshot) return [{ repoId: repo.id, label: t('repo.reading'), icon: 'loading~spin' }];
    const head = snapshot.head;
    const nodes = [{
      repoId: repo.id, ref: 'HEAD', oid: head.oid,
      label: head.ref ? t('branch.headCurrent') : t('branch.headDetached'),
      description: !head.oid ? t('branch.noCommits') : !head.ref ? shortOid(head.oid) : undefined,
      tooltip: head.ref ? head.ref.slice('refs/heads/'.length) : head.oid,
      contextValue: head.oid ? 'gb-head' : undefined,
      icon: 'git-branch', color: 'charts.blue'
    }];
    const kinds = [['local', t('branch.local')], ['remote', t('branch.remote')]];
    if (this.registry.showTags) kinds.push(['tag', t('branch.tags')]);
    for (const [section, label] of kinds) {
      const count = snapshot.allRefs.filter(ref => ref.kind === section).length;
      nodes.push({ repoId: repo.id, section, label, count, description: count ? undefined : t('branch.none') });
    }
    return nodes;
  }

  branch(repo, item) {
    const current = item.ref === repo.snapshot.head.ref;
    const tracking = item.upstream?.tracking;
    const contextValue = current ? 'gb-current' : item.kind === 'tag' && !item.oid ? 'gb-noncommit-tag' : `gb-${item.kind}`;
    return {
      repoId: repo.id, ref: item.ref, oid: item.oid, label: item.name, contextValue,
      icon: item.kind === 'tag' ? 'tag' : 'git-branch',
      color: current ? 'charts.yellow' : undefined,
      description: item.kind === 'tag' && !item.oid ? t('branch.nonCommit') : formatTracking(item.trackingCount),
      tooltip: [item.name, current && t('branch.current'), item.oid,
        tracking && t('branch.upstreamLabel', { name: tracking.replace(/^refs\/remotes\//, '') })].filter(Boolean).join('\n')
    };
  }
}

module.exports = { BranchesProvider };
