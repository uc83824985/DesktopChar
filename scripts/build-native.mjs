import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

if (process.platform !== 'win32') {
  console.log('[native] cursor refresh is Windows-only; skipping build');
  process.exit(0);
}

const executable = path.resolve('node_modules/node-gyp/bin/node-gyp.js');
const result = spawnSync(process.execPath, [executable, 'rebuild', '--directory', 'native/cursor-refresh'], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
