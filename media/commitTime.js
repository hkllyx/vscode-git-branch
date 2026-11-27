(function () {
  'use strict';

  const pad = (number, width = 2) => String(number).padStart(width, '0');

  function formatCommitTime(iso) {
    const value = new Date(iso);
    if (!iso || Number.isNaN(value.getTime())) return { label: iso || '—', precise: iso || '—' };
    const date = [pad(value.getFullYear(), 4), pad(value.getMonth() + 1), pad(value.getDate())];
    const minutes = `${pad(value.getHours())}:${pad(value.getMinutes())}`;
    return { label: `${date.join('/')} ${minutes}`, precise: `${date.join('-')} ${minutes}:${pad(value.getSeconds())}` };
  }

  if (typeof module === 'object' && module.exports) module.exports = { formatCommitTime };
  else globalThis.gitBranchFormatCommitTime = formatCommitTime;
})();
