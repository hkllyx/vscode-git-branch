'use strict';

/** Resolve Git's recorded UTC offset, then display in the extension host's
 * system timezone. Keep raw ISO dates in repository data, not formatted strings. */
function formatGitDate(value) {
  if (typeof value !== 'string') return 'Unknown';
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.\d+)?(?: ?(Z|[+-]\d{2}:?\d{2}))?$/.exec(value.trim());
  if (!match) return 'Unknown';
  const [year, month, day] = match[1].split('-').map(Number);
  const [hour, minute, second] = match[2].split(':').map(Number);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1] || hour > 23 || minute > 59 || second > 59) return 'Unknown';
  const zone = (match[3] || '').replace(/^([+-]\d{2})(\d{2})$/, '$1:$2');
  // Git's %aI/%cI always provide an offset. Legacy offset-free values are
  // interpreted as local time, never silently assumed to be UTC.
  const date = new Date(`${match[1]}T${match[2]}${zone}`);
  if (!Number.isFinite(date.getTime())) return 'Unknown';
  const pad = (number, width = 2) => String(number).padStart(width, '0');
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + ` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

module.exports = { formatGitDate };
