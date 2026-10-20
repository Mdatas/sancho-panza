#!/usr/bin/env node
// Flip Electron "fuses" on a packaged binary (node scripts/fuses.js <path-to-electron-executable>):
// the installed app can no longer be used as a plain Node runtime (ELECTRON_RUN_AS_NODE), nor driven with
// NODE_OPTIONS or --inspect from outside. The file:// privileges stay (the app loads its pages from disk).
// Used by scripts/package-mac.sh; the Windows installer (setup.ps1) does the same byte flip in PowerShell.
'use strict';
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');
const bin = process.argv[2];
if (!bin) {
  console.error('usage: node scripts/fuses.js <electron executable>');
  process.exit(2);
}
flipFuses(bin, {
  version: FuseVersion.V1,
  resetAdHocDarwinSignature: process.platform === 'darwin',
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
})
  .then(() => console.log('fuses flipped:', bin))
  .catch((e) => {
    console.error('fuses failed:', e.message);
    process.exit(1);
  });
