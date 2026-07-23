import assert from 'node:assert/strict';
import { mkdir as fsMkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
      profile: 'custom',
    },
    characterMcp: { autoStart: true, port: 0, path: '/character-mcp' },
  }, {
    DESKTOP_CHAR_TTS_MODE: 'mcp',
    DESKTOP_CHAR_TTS_MCP_URL: 'http://127.0.0.1:9999/from-env',
  }, {
    ttsProfileName: 'custom',
    ttsProfileConfig: {
      lifecycle: {
        type: 'managed',
        start: { executable: process.execPath, args: ['provider.mjs'], cwd: '.', env: { PROVIDER_RATE: '0.8' } },
      },
      connection: { url: 'http://127.0.0.1:9876/mcp' },
      synthesis: { voice: 'test-voice', rate: 1.25 },
      reconnect: { initialDelayMs: 20, maximumDelayMs: 40 },
    },
  });
  assert.equal(config.tts.lifecycle.type, 'managed');
  assert.equal(config.tts.autoStart, false);
  assert.equal(config.tts.connection.url, 'http://127.0.0.1:9876/mcp');
  assert.equal(config.tts.lifecycle.start.env.PROVIDER_RATE, '0.8');
  assert.equal(config.tts.synthesis.voice, 'test-voice');
  assert.equal(config.tts.synthesis.rate, 1.25);
  assert.equal(config.character.path, '/character-mcp');
  assert.equal(Object.isFrozen(config.tts.lifecycle.start), true);
});

test('TTS config exposes the selected profile name from the resolved profile file', () => {
  const config = normalizeMcpServicesConfig({
    ttsMcp: {
      autoStart: true,
      profile: 'qwen',
    },
  }, {}, {
    ttsProfileName: 'qwen',
    ttsProfileConfig: {
      lifecycle: {
        type: 'managed',
        start: {
          executable: 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
          args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'G:/Qwen3-TTS-GGUF/Start-DesktopChar-TTS-MCP.ps1'],
          cwd: 'G:/Qwen3-TTS-GGUF',
          env: { PYTHONUTF8: '1' },
        },
      },
      connection: { url: 'http://127.0.0.1:8766/mcp', timeoutMs: 45_000 },
      synthesis: { format: 'pcm_s16le', rate: 1 },
    },
  });
  assert.equal(config.tts.profile, 'qwen');
  assert.equal(config.tts.lifecycle.start.cwd.replaceAll('\\', '/'), 'G:/Qwen3-TTS-GGUF');
  assert.equal(config.tts.connection.timeoutMs, 45_000);
  assert.equal(config.tts.synthesis.rate, 1);
  assert.equal(config.tts.synthesis.voice, undefined);
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
  assert.equal(config.performanceInference.enabled, false);
  assert.equal(config.performanceInference.lifecycle, 'external');
  assert.equal(config.performanceInference.baseUrl, 'http://127.0.0.1:18090/v1');
  assert.equal(Object.isFrozen(config.interaction.drag), true);
  assert.equal(config.tts.profile, 'local');
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
  assert.throws(() => normalizeDesktopConfig({ performanceInference: { temperature: 3 } }), /0 to 2/);
  assert.throws(() => normalizeDesktopConfig({ performanceInference: { maxOutputTokens: 0 } }), /positive integer/);
  assert.throws(
    () => normalizeDesktopConfig({ performanceInference: { lifecycle: 'managed' } }),
    /only supports external/,
  );
  assert.throws(
    () => normalizeDesktopConfig({ performanceInference: { baseUrl: 'https://example.com/v1' } }),
    /loopback HTTP origin/,
  );
});

test('MCP config rejects unsafe server binding and malformed reconnect policy', () => {
  assert.throws(() => normalizeMcpServicesConfig({ characterMcp: { host: '0.0.0.0' } }), /loopback/);
  assert.throws(() => normalizeMcpServicesConfig({ ttsMcp: { profiles: {} } }), /unknown field/);
  assert.throws(() => normalizeMcpServicesConfig({ ttsMcp: { activeProfile: 'local' } }), /unknown field/);
  assert.throws(() => normalizeMcpServicesConfig({ ttsMcp: { lifecycle: { type: 'managed' } } }), /unknown field/);
  assert.throws(() => normalizeMcpServicesConfig({}, {}, { ttsProfileName: 'bad', ttsProfileConfig: { reconnect: { initialDelayMs: 50, maximumDelayMs: 10 } } }), /at least/);
  assert.throws(() => normalizeMcpServicesConfig({}, {}, { ttsProfileName: 'bad', ttsProfileConfig: { synthesis: { format: 'aac' } } }), /unsupported/);
  assert.throws(() => normalizeMcpServicesConfig({}, {}, { ttsProfileName: 'bad', ttsProfileConfig: { synthesis: { rate: 0.4 } } }), /0.5 to 2/);
  assert.throws(() => normalizeMcpServicesConfig({}, {}, { ttsProfileName: 'bad', ttsProfileConfig: { lifecycle: { type: 'embedded' } } }), /managed or external/);
  assert.throws(() => normalizeMcpServicesConfig({}, {}, { ttsProfileName: 'bad', ttsProfileConfig: { contract: { version: 2 } } }), /version must be 1|unsupported/);
  assert.throws(() => normalizeMcpServicesConfig({}, { DESKTOP_CHAR_TTS_MCP_TOOL: 'voice.generate' }), /fixed by the DesktopChar TTS Profile/);
  assert.throws(() => normalizeMcpServicesConfig({}, {}, { ttsProfileName: 'bad', ttsProfileConfig: { lifecycle: { start: { executable: 'node', env: { INVALID: 1 } } } } }), /must be a string/);
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

test('checked-in desktop config example stays aligned with built-in defaults', async () => {
  const examplePath = new URL('../../../desktop-char.config.example.json', import.meta.url);
  const example = JSON.parse(await readFile(examplePath, 'utf8'));
  assert.deepEqual(
    normalizeDesktopConfig(example, {}),
    normalizeDesktopConfig({}, {}),
  );
});

test('desktop config loader falls back from a missing user config to example then built-in defaults', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'desktop-char-config-fallback-'));
  const filePath = path.join(directory, 'desktop-char.config.json');
  const exampleFilePath = path.join(directory, 'desktop-char.config.example.json');
  const profileDirectory = path.join(directory, 'tts-mcp-profiles');
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeProfile(profileDirectory, 'local', {});
  await writeFile(exampleFilePath, JSON.stringify({
    version: 1,
    interaction: { drag: { holdDelayMs: 321 } },
    window: { defaultSize: { width: 512, height: 768 } },
    ttsMcp: { profile: 'local' },
  }), 'utf8');

  const fromExample = await loadMcpServicesConfig({ filePath, exampleFilePath, env: {} });
  assert.equal(fromExample.exists, false);
  assert.equal(fromExample.source, 'example');
  assert.equal(fromExample.sourcePath, exampleFilePath);
  assert.equal(fromExample.config.interaction.drag.holdDelayMs, 321);
  assert.deepEqual(fromExample.config.window.defaultSize, { width: 512, height: 768 });

  await writeFile(filePath, JSON.stringify({
    interaction: { drag: { holdDelayMs: 123 } },
    window: { alwaysOnTop: false },
  }), 'utf8');
  const fromUserOverride = await loadMcpServicesConfig({
    filePath,
    exampleFilePath,
    env: { DESKTOP_CHAR_DRAG_HOLD_DELAY_MS: '222' },
  });
  assert.equal(fromUserOverride.exists, true);
  assert.equal(fromUserOverride.source, 'user');
  assert.equal(fromUserOverride.sourcePath, filePath);
  assert.equal(fromUserOverride.config.interaction.drag.holdDelayMs, 123);
  assert.deepEqual(fromUserOverride.config.window.defaultSize, { width: 512, height: 768 });
  assert.equal(fromUserOverride.config.window.alwaysOnTop, false);

  await writeFile(filePath, JSON.stringify({
    window: { alwaysOnTop: false },
  }), 'utf8');
  const fromEnvironmentOverride = await loadMcpServicesConfig({
    filePath,
    exampleFilePath,
    env: { DESKTOP_CHAR_DRAG_HOLD_DELAY_MS: '222' },
  });
  assert.equal(fromEnvironmentOverride.config.interaction.drag.holdDelayMs, 222);

  await rm(filePath);
  await rm(exampleFilePath);
  const fromBuiltIn = await loadMcpServicesConfig({ filePath, exampleFilePath, env: {} });
  assert.equal(fromBuiltIn.exists, false);
  assert.equal(fromBuiltIn.source, 'built-in');
  assert.equal(fromBuiltIn.sourcePath, null);
  assert.equal(fromBuiltIn.config.interaction.drag.holdDelayMs, 180);
  assert.deepEqual(fromBuiltIn.config.window.defaultSize, { width: 460, height: 700 });
});

test('desktop config loader reports an invalid example instead of silently using built-in defaults', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'desktop-char-config-invalid-example-'));
  const filePath = path.join(directory, 'desktop-char.config.json');
  const exampleFilePath = path.join(directory, 'desktop-char.config.example.json');
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(exampleFilePath, '{ invalid', 'utf8');
  await assert.rejects(
    loadMcpServicesConfig({ filePath, exampleFilePath, env: {} }),
    /Desktop example config is not valid JSON/,
  );
});

test('MCP config loader tolerates a missing file and watcher observes later edits', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'desktop-char-mcp-config-'));
  const filePath = path.join(directory, 'desktop-char.config.json');
  const profileDirectory = path.join(directory, 'tts-mcp-profiles');
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeProfile(profileDirectory, 'local', {});
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

async function writeProfile(directory, name, profile) {
  await fsMkdir(directory, { recursive: true });
  await writeFile(path.join(directory, `${name}.json`), JSON.stringify({
    $schema: '../../apps/desktop/public/schemas/desktop-char.tts-mcp-profile.schema.json',
    version: 1,
    ...profile,
  }), 'utf8');
}
