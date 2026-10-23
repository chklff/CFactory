#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const requiredMajor = 20;
const currentMajor = Number(process.versions.node.split('.')[0]);

if (!Number.isFinite(currentMajor) || currentMajor < requiredMajor) {
  console.error(`CFactory needs Node.js ${requiredMajor} or newer. Install the current Node.js LTS release, then run npm run setup again.`);
  process.exit(1);
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const result = spawnSync(npm, ['install'], { stdio: 'inherit', shell: false });

if (result.error) {
  console.error(`Could not start npm: ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) process.exit(result.status ?? 1);

console.log('\nCFactory is installed. Run: npm start');
console.log('Then open: http://127.0.0.1:4312');
console.log('In Settings, connect Higgsfield with OAuth and optionally add OpenAI, Claude, or both for script writing.');
