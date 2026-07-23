import { watchFile, unwatchFile } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const AUDIO_FORMATS = new Set(['wav', 'mp3', 'ogg', 'opus', 'pcm_s16le', 'pcm_f32le']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const TTS_PROFILE_DIRECTORY = 'tts-mcp-profiles';
const DEFAULT_TTS_PROFILE_NAME = 'local';
const DEFAULT_DESKTOP_CONFIG_EXAMPLE = 'desktop-char.config.example.json';

export function resolveDesktopConfigPath(env = process.env, cwd = process.cwd(), defaultFilePath) {
  const configuredPath = env.DESKTOP_CHAR_CONFIG_PATH ?? env.DESKTOP_CHAR_MCP_CONFIG_PATH;
  return configuredPath
    ? path.resolve(cwd, configuredPath)
    : path.resolve(defaultFilePath ?? path.join(cwd, 'desktop-char.config.json'));
}

export function resolveDesktopExampleConfigPath(cwd = process.cwd(), defaultFilePath) {
  return path.resolve(defaultFilePath ?? path.join(cwd, DEFAULT_DESKTOP_CONFIG_EXAMPLE));
}

export async function loadDesktopConfig(options = {}) {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const filePath = options.filePath ?? resolveDesktopConfigPath(env, options.cwd, options.defaultFilePath);
  const exampleFilePath = resolveDesktopExampleConfigPath(cwd, options.exampleFilePath);
  let userConfig;
  let exampleConfig;
  let exists = true;
  try {
    userConfig = await readConfigObject(filePath, 'Desktop config');
  }
  catch (error) {
    if (!isMissingFileError(error)) throw error;
    exists = false;
  }
  try {
    exampleConfig = await readConfigObject(exampleFilePath, 'Desktop example config');
  }
  catch (error) {
    if (!isMissingFileError(error)) throw error;
  }
  const source = exists ? 'user' : exampleConfig ? 'example' : 'built-in';
  const presetConfig = mergeConfigObjects(exampleConfig ?? {}, desktopEnvironmentOverrides(env));
  const fileConfig = mergeConfigObjects(presetConfig, userConfig ?? {});
  const ttsProfileName = requestedTtsProfileName(optionalRecord(fileConfig.ttsMcp, 'ttsMcp'));
  const ttsProfile = await loadTtsProfileConfig(ttsProfileName, {
    configFilePath: filePath,
    exampleConfigFilePath: exampleFilePath,
    cwd,
  });
  return {
    filePath,
    exists,
    source,
    sourcePath: source === 'user' ? filePath : source === 'example' ? exampleFilePath : null,
    config: normalizeDesktopConfig(fileConfig, env, {
      ttsProfileName: ttsProfileName,
      ttsProfileConfig: ttsProfile.config,
      ttsProfilePath: ttsProfile.filePath,
      cwd,
      configFilePath: filePath,
    }),
  };
}

export function normalizeDesktopConfig(fileConfig = {}, env = {}, options = {}) {
  if (!isRecord(fileConfig)) throw new TypeError('Desktop config root must be an object');
  assertKnownKeys(fileConfig, ['$schema', 'version', 'interaction', 'window', 'agentHttp', 'character', 'ttsMcp', 'characterMcp'], 'Desktop config');
  if (fileConfig.$schema !== undefined) text(fileConfig.$schema, '$schema');
  const version = fileConfig.version ?? 1;
  if (version !== 1) throw new TypeError('Desktop config version must be 1');
  const interaction = optionalRecord(fileConfig.interaction, 'interaction');
  assertKnownKeys(interaction, ['drag'], 'interaction');
  const drag = optionalRecord(interaction.drag, 'interaction.drag');
  assertKnownKeys(drag, ['holdDelayMs'], 'interaction.drag');
  const window = optionalRecord(fileConfig.window, 'window');
  assertKnownKeys(window, ['defaultSize', 'defaultMarginDip', 'alwaysOnTop'], 'window');
  const defaultSize = optionalRecord(window.defaultSize, 'window.defaultSize');
  assertKnownKeys(defaultSize, ['width', 'height'], 'window.defaultSize');
  const agentHttp = optionalRecord(fileConfig.agentHttp, 'agentHttp');
  assertKnownKeys(agentHttp, ['enabled', 'host', 'port'], 'agentHttp');
  const characterProfile = optionalRecord(fileConfig.character, 'character');
  assertKnownKeys(characterProfile, ['profile'], 'character');
  const tts = optionalRecord(fileConfig.ttsMcp, 'ttsMcp');
  assertKnownKeys(tts, ['autoStart', 'profile'], 'ttsMcp');
  const selectedTtsProfileName = options.ttsProfileName ?? requestedTtsProfileName(tts);
  const selectedTtsProfile = normalizeSelectedTtsProfile(options.ttsProfileConfig ?? defaultLocalTtsProfile(), selectedTtsProfileName);
  const lifecycle = optionalRecord(selectedTtsProfile.lifecycle, 'ttsMcp.lifecycle');
  assertKnownKeys(lifecycle, ['type', 'start', 'startupTimeoutMs', 'shutdownTimeoutMs', 'healthIntervalMs', 'restartOnFailure'], 'ttsMcp.lifecycle');
  const launch = optionalRecord(lifecycle.start, 'ttsMcp.lifecycle.start');
  assertKnownKeys(launch, ['executable', 'args', 'cwd', 'env'], 'ttsMcp.lifecycle.start');
  const connection = optionalRecord(selectedTtsProfile.connection, 'ttsMcp.connection');
  assertKnownKeys(connection, ['transport', 'url', 'timeoutMs'], 'ttsMcp.connection');
  const contract = optionalRecord(selectedTtsProfile.contract, 'ttsMcp.contract');
  assertKnownKeys(contract, ['profile', 'version'], 'ttsMcp.contract');
  const synthesis = optionalRecord(selectedTtsProfile.synthesis, 'ttsMcp.synthesis');
  assertKnownKeys(synthesis, ['format', 'voice', 'rate'], 'ttsMcp.synthesis');
  const ttsReconnect = optionalRecord(selectedTtsProfile.reconnect, 'ttsMcp.reconnect');
  const character = optionalRecord(fileConfig.characterMcp, 'characterMcp');
  assertKnownKeys(character, ['autoStart', 'host', 'port', 'path', 'reconnect'], 'characterMcp');
  const characterReconnect = optionalRecord(character.reconnect, 'characterMcp.reconnect');
  fixedSemanticName(env.DESKTOP_CHAR_TTS_MCP_TOOL, 'tts_open_stream', 'DESKTOP_CHAR_TTS_MCP_TOOL');
  fixedSemanticName(env.DESKTOP_CHAR_TTS_MCP_CANCEL_TOOL, 'tts_cancel_synthesis', 'DESKTOP_CHAR_TTS_MCP_CANCEL_TOOL');
  fixedSemanticName(env.DESKTOP_CHAR_TTS_REQUEST_ID_ARGUMENT, 'request_id', 'DESKTOP_CHAR_TTS_REQUEST_ID_ARGUMENT');
  fixedSemanticName(env.DESKTOP_CHAR_TTS_TEXT_ARGUMENT, 'text', 'DESKTOP_CHAR_TTS_TEXT_ARGUMENT');
  const lifecycleType = ttsLifecycleType(lifecycle.type ?? env.DESKTOP_CHAR_TTS_LIFECYCLE, env.DESKTOP_CHAR_TTS_MODE);
  const format = text(synthesis.format ?? env.DESKTOP_CHAR_TTS_FORMAT ?? 'pcm_s16le', 'ttsMcp.synthesis.format');
  if (!AUDIO_FORMATS.has(format)) throw new TypeError('ttsMcp.format is unsupported');
  const voice = optionalText(synthesis.voice ?? env.DESKTOP_CHAR_TTS_VOICE, 'ttsMcp.synthesis.voice');
  const synthesisRateValue = synthesis.rate ?? env.DESKTOP_CHAR_TTS_RATE;
  const synthesisRate = synthesisRateValue === undefined || synthesisRateValue === ''
    ? undefined
    : rate(synthesisRateValue, 1, 'ttsMcp.synthesis.rate');
  const transport = text(connection.transport ?? 'streamable-http', 'ttsMcp.connection.transport');
  if (transport !== 'streamable-http') throw new TypeError('ttsMcp.connection.transport must be streamable-http');
  const profile = text(contract.profile ?? 'desktop-char.tts.streaming', 'ttsMcp.contract.profile');
  if (profile !== 'desktop-char.tts.streaming') throw new TypeError('ttsMcp.contract.profile is unsupported');
  const profileVersion = positiveInteger(contract.version, 1, 'ttsMcp.contract.version');
  if (profileVersion !== 1) throw new TypeError('ttsMcp.contract.version is unsupported');
  const defaultLocalLaunch = Object.keys(launch).length === 0;
  const localHost = loopbackHost(env.DESKTOP_CHAR_TTS_LOCAL_MCP_HOST ?? '127.0.0.1', 'DESKTOP_CHAR_TTS_LOCAL_MCP_HOST');
  const localPort = port(env.DESKTOP_CHAR_TTS_LOCAL_MCP_PORT, 8_766, 'DESKTOP_CHAR_TTS_LOCAL_MCP_PORT');
  const defaultTtsUrl = `http://${urlHost(localHost)}:${localPort}/mcp`;
  const ttsUrl = httpUrl(connection.url ?? env.DESKTOP_CHAR_TTS_MCP_URL ?? defaultTtsUrl, 'ttsMcp.connection.url');
  const localDelayMs = nonNegative(env.DESKTOP_CHAR_TTS_LOCAL_DELAY_MS, 15, 'DESKTOP_CHAR_TTS_LOCAL_DELAY_MS');
  const localRate = rate(env.DESKTOP_CHAR_TTS_LOCAL_RATE, 1, 'DESKTOP_CHAR_TTS_LOCAL_RATE');
  const localCharacterMs = positive(env.DESKTOP_CHAR_TTS_LOCAL_CHAR_MS, 232, 'DESKTOP_CHAR_TTS_LOCAL_CHAR_MS');
  const localMinimumMs = positive(env.DESKTOP_CHAR_TTS_LOCAL_MIN_MS, 500, 'DESKTOP_CHAR_TTS_LOCAL_MIN_MS');
  const localSampleRate = positiveInteger(env.DESKTOP_CHAR_TTS_SAMPLE_RATE_HZ, 24_000, 'DESKTOP_CHAR_TTS_SAMPLE_RATE_HZ');
  const localChannels = monoChannels(env.DESKTOP_CHAR_TTS_CHANNELS);
  const defaultCwd = path.resolve(process.cwd());
  const defaultServerPath = path.resolve(defaultCwd, 'local-tts-mcp/server.mjs');
  const characterHost = loopbackHost(character.host ?? env.DESKTOP_CHAR_CHARACTER_MCP_HOST ?? '127.0.0.1', 'characterMcp.host');
  const characterPath = endpointPath(character.path ?? env.DESKTOP_CHAR_CHARACTER_MCP_PATH ?? '/mcp');

  return deepFreeze({
    version,
    interaction: {
      drag: {
        holdDelayMs: boundedInteger(
          drag.holdDelayMs ?? env.DESKTOP_CHAR_DRAG_HOLD_DELAY_MS,
          180,
          0,
          999,
          'interaction.drag.holdDelayMs',
        ),
      },
    },
    window: {
      defaultSize: {
        width: boundedInteger(defaultSize.width, 460, 1, 8_192, 'window.defaultSize.width'),
        height: boundedInteger(defaultSize.height, 700, 1, 8_192, 'window.defaultSize.height'),
      },
      defaultMarginDip: nonNegative(window.defaultMarginDip, 24, 'window.defaultMarginDip'),
      alwaysOnTop: boolean(window.alwaysOnTop, true, 'window.alwaysOnTop'),
    },
    agentHttp: {
      enabled: boolean(agentHttp.enabled, true, 'agentHttp.enabled'),
      host: loopbackHost(agentHttp.host ?? '127.0.0.1', 'agentHttp.host'),
      port: port(agentHttp.port ?? env.DESKTOP_CHAR_AGENT_PORT, 17_373, 'agentHttp.port'),
    },
    characterProfile: {
      url: assetPath(characterProfile.profile ?? 'models/Mao/DesktopChar.character.json', 'character.profile'),
    },
    tts: {
      autoStart: boolean(tts.autoStart ?? env.DESKTOP_CHAR_TTS_MCP_ENABLED, true, 'ttsMcp.autoStart'),
      profile: selectedTtsProfileName,
      ...(options.ttsProfilePath ? { profilePath: options.ttsProfilePath } : {}),
      lifecycle: {
        type: lifecycleType,
        ...(lifecycleType === 'managed' ? {
          start: {
            executable: text(launch.executable ?? process.execPath, 'ttsMcp.lifecycle.start.executable'),
            args: stringArray(launch.args ?? [defaultServerPath], 'ttsMcp.lifecycle.start.args'),
            cwd: path.resolve(text(launch.cwd ?? defaultCwd, 'ttsMcp.lifecycle.start.cwd')),
            env: environmentRecord(launch.env ?? (defaultLocalLaunch ? {
              ELECTRON_RUN_AS_NODE: '1',
              DESKTOP_CHAR_TTS_LOCAL_MCP_HOST: localHost,
              DESKTOP_CHAR_TTS_LOCAL_MCP_PORT: String(localPort),
              DESKTOP_CHAR_TTS_LOCAL_DELAY_MS: String(localDelayMs),
              DESKTOP_CHAR_TTS_LOCAL_RATE: String(localRate),
              DESKTOP_CHAR_TTS_LOCAL_CHAR_MS: String(localCharacterMs),
              DESKTOP_CHAR_TTS_LOCAL_MIN_MS: String(localMinimumMs),
              DESKTOP_CHAR_TTS_SAMPLE_RATE_HZ: String(localSampleRate),
              DESKTOP_CHAR_TTS_CHANNELS: String(localChannels),
            } : {}), 'ttsMcp.lifecycle.start.env'),
          },
        } : {}),
        startupTimeoutMs: positive(lifecycle.startupTimeoutMs, 120_000, 'ttsMcp.lifecycle.startupTimeoutMs'),
        shutdownTimeoutMs: positive(lifecycle.shutdownTimeoutMs, 10_000, 'ttsMcp.lifecycle.shutdownTimeoutMs'),
        healthIntervalMs: positive(lifecycle.healthIntervalMs, 10_000, 'ttsMcp.lifecycle.healthIntervalMs'),
        restartOnFailure: boolean(lifecycle.restartOnFailure, true, 'ttsMcp.lifecycle.restartOnFailure'),
      },
      connection: {
        transport,
        url: ttsUrl,
        timeoutMs: positive(connection.timeoutMs ?? env.DESKTOP_CHAR_TTS_TIMEOUT_MS, 30_000, 'ttsMcp.connection.timeoutMs'),
      },
      contract: { profile, version: profileVersion },
      synthesis: {
        format,
        ...(voice ? { voice } : {}),
        ...(synthesisRate !== undefined ? { rate: synthesisRate } : {}),
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

export function watchDesktopConfig(filePath, onChanged, options = {}) {
  if (typeof onChanged !== 'function') throw new TypeError('Desktop config watcher requires an onChanged callback');
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

// Compatibility exports keep existing integrations working while the main-owned
// configuration controller is generalized beyond MCP services.
export const resolveMcpServicesConfigPath = resolveDesktopConfigPath;
export const loadMcpServicesConfig = loadDesktopConfig;
export const normalizeMcpServicesConfig = normalizeDesktopConfig;
export const watchMcpServicesConfig = watchDesktopConfig;

export async function loadTtsProfileConfig(profileName, options = {}) {
  const candidates = ttsProfileCandidates(profileName, options);
  let lastError;
  for (const filePath of candidates) {
    try {
      const text = await readFile(filePath, 'utf8');
      const parsed = JSON.parse(text);
      if (!isRecord(parsed)) throw new TypeError(`TTS profile ${profileName} must be an object`);
      return { filePath, config: parsed };
    }
    catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') {
        lastError = error;
        continue;
      }
      if (error instanceof SyntaxError) {
        throw new TypeError(`TTS profile ${profileName} is not valid JSON: ${error.message}`, { cause: error });
      }
      throw error;
    }
  }
  const searched = candidates.map(candidate => candidate.replaceAll('\\', '/')).join(', ');
  throw new Error(`TTS profile ${profileName} was not found in: ${searched}`, { cause: lastError });
}

function reconnectConfig(value, label) {
  assertKnownKeys(value, ['initialDelayMs', 'maximumDelayMs'], label);
  const initialDelayMs = positive(value.initialDelayMs, 500, `${label}.initialDelayMs`);
  const maximumDelayMs = positive(value.maximumDelayMs, 10_000, `${label}.maximumDelayMs`);
  if (maximumDelayMs < initialDelayMs) throw new TypeError(`${label}.maximumDelayMs must be at least initialDelayMs`);
  return { initialDelayMs, maximumDelayMs };
}

function requestedTtsProfileName(tts) {
  if (Object.keys(tts).length === 0) return DEFAULT_TTS_PROFILE_NAME;
  return text(tts.profile ?? DEFAULT_TTS_PROFILE_NAME, 'ttsMcp.profile');
}

function normalizeSelectedTtsProfile(value, profileName) {
  const profile = optionalRecord(value, `tts profile ${profileName}`);
  assertKnownKeys(profile, ['$schema', 'version', 'lifecycle', 'connection', 'contract', 'synthesis', 'reconnect'], `tts profile ${profileName}`);
  if (profile.$schema !== undefined) text(profile.$schema, `tts profile ${profileName}.$schema`);
  const version = profile.version ?? 1;
  if (version !== 1) throw new TypeError(`tts profile ${profileName} version must be 1`);
  return profile;
}

function ttsProfileCandidates(profileName, options = {}) {
  const configFilePath = options.configFilePath ? path.resolve(options.configFilePath) : undefined;
  const exampleConfigFilePath = options.exampleConfigFilePath ? path.resolve(options.exampleConfigFilePath) : undefined;
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const filenames = [`${profileName}.json`];
  const directories = [];
  if (configFilePath) directories.push(path.resolve(path.dirname(configFilePath), TTS_PROFILE_DIRECTORY));
  if (exampleConfigFilePath) directories.push(path.resolve(path.dirname(exampleConfigFilePath), TTS_PROFILE_DIRECTORY));
  directories.push(path.resolve(cwd, TTS_PROFILE_DIRECTORY));
  return [...new Set(directories)].flatMap(directory => filenames.map(filename => path.join(directory, filename)));
}

async function readConfigObject(filePath, label) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(filePath, 'utf8'));
  }
  catch (error) {
    if (error instanceof SyntaxError) {
      throw new TypeError(`${label} is not valid JSON: ${error.message}`, { cause: error });
    }
    throw error;
  }
  if (!isRecord(parsed)) throw new TypeError(`${label} root must be an object`);
  return parsed;
}

function isMissingFileError(error) {
  return Boolean(error && typeof error === 'object' && error.code === 'ENOENT');
}

function mergeConfigObjects(base, overrides) {
  const keys = new Set([...Object.keys(base), ...Object.keys(overrides)]);
  return Object.fromEntries([...keys].map(key => {
    const baseValue = base[key];
    const overrideValue = overrides[key];
    if (overrideValue === undefined) return [key, baseValue];
    if (isRecord(baseValue) && isRecord(overrideValue)) {
      return [key, mergeConfigObjects(baseValue, overrideValue)];
    }
    return [key, overrideValue];
  }));
}

function desktopEnvironmentOverrides(env) {
  return {
    interaction: {
      drag: {
        holdDelayMs: env.DESKTOP_CHAR_DRAG_HOLD_DELAY_MS,
      },
    },
    agentHttp: {
      port: env.DESKTOP_CHAR_AGENT_PORT,
    },
    ttsMcp: {
      autoStart: env.DESKTOP_CHAR_TTS_MCP_ENABLED,
    },
    characterMcp: {
      autoStart: env.DESKTOP_CHAR_CHARACTER_MCP_ENABLED,
      host: env.DESKTOP_CHAR_CHARACTER_MCP_HOST,
      port: env.DESKTOP_CHAR_CHARACTER_MCP_PORT,
      path: env.DESKTOP_CHAR_CHARACTER_MCP_PATH,
    },
  };
}

function defaultLocalTtsProfile() {
  return {
    lifecycle: { type: 'managed' },
    connection: { transport: 'streamable-http' },
    contract: { profile: 'desktop-char.tts.streaming', version: 1 },
    synthesis: { format: 'pcm_s16le', voice: 'jrpg-blip', rate: 1 },
    reconnect: { initialDelayMs: 500, maximumDelayMs: 10_000 },
  };
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

function fixedSemanticName(value, expected, label) {
  if (value === undefined || value === '') return;
  if (text(value, label) !== expected) throw new TypeError(`${label} is fixed by the DesktopChar TTS Profile and must be ${expected}`);
}

function ttsLifecycleType(value, legacyValue) {
  const requested = value ?? legacyValue ?? 'managed';
  if (requested === 'managed' || requested === 'local') return 'managed';
  if (requested === 'external' || requested === 'mcp') return 'external';
  throw new TypeError('ttsMcp.lifecycle.type must be managed or external');
}

function stringArray(value, label) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value.map((item, index) => {
    if (typeof item !== 'string') throw new TypeError(`${label}[${index}] must be a string`);
    return item;
  });
}

function urlHost(host) {
  return host.includes(':') ? `[${host}]` : host;
}

function environmentRecord(value, label) {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (!key || typeof item !== 'string') throw new TypeError(`${label}.${key || '<empty>'} must be a string`);
    return [key, item];
  }));
}

function assetPath(value, label) {
  const result = text(value, label).replaceAll('\\', '/');
  if (result.startsWith('/') || /^[a-z][a-z\d+.-]*:/iu.test(result) || result.split('/').includes('..')) {
    throw new TypeError(`${label} must be an application-relative asset path without parent traversal`);
  }
  return result;
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

function boundedInteger(value, fallback, minimum, maximum, label) {
  const result = number(value, fallback, label);
  if (!Number.isInteger(result) || result < minimum || result > maximum) {
    throw new TypeError(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return result;
}

function monoChannels(value) {
  const result = positiveInteger(value, 1, 'DESKTOP_CHAR_TTS_CHANNELS');
  if (result !== 1) throw new TypeError('DESKTOP_CHAR_TTS_CHANNELS must be 1 for the reference Provider');
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

function assertKnownKeys(value, allowed, label) {
  const known = new Set(allowed);
  const unknown = Object.keys(value).filter(key => !known.has(key));
  if (unknown.length) throw new TypeError(`${label} contains unknown field(s): ${unknown.join(', ')}`);
}

function deepFreeze(value) {
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') deepFreeze(child);
  }
  return Object.freeze(value);
}
