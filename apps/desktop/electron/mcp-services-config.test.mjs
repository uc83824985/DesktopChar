import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  normalizeDesktopConfig,
  resolveDesktopConfigPath,
  loadMcpServicesConfig,
  normalizeMcpServicesConfig,
  watchMcpServicesConfig,
} from './mcp-services-config.mjs';

test('MCP config merges environment bootstrap with JSON overrides', () => {
  const config = normalizeMcpServicesConfig({
    ttsMcp: {
      autoStart: false,
      lifecycle: {
        type: 'managed',
        start: { executable: process.execPath, args: ['provider.mjs'], cwd: '.', env: { PROVIDER_RATE: '0.8' } },
      },
      connection: { url: 'http://127.0.0.1:9876/mcp' },
      synthesis: { voice: 'test-voice' },
      reconnect: { initialDelayMs: 20, maximumDelayMs: 40 },
    },
    characterMcp: { autoStart: true, port: 0, path: '/character-mcp' },
  }, {
    DESKTOP_CHAR_TTS_MODE: 'mcp',
    DESKTOP_CHAR_TTS_MCP_URL: 'http://127.0.0.1:9999/from-env',
  });
  assert.equal(config.tts.lifecycle.type, 'managed');
  assert.equal(config.tts.autoStart, false);
  assert.equal(config.tts.connection.url, 'http://127.0.0.1:9876/mcp');
  assert.equal(config.tts.lifecycle.start.env.PROVIDER_RATE, '0.8');
  assert.equal(config.tts.synthesis.voice, 'test-voice');
  assert.equal(config.character.path, '/character-mcp');
  assert.equal(Object.isFrozen(config.tts.lifecycle.start), true);
});

test('desktop config owns interaction, window, agent and character profile settings', () => {
  const config = normalizeDesktopConfig({
    version: 1,
    interaction: { drag: { holdDelayMs: 120 } },
    window: { defaultSize: { width: 512, height: 768 }, defaultMarginDip: 16, alwaysOnTop: false },
    agentHttp: { enabled: false, port: 0 },
    character: { profile: 'models/Test/DesktopChar.character.json' },
  }, {
    DESKTOP_CHAR_DRAG_HOLD_DELAY_MS: '300',
    DESKTOP_CHAR_AGENT_PORT: '18000',
  });
  assert.equal(config.interaction.drag.holdDelayMs, 120);
  assert.deepEqual(config.window.defaultSize, { width: 512, height: 768 });
  assert.equal(config.window.alwaysOnTop, false);
  assert.equal(config.agentHttp.enabled, false);
  assert.equal(config.agentHttp.port, 0);
  assert.equal(config.characterProfile.url, 'models/Test/DesktopChar.character.json');
  assert.equal(Object.isFrozen(config.interaction.drag), true);
});

test('desktop config path prefers the new bootstrap variable and validates application fields', () => {
  assert.equal(
    resolveDesktopConfigPath({
      DESKTOP_CHAR_CONFIG_PATH: 'new.json',
      DESKTOP_CHAR_MCP_CONFIG_PATH: 'legacy.json',
    }, 'C:/workspace').replaceAll('\\', '/'),
    'C:/workspace/new.json',
  );
  assert.throws(() => normalizeDesktopConfig({ version: 2 }), /version/);
  assert.throws(() => normalizeDesktopConfig({ interaction: { drag: { holdDelayMs: 1000 } } }), /0 to 999/);
  assert.throws(() => normalizeDesktopConfig({ interaction: { drag: { holdDelyMs: 100 } } }), /unknown field/);
  assert.throws(() => normalizeDesktopConfig({ agentHttp: { host: '0.0.0.0' } }), /loopback/);
  assert.throws(() => normalizeDesktopConfig({ character: { profile: '../escape.json' } }), /parent traversal/);
});

test('MCP config rejects unsafe server binding and malformed reconnect policy', () => {
  assert.throws(() => normalizeMcpServicesConfig({ characterMcp: { host: '0.0.0.0' } }), /loopback/);
  assert.throws(() => normalizeMcpServicesConfig({ ttsMcp: { reconnect: { initialDelayMs: 50, maximumDelayMs: 10 } } }), /at least/);
  assert.throws(() => normalizeMcpServicesConfig({ ttsMcp: { synthesis: { format: 'aac' } } }), /unsupported/);
  assert.throws(() => normalizeMcpServicesConfig({ ttsMcp: { lifecycle: { type: 'embedded' } } }), /managed or external/);
  assert.throws(() => normalizeMcpServicesConfig({ ttsMcp: { contract: { version: 2 } } }), /unsupported/);
  assert.throws(() => normalizeMcpServicesConfig({}, { DESKTOP_CHAR_TTS_MCP_TOOL: 'voice.generate' }), /fixed by the DesktopChar TTS Profile/);
  assert.throws(() => normalizeMcpServicesConfig({ ttsMcp: { lifecycle: { start: { executable: 'node', env: { INVALID: 1 } } } } }), /must be a string/);
});

test('managed Local TTS uses one host and port for its process and endpoint defaults', () => {
  const config = normalizeMcpServicesConfig({}, {
    DESKTOP_CHAR_TTS_LOCAL_MCP_HOST: '127.0.0.1',
    DESKTOP_CHAR_TTS_LOCAL_MCP_PORT: '19876',
  });
  assert.equal(config.tts.lifecycle.type, 'managed');
  assert.equal(config.tts.lifecycle.start.env.DESKTOP_CHAR_TTS_LOCAL_MCP_PORT, '19876');
  assert.equal(config.tts.connection.url, 'http://127.0.0.1:19876/mcp');
});

test('MCP config loader tolerates a missing file and watcher observes later edits', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'desktop-char-mcp-config-'));
  const filePath = path.join(directory, 'desktop-char.config.json');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const missing = await loadMcpServicesConfig({ filePath, env: {} });
  assert.equal(missing.exists, false);
  const changed = new Promise(resolve => {
    const stop = watchMcpServicesConfig(filePath, () => {
      stop();
      resolve();
    }, { intervalMs: 20 });
  });
  await writeFile(filePath, JSON.stringify({ characterMcp: { port: 0 } }), 'utf8');
  await Promise.race([changed, new Promise((_, reject) => setTimeout(() => reject(new Error('config watcher timed out')), 1_000))]);
  const loaded = await loadMcpServicesConfig({ filePath, env: {} });
  assert.equal(loaded.exists, true);
  assert.equal(loaded.config.character.port, 0);
});
