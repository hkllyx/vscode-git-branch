'use strict';

const WINDOW_MS = 500;
const keyOf = node => node?.repoId && node?.ref ? JSON.stringify([node.repoId, node.ref]) : undefined;

// TreeItem commands get no mouse event. With the default list mode VS Code dispatches
// one open for the first click and one for dblclick. In native doubleClick mode it
// dispatches only the latter, so pass through instead of requiring two opens there.
class BranchActivation {
  activate(node, nativeDoubleClick, now = performance.now()) {
    const key = keyOf(node);
    if (!key) { this.reset(); return false; }
    const open = nativeDoubleClick || (this.pending?.key === key && now - this.pending.at <= WINDOW_MS);
    this.pending = open ? undefined : { key, at: now };
    return open;
  }

  selectionChanged(node) {
    if (this.pending?.key !== keyOf(node)) this.reset();
  }

  reset() { this.pending = undefined; }
}

module.exports = { BranchActivation };
