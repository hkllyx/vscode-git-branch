'use strict';

const { randomUUID } = require('node:crypto');
const { t } = require('../i18n');
const { GitError } = require('./gitClient');
const { BranchError, errorText, isOid, shortOid } = require('../util/format');

function pathsOverlap(first, second, ignoreCase) {
  const keys = paths => new Set(ignoreCase ? paths.map(file => file.toLowerCase()) : paths);
  const left = keys(first), right = keys(second);
  // A file-to-directory change can also collide with local changes below that path.
  const touches = (paths, against) => {
    for (const file of paths) {
      for (let path = file; path; path = path.slice(0, Math.max(0, path.lastIndexOf('/')))) {
        if (against.has(path)) return true;
      }
    }
    return false;
  };
  return touches(left, right) || touches(right, left);
}

class UpdateStash {
  constructor(client, reads, base, operation = 'Update') {
    this.client = client;
    this.reads = reads;
    this.base = base;
    this.label = `Git Branch ${operation} ${randomUUID()}`;
  }

  async save() {
    let failure;
    try {
      // A root pathspec makes Git stash the tracked paths without its wholesale
      // worktree reset. Neither untracked nor ignored files go into this stash.
      const result = await this.client.query(['-c', 'submodule.recurse=false', 'stash', 'push', '--no-keep-index',
        '--message', this.label, '--', ':/'], { write: true });
      if (result.code !== 0) failure = new GitError('stash', result);
    } catch (error) { failure = error; }
    try {
      const log = await this.client.text(['stash', 'list', '--no-color', '--format=%H%x00%gs']);
      const entries = log.split(/\r?\n/).map(line => line.split('\0'))
        .filter(([oid, subject]) => isOid(oid) && subject?.endsWith(`: ${this.label}`));
      if (entries.length === 1) this.oid = entries[0][0];
      if (this.oid && await this.reads.resolveCommit(`${this.oid}^1`) !== this.base) throw new BranchError(t('git.updateStashBaseChanged'));
    } catch (error) { failure ||= error; }
    if (failure || !this.oid) {
      throw new BranchError(t('git.updateStashFailed', {
        detail: failure ? errorText(failure) : t('git.updateStashMissing'), label: this.label
      }));
    }
  }

  async apply() {
    // Pin by object ID, never a reflog position. Renames could redirect saved
    // edits to a previously ignored path outside the checked set of paths.
    await this.client.text(['-c', 'merge.renames=false', '-c', 'merge.directoryRenames=false', '-c', 'rerere.enabled=false',
      '-c', 'submodule.recurse=false', 'stash', 'apply', '--quiet', '--index', this.oid], { write: true });
  }

  backupMessage() {
    // There is no compare-and-drop for a single native stash reflog entry.
    // Keep our labelled recovery entry even after success, never drop another process's stash.
    return t('git.updateStashKept', { label: this.label, oid: shortOid(this.oid) });
  }
}

module.exports = { pathsOverlap, UpdateStash };
