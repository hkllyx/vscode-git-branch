'use strict';

const { t } = require('../i18n');
const { BranchError, errorText, isOid } = require('../util/format');
const { PATCH, APPLY_OPTIONS } = require('./historyActions');
const { sameHead } = require('./refs');
const { pathsOverlap } = require('./updateChanges');
const { regularMode, pathParts, safeWorktreeFile } = require('./worktreePaths');

const OPTIONS = { write: true, offline: true };
const MAX_PATCH_FILES = 200;
const repositoryVersion = file => file.workingTree && !file.worktreeBefore ? file.old : file.new;
const editableFileSide = file => file.worktreeBefore ? file.old || file.new : file.new || file.old;
const canApply = file => !file.workingTree && !file.ambiguous && !file.includesGap && !file.partial &&
  ['A', 'C', 'D', 'M', 'R'].includes(file.status) && [file.old, file.new].filter(Boolean).every(side => regularMode(side.mode));

class SelectedChanges {
  constructor(branches) {
    this.branches = branches;
    this.client = branches.client;
    this.reads = branches.reads;
  }

  async tree(entries) {
    const root = new Map();
    for (const { side, parts } of entries) {
      let folder = root;
      for (const part of parts.slice(0, -1)) {
        if (!folder.has(part)) folder.set(part, new Map());
        folder = folder.get(part);
      }
      folder.set(parts.at(-1), side);
    }
    const write = async folder => {
      const input = [];
      for (const [name, side] of folder) {
        const entry = side instanceof Map ? `040000 tree ${await write(side)}` : `${side.mode} blob ${side.oid}`;
        input.push(`${entry}\t${name}\0`);
      }
      const oid = (await this.client.text(['-c', 'core.quotePath=true', 'mktree', '-z'], { ...OPTIONS, input: input.join('') })).trim();
      if (!isOid(oid)) throw new BranchError(t('git.invalidObjectId'));
      return oid;
    };
    return write(root);
  }

  async apply(files, expectedHead, guard) {
    if (!files.length || files.length > MAX_PATCH_FILES) throw new BranchError(t('git.historyPatchFileLimit', { count: MAX_PATCH_FILES }));
    if (files.some(file => !canApply(file))) throw new BranchError(t('git.historyPatchUnsupported'));
    const work = await this.branches.working();
    if (expectedHead && !sameHead(work.head, expectedHead)) throw new BranchError(t('history.staleAction'));
    const before = [], after = [], paths = new Map();
    const ignoreCase = await this.branches.ignoresCase();
    for (const [index, file] of files.entries()) {
      for (const [side, endpoint] of [[file.status === 'C' ? undefined : file.old, before], [file.new, after]]) {
        if (!side) continue;
        if (!isOid(side.oid)) throw new BranchError(t('git.historyPatchUnsupported'));
        const parts = pathParts(side.pathKey);
        const name = parts.join('/');
        const key = ignoreCase ? name.toLowerCase() : name;
        const existing = paths.get(key);
        if (existing && (existing.index !== index || existing.name !== name)) throw new BranchError(t('git.historyPatchPathsOverlap'));
        const entry = existing || { name, index, key: side.pathKey, before: false };
        if (endpoint === before) entry.before = true;
        paths.set(key, entry);
        endpoint.push({ side, parts });
      }
    }
    // Applying two selected changes must not resolve/delete a directory in
    // order to make room for another selected path.
    for (const key of paths.keys()) {
      for (let i = key.indexOf('/'); i !== -1; i = key.indexOf('/', i + 1)) {
        if (paths.has(key.slice(0, i))) throw new BranchError(t('git.historyPatchPathsOverlap'));
      }
    }
    const inspect = async () => {
      const state = await this.branches.verifyWork(work);
      const blocked = [...state.untrackedPaths, ...await this.reads.ignoredPaths()];
      if (pathsOverlap([...paths.keys()], blocked, ignoreCase)) throw new BranchError(t('git.historyUnsafePaths'));
      for (const entry of paths.values()) {
        const { stat } = await safeWorktreeFile(this.client.root, entry.key, { allowMissing: !entry.before });
        if (stat && !entry.before) throw new BranchError(t('git.historyPatchTargetExists', { path: entry.name }));
      }
      guard?.();
    };
    await inspect();
    // Build only the chosen sides into two private trees. This avoids Git's
    // pathspec expansion, and works for endpoints that come from different commits.
    const [oldTree, newTree] = await Promise.all([this.tree(before), this.tree(after)]);
    const patch = await this.client.buffer(['-c', 'core.quotePath=true', 'diff-tree', '-r', '--no-commit-id', ...PATCH, oldTree, newTree, '--']);
    if (!patch.length) throw new BranchError(t('git.historyPatchUnsupported'));
    const args = ['-c', 'core.protectNTFS=true', '-c', 'core.protectHFS=true', 'apply', '-p1', '--no-unsafe-paths', ...APPLY_OPTIONS];
    try { await this.client.text([...args, '--check', '-'], { ...OPTIONS, input: patch }); }
    catch (error) { throw new BranchError(t('git.historyPatchCheckFailed', { detail: errorText(error) })); }
    await inspect();
    try { await this.client.text([...args, '-'], { ...OPTIONS, input: patch }); }
    catch (error) { throw new BranchError(t('git.historyPatchFailed', { detail: errorText(error) })); }
    return { message: t('git.historyPatchApplied', { count: files.length }) };
  }
}

module.exports = { SelectedChanges, repositoryVersion, editableFileSide, canApply, MAX_PATCH_FILES };
