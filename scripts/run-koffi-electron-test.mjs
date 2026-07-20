import { spawnSync } from 'node:child_process';
import electron from 'electron';

const result = spawnSync(electron, ['scripts/test-koffi-electron.mjs'], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stdio: 'inherit',
  timeout: 15_000,
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
