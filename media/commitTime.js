(function () {
  'use strict';

  const pad = (number, width = 2) => String(number).padStart(width, '0');
  const day = value => Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()) / 86_400_000;

  function createCommitTimeFormatter(locale) {
    const relative = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
    return (iso, now = new Date()) => {
      const value = new Date(iso);
      if (!iso || Number.isNaN(value.getTime())) return { label: iso || '—', title: iso };
      const label = `${pad(value.getFullYear(), 4)}/${pad(value.getMonth() + 1)}/${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}`;
      const elapsed = value - now;
      const days = day(value) - day(now);
      const hint = Math.abs(elapsed) < 60_000 ? relative.format(0, 'second')
        : Math.abs(elapsed) < 3_600_000 ? relative.format(Math.trunc(elapsed / 60_000), 'minute')
        : Math.abs(days) <= 1 ? relative.format(days, 'day') : '';
      return { label, title: `${label}${hint ? ` · ${hint}` : ''}\n${iso}` };
    };
  }

  if (typeof module === 'object' && module.exports) module.exports = { createCommitTimeFormatter };
  else globalThis.gitBranchCreateCommitTimeFormatter = createCommitTimeFormatter;
})();
