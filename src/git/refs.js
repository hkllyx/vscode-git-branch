'use strict';

const { compareName } = require('../util/format');

const HEADS = 'refs/heads/';
const REMOTES = 'refs/remotes/';

// A branch switch can keep the same commit, so compare both parts of HEAD.
const sameHead = (actual, expected) => actual.ref === expected?.ref && actual.oid === expected?.oid;

function orderRefs(refs, current) {
  return [...refs].sort((a, b) => Number(b.ref === current) - Number(a.ref === current) || compareName(a.name, b.name));
}

module.exports = { HEADS, REMOTES, sameHead, orderRefs };
