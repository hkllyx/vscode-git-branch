'use strict';

/** Display the wall-clock time recorded by Git, without converting its timezone.
 * Keep the raw ISO value in repository data for sorting and snapshot identity. */
function formatGitDate(value) {
  if (typeof value !== 'string') return 'Unknown';
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.\d+)?(?:Z| ?[+-]\d{2}:?\d{2})?$/.exec(value.trim());
  if (!match) return 'Unknown';
  const [year, month, day] = match[1].split('-').map(Number);
  const [hour, minute, second] = match[2].split(':').map(Number);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1] || hour > 23 || minute > 59 || second > 59) return 'Unknown';
  return `${match[1]} ${match[2]}`;
}

module.exports = { formatGitDate };
