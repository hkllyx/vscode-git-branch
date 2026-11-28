(() => {
  'use strict';

  // Presentation order also defines range selection and Select All in the host.
  function comparisonGroups(rows, collapsed) {
    const groups = ['left', 'right'].map(side => ({ side, collapsed: collapsed.includes(side), rows: [] }));
    const bySide = new Map(groups.map(group => [group.side, group.rows]));
    for (const row of rows) bySide.get(row.side)?.push(row);
    return groups;
  }

  if (typeof module === 'object' && module.exports) module.exports = { comparisonGroups };
  else globalThis.gitBranchComparisonGroups = comparisonGroups;
})();
