'use strict';

const { t } = require('../i18n');
const { orderRefs } = require('../git/refs');

function refSections({ remotes = true, tags = false } = {}) {
  const sections = [{ kind: 'local', label: t('branch.local') }];
  if (remotes) sections.push({ kind: 'remote', label: t('branch.remote') });
  if (tags) sections.push({ kind: 'tag', label: t('branch.tags') });
  return sections;
}

function sectionRefs({ allRefs, head }, kind) {
  return orderRefs(allRefs.filter(ref => ref.kind === kind), head.ref);
}

function refAppearance(item, head) {
  const current = item.ref === head.ref;
  return { current, icon: current ? 'star-full' : item.kind === 'tag' ? 'tag' : 'git-branch' };
}

module.exports = { refSections, sectionRefs, refAppearance };
