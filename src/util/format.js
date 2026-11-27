'use strict';

const { t } = require('../i18n');

const isOid = value => typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
const shortOid = oid => oid?.slice(0, 8) || '';
const compareName = (a, b) => a === b ? 0 : a < b ? -1 : 1;
const stripLineEnd = text => text.replace(/\r?\n$/, '');

function formatTracking(count) {
  return count ? [count.ahead ? `↑${count.ahead}` : '', count.behind ? `↓${count.behind}` : ''].filter(Boolean).join(' ') : '';
}

function redact(text) {
  const hiddenUrl = () => t('git.redactedUrl');
  return String(text || '')
    .replace(/\b[a-z][a-z\d+.-]*:\/\/[^\s<>"']+/gi, hiddenUrl)
    .replace(/[\w.+-]+@[^\s:]+:[^\s<>"']+/g, hiddenUrl)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').trim().slice(0, 1200);
}

class BranchError extends Error {
  constructor(message, { warning = true, terminal = false } = {}) {
    super(message);
    this.name = 'BranchError';
    this.warning = warning;
    this.terminal = terminal;
  }
}

function errorText(error) {
  return redact(error?.message) || t('git.unknownError');
}

module.exports = { isOid, shortOid, compareName, stripLineEnd, formatTracking, redact, errorText, BranchError };
