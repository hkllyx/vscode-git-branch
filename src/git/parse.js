'use strict';

const { t } = require('../i18n');
const { isOid, compareName, BranchError } = require('../util/format');

const REF_FORMAT = [
  'refname', 'objectname', 'objecttype', 'symref', '*objectname', '*objecttype',
  'upstream', 'upstream:remotename', 'upstream:remoteref'
].map(field => `%(${field})`).join('%00');
const LOG_FORMAT = '%m%H%x00%P%x00%an%x00%cI%x00%s';
const REF_KINDS = [['refs/heads/', 'local'], ['refs/remotes/', 'remote'], ['refs/tags/', 'tag']];

function parseRefs(output) {
  return output.split(/\r?\n/).flatMap(line => {
    if (!line) return [];
    const [ref, oid, type, symbolic, peeled, peeledType, tracking, remote, source, trackStatus] = line.split('\0');
    const [prefix, kind] = REF_KINDS.find(([start]) => ref.startsWith(start)) || [];
    if (!prefix || symbolic || !isOid(oid)) return [];
    const item = {
      ref, kind, name: ref.slice(prefix.length),
      oid: type === 'commit' ? oid : peeledType === 'commit' && isOid(peeled) ? peeled : undefined,
      needsPeel: type === 'tag' && peeledType === 'tag',
      upstream: tracking || remote || source ? { tracking, remote, source } : undefined
    };
    // GitClient uses the C locale. An empty status is up to date; "gone" has no count.
    if (kind === 'local' && item.oid && tracking && trackStatus !== undefined) {
      const counts = /^(?:ahead (\d+)(?:, behind (\d+))?|behind (\d+)|)$/.exec(trackStatus);
      if (counts) item.trackingCount = { ahead: Number(counts[1] ?? 0), behind: Number(counts[2] ?? counts[3] ?? 0) };
    }
    return [item];
  });
}

function parseLog(output, compare, withBody = false) {
  if (!output) return [];
  const fields = output.split('\0');
  const width = withBody ? 6 : 5;
  if (fields.pop() !== '' || fields.length % width) throw new Error(t('git.invalidLog'));
  const rows = [];
  for (let i = 0; i < fields.length; i += width) {
    const [marked, parentList, author, date, subject, body] = fields.slice(i, i + width);
    const oid = /^[<>-]/.test(marked) ? marked.slice(1) : marked;
    const parents = parentList ? parentList.split(' ') : [];
    if (!isOid(oid) || parents.some(parent => !isOid(parent))) throw new Error(t('git.invalidCommitId'));
    const row = { oid, parents, author, date, subject, side: compare ? (marked[0] === '<' ? 'left' : 'right') : undefined };
    if (withBody) row.body = body;
    rows.push(row);
  }
  return rows;
}

function parseCommit(buffer) {
  const split = buffer.indexOf('\n\n');
  if (split < 0) throw new Error(t('git.invalidCommitDetails'));
  const header = buffer.subarray(0, split);
  const encoding = /^encoding ([^\r\n]+)/m.exec(header.toString('ascii'))?.[1];
  let decode = data => data.toString('utf8');
  if (encoding) {
    try {
      const decoder = new TextDecoder(encoding);
      decode = data => decoder.decode(data);
    } catch { /* An unknown legacy encoding still gets a readable UTF-8 fallback. */ }
  }
  const headers = decode(header).split('\n');
  const parents = headers.filter(line => line.startsWith('parent ')).map(line => line.slice(7));
  if (parents.some(parent => !isOid(parent))) throw new Error(t('git.invalidParentId'));
  const author = headers.find(line => line.startsWith('author '))?.slice(7).replace(/ \d+ [+-]\d{4}$/, '') || '';
  return { parents, author, message: decode(buffer.subarray(split + 2)).trimEnd() };
}

function parseRawDiff(output) {
  const files = [];
  let i = 0;
  function next() {
    const end = output.indexOf(0, i);
    if (end < 0) throw new Error(t('git.incompleteFileChange'));
    const part = output.subarray(i, end);
    i = end + 1;
    return part;
  }
  function filePath(raw) {
    return raw.toString('utf8').replace(/[\u0000-\u001f\u007f]/g, ch => `\\x${ch.charCodeAt(0).toString(16).padStart(2, '0')}`);
  }
  while (i < output.length) {
    const head = next().toString('ascii');
    const meta = /^:([0-7]{6}) ([0-7]{6}) ([a-f0-9]+) ([a-f0-9]+) ([ACDMRTUXB])\d*$/.exec(head);
    if (!meta || !isOid(meta[3]) || !isOid(meta[4])) throw new Error(t('git.invalidFileChange'));
    const [, oldMode, newMode, oldOid, newOid, status] = meta;
    const first = next();
    const renamed = status === 'R' || status === 'C';
    const second = renamed ? next() : first;
    const side = (raw, oid, mode) => ({ oid, mode, path: filePath(raw), pathKey: raw.toString('base64') });
    const old = status === 'A' ? undefined : side(first, oldOid, oldMode);
    const nextSide = status === 'D' ? undefined : side(second, newOid, newMode);
    files.push({ status, path: (nextSide || old).path, pathKey: (nextSide || old).pathKey, old, new: nextSide });
  }
  return files;
}

function matchPattern(pattern, value) {
  const star = pattern.indexOf('*');
  if (star < 0) return pattern === value ? '' : undefined;
  const prefix = pattern.slice(0, star), suffix = pattern.slice(star + 1);
  if (value.length >= prefix.length + suffix.length && value.startsWith(prefix) && value.endsWith(suffix)) {
    return value.slice(prefix.length, value.length - suffix.length);
  }
  return undefined;
}

function parseFetchRules(values) {
  const negative = [], positive = [];
  for (let value of values) {
    if (value.startsWith('^')) { negative.push(value.slice(1)); continue; }
    if (value.startsWith('+')) value = value.slice(1);
    const [source, target, extra] = value.split(':');
    if (extra !== undefined || !target) continue;
    // Keep competing mappings too. For example, a tag fetched into a remote
    // tracking ref must not make that entry look like a safe branch to delete.
    const tracking = target.startsWith('refs/') ? target
      : /^(?:heads|tags|remotes)\//.test(target) ? `refs/${target}` : `refs/heads/${target}`;
    const stars = part => (part.match(/\*/g) || []).length;
    if (stars(source) > 1 || stars(source) !== stars(tracking)) continue;
    positive.push({ source, tracking });
  }
  return { negative, positive };
}

function mappedTracking(rules, source) {
  if (rules.negative.some(pattern => matchPattern(pattern, source) !== undefined)) return [];
  return [...new Set(rules.positive.flatMap(rule => {
    const matched = matchPattern(rule.source, source);
    return matched === undefined ? [] : [rule.tracking.replace('*', () => matched)];
  }))];
}

function mappedSources(rules, tracking) {
  const sources = new Set();
  for (const rule of rules.positive) {
    const matched = matchPattern(rule.tracking, tracking);
    if (matched === undefined) continue;
    const source = rule.source.replace('*', () => matched);
    const destinations = mappedTracking(rules, source);
    if (destinations.length === 1 && destinations[0] === tracking) sources.add(source);
    else if (destinations.includes(tracking)) throw new BranchError(t('git.multipleTrackingMappings', { ref: tracking }));
  }
  return [...sources];
}

function orderRefs(refs, current) {
  return [...refs].sort((a, b) => Number(b.ref === current) - Number(a.ref === current) || compareName(a.name, b.name));
}

module.exports = { REF_FORMAT, LOG_FORMAT, parseRefs, parseLog, parseCommit, parseRawDiff, parseFetchRules, mappedTracking, mappedSources, orderRefs };
