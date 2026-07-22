import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createLocalTtsMcpService } from '../../../local-tts-mcp/service.mjs';
import { createMcpServicesController } from './mcp-services-controller.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const localTtsServer = path.join(repositoryRoot, 'local-tts-mcp/server.mjs');

test('both MCP services dynamically enable, test, reload and disable', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'desktop-char-mcp-controller-'));
  const configFilePath = path.join(directory, 'desktop-char.config.json');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ttsPort = await reservePort();
  const baseConfig = {
    ttsMcp: managedLocalTtsConfig(ttsPort, { autoStart: false }),
    characterMcp: { autoStart: false, port: 0 },
  };
  await writeFile(configFilePath, JSON.stringify(baseConfig), 'utf8');
  const states = [];
  const commands = [];
  const controller = createMcpServicesController({
    configFilePath,
    env: {},
    onStateChanged: state => states.push(state),
    onCharacterCommand: command => commands.push(command),
  });
  t.after(() => controller.close());
  await controller.start();
  assert.equal(controller.snapshot().tts.phase, 'disabled');
  assert.equal(controller.snapshot().character.phase, 'disabled');
  let combined = await controller.testAll();
  assert.equal(combined.character.status, 'failed');
  assert.equal(combined.tts.status, 'failed');
  assert.match(combined.character.details, /角色接入 MCP 服务未启用/);
  assert.match(combined.tts.details, /语音合成 MCP 服务未启用/);

  let state = await controller.setEnabled('tts', true);
  assert.equal(state.tts.phase, 'ready');
  assert.equal(state.tts.endpoint, `http://127.0.0.1:${ttsPort}/mcp`);
  assert.ok(state.tts.processId);
  assert.equal((await controller.test('tts')).status, 'passed');
  state = await controller.setEnabled('character', true);
  assert.equal(state.character.phase, 'ready');
  assert.match(state.character.endpoint, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  assert.equal((await controller.test('character')).status, 'passed');
  combined = await controller.testAll();
  assert.equal(combined.character.status, 'passed');
  assert.equal(combined.tts.status, 'passed');

  const stableEndpoints = {
    tts: controller.snapshot().tts.endpoint,
    character: controller.snapshot().character.endpoint,
  };
  await writeFile(configFilePath, JSON.stringify({
    ...baseConfig,
    interaction: { drag: { holdDelayMs: 123 } },
  }), 'utf8');
  state = await controller.reload('application-only-test');
  assert.equal(state.tts.endpoint, stableEndpoints.tts, 'application-only changes must not restart TTS MCP');
  assert.equal(state.character.endpoint, stableEndpoints.character, 'application-only changes must not restart character MCP');
  assert.equal(controller.currentDesktopConfig().interaction.drag.holdDelayMs, 123);

  await writeFile(configFilePath, JSON.stringify({
    ttsMcp: managedLocalTtsConfig(ttsPort, {
      autoStart: false,
      rate: 0.8,
      reconnect: { initialDelayMs: 20, maximumDelayMs: 80 },
    }),
    characterMcp: {
      autoStart: false,
      port: 0,
      path: '/character-hot',
      reconnect: { initialDelayMs: 20, maximumDelayMs: 80 },
    },
  }), 'utf8');
  state = await controller.reload('test');
  assert.equal(state.tts.phase, 'ready');
  assert.equal(state.character.phase, 'ready');
  assert.match(state.character.endpoint, /\/character-hot$/);
  assert.equal(state.tts.desiredEnabled, true, 'reload must preserve the UI-owned desired state');
  assert.equal(state.character.desiredEnabled, true);

  state = await controller.setEnabled('tts', false);
  assert.equal(state.tts.phase, 'disabled');
  await assertEndpointUnavailable(`http://127.0.0.1:${ttsPort}/mcp`);
  state = await controller.setEnabled('character', false);
  assert.equal(state.character.phase, 'disabled');
  assert.ok(states.length > 8);
  assert.deepEqual(commands, []);
});

test('TTS hot reload waits for the Runtime idle boundary', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'desktop-char-mcp-idle-'));
  const configFilePath = path.join(directory, 'desktop-char.config.json');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ttsPort = await reservePort();
  await writeFile(configFilePath, JSON.stringify({
    ttsMcp: managedLocalTtsConfig(ttsPort, { autoStart: true, delayMs: 1 }),
    characterMcp: { autoStart: false },
  }), 'utf8');
  const controller = createMcpServicesController({ configFilePath, env: {} });
  t.after(() => controller.close());
  await controller.start();
  await waitFor(() => controller.snapshot().tts.phase === 'ready');
  const endpoint = controller.snapshot().tts.endpoint;
  const processId = controller.snapshot().tts.processId;
  controller.updateAvatarState({ ready: true, snapshot: { state: 'speaking' } });
  await writeFile(configFilePath, JSON.stringify({
    ttsMcp: managedLocalTtsConfig(ttsPort, { autoStart: true, delayMs: 2 }),
    characterMcp: { autoStart: false },
  }), 'utf8');
  const pending = await controller.reload('test');
  assert.equal(pending.tts.phase, 'reload-pending');
  assert.equal(pending.tts.endpoint, endpoint);
  controller.updateAvatarState({ ready: true, snapshot: { state: 'idle' } });
  await waitFor(() => controller.snapshot().tts.phase === 'ready'
    && controller.snapshot().tts.processId !== processId);
  assert.equal(controller.snapshot().tts.endpoint, endpoint);
});

test('external TTS reconnects when its MCP endpoint becomes available', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'desktop-char-mcp-reconnect-'));
  const configFilePath = path.join(directory, 'desktop-char.config.json');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const reservation = createLocalTtsMcpService({ port: 0 });
  const reservedAddress = await reservation.listen();
  await reservation.close();
  await writeFile(configFilePath, JSON.stringify({
    ttsMcp: {
      autoStart: true,
      lifecycle: { type: 'external' },
      connection: { url: `http://127.0.0.1:${reservedAddress.port}/mcp`, timeoutMs: 100 },
      reconnect: { initialDelayMs: 20, maximumDelayMs: 40 },
    },
    characterMcp: { autoStart: false },
  }), 'utf8');
  const controller = createMcpServicesController({ configFilePath, env: {} });
  t.after(() => controller.close());
  await controller.start();
  await waitFor(() => controller.snapshot().tts.phase === 'reconnecting'
    && controller.snapshot().tts.reconnectAttempt >= 1);
  const provider = createLocalTtsMcpService({ port: reservedAddress.port });
  await provider.listen();
  t.after(() => provider.close());
  await waitFor(() => controller.snapshot().tts.phase === 'ready');
  assert.equal(controller.snapshot().tts.reconnectAttempt, 0);
  assert.equal((await controller.test('tts')).status, 'passed');
  const disabled = await controller.setEnabled('tts', false);
  assert.equal(disabled.tts.phase, 'disabled');
  assert.equal(disabled.tts.nextReconnectAt, null);
  assert.equal(provider.diagnostics().baseUrl, reservedAddress.baseUrl, 'external lifecycle must not stop the Provider');
});

test('character MCP retries its loopback binding after a port conflict clears', async t => {
  const blocker = http.createServer();
  await new Promise((resolve, reject) => {
    blocker.once('error', reject);
    blocker.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => blocker.listening ? new Promise(resolve => blocker.close(() => resolve())) : undefined);
  const address = blocker.address();
  assert.ok(address && typeof address !== 'string');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'desktop-char-character-reconnect-'));
  const configFilePath = path.join(directory, 'desktop-char.config.json');
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(configFilePath, JSON.stringify({
    ttsMcp: { autoStart: false },
    characterMcp: {
      autoStart: true,
      port: address.port,
      reconnect: { initialDelayMs: 20, maximumDelayMs: 40 },
    },
  }), 'utf8');
  const controller = createMcpServicesController({ configFilePath, env: {} });
  t.after(() => controller.close());
  await controller.start();
  await waitFor(() => controller.snapshot().character.phase === 'reconnecting');
  await new Promise((resolve, reject) => blocker.close(error => error ? reject(error) : resolve()));
  await waitFor(() => controller.snapshot().character.phase === 'ready');
  assert.match(controller.snapshot().character.endpoint, new RegExp(`:${address.port}/mcp$`));
});

test('controller automatically applies a saved config file revision', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'desktop-char-config-watch-'));
  const configFilePath = path.join(directory, 'desktop-char.config.json');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const controller = createMcpServicesController({
    configFilePath,
    env: {
      DESKTOP_CHAR_TTS_MCP_ENABLED: 'false',
      DESKTOP_CHAR_CHARACTER_MCP_ENABLED: 'false',
    },
  });
  t.after(() => controller.close());
  await controller.start();
  const revision = controller.snapshot().config.revision;
  await writeFile(configFilePath, JSON.stringify({
    ttsMcp: { autoStart: false, lifecycle: { type: 'external' }, connection: { timeoutMs: 12_345 } },
    characterMcp: { autoStart: false, path: '/watched-mcp' },
  }), 'utf8');
  await waitFor(() => controller.snapshot().config.revision > revision, 3_000);
  assert.equal(controller.currentTtsConfig().timeoutMs, 12_345);
  assert.equal(controller.snapshot().config.status, 'ready');
});

async function waitFor(predicate, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('condition timed out');
}

function managedLocalTtsConfig(port, options = {}) {
  return {
    autoStart: options.autoStart ?? true,
    lifecycle: {
      type: 'managed',
      start: {
        executable: process.execPath,
        args: [localTtsServer],
        cwd: repositoryRoot,
        env: {
          DESKTOP_CHAR_TTS_LOCAL_MCP_HOST: '127.0.0.1',
          DESKTOP_CHAR_TTS_LOCAL_MCP_PORT: String(port),
          DESKTOP_CHAR_TTS_LOCAL_DELAY_MS: String(options.delayMs ?? 1),
          DESKTOP_CHAR_TTS_LOCAL_RATE: String(options.rate ?? 1),
        },
      },
      startupTimeoutMs: 5_000,
      shutdownTimeoutMs: 2_000,
      healthIntervalMs: 100,
    },
    connection: { url: `http://127.0.0.1:${port}/mcp`, timeoutMs: 1_000 },
    ...(options.reconnect ? { reconnect: options.reconnect } : {}),
  };
}

async function reservePort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to reserve loopback port');
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

async function assertEndpointUnavailable(url) {
  await assert.rejects(fetch(url, { method: 'GET' }));
}
