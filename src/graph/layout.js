'use strict';

const MAX_DRAW_LANES = 14;
const COLORS = 7;

/** Keeps pending parent OIDs across pages without treating adjacent rows as edges. */
class GraphLayout {
  constructor() {
    this.byOid = new Map();
    this.lanes = [];
    this.nextColor = 0;
    this.columns = 1;
  }

  allocate(oid, preferred, color) {
    const existing = this.byOid.get(oid);
    if (existing) return existing;
    let column = preferred === undefined ? this.lanes.indexOf(null) : preferred;
    if (column < 0) column = this.lanes.length;
    const lane = { oid, column, color: color ?? this.nextColor++ % COLORS };
    this.lanes[column] = lane;
    this.byOid.set(oid, lane);
    this.columns = Math.min(MAX_DRAW_LANES, Math.max(column + 1, this.columns));
    return lane;
  }

  append(commit, known) {
    const incoming = this.byOid.has(commit.oid);
    const node = this.allocate(commit.oid);
    const through = this.lanes.slice(0, MAX_DRAW_LANES).filter(lane => lane && lane !== node);
    this.lanes[node.column] = null;
    this.byOid.delete(commit.oid);
    const edges = [...new Set(commit.parents)].map((oid, i) => known && !known.has(oid)
      ? { oid, column: node.column, color: node.color }
      : this.allocate(oid, i === 0 ? node.column : undefined, i === 0 ? node.color : undefined));
    while (this.lanes.at(-1) === null) this.lanes.pop();
    return { column: node.column, color: node.color, incoming, through, edges };
  }
}

module.exports = { GraphLayout, MAX_DRAW_LANES };
