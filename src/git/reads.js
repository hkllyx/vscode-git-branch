'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { t } = require('../i18n');
const { GitError } = require('./gitClient');
const { parseRefs, parseLog, parseCommit, parseRawDiff, REF_FORMAT, LOG_FORMAT } = require('./parse');
const { regularMode, safeWorktreeFile } = require('./worktreePaths');
const { isOid, shortOid, stripLineEnd, BranchError } = require('../util/format');

const DIFF = ['-r', '--raw', '-z', '--no-abbrev', '--no-ext-diff', '--no-textconv', '--ignore-submodules=none', '--find-renames', '-l1000'];
const MAX_BLOB = 1024 * 1024;
const PAGE_SIZE = 120;

function assertOid(oid) {
  if (!isOid(oid)) throw new Error(t('git.invalidObjectId'));
  return oid;
}

function ensureResult(command, result, ok = [0]) {
  if (!ok.includes(result.code)) throw new GitError(command, result);
  return result;
}

async function fileExists(target) {
  try { await fs.access(target); return true; }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false; throw error; }
}

function decodeText(bytes) {
  try {
    if (bytes.includes(0)) throw new Error('Binary');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch { throw new BranchError(t('git.blobNotText')); }
}

class GitReads {
  constructor(client) { this.client = client; }

  async directories() {
    const args = ['rev-parse', '--path-format=absolute'];
    const [gitDir, commonDir] = await Promise.all([
      this.client.text([...args, '--git-dir']), this.client.text([...args, '--git-common-dir'])
    ]);
    return { gitDir: stripLineEnd(gitDir), commonDir: stripLineEnd(commonDir) };
  }

  async resolveCommit(ref, opts) {
    const result = await this.client.query(['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], opts);
    ensureResult('rev-parse', result, [0, 1]);
    return result.code === 0 ? assertOid(result.out.toString('ascii').trim()) : undefined;
  }

  async head(opts) {
    const [symref, oid] = await Promise.all([
      this.client.query(['symbolic-ref', '--quiet', '--no-recurse', 'HEAD'], opts), this.resolveCommit('HEAD', opts)
    ]);
    ensureResult('symbolic-ref', symref, [0, 1]);
    const ref = symref.code === 0 ? stripLineEnd(symref.out.toString('utf8')) : undefined;
    return { ref: ref?.startsWith('refs/heads/') ? ref : undefined, oid };
  }

  async refs({ tags = false, ref, trackingCounts = false, ...opts } = {}) {
    const patterns = ref ? [ref] : ['refs/heads/', 'refs/remotes/', ...(tags ? ['refs/tags/'] : [])];
    // Git evaluates upstream:track against each ref's own configured upstream, not HEAD's upstream.
    const format = trackingCounts ? `${REF_FORMAT}%00%(upstream:track,nobracket)` : REF_FORMAT;
    const records = parseRefs(await this.client.text(['for-each-ref', `--format=${format}`, '--', ...patterns], opts));
    if (ref) return records.filter(item => item.ref === ref);
    for (const item of records) {
      if (item.needsPeel) item.oid = await this.resolveCommit(item.ref, opts);
    }
    return records;
  }

  async snapshot(dirs, tags, opts) {
    const [head, allRefs, shallowInfo] = await Promise.all([
      this.head(opts), this.refs({ ...opts, tags, trackingCounts: true }), this.shallowInfo(dirs.commonDir)
    ]);
    const byRef = new Map(allRefs.map(item => [item.ref, item]));
    return { head, allRefs, byRef, ...shallowInfo };
  }

  async shallowInfo(commonDir) {
    let data;
    try { data = await fs.readFile(path.join(commonDir, 'shallow'), 'ascii'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const shallowRoots = new Set(data?.split(/\r?\n/).filter(isOid));
    const shallow = shallowRoots.size ? createHash('sha256').update(data).digest('hex') : '';
    return { shallow, shallowRoots };
  }

  async firstParentHistory(oid, opts) {
    const output = await this.client.text(['rev-list', '--first-parent', '--max-count=10000', assertOid(oid), '--'], opts);
    return new Set(output.split(/\r?\n/).filter(isOid));
  }

  /** The scan cursor counts raw log rows, including rows skipped by the filter. */
  async historyPage({ tips = [], compare, skip = 0, scan, limit = PAGE_SIZE, filter, signal }) {
    if (!compare && !tips.length) return { commits: [], hasMore: false, scanned: scan ?? skip };
    const revs = compare ? ['--left-right', `${assertOid(compare.left.oid)}...${assertOid(compare.right.oid)}`] : ['--stdin'];
    const input = compare ? undefined : `${tips.map(assertOid).join('\n')}\n`;
    const text = filter?.trim().toLowerCase();
    const base = ['log', '-z', '--topo-order', '--no-decorate', '--no-show-signature', '--no-notes',
      `--format=tformat:${LOG_FORMAT}${text ? '%x00%b' : ''}`, ...revs];
    if (!text) {
      const rows = parseLog(await this.client.text([...base, `--skip=${skip}`, `--max-count=${limit + 1}`], { signal, input }),
        Boolean(compare));
      return { commits: rows.slice(0, limit), hasMore: rows.length > limit, scanned: skip + Math.min(rows.length, limit) };
    }
    const chunkSize = 400;
    const matches = [];
    let position = scan ?? 0;
    for (;;) {
      const chunk = parseLog(await this.client.text([...base, `--skip=${position}`, `--max-count=${chunkSize}`],
        { signal, input }), Boolean(compare), true);
      for (const { body, ...row } of chunk) {
        if (row.subject.toLowerCase().includes(text) || body.toLowerCase().includes(text) ||
            row.author.toLowerCase().includes(text) || row.oid.startsWith(text)) {
          // Keep the first match after the page for the next read, even mid-chunk.
          if (matches.length === limit) return { commits: matches, hasMore: true, scanned: position };
          matches.push(row);
        }
        position++;
      }
      if (chunk.length < chunkSize) return { commits: matches, hasMore: false, scanned: position };
    }
  }

  /** Diff of a commit against one of its parents. */
  async commitFilesFromParent(oid, parentOid, opts) {
    assertOid(oid);
    assertOid(parentOid);
    return parseRawDiff(await this.client.buffer(['diff-tree', '--no-commit-id', ...DIFF, parentOid, oid, '--'], opts));
  }

  async divergence(left, right, opts) {
    const result = await this.client.text(['rev-list', '--left-right', '--count', `${assertOid(left)}...${assertOid(right)}`, '--'], opts);
    const counts = /^(\d+)\s+(\d+)$/.exec(result.trim());
    if (!counts) throw new Error(t('git.invalidCommitCounts'));
    return { left: Number(counts[1]), right: Number(counts[2]) };
  }

  async commonAncestor(left, right, opts) {
    const result = await this.client.query(['merge-base', assertOid(left), assertOid(right)], opts);
    return ensureResult('merge-base', result, [0, 1]).code === 0;
  }

  async isAncestor(from, to, opts) {
    const result = await this.client.query(['merge-base', '--is-ancestor', assertOid(from), assertOid(to)], opts);
    return ensureResult('merge-base', result, [0, 1]).code === 0;
  }

  async commit(oid, opts) {
    return parseCommit(await this.client.buffer(['cat-file', 'commit', assertOid(oid)], opts));
  }

  async commitFiles(oid, commit, opts) {
    return (await this.commitFileDetails(oid, commit, opts)).files;
  }

  async commitFileDetails(oid, commit, opts, includeParents = false) {
    assertOid(oid);
    const [base, ...otherParents] = commit.parents;
    const parentGroups = [];
    if (!base) {
      const files = parseRawDiff(await this.client.buffer(['diff-tree', '--root', '--no-commit-id', ...DIFF, oid, '--'], opts));
      return { files, parentGroups };
    }
    for (const parent of commit.parents) {
      if (!(await this.resolveCommit(assertOid(parent), opts))) {
        throw new BranchError(t('git.missingParent', { oid: shortOid(parent) }));
      }
    }
    const grouped = includeParents && otherParents.length > 0;
    const remember = (oid, files) => { if (grouped && files.length) parentGroups.push({ oid, files }); };
    let files = await this.commitFilesFromParent(oid, base, opts);
    remember(base, files);
    // The combined view keeps paths changed against every parent. Reuse the
    // same reads for the full parent-to-merge diffs when they are requested.
    for (const parent of otherParents) {
      if (!files.length && !grouped) break;
      const changes = await this.commitFilesFromParent(oid, parent, opts);
      remember(parent, changes);
      if (files.length) {
        const paths = new Set(changes.map(file => file.pathKey));
        files = files.filter(file => paths.has(file.pathKey));
      }
    }
    return { files, parentGroups };
  }

  async branchFiles(left, right, opts) {
    if (assertOid(left) === assertOid(right)) return [];
    // diff-tree treats both inputs as fixed trees and cannot fall back to the checkout.
    return parseRawDiff(await this.client.buffer(['diff-tree', '--no-commit-id', ...DIFF, left, right, '--'], opts));
  }

  async worktreeFiles(oid, opts) {
    return parseRawDiff(await this.client.buffer(['diff', ...DIFF, '--no-relative', '--no-color', '--ita-invisible-in-index',
      assertOid(oid), '--'], opts)).map(file => ({ ...file, workingTree: true }));
  }

  async workingBlob(change, signal) {
    if (!change.new) return '';
    if (!regularMode(change.new.mode)) throw new BranchError(t('git.worktreeNotRegular'));
    try {
      const { absolute: target, stat: before } = await safeWorktreeFile(this.client.root, change.pathKey);
      const file = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      try {
        const opened = await file.stat();
        if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) throw new BranchError(t('git.worktreePathUnavailable'));
        if (opened.size > MAX_BLOB) throw new BranchError(t('git.blobTooLarge'));
        const bytes = Buffer.alloc(MAX_BLOB + 1);
        let length = 0;
        while (length < bytes.length) {
          signal?.throwIfAborted();
          const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
          if (!bytesRead) break;
          length += bytesRead;
        }
        if (length > MAX_BLOB) throw new BranchError(t('git.blobTooLarge'));
        return decodeText(bytes.subarray(0, length));
      } finally { await file.close(); }
    } catch (error) {
      if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code)) throw new BranchError(t('git.worktreePathUnavailable'));
      throw error;
    }
  }

  async blob(side, signal) {
    if (!side) return '';
    if (side.mode === '160000') throw new BranchError(t('git.submodulePointer', { oid: side.oid }));
    const oid = assertOid(side.oid);
    const size = Number((await this.client.text(['cat-file', '-s', oid], { signal })).trim());
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_BLOB) throw new BranchError(t('git.blobTooLarge'));
    return decodeText(await this.client.buffer(['cat-file', 'blob', oid], { signal, maxBuffer: MAX_BLOB + 1024 }));
  }

  async changedPaths(from, to) {
    const output = await this.client.text(['diff-tree', '-r', '--no-commit-id', '--name-only', '-z', '--no-renames',
      '--ignore-submodules=none', assertOid(from), assertOid(to), '--']);
    return output.split('\0').filter(Boolean);
  }

  async replayPaths(base, head) {
    const output = await this.client.text(['log', '--format=', '--name-only', '-z', '--no-renames', '--no-ext-diff', '--no-textconv',
      '--ignore-submodules=none', `${assertOid(base)}..${assertOid(head)}`, '--']);
    return output.split('\0').filter(Boolean);
  }

  async ignoredPaths() {
    const output = await this.client.text(['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '--no-empty-directory', '-z']);
    return output.split('\0').filter(Boolean).map(file => file.replace(/\/$/, ''));
  }

  async workingState(gitDir) {
    const markers = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer', 'BISECT_START'];
    const [status, markersPresent, head] = await Promise.all([
      this.client.buffer(['status', '--porcelain=v2', '-z', '--untracked-files=all', '--ignore-submodules=none']),
      Promise.all(markers.map(name => fileExists(path.join(gitDir, name)))), this.head()
    ]);
    const records = status.toString('utf8').split('\0');
    const trackedPaths = [], untrackedPaths = [];
    let conflicted = false, staged = false, unstaged = false, changedGitlink = false, intentToAdd = false;
    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      if (record.startsWith('u ')) conflicted = true;
      else if (record.startsWith('? ')) untrackedPaths.push(record.slice(2));
      else if (record.startsWith('1 ') || record.startsWith('2 ')) {
        const rename = record[0] === '2';
        const fields = record.split(' ', rename ? 9 : 8);
        trackedPaths.push(record.slice(fields.join(' ').length + 1));
        if (rename) trackedPaths.push(records[++i]);
        staged ||= fields[1][0] !== '.';
        unstaged ||= fields[1][1] !== '.';
        intentToAdd ||= fields[1] === '.A';
        changedGitlink ||= fields.slice(3, 6).includes('160000');
      }
    }
    return { head, status, trackedPaths, untrackedPaths, staged, unstaged, intentToAdd, changedGitlink, conflicted,
      operation: markers.find((_, i) => markersPresent[i]) };
  }
}

module.exports = { GitReads, PAGE_SIZE, ensureResult };
