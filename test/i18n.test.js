'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { readFileSync } = require('node:fs');
const { runInNewContext } = require('node:vm');
const { configureLocale, createLocalizer, historyMessages, locale } = require('../src/i18n');
const { GitActions } = require('../src/git/actions');
const { GitError } = require('../src/git/gitClient');
const { historyTarget, ALL } = require('../src/panel/historyState');
const { errorText } = require('../src/util/format');

const cases = [
  { language: 'en', id: 'en', open: 'Show Git History', all: 'All Branches', invalid: 'Enter a valid Git branch name.', hidden: '[remote URL]',
    firstCommit: 'The repository has no commits yet. Make the first commit to continue.' },
  { language: 'zh-CN', id: 'zh-cn', open: '显示 Git 历史', all: '全部分支', invalid: '请输入有效的 Git 分支名。', hidden: '[远程地址]',
    firstCommit: '仓库尚无提交，请先完成首次提交。' },
  { language: 'zh-tw', id: 'zh-tw', open: '顯示 Git 歷程記錄', all: '所有分支', invalid: '請輸入有效的 Git 分支名稱。', hidden: '[遠端網址]',
    firstCommit: '儲存庫尚無提交。請先完成第一次提交。' },
  { language: 'ja', id: 'en', open: 'Show Git History', all: 'All Branches', invalid: 'Enter a valid Git branch name.', hidden: '[remote URL]',
    firstCommit: 'The repository has no commits yet. Make the first commit to continue.' }
];
const browserSource = readFileSync(require.resolve('../media/translate'), 'utf8');
const browser = {};
runInNewContext(browserSource, browser);

for (const { language, id, open, all, invalid, hidden, firstCommit } of cases) {
  test(`native labels, extension messages and history share the ${language} language selection`, async t => {
    configureLocale(language);
    t.after(() => configureLocale('en'));
    const localizer = createLocalizer(language);
    assert.equal(locale(), id);
    assert.equal(localizer.t('command.openLog'), open);
    const snapshot = { head: {}, allRefs: [], byRef: new Map() };
    assert.equal(historyTarget(snapshot, ALL, false).label, all);
    const packet = JSON.parse(JSON.stringify(historyMessages()));
    const browserT = browser.gitBranchCreateTranslator(packet);
    assert.equal(browserT('history.allBranches'), all);
    const emptyRepo = new GitActions();
    emptyRepo.reads.head = async () => ({});
    await assert.rejects(emptyRepo.named('HEAD'), { name: 'BranchError', message: firstCommit });
    assert.equal(browserT('history.baseCount', { count: 0 }), localizer.t('history.baseCount', { count: 0 }));
    assert.ok('repo.pick' in packet);
    assert.ok(!('git.pushUnconfirmed' in packet));
    // The branch name is literal text, not a second set of parameters to interpolate.
    const branch = 'feature/{oid}-修正';
    const name = localizer.t('action.createStartLabel', { name: branch, oid: 'b16b00b5' });
    assert.ok(name.includes(branch));
    assert.ok(name.includes('b16b00b5'));
    const filePath = '<b>{oid} 修正 & test</b>';
    assert.ok(browserT('history.openDiffLabel', { status: 'M', path: filePath, commit: 'b16b00b5' }).includes(filePath));
    assert.match(localizer.t('action.checkoutCreated', { name: branch, repo: 'test' }), /feature\/\{oid\}-修正/);
    await assert.rejects(new GitActions().validateName('-bad'), { name: 'BranchError', message: invalid });
    const error = new GitError('push', { code: 1, err: Buffer.from('Authentication failed for https://user:secret@example.invalid/repo'), out: Buffer.alloc(0) });
    assert.equal(error.auth, true);
    assert.equal(errorText(error), `Authentication failed for ${hidden}`);
    const noDiagnostic = new GitError('log', { code: null, err: Buffer.alloc(0), out: Buffer.alloc(0) });
    assert.equal(noDiagnostic.message, localizer.t('git.commandFailed', { command: 'log', reason: localizer.t('git.processStopped') }));
  });
}

test('VS Code language pack IDs resolve case-insensitively and can fall back from a more specific locale', () => {
  assert.equal(createLocalizer('ZH-tW-private').locale, 'zh-tw');
  assert.equal(createLocalizer('ZH-CN-private').locale, 'zh-cn');
  assert.equal(createLocalizer('en-GB').locale, 'en');
  assert.equal(createLocalizer(undefined).locale, 'en');
});
