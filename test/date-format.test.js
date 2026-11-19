'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { formatGitDate } = require('../src/date-format');

test('Git display dates are local yyyy-MM-dd HH:mm:ss and reject invalid dates', () => {
  const local = '2026-11-16 17:52:15';
  assert.equal(formatGitDate(local), local);
  const value = formatGitDate('2026-11-16T17:52:15Z');
  assert.match(value, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.equal(formatGitDate('2026-11-16T17:52:15.123Z'), value);
  for (const input of [undefined, null, 0, '', 'not a date', '2026-11-16',
    '2026-02-29T12:00:00Z', '2026-13-01T12:00:00Z', '2026-11-16T25:00:00Z',
    '2026-11-16T12:00:00+25:00', '2026-11-16T12:00:00+08:60']) {
    assert.equal(formatGitDate(input), 'Unknown');
  }
});

test('system timezone conversion: equivalent offsets, date rollover and historical DST', () => {
  const inputs = ['2026-11-16T17:52:15+08:00', '2026-11-16T09:52:15Z',
    '2026-11-16T02:22:15-07:30', '2026-11-16 17:52:15 +0800',
    '2026-11-16T17:52:15Z', '2024-02-29T23:30:00-02:00',
    '2026-03-08T06:59:59Z', '2026-03-08T07:00:00Z',
    '2026-11-01T05:30:00Z', '2026-11-01T06:30:00Z'];
  const cases = [
    ['Asia/Shanghai', ['2026-11-16 17:52:15', '2026-11-17 01:52:15', '2024-03-01 09:30:00',
      '2026-03-08 14:59:59', '2026-03-08 15:00:00', '2026-11-01 13:30:00', '2026-11-01 14:30:00']],
    ['Etc/UTC', ['2026-11-16 09:52:15', '2026-11-16 17:52:15', '2024-03-01 01:30:00',
      '2026-03-08 06:59:59', '2026-03-08 07:00:00', '2026-11-01 05:30:00', '2026-11-01 06:30:00']],
    ['America/New_York', ['2026-11-16 04:52:15', '2026-11-16 12:52:15', '2024-02-29 20:30:00',
      '2026-03-08 01:59:59', '2026-03-08 03:00:00', '2026-11-01 01:30:00', '2026-11-01 01:30:00']]
  ];
  // Isolate TZ in same-runtime child processes; never mutate the running host's timezone.
  const script = `const { formatGitDate } = require(${JSON.stringify(require.resolve('../src/date-format'))});
    console.log(JSON.stringify(${JSON.stringify(inputs)}.map(formatGitDate)));`;
  for (const [timezone, expected] of cases) {
    const actual = JSON.parse(execFileSync(process.execPath, ['-e', script], {
      env: { ...process.env, TZ: timezone }, encoding: 'utf8', windowsHide: true
    }));
    assert.deepEqual(actual, [expected[0], expected[0], expected[0], expected[0], ...expected.slice(1)], timezone);
  }
});
