'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');

const base = __dirname;
const manifest = JSON.parse(fs.readFileSync(path.join(base, 'package.json'), 'utf8'));
const target = path.join(base, `${manifest.publisher}.${manifest.name}-${manifest.version}.vsix`);
const xml = fs.readFileSync(path.join(base, 'extension.vsixmanifest'), 'utf8');
if (!xml.includes(`Id="${manifest.name}" Version="${manifest.version}" Publisher="${manifest.publisher}"`) ||
    !xml.includes(`Id="Microsoft.VisualStudio.Code.Engine" Value="${manifest.engines.vscode}"`)) {
  throw new Error('VSIX manifest identity or engine differs from package.json');
}
if (process.platform !== 'win32') throw new Error('The bundled VSIX packager requires Windows PowerShell.');

function filesUnder(directory, suffixes) {
  return fs.readdirSync(path.join(base, directory), { withFileTypes: true }).flatMap(entry => {
    const name = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return filesUnder(name, suffixes);
    return entry.isFile() && suffixes.has(path.extname(name)) ? [name] : [];
  }).sort();
}

// Only ship the Marketplace README, extension metadata, and runtime files.
// The README screenshot is served from GitHub; docs and tests stay in the repository.
const catalogs = ['package.nls.json', 'package.nls.zh-cn.json', 'package.nls.zh-tw.json'];
const runtimeFiles = ['package.json', ...catalogs, 'README.md', ...filesUnder('src', new Set(['.js'])),
  ...filesUnder('media', new Set(['.js', '.css', '.svg', '.png']))];
if (!runtimeFiles.includes(manifest.main.replace(/^\.\//, ''))) throw new Error('Package is missing its entry point');
const mappings = [
  ['extension.vsixmanifest', 'extension.vsixmanifest'],
  ['[Content_Types].xml', '[Content_Types].xml'],
  ...runtimeFiles.map(relative => [relative, `extension/${relative}`])
];
const quote = value => `'${value.replace(/'/g, "''")}'`;
const entries = mappings.map(([source, entry]) =>
  `[IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, ${quote(path.join(base, source))}, ${quote(entry)}, [IO.Compression.CompressionLevel]::Optimal) | Out-Null;`
).join('\n');
const temporary = `${target}.${randomUUID()}.tmp`;
const command = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$stream = [IO.File]::Open(${quote(temporary)}, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite)
try {
  $zip = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create)
  try { ${entries} } finally { $zip.Dispose() }
} finally { $stream.Dispose() }
`;
try {
  const encoded = Buffer.from(command, 'utf16le').toString('base64');
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { stdio: 'inherit', windowsHide: true });
  fs.renameSync(temporary, target);
} finally { fs.rmSync(temporary, { force: true }); }
console.log(`Created: ${target} (${(fs.statSync(target).size / 1024).toFixed(1)} KB, ${mappings.length} entries)`);
