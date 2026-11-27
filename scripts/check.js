'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const manifest = JSON.parse(read('package.json'));
const { contributes } = manifest;
const english = JSON.parse(read('package.nls.json'));
const keys = Object.keys(english).sort();
const placeholders = text => [...new Set(Array.from(text.matchAll(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g), match => match[1]))].sort();
for (const language of ['', '.zh-cn', '.zh-tw']) {
  const file = `package.nls${language}.json`;
  const catalog = JSON.parse(read(file));
  assert.deepEqual(Object.keys(catalog).sort(), keys, `${file} has different message keys`);
  for (const key of keys) {
    assert.ok(typeof catalog[key] === 'string' && catalog[key].trim(), `${file}: empty or invalid message ${key}`);
    assert.deepEqual(placeholders(catalog[key]), placeholders(english[key]), `${file}: placeholder mismatch in ${key}`);
  }
}
const requiredMessages = [manifest.description, ...contributes.commands.map(command => command.title),
  ...contributes.viewsContainers.panel.map(container => container.title),
  ...Object.values(contributes.views).flatMap(views => views.map(view => view.name))];
for (const message of requiredMessages) {
  const key = /^%([\w.]+)%$/.exec(message)?.[1];
  assert.ok(key && Object.hasOwn(english, key), `Manifest text must reference a message key: ${message}`);
  assert.deepEqual(placeholders(english[key]), [], `Manifest message cannot take arguments: ${key}`);
}
const contributedCommands = new Set(contributes.commands.map(item => item.command));
const host = read('src/extension.js');
for (const menu of Object.values(contributes.menus)) {
  for (const item of menu) assert.ok(contributedCommands.has(item.command), item.command);
}
for (const command of contributedCommands) {
  const action = command.replace(/^git-branch\./, '');
  assert.ok(host.includes(`register('${action}',`), `No implementation for ${command}`);
}
assert.ok(fs.existsSync(path.join(root, manifest.main)));
assert.ok(contributes.views.scm.some(view => view.id === 'git-branch.branches'));
assert.ok(contributes.viewsContainers.panel.some(view => view.id === 'git-branch-history'));
assert.ok(contributes.views['git-branch-history'].some(view => view.id === 'git-branch.log' && view.type === 'webview'));
assert.ok(!contributes.keybindings, 'This version does not define shortcuts');
for (const container of contributes.viewsContainers.panel) {
  assert.match(container.id, /^[0-9A-Za-z_-]+$/);
  assert.ok(/^\$\([a-z0-9-]+\)$/.test(container.icon) || fs.existsSync(path.join(root, container.icon)),
    `Invalid panel icon: ${container.icon}`);
}

const html = read('src/panel/graphController.js');
const graph = read('media/graph.js');
for (const [, id] of graph.matchAll(/\$\('([\w-]+)'\)/g)) assert.ok(html.includes(`id="${id}"`), `Webview HTML is missing #${id}`);
for (const [, file] of html.matchAll(/\basset\('([^']+)'\)/g)) assert.ok(fs.existsSync(path.join(root, 'media', file)));
const css = read('media/graph.css');
for (const [, file] of css.matchAll(/url\(['"]?([^'"\s)]+)['"]?\)/g)) {
  assert.ok(fs.existsSync(path.join(root, 'media', file)), `Missing Webview CSS asset: ${file}`);
}
const previewPath = 'docs/design/workbench-preview.png';
const markdownImages = name => Array.from(read(name).matchAll(/!\[[^\]]*\]\(([^)]+)\)/g), match => match[1]);
assert.deepEqual(markdownImages('README.md'), [`https://raw.githubusercontent.com/hkllyx/vscode-git-branch/main/${previewPath}`],
  'The Marketplace README must use the GitHub raw URL for the workbench preview');
assert.deepEqual(markdownImages('docs/DESIGN.md'), ['./design/workbench-preview.png'],
  'The design document must reference the same workbench preview');
assert.deepEqual(fs.readdirSync(path.join(root, 'docs/design')), ['workbench-preview.png'],
  'Keep only the workbench preview in the design assets directory');
const previewBytes = fs.readFileSync(path.join(root, previewPath));
assert.ok(previewBytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')), `Not a PNG: ${previewPath}`);

function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const absolute = path.join(dir, entry.name);
    return entry.isDirectory() ? jsFiles(absolute) : entry.isFile() && entry.name.endsWith('.js') ? [absolute] : [];
  });
}
const runtimeModules = ['src', 'media'].flatMap(dir => jsFiles(path.join(root, dir)));
for (const file of runtimeModules) {
  const source = fs.readFileSync(file, 'utf8');
  const label = path.relative(root, file);
  assert.ok(!/\p{Script=Han}/u.test(source), `${label}: keep UI text in the message catalogs`);
  for (const [, helper, key] of source.matchAll(/(?:(\bcountText)\(\s*)?['"]((?:view|command|repo|branch|action|git|history)\.[a-zA-Z][\w]*)['"]/g)) {
    for (const candidate of helper ? [`${key}One`, `${key}Other`] : [key]) {
      assert.ok(Object.hasOwn(english, candidate), `${label}: missing message ${candidate}`);
    }
  }
}
const modules = [path.join(root, 'package-vsix.js'), ...runtimeModules,
  ...['scripts', 'test', 'test-support'].flatMap(dir => jsFiles(path.join(root, dir)))];
for (const file of modules) execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
console.log(`Checked ${modules.length} JS files, ${keys.length} messages in three locales, VS Code commands/views, Webview resources and README images.`);
