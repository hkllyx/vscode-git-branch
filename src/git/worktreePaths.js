'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { t } = require('../i18n');
const { BranchError } = require('../util/format');

const regularMode = mode => mode === '100644' || mode === '100755';
const pathUnavailable = () => new BranchError(t('git.worktreePathUnavailable'));
const notRegular = () => new BranchError(t('git.worktreeNotRegular'));

function pathParts(key) {
  let parts;
  try {
    parts = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.from(key, 'base64')).split('/');
  } catch { throw pathUnavailable(); }
  if (parts.some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git' || part.includes('\0') ||
    (process.platform === 'win32' && (/[\\:<>"|?*\x01-\x1f]|[ .]$/.test(part) ||
      /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³]|CONIN\$|CONOUT\$)(?:\.|$)/i.test(part))))) throw pathUnavailable();
  return parts;
}

async function fileStat(target) {
  try { return await fs.lstat(target); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

async function safeWorktreeFile(rootPath, pathKey, { allowMissing = false } = {}) {
  const parts = pathParts(pathKey);
  let current = await fs.realpath(rootPath);
  const absolute = path.join(current, ...parts);
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    const stat = await fileStat(current);
    if (!stat) {
      if (!allowMissing) throw pathUnavailable();
      return { absolute, parts };
    }
    const leaf = i === parts.length - 1;
    // lstat catches symlinks and junctions; realpath also rejects aliases such
    // as a Windows short name that could lead into an unrelated physical path.
    if (!(leaf ? stat.isFile() : stat.isDirectory()) || path.relative(current, await fs.realpath(current)) !== '') throw notRegular();
    if (leaf) return { absolute, parts, stat };
    if (await fileStat(path.join(current, '.git'))) throw notRegular();
  }
  throw pathUnavailable();
}

module.exports = { regularMode, pathParts, safeWorktreeFile };
