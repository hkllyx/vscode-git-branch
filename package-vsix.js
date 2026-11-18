'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const base = __dirname;
const target = path.join(base, 'hkllyx.git-branch-0.1.0.vsix');
const files = [
  'extension.vsixmanifest',
  '[Content_Types].xml',
  'extension/package.json',
  'extension/README.md',
  'extension/src/extension.js',
  'extension/src/git-operations.js'
];

// Verify all files exist
for (const f of files) {
  const p = path.join(base, f);
  if (!fs.existsSync(p)) {
    console.error(`Missing: ${f}`);
    process.exit(1);
  }
}

// Use tar to create zip (available on Windows 10+)
// Build a temporary directory structure
const tmpDir = path.join(base, '_vsix_tmp');
fs.rmSync(tmpDir, { recursive: true, force: true });
fs.mkdirSync(path.join(tmpDir, 'extension', 'src'), { recursive: true });

for (const f of files) {
  const src = path.join(base, f);
  const dst = path.join(tmpDir, f);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

// Create zip using PowerShell Compress-Archive
const psCmd = `Compress-Archive -Path '${tmpDir.replace(/'/g, "''")}\\*' -DestinationPath '${target.replace(/'/g, "''")}' -Force`;
execFileSync('powershell.exe', ['-NoProfile', '-Command', psCmd], { stdio: 'inherit' });

// Verify
const stat = fs.statSync(target);
console.log(`Created: ${target} (${(stat.size / 1024).toFixed(1)} KB)`);

// Cleanup
fs.rmSync(tmpDir, { recursive: true, force: true });
