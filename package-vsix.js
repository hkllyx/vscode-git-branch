'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const base = __dirname;
const manifest = JSON.parse(fs.readFileSync(path.join(base, 'package.json'), 'utf8'));
const target = path.join(base, `${manifest.publisher}.${manifest.name}-${manifest.version}.vsix`);
const xml = fs.readFileSync(path.join(base, 'extension.vsixmanifest'), 'utf8');
if (!xml.includes(`Version="${manifest.version}" Publisher="${manifest.publisher}"`)) {
  throw new Error('VSIX manifest publisher/version differs from package.json');
}
const groupIcons = ['tags-group', 'remote-group', 'comparisons-group']
  .flatMap(name => [`media/${name}.svg`, `media/${name}-light.svg`]);
// Refresh the tracked staging copy from authoritative source on every build.
for (const relative of ['package.json', 'README.md', 'src/extension.js', 'src/git-operations.js', 'src/comparison-view.js', 'media/branch-diff.svg',
  'media/branch-diff-light.svg', 'media/current-branch.svg', 'media/primary-branch.svg', 'media/current-primary.svg', ...groupIcons]) {
  const destination = path.join(base, 'extension', relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(path.join(base, relative), destination);
}
const quote = value => `'${value.replace(/'/g, "''")}'`;
const mappings = [
  ['extension.vsixmanifest', 'extension.vsixmanifest'],
  ['[Content_Types].xml', '[Content_Types].xml'],
  ['package.json', 'extension/package.json'],
  ['README.md', 'extension/README.md'],
  ['src/extension.js', 'extension/src/extension.js'],
  ['src/git-operations.js', 'extension/src/git-operations.js'],
  ['src/comparison-view.js', 'extension/src/comparison-view.js'],
  ['media/branch-diff.svg', 'extension/media/branch-diff.svg'],
  ['media/branch-diff-light.svg', 'extension/media/branch-diff-light.svg'],
  ['media/current-branch.svg', 'extension/media/current-branch.svg'],
  ['media/primary-branch.svg', 'extension/media/primary-branch.svg'],
  ['media/current-primary.svg', 'extension/media/current-primary.svg'],
  ...groupIcons.map(relative => [relative, `extension/${relative}`])
];
// Use Windows .NET ZIP support without installing dependencies or leaving temp directories.
const entries = mappings.map(([source, entry]) =>
  `[IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, ${quote(path.join(base, source))}, ${quote(entry)}, [IO.Compression.CompressionLevel]::Optimal) | Out-Null;`
).join('\n');
const command = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$stream = [IO.File]::Open(${quote(target)}, [IO.FileMode]::Create, [IO.FileAccess]::ReadWrite)
$zip = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create)
try { ${entries} } finally { $zip.Dispose(); $stream.Dispose() }
`;
execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { stdio: 'inherit', windowsHide: true });
console.log(`Created: ${target} (${(fs.statSync(target).size / 1024).toFixed(1)} KB)`);
