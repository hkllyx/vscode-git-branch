'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { formatGitDate } = require('../src/date-format');

test('Git display dates use yyyy-MM-dd HH:mm:ss without converting the recorded timezone', () => {
  for (const value of ['2026-11-16T17:52:15+08:00', '2026-11-16T17:52:15-07:30',
    '2026-11-16T17:52:15Z', '2026-11-16 17:52:15 +0800', '2026-11-16T17:52:15.123Z',
    '2026-11-16 17:52:15']) {
    assert.equal(formatGitDate(value), '2026-11-16 17:52:15');
  }
  assert.equal(formatGitDate('2024-02-29T00:00:00+08:00'), '2024-02-29 00:00:00');
  for (const value of [undefined, null, 0, '', 'not a date', '2026-11-16',
    '2026-02-29T12:00:00Z', '2026-13-01T12:00:00Z', '2026-11-16T25:00:00Z']) {
    assert.equal(formatGitDate(value), 'Unknown');
  }
});
