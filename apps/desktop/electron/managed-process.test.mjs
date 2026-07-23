import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { startManagedProcess } from './managed-process.mjs';

test('Windows managed process close immediately force-terminates the owned process tree', async () => {
  const child = createFakeChild(4321);
  const treeCalls = [];
  const processHandle = await startManagedProcess({
    executable: 'powershell.exe',
    args: ['-File', 'Start-DesktopChar-TTS-MCP.ps1'],
  }, {
    platform: 'win32',
    spawnProcess: () => child,
    useProcessHost: false,
    closeProcessTree: async (pid, options) => {
      treeCalls.push({ pid, ...options });
      setImmediate(() => child.emit('exit', 0, null));
    },
  });

  const result = await processHandle.close(20);
  assert.deepEqual(treeCalls, [{ pid: 4321, force: true }]);
  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.deepEqual(child.killCalls, []);
});

test('Windows managed process closes a real hosted Node tree without waiting for the shutdown timeout', {
  skip: process.platform !== 'win32',
}, async () => {
  const processHandle = await startManagedProcess({
    executable: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    cwd: process.cwd(),
    env: {},
  });
  const startedAt = performance.now();
  await processHandle.close(8_000);
  const elapsedMs = performance.now() - startedAt;

  assert.ok(elapsedMs < 7_000, `owned process tree took ${Math.round(elapsedMs)} ms to close`);
  assert.throws(() => process.kill(processHandle.pid, 0));
});

test('Windows process host removes its Provider tree after an abrupt owner death', {
  skip: process.platform !== 'win32',
  timeout: 10_000,
}, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'desktop-char-managed-orphan-'));
  const pidFile = path.join(directory, 'provider.pid');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const hostPath = fileURLToPath(new URL('./managed-process-host.mjs', import.meta.url));
  const payload = Buffer.from(JSON.stringify({
    // A missing owner is the observable state after Electron is force-killed.
    parentPid: 2_147_483_000,
    spec: {
      executable: process.execPath,
      args: [
        '-e',
        'require("node:fs").writeFileSync(process.env.PID_FILE,String(process.pid));'
          + 'setInterval(()=>{},1000)',
      ],
      cwd: process.cwd(),
      env: { PID_FILE: pidFile },
    },
  }), 'utf8').toString('base64');
  const host = spawn(process.execPath, [hostPath, payload], {
    windowsHide: true,
    shell: false,
    stdio: 'ignore',
  });

  const providerPid = Number(await waitForFile(pidFile));
  assert.equal(Number.isInteger(providerPid), true);
  await waitForProcessExit(providerPid);
  await waitForChildExit(host);
  assert.throws(() => process.kill(providerPid, 0));
});

test('non-Windows managed process keeps direct signal shutdown', async () => {
  const child = createFakeChild(9876);
  const processHandle = await startManagedProcess({
    executable: 'node',
    args: ['server.mjs'],
  }, {
    platform: 'linux',
    spawnProcess: () => child,
  });

  setImmediate(() => child.emit('exit', 0, 'SIGTERM'));
  const result = await processHandle.close(20);
  assert.deepEqual(child.killCalls, ['SIGTERM']);
  assert.equal(result.code, 0);
  assert.equal(result.signal, 'SIGTERM');
});

function createFakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killCalls = [];
  child.kill = signal => {
    child.killCalls.push(signal);
    return true;
  };
  setImmediate(() => child.emit('spawn'));
  return child;
}

async function waitForFile(filePath, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await readFile(filePath, 'utf8');
    }
    catch {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

async function waitForProcessExit(pid, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    catch {
      return;
    }
  }
  throw new Error(`Process ${pid} did not exit`);
}

async function waitForChildExit(child, timeoutMs = 5_000) {
  if (child.exitCode !== null) return;
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    new Promise((_, reject) => setTimeout(
      () => reject(new Error(`Process host ${child.pid} did not exit`)),
      timeoutMs,
    )),
  ]);
}
