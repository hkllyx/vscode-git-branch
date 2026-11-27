'use strict';

const { execFile } = require('node:child_process');
const { t } = require('../i18n');
const { redact } = require('../util/format');

const REPO_ENV = new Set([
  'GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_NAMESPACE',
  'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_GRAFT_FILE',
  'GIT_REPLACE_REF_BASE', 'GIT_PREFIX', 'GIT_IMPLICIT_WORK_TREE', 'GIT_INTERNAL_SUPER_PREFIX',
  'GIT_SHALLOW_FILE', 'GIT_QUARANTINE_PATH', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT'
]);

class GitError extends Error {
  constructor(command, result) {
    const detail = redact(Buffer.concat([result.err, Buffer.from('\n'), result.out]).toString('utf8'));
    super(detail || t('git.commandFailed', { command, reason: result.code ?? t('git.processStopped') }));
    this.name = 'GitError';
    this.code = result.code;
    const diagnostic = `${result.err.toString('utf8')}\n${result.out.toString('utf8')}`;
    this.auth = /authentication|permission denied \(publickey\)|terminal prompts disabled|could not read (?:username|password)|not authorized/i.test(diagnostic);
    this.rejected = /\[(?:remote )?rejected\]/i.test(diagnostic);
    this.remoteFailure = /\[remote failure\]/i.test(diagnostic);
  }
}

function gitEnv(withoutTransport) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => {
    key = key.toUpperCase();
    return !REPO_ENV.has(key) && !/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key) && !key.startsWith('GIT_TRACE');
  }));
  Object.assign(env, {
    LANG: 'C', LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_REPLACE_OBJECTS: '1', GIT_PAGER: 'cat'
  });
  if (withoutTransport) {
    env.GIT_NO_LAZY_FETCH = '1';
    // Older Git versions may ignore NO_LAZY_FETCH. Disable transports too.
    env.GIT_ALLOW_PROTOCOL = '';
  }
  return env;
}

class GitClient {
  constructor(root, executable = 'git') {
    this.root = root;
    this.executable = executable;
  }

  async query(args, { signal, input, timeout = 30_000, maxBuffer = 24 * 1024 * 1024, write = false,
    offline = false, localFetch = false, indexFile, author, noEditor = false } = {}) {
    signal?.throwIfAborted();
    const env = gitEnv(!write || offline);
    if (indexFile) env.GIT_INDEX_FILE = indexFile;
    if (author) Object.assign(env, { GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email, GIT_AUTHOR_DATE: author.date });
    if (noEditor) Object.assign(env, { GIT_EDITOR: 'false', GIT_SEQUENCE_EDITOR: 'false' });
    if (localFetch) {
      env.GIT_NO_LAZY_FETCH = '1';
      env.GIT_ALLOW_PROTOCOL = 'file';
    }
    return new Promise((resolve, reject) => {
      const child = execFile(this.executable, ['--no-pager', ...args], {
        cwd: this.root, windowsHide: true, encoding: 'buffer', maxBuffer, timeout, signal, env
      }, (error, stdout, stderr) => {
        if (signal?.aborted || error?.name === 'AbortError') return reject(signal?.reason ?? error);
        const out = Buffer.isBuffer(stdout) ? stdout : Buffer.alloc(0);
        const err = Buffer.isBuffer(stderr) ? stderr : Buffer.alloc(0);
        if (error && typeof error.code !== 'number' && !error.killed && error.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          reject(new Error(t('git.launchFailed', { reason: error.code || t('git.startFailed') })));
          return;
        }
        resolve({ code: error ? error.code : 0, out, err });
      });
      // Closing stdin prevents an accidental terminal prompt from waiting on a pipe.
      child.stdin?.on('error', () => {});
      child.stdin?.end(input);
    });
  }

  async buffer(args, options) {
    const result = await this.query(args, options);
    if (result.code !== 0) throw new GitError(args[0], result);
    return result.out;
  }

  async text(args, options) {
    return (await this.buffer(args, options)).toString('utf8');
  }
}

module.exports = { GitClient, GitError };
