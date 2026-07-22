import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { startManagedProcess } from './managed-process.mjs';

test('Windows managed process close terminates the full process tree', async () => {
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
  assert.deepEqual(treeCalls, [{ pid: 4321, force: false }]);
  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.deepEqual(child.killCalls, []);
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
