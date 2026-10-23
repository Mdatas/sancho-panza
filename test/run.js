'use strict';
const { execFileSync } = require('child_process');
const path = require('path');
for (const f of [
  'engine.test.js',
  'misc.test.js',
  'knowledge.test.js',
  'integrations.test.js',
  'strategy.test.js',
  'brain.test.js',
  'stream.test.js',
  'team.test.js',
]) {
  process.stdout.write(f + ': ');
  execFileSync(process.execPath, [path.join(__dirname, f)], { stdio: 'inherit' });
}
