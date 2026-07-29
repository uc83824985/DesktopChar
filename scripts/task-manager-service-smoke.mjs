import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const sessionMonitorMarker = process.env.SESSION_MONITOR_MARKER;
if (!sessionMonitorMarker) {
  throw new Error('Set SESSION_MONITOR_MARKER to the live Session Monitor marker path');
}

const stateDirectory = await mkdtemp(path.join(os.tmpdir(), 'desktop-char-task-manager-service-'));
const markerPath = path.join(stateDirectory, 'task_manager.json');
const child = spawn(process.execPath, ['task-manager/server.mjs'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    SESSION_MONITOR_MARKER: sessionMonitorMarker,
    DESKTOP_CHAR_TASK_MANAGER_STATE_DIR: stateDirectory,
    DESKTOP_CHAR_TASK_MANAGER_PORT: '0',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
let output = '';
child.stdout.on('data', chunk => { output += chunk; });
child.stderr.on('data', chunk => { output += chunk; });

try {
  const marker = await waitForMarker(markerPath, 15_000);
  const token = (await readFile(marker.httpTokenFile, 'utf8')).trim();
  const headers = { Authorization: `Bearer ${token}` };
  const healthResponse = await fetch(`${marker.httpBaseUrl}/health`);
  const health = await healthResponse.json();
  const sessionsResponse = await fetch(`${marker.httpBaseUrl}/sessions`, { headers });
  const sessions = await sessionsResponse.json();
  const eventsResponse = await fetch(`${marker.httpBaseUrl}/events?after=0`, { headers });
  const events = await eventsResponse.json();
  if (
    !healthResponse.ok
    || health.role !== 'desktop_char_task_manager'
    || !sessionsResponse.ok
    || sessions.ok !== true
    || !Array.isArray(sessions.sessions)
    || sessions.sessions.length < 1
    || !eventsResponse.ok
    || events.ok !== true
    || !Array.isArray(events.events)
    || marker.persistence !== 'memory-only'
  ) {
    throw new Error(`Unexpected Task Manager service response: ${JSON.stringify({
      health,
      sessionCount: sessions.sessions?.length,
      events,
      marker,
    })}`);
  }
  console.log(
    `Task Manager service smoke passed (${sessions.sessions.length} live session records; `
      + 'authenticated loopback API; no input submitted).',
  );
}
catch (error) {
  console.error(output);
  throw error;
}
finally {
  child.kill();
  await waitForExit(child, 5_000);
  await rm(stateDirectory, { recursive: true, force: true });
}

async function waitForMarker(filePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Task Manager exited before writing its marker (${child.exitCode})`);
    }
    try {
      return JSON.parse(await readFile(filePath, 'utf8'));
    }
    catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Task Manager marker did not appear within ${timeoutMs}ms`);
}

async function waitForExit(process, timeoutMs) {
  if (process.exitCode !== null) return;
  await Promise.race([
    new Promise(resolve => process.once('exit', resolve)),
    new Promise(resolve => setTimeout(resolve, timeoutMs)),
  ]);
}
