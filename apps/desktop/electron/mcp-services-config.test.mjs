import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  loadMcpServicesConfig,
  normalizeMcpServicesConfig,
  watchMcpServicesConfig,
} from './mcp-services-config.mjs';

test('MCP config merges environment bootstrap with JSON overrides', () => {
  const config = normalizeMcpServicesConfig({
    ttsMcp: { mode: 'local', autoStart: false, local: { port: 0, defaultRate: 0.8 }, reconnect: { initialDelayMs: 20, maximumDelayMs: 40 } },
    characterMcp: { autoStart: true, port: 0, path: '/character-mcp' },
  }, {
    DESKTOP_CHAR_TTS_MODE: 'mcp',
    DESKTOP_CHAR_TTS_MCP_URL: 'http://127.0.0.1:9999/from-env',
    DESKTOP_CHAR_TTS_MCP_TOOL: 'voice.generate',
  });
  assert.equal(config.tts.mode, 'local');
  assert.equal(config.tts.autoStart, false);
  assert.equal(config.tts.toolName, 'voice.generate');
  assert.equal(config.tts.local.defaultRate, 0.8);
  assert.equal(config.character.path, '/character-mcp');
  assert.equal(Object.isFrozen(config.tts.local), true);
});

test('MCP config rejects unsafe server binding and malformed reconnect policy', () => {
  assert.throws(() => normalizeMcpServicesConfig({ characterMcp: { host: '0.0.0.0' } }), /loopback/);
  assert.throws(() => normalizeMcpServicesConfig({ ttsMcp: { reconnect: { initialDelayMs: 50, maximumDelayMs: 10 } } }), /at least/);
  assert.throws(() => normalizeMcpServicesConfig({ ttsMcp: { format: 'aac' } }), /unsupported/);
  assert.throws(() => normalizeMcpServicesConfig({ ttsMcp: { local: { channels: 2 } } }), /must be 1/);
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
