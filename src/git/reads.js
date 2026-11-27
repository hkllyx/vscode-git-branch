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
/** How far back the commit-author dropdown scans; IntelliJ also derives it lazily. */
const AUTHOR_SCAN = 2000;

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

  async refs({ tags = false, ref, ...opts } = {}) {
    const patterns = ref ? [ref] : ['refs/heads/', 'refs/remotes/', ...(tags ? ['refs/tags/'] : [])];
    const records = parseRefs(await this.client.text(['for-each-ref', `--format=${REF_FORMAT}`, '--', ...patterns], opts));
    if (ref) return records.filter(item => item.ref === ref);
    for (const item of records) {
      if (item.needsPeel) item.oid = await this.resolveCommit(item.ref, opts);
    }
    return records;
  }

  async snapshot(dirs, tags, opts) {
    const [head, allRefs, shallowInfo] = await Promise.all([
      this.head(opts), this.refs({ tags, ...opts }), this.shallowInfo(dirs.commonDir)
    ]);
    const byRef = new Map(allRefs.map(item => [item.ref, item]));
    const current = byRef.get(head.ref);
    const upstream = byRef.get(current?.upstream?.tracking);
    if (current?.oid && upstream?.oid) {
      try {
        const { left, right } = await this.divergence(current.oid, upstream.oid, opts);
        current.trackingCount = { ahead: left, behind: right };
      } catch (error) { if (opts?.signal?.aborted) throw error; }
    }
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

  /**
   * Log pages keep the raw `skip` semantics (rows of the unfiltered log) unless a
   * text filter is active, in which case `skip` counts matched rows instead. The
   * scan cursor is returned so callers can page through the raw log and keep the
   * matching stream stable even while new commits arrive.
   */
  async historyPage({ tips = [], compare, skip = 0, scan, limit = PAGE_SIZE, filter, signal }) {
    if (!compare && !tips.length) return { commits: [], hasMore: false, scanned: scan ?? skip };
    const revs = compare ? ['--left-right', `${assertOid(compare.left.oid)}...${assertOid(compare.right.oid)}`] : ['--stdin'];
    const input = compare ? undefined : `${tips.map(assertOid).join('\n')}\n`;
    const args = ['log', '-z', '--topo-order', '--no-decorate', '--no-show-signature', '--no-notes',
      `--format=tformat:${LOG_FORMAT}`, ...revs];
    const author = filter?.author?.trim();
    const text = filter?.text?.trim().toLowerCase();
    // --author is a regex; an unescaped name containing +.* etc. would misbehave.
    const pattern = author ? author.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : undefined;
    const base = pattern ? [...args, `--author=${pattern}`] : args;
    if (!text) {
      const rows = parseLog(await this.client.text([...base, `--skip=${skip}`, `--max-count=${limit + 1}`], { signal, input }),
        Boolean(compare));
      return { commits: rows.slice(0, limit), hasMore: rows.length > limit, scanned: skip + Math.min(rows.length, limit) };
    }
    // Text search spans subject, author and hash prefix, so the rows have to be
    // matched here; the log is scanned in chunks until the page is full.
    const CHUNK = 400;
    const MAX_SCAN = 20000;
    const matches = [];
    let position = scan ?? 0;
    let more = true;
    while (matches.length <= limit && more && position < MAX_SCAN) {
      const chunk = parseLog(await this.client.text([...base, `--skip=${position}`, `--max-count=${CHUNK}`],
        { signal, input }), Boolean(compare));
      position += chunk.length;
      more = chunk.length === CHUNK;
      for (const row of chunk) {
        if (row.subject.toLowerCase().includes(text) || row.author.toLowerCase().includes(text) || row.oid.startsWith(text)) {
          matches.push(row);
          if (matches.length > limit) break;
        }
      }
    }
    return { commits: matches.slice(0, limit), hasMore: matches.length > limit || more, scanned: position };
  }

  /**
   * Authors offered by the commit filter. IntelliJ populates the author list from
   * the log it is showing, so this scans the range history rather than only the
   * tip commits (which would hide everyone whose work is not the branch head).
   */
  async authors(tips, opts) {
    if (!tips.length) return [];
    const output = await this.client.text(['log', `--max-count=${AUTHOR_SCAN}`,
      '--format=%an', ...tips.map(assertOid), '--'], opts).catch(() => '');
    const seen = new Set(output.split(/\r?\n/).filter(Boolean));
    return [...seen].sort((a, b) => a.localeCompare(b));
  }

  /** Diff of a commit against one of its parents; a merge has one per parent. */
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
    assertOid(oid);
    const base = commit.parents[0];
    if (base && !(await this.resolveCommit(assertOid(base), opts))) {
      throw new BranchError(t('git.missingParent', { oid: shortOid(base) }));
    }
    const args = base ? ['diff-tree', '--no-commit-id', ...DIFF, base, oid, '--']
      : ['diff-tree', '--root', '--no-commit-id', ...DIFF, oid, '--'];
    return parseRawDiff(await this.client.buffer(args, opts));
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
