'use strict';

const { randomUUID } = require('node:crypto');
const vscode = require('vscode');
const { t } = require('../i18n');
const { editableFileSide, repositoryVersion } = require('../git/selectedChanges');
const { regularMode, safeWorktreeFile } = require('../git/worktreePaths');
const { BranchError } = require('../util/format');

const SCHEME = 'git-branch-history';

class HistoryDocuments {
  constructor() { this.documents = new Map(); }

  provideTextDocumentContent(uri) {
    return this.documents.get(uri.toString()) ?? t('history.expiredSnapshot');
  }

  add(side, fallback, text) {
    const file = (side?.path || fallback).split('/').at(-1).replace(/[\u0000-\u001f\\]/g, '_');
    const uri = vscode.Uri.from({ scheme: SCHEME, path: `/${randomUUID()}/${file || t('history.snapshotName')}` });
    this.documents.set(uri.toString(), text);
    while (this.documents.size > 40) this.documents.delete(this.documents.keys().next().value);
    return uri;
  }

  async open(repo, change, signal, isCurrent) {
    const [before, after] = await Promise.all([repo.reads.blob(change.old, signal), change.workingTree
      ? repo.reads.workingBlob(change, signal) : repo.reads.blob(change.new, signal)]);
    if (!isCurrent()) return;
    const left = this.add(change.old, change.path, before);
    const right = this.add(change.new, change.path, after);
    const pathLabel = change.old?.path && change.old.path !== change.path ? `${change.old.path} → ${change.path}` : change.path;
    await vscode.commands.executeCommand('vscode.diff', left, right, `${pathLabel} · ${change.caption}`, { preview: true });
  }

  async openSource(repo, change, guard) {
    const side = editableFileSide(change);
    if (!regularMode(side?.mode)) throw new BranchError(t('git.worktreeNotRegular'));
    const { parts } = await safeWorktreeFile(repo.root.fsPath, side.pathKey);
    guard();
    const uri = vscode.Uri.joinPath(repo.root, ...parts);
    const document = await vscode.workspace.openTextDocument(uri);
    await safeWorktreeFile(repo.root.fsPath, side.pathKey);
    guard();
    await vscode.window.showTextDocument(document, { preview: true });
  }

  async openVersion(repo, change, guard) {
    const side = repositoryVersion(change);
    if (!side || side.mode === '160000') throw new BranchError(t('history.noRepositoryVersion'));
    const text = await repo.reads.blob(side);
    guard();
    await vscode.window.showTextDocument(this.add(side, change.path, text), { preview: true });
  }

  dispose() { this.documents.clear(); }
}

module.exports = { HistoryDocuments, SCHEME };
