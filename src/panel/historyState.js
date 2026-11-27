'use strict';

const { t } = require('../i18n');
const { compareName } = require('../util/format');

const ALL = 'all';
const MAX_SELECTION = 50;

function historyTarget(snapshot, range, tags) {
  const ref = snapshot.byRef.get(range);
  if ((!ref?.oid || (ref.kind === 'tag' && !tags)) && range !== ALL) range = 'HEAD';
  const tip = range === ALL ? [snapshot.head.oid, ...snapshot.allRefs.filter(item => item.kind !== 'tag').map(item => item.oid)]
    : [range === 'HEAD' ? snapshot.head.oid : ref.oid];
  const tips = [...new Set(tip.filter(Boolean))].sort();
  return { range, tips, shallow: snapshot.shallow, key: JSON.stringify([range, snapshot.shallow, tips]),
    label: range === ALL ? t('history.allBranches') : range === 'HEAD' ? 'HEAD' : ref.name };
}

class HistorySelection {
  constructor() { this.focus = undefined; this.anchor = undefined; this.selected = new Set(); }

  restore(packet, rows) {
    const available = new Set(rows.map(row => row.oid));
    this.selected = new Set(packet?.selected.filter(oid => available.has(oid)));
    if (!this.selected.size && (!packet || packet.selected.length) && rows.length) this.selected.add(rows[0].oid);
    this.focus = this.selected.has(packet?.focus) ? packet.focus : this.selected.values().next().value;
    this.anchor = available.has(packet?.anchor) ? packet.anchor : this.focus;
  }

  select(oid, mode, rows) {
    if (mode === 'range' || mode === 'extend') {
      const end = rows.findIndex(row => row.oid === oid);
      let start = rows.findIndex(row => row.oid === this.anchor);
      if (end < 0) return false;
      if (start < 0) start = end;
      if (Math.abs(end - start) + 1 > MAX_SELECTION) return false;
      const next = new Set(mode === 'extend' ? this.selected : []);
      for (let i = Math.min(start, end); i <= Math.max(start, end); i++) next.add(rows[i].oid);
      if (next.size > MAX_SELECTION) return false;
      this.selected = next;
      this.focus = oid;
      this.anchor ??= rows[start].oid;
    } else if (mode === 'toggle') {
      if (this.selected.has(oid)) {
        this.selected.delete(oid);
        if (this.focus === oid) this.focus = [...this.selected].at(-1);
      } else {
        if (this.selected.size >= MAX_SELECTION) return false;
        this.selected.add(oid);
        this.focus = oid;
      }
      this.anchor = this.selected.size ? oid : undefined;
    } else {
      this.selected = new Set([oid]);
      this.anchor = this.focus = oid;
    }
    return true;
  }

  asPacket() { return { focus: this.focus, anchor: this.anchor, selected: [...this.selected] }; }
}

const sameSide = (left, right) => left?.pathKey === right?.pathKey && left?.oid === right?.oid && left?.mode === right?.mode;

function statusOf(old, next) {
  if (!old) return 'A';
  if (!next) return 'D';
  if (old.pathKey !== next.pathKey) return 'R';
  return old.mode.slice(0, 3) !== next.mode.slice(0, 3) ? 'T' : 'M';
}

// Mirrors IntelliJ's CommittedChangesTreeBrowser.zipChanges: changes are given
// oldest-first and spliced purely by file path, keeping one entry per path with
// the first change's "before" side and the last change's "after" side. Divergent
// branches or skipped commits never make the result ambiguous; the endpoints are
// simply diffed. `readFirstParents` is only used to tell whether a splice skipped
// commits that also touched the path (`includesGap`, an informational flag).
async function combineChanges(results, readFirstParents, signal) {
  // `readFirstParents` is kept for callers that still pass it, but the splice is
  // decided by blob identity, which is both cheaper and more exact.
  if (readFirstParents && typeof readFirstParents !== 'function') signal = readFirstParents;
  const open = new Map(); // current path -> the oldest still-open splice entry

  const gap = (before, after) => !sameSide(before, after);
  const place = entry => {
    const anchor = entry.new || entry.old;
    // A path added and later removed inside the selection has no net change.
    if (!anchor) return;
    const key = anchor.pathKey;
    const previous = open.get(key);
    if (!previous) {
      open.set(key, entry);
      return;
    }
    open.set(key, { old: previous.old, new: entry.new, baseOid: previous.baseOid, afterOid: entry.afterOid,
      includesGap: previous.includesGap || entry.includesGap || gap(previous.new, entry.old) });
  };

  for (const { files } of [...results].reverse()) {
    signal?.throwIfAborted();
    for (const file of files) {
      // A copy introduces a new path but does not consume the original one.
      const change = file.status === 'C' ? { ...file, status: 'A', old: undefined } : file;
      const base = { baseOid: change.baseOid, afterOid: change.afterOid, includesGap: Boolean(file.includesGap) };
      if (!change.old) { place({ ...base, old: undefined, new: change.new }); continue; }
      const previous = open.get(change.old.pathKey);
      if (!previous) { place({ ...base, old: change.old, new: change.new }); continue; }
      open.delete(change.old.pathKey);
      // Interior commits that never touched this path leave the blob unchanged,
      // so no note is needed; anything else means the diff spans omitted work.
      place({ old: previous.old, new: change.new, baseOid: previous.baseOid, afterOid: change.afterOid,
        includesGap: previous.includesGap || base.includesGap || gap(previous.new, change.old) });
    }
  }

  const combined = [];
  for (const entry of open.values()) {
    const { old, new: next } = entry;
    if (sameSide(old, next)) continue;
    const { path, pathKey } = next || old;
    combined.push({ status: statusOf(old, next), path, pathKey, old, new: next,
      baseOid: entry.baseOid, afterOid: entry.afterOid, includesGap: Boolean(entry.includesGap) });
  }
  return combined.sort((a, b) => compareName(a.path, b.path) || compareName(a.pathKey, b.pathKey));
}

async function mapWithLimit(items, limit, signal, run) {
  const results = [];
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      signal?.throwIfAborted();
      const index = cursor++;
      results[index] = await run(items[index]);
    }
  }));
  return results;
}

module.exports = { ALL, MAX_SELECTION, HistorySelection, historyTarget, combineChanges, mapWithLimit };
