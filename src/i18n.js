'use strict';

const { createTranslator } = require('../media/translate');
const english = require('../package.nls.json');
const translations = {
  'zh-cn': require('../package.nls.zh-cn.json'),
  'zh-tw': require('../package.nls.zh-tw.json')
};

function createLocalizer(language) {
  // Match the VS Code language pack IDs, including their more specific subtags.
  const locale = /^(zh-cn|zh-tw)(?:-|$)/.exec(String(language ?? '').toLowerCase())?.[1] ?? 'en';
  const messages = { ...english, ...translations[locale] };
  return { locale, messages, t: createTranslator(messages) };
}

let active = createLocalizer();

function configureLocale(language) { active = createLocalizer(language); }
const t = (key, values) => active.t(key, values);
const locale = () => active.locale;

function historyMessages() {
  return Object.fromEntries(Object.entries(active.messages).filter(([key]) => key.startsWith('history.') || key === 'repo.pick'));
}

module.exports = { configureLocale, createLocalizer, historyMessages, locale, t };
