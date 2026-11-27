'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { GitClient } = require('../src/git/gitClient');
const { GitReads } = require('../src/git/reads');
const { GitActions } = require('../src/git/actions');

// Each test file uses these fixtures sequentially in its own Node test process.
async function fixture(t) {
  const parent = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(parent, 'git-branch-test-'));
  const emptyTemplate = path.join(root, 'empty-template');
  const ownConfig = path.join(root, 'empty-global');
  const oldConfig = process.env.GIT_CONFIG_GLOBAL;
  const oldSystem = process.env.GIT_CONFIG_NOSYSTEM;
  t.after(async () => {
    if (oldConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = oldConfig;
    if (oldSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
    else process.env.GIT_CONFIG_NOSYSTEM = oldSystem;
    const target = await fs.realpath(root);
    assert.equal(path.dirname(target), parent);
    assert.ok(path.basename(target).startsWith('git-branch-test-'));
    await fs.rm(target, { recursive: true, force: true, maxRetries: 4 });
  });
  await fs.mkdir(emptyTemplate);
  await fs.writeFile(ownConfig, '');
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.GIT_CONFIG_GLOBAL = ownConfig;

  async function repo(name, { bare = false, url, depth, filter, objectFormat } = {}) {
    const dir = path.join(root, name);
    if (url) {
      const outer = new GitClient(root);
      await outer.text(['clone', `--template=${emptyTemplate}`, ...(depth ? [`--depth=${depth}`] : []),
        ...(filter ? [`--filter=${filter}`] : []), '--', url, dir], { write: true });
    } else {
      await fs.mkdir(dir);
      await new GitClient(dir).text(['init', `--template=${emptyTemplate}`, '--initial-branch=main',
        ...(bare ? ['--bare'] : []), ...(objectFormat ? [`--object-format=${objectFormat}`] : [])], { write: true });
    }
    const client = new GitClient(dir);
    const git = (...args) => client.text(args, { write: true });
    for (const [key, value] of Object.entries({ 'user.name': 'Git Branch Test', 'user.email': 'fixture@example.invalid',
      'core.autocrlf': 'false', 'commit.gpgSign': 'false', 'gc.auto': '0', 'protocol.file.allow': 'always' })) {
      await git('config', key, value);
    }
    const reads = new GitReads(client);
    const dirs = await reads.directories();
    const actions = new GitActions(client, dirs);
    const write = async (file, data) => {
      const target = path.join(dir, file);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, data);
    };
    const head = async () => (await reads.head()).oid;
    const commit = async (message, data = {}) => {
      for (const [file, content] of Object.entries(data)) {
        if (content === null) await fs.unlink(path.join(dir, file));
        else await write(file, content);
      }
      await git('add', '-A');
      await git('commit', '--allow-empty', '-m', message);
      return head();
    };
    return { dir, url: pathToFileURL(dir).href, client, git, reads, dirs, actions, write, head, commit,
      read: file => fs.readFile(path.join(dir, file), 'utf8') };
  }

  async function remotePair() {
    const remote = await repo('remote', { bare: true });
    const seed = await repo('seed');
    const initial = await seed.commit('initial', { 'common.txt': 'root\n', '.gitignore': 'ignored.txt\n' });
    await seed.git('remote', 'add', 'origin', remote.dir);
    await seed.git('push', '--set-upstream', 'origin', 'main');
    const local = await repo('local', { url: remote.url });
    return { remote, seed, local, initial };
  }

  return { root, repo, remotePair };
}

module.exports = { fixture };
