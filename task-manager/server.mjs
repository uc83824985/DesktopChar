import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTaskManagerHttpService } from './http-service.mjs';
import { createSessionMonitorClient } from './session-monitor-client.mjs';
import { createTaskManagerRuntime } from './task-manager-runtime.mjs';

const sessionMonitorMarker = requiredEnvironment(
  process.env.SESSION_MONITOR_MARKER,
  'SESSION_MONITOR_MARKER',
);
const stateDirectory = path.resolve(
  process.env.DESKTOP_CHAR_TASK_MANAGER_STATE_DIR
    ?? path.join(process.env.LOCALAPPDATA ?? os.tmpdir(), 'DesktopChar', 'task-manager'),
);
const markerPath = path.join(stateDirectory, 'task_manager.json');
const tokenPath = path.join(stateDirectory, 'task_manager_token.txt');
const token = randomBytes(32).toString('base64url');
const allowedArtifactRoots = (process.env.DESKTOP_CHAR_TASK_MANAGER_ARTIFACT_ROOTS ?? '')
  .split(path.delimiter)
  .map(value => value.trim())
  .filter(Boolean);
const monitor = createSessionMonitorClient({ markerPath: sessionMonitorMarker });
const runtime = createTaskManagerRuntime({ monitor, allowedArtifactRoots });
const service = createTaskManagerHttpService({
  runtime,
  token,
  host: '127.0.0.1',
  port: environmentPort(process.env.DESKTOP_CHAR_TASK_MANAGER_PORT),
});
let closing;

try {
  await mkdir(stateDirectory, { recursive: true });
  await writeFile(tokenPath, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
  await runtime.start();
  const address = await service.listen();
  await writeFile(markerPath, JSON.stringify({
    version: 1,
    role: 'desktop_char_task_manager',
    instanceId: randomUUID(),
    pid: process.pid,
    httpBaseUrl: address.baseUrl,
    httpTokenFile: tokenPath,
    sessionMonitorMarker,
    persistence: 'memory-only',
    updatedAtUtc: new Date().toISOString(),
  }, null, 2), 'utf8');
  console.log(`[task-manager] ready at ${address.baseUrl}; marker ${markerPath}`);
}
catch (error) {
  console.error('[task-manager] startup failed', error);
  await shutdown();
  process.exitCode = 1;
}

process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });

async function shutdown() {
  if (closing) return closing;
  closing = (async () => {
    await service.close().catch(() => {});
    await runtime.close().catch(() => {});
    await rm(markerPath, { force: true }).catch(() => {});
    await rm(tokenPath, { force: true }).catch(() => {});
  })();
  return closing;
}

function requiredEnvironment(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${name} must point to the Session Monitor marker`);
  }
  return value.trim();
}

function environmentPort(value) {
  if (value === undefined || value === '') return 0;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error('DESKTOP_CHAR_TASK_MANAGER_PORT must be an integer from 0 to 65535');
  }
  return port;
}
