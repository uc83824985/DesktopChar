import { watchFile, unwatchFile } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const AUDIO_FORMATS = new Set(['wav', 'mp3', 'ogg', 'opus', 'pcm_s16le', 'pcm_f32le']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export function resolveMcpServicesConfigPath(env = process.env, cwd = process.cwd()) {
  return path.resolve(cwd, env.DESKTOP_CHAR_MCP_CONFIG_PATH ?? 'desktop-char.config.json');
}

export async function loadMcpServicesConfig(options = {}) {
  const env = options.env ?? process.env;
  const filePath = options.filePath ?? resolveMcpServicesConfigPath(env, options.cwd);
  let fileConfig = {};
  let exists = true;
  try {
    const text = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(text);
    if (!isRecord(parsed)) throw new TypeError('MCP config root must be an object');
    fileConfig = parsed;
  }
  catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') exists = false;
    else if (error instanceof SyntaxError) throw new TypeError(`MCP config is not valid JSON: ${error.message}`, { cause: error });
    else throw error;
  }
  return {
    filePath,
    exists,
    config: normalizeMcpServicesConfig(fileConfig, env),
  };
}

export function normalizeMcpServicesConfig(fileConfig = {}, env = {}) {
  if (!isRecord(fileConfig)) throw new TypeError('MCP config root must be an object');
  const tts = optionalRecord(fileConfig.ttsMcp, 'ttsMcp');
  const local = optionalRecord(tts.local, 'ttsMcp.local');
  const ttsReconnect = optionalRecord(tts.reconnect, 'ttsMcp.reconnect');
  const character = optionalRecord(fileConfig.characterMcp, 'characterMcp');
  const characterReconnect = optionalRecord(character.reconnect, 'characterMcp.reconnect');
  const mode = text(tts.mode ?? env.DESKTOP_CHAR_TTS_MODE ?? 'local', 'ttsMcp.mode');
  if (mode !== 'local' && mode !== 'mcp') throw new TypeError('ttsMcp.mode must be local or mcp');
  const format = text(tts.format ?? env.DESKTOP_CHAR_TTS_FORMAT ?? 'pcm_s16le', 'ttsMcp.format');
  if (!AUDIO_FORMATS.has(format)) throw new TypeError('ttsMcp.format is unsupported');
  const voice = optionalText(tts.voice ?? env.DESKTOP_CHAR_TTS_VOICE, 'ttsMcp.voice');
  const ttsUrl = httpUrl(tts.url ?? env.DESKTOP_CHAR_TTS_MCP_URL ?? 'http://127.0.0.1:8766/mcp', 'ttsMcp.url');
  const characterHost = loopbackHost(character.host ?? env.DESKTOP_CHAR_CHARACTER_MCP_HOST ?? '127.0.0.1', 'characterMcp.host');
  const characterPath = endpointPath(character.path ?? env.DESKTOP_CHAR_CHARACTER_MCP_PATH ?? '/mcp');

  return deepFreeze({
    tts: {
      autoStart: boolean(tts.autoStart ?? env.DESKTOP_CHAR_TTS_MCP_ENABLED, true, 'ttsMcp.autoStart'),
      mode,
      url: ttsUrl,
      toolName: text(tts.toolName ?? env.DESKTOP_CHAR_TTS_MCP_TOOL ?? 'tts_open_stream', 'ttsMcp.toolName'),
      cancelToolName: text(tts.cancelToolName ?? env.DESKTOP_CHAR_TTS_MCP_CANCEL_TOOL ?? 'tts_cancel_synthesis', 'ttsMcp.cancelToolName'),
      timeoutMs: positive(tts.timeoutMs ?? env.DESKTOP_CHAR_TTS_TIMEOUT_MS, 30_000, 'ttsMcp.timeoutMs'),
      requestIdArgument: text(tts.requestIdArgument ?? env.DESKTOP_CHAR_TTS_REQUEST_ID_ARGUMENT ?? 'request_id', 'ttsMcp.requestIdArgument'),
      textArgument: text(tts.textArgument ?? env.DESKTOP_CHAR_TTS_TEXT_ARGUMENT ?? 'text', 'ttsMcp.textArgument'),
      format,
      ...(voice ? { voice } : {}),
      local: {
        host: loopbackHost(local.host ?? env.DESKTOP_CHAR_TTS_LOCAL_MCP_HOST ?? '127.0.0.1', 'ttsMcp.local.host'),
        port: port(local.port ?? env.DESKTOP_CHAR_TTS_LOCAL_MCP_PORT, 0, 'ttsMcp.local.port'),
        delayMs: nonNegative(local.delayMs ?? env.DESKTOP_CHAR_TTS_LOCAL_DELAY_MS, 15, 'ttsMcp.local.delayMs'),
        defaultRate: rate(local.defaultRate ?? env.DESKTOP_CHAR_TTS_LOCAL_RATE, 1, 'ttsMcp.local.defaultRate'),
        durationPerCharacterMs: positive(local.durationPerCharacterMs ?? env.DESKTOP_CHAR_TTS_LOCAL_CHAR_MS, 232, 'ttsMcp.local.durationPerCharacterMs'),
        minimumDurationMs: positive(local.minimumDurationMs ?? env.DESKTOP_CHAR_TTS_LOCAL_MIN_MS, 500, 'ttsMcp.local.minimumDurationMs'),
        sampleRateHz: positiveInteger(local.sampleRateHz ?? env.DESKTOP_CHAR_TTS_SAMPLE_RATE_HZ, 24_000, 'ttsMcp.local.sampleRateHz'),
        channels: monoChannels(local.channels ?? env.DESKTOP_CHAR_TTS_CHANNELS),
      },
      reconnect: reconnectConfig(ttsReconnect, 'ttsMcp.reconnect'),
    },
    character: {
      autoStart: boolean(character.autoStart ?? env.DESKTOP_CHAR_CHARACTER_MCP_ENABLED, true, 'characterMcp.autoStart'),
      host: characterHost,
      port: port(character.port ?? env.DESKTOP_CHAR_CHARACTER_MCP_PORT, 17_374, 'characterMcp.port'),
      path: characterPath,
      reconnect: reconnectConfig(characterReconnect, 'characterMcp.reconnect'),
    },
  });
}

export function watchMcpServicesConfig(filePath, onChanged, options = {}) {
  if (typeof onChanged !== 'function') throw new TypeError('MCP config watcher requires an onChanged callback');
  const interval = positive(options.intervalMs, 350, 'watch interval');
  let previousSignature;
  const listener = (current, previous) => {
    const signature = `${current.mtimeMs}:${current.size}`;
    const oldSignature = `${previous.mtimeMs}:${previous.size}`;
    if (signature === oldSignature || signature === previousSignature) return;
    previousSignature = signature;
    onChanged();
  };
  watchFile(filePath, { interval, persistent: false }, listener);
  return () => unwatchFile(filePath, listener);
}

function reconnectConfig(value, label) {
  const initialDelayMs = positive(value.initialDelayMs, 500, `${label}.initialDelayMs`);
  const maximumDelayMs = positive(value.maximumDelayMs, 10_000, `${label}.maximumDelayMs`);
  if (maximumDelayMs < initialDelayMs) throw new TypeError(`${label}.maximumDelayMs must be at least initialDelayMs`);
  return { initialDelayMs, maximumDelayMs };
}

function endpointPath(value) {
  const result = text(value, 'characterMcp.path');
  if (!result.startsWith('/') || result.includes('?') || result.includes('#')) {
    throw new TypeError('characterMcp.path must be an absolute URL path without query or fragment');
  }
  return result;
}

function httpUrl(value, label) {
  const result = new URL(text(value, label));
  if (result.protocol !== 'http:' && result.protocol !== 'https:') throw new TypeError(`${label} must use HTTP or HTTPS`);
  return result.href;
}

function optionalRecord(value, label) {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

function loopbackHost(value, label) {
  const result = text(value, label);
  if (!LOOPBACK_HOSTS.has(result)) throw new TypeError(`${label} must be a loopback host`);
  return result;
}

function optionalText(value, label) {
  if (value === undefined || value === null || value === '') return undefined;
  return text(value, label);
}

function text(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be a non-empty string`);
  return value.trim();
}

function boolean(value, fallback, label) {
  if (value === undefined || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new TypeError(`${label} must be a boolean`);
}

function port(value, fallback, label) {
  const result = number(value, fallback, label);
  if (!Number.isInteger(result) || result < 0 || result > 65_535) throw new TypeError(`${label} must be an integer from 0 to 65535`);
  return result;
}

function positive(value, fallback, label) {
  const result = number(value, fallback, label);
  if (!Number.isFinite(result) || result <= 0) throw new TypeError(`${label} must be positive`);
  return result;
}

function nonNegative(value, fallback, label) {
  const result = number(value, fallback, label);
  if (!Number.isFinite(result) || result < 0) throw new TypeError(`${label} must be non-negative`);
  return result;
}

function positiveInteger(value, fallback, label) {
  const result = number(value, fallback, label);
  if (!Number.isInteger(result) || result <= 0) throw new TypeError(`${label} must be a positive integer`);
  return result;
}

function monoChannels(value) {
  const result = positiveInteger(value, 1, 'ttsMcp.local.channels');
  if (result !== 1) throw new TypeError('ttsMcp.local.channels must be 1 for the reference Provider');
  return result;
}

function rate(value, fallback, label) {
  const result = number(value, fallback, label);
  if (!Number.isFinite(result) || result < 0.5 || result > 2) throw new TypeError(`${label} must be from 0.5 to 2`);
  return result;
}

function number(value, fallback, label) {
  if (value === undefined || value === '') return fallback;
  const result = Number(value);
  if (!Number.isFinite(result)) throw new TypeError(`${label} must be a finite number`);
  return result;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepFreeze(value) {
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') deepFreeze(child);
  }
  return Object.freeze(value);
}
