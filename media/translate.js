(function () {
  'use strict';

  function createTranslator(messages) {
    return (key, values = {}) => {
      const text = Object.hasOwn(messages, key) ? messages[key] : key;
      return text.replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (token, name) =>
        Object.hasOwn(values, name) ? String(values[name]) : token);
    };
  }

  if (typeof module === 'object' && module.exports) module.exports = { createTranslator };
  else globalThis.gitBranchCreateTranslator = createTranslator;
})();
