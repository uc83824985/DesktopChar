import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createLocalTtsMcpService } from '../../../local-tts-mcp/service.mjs';
import { createCharacterMcpService, CHARACTER_MCP_TOOLS } from './character-mcp-service.mjs';
import {
  loadDesktopConfig,
  resolveDesktopConfigPath,
  watchDesktopConfig,
} from './mcp-services-config.mjs';

export function createMcpServicesController(options = {}) {
  const env = options.env ?? process.env;
  const configFilePath = options.configFilePath ?? resolveDesktopConfigPath(env, options.cwd, options.defaultFilePath);
  const createTtsService = options.createLocalTtsService ?? createLocalTtsMcpService;
  const createCharacterService = options.createCharacterService ?? createCharacterMcpService;
  const connectClient = options.connectClient ?? connectMcpClient;
  const onStateChanged = options.onStateChanged ?? (() => {});
  const onDesktopConfigChanged = options.onDesktopConfigChanged ?? (() => {});
  const onCharacterCommand = options.onCharacterCommand ?? (() => {});
  const ttsContext = options.ttsContext ?? {};
  const clock = options.clock ?? (() => new Date().toISOString());
  let config;
  let configSignature;
  let servicesSignature;
  let operation = Promise.resolve();
  let stopWatching;
  let reloadTimer;
  let ttsReconnectTimer;
  let characterReconnectTimer;
  let ttsSession;
  let localTtsService;
  let characterService;
  let activeTtsConfig;
  let avatarState = { ready: false, snapshot: null };
  let disposed = false;
  let started = false;
  let avatarBusy = false;
  let pendingTtsReload = false;
  const state = {
    config: {
      path: configFilePath,
      exists: false,
      revision: 0,
      status: 'loading',
      loadedAt: null,
      error: null,
    },
    tts: serviceState('tts'),
    character: serviceState('character'),
  };
  setTtsContext(null, null, 'disabled');

  function snapshot() {
    return structuredClone(state);
  }

  function emit() {
    state.tts.runtimeConfig = ttsRuntimeConfig(activeTtsConfig ?? config?.tts, state.tts.endpoint);
    onStateChanged(snapshot());
  }

  async function start() {
    if (started) return snapshot();
    started = true;
    await loadLatestConfig({ initial: true, reason: 'startup' });
    stopWatching = watchDesktopConfig(configFilePath, () => {
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => {
        reloadTimer = undefined;
        void reload('watch').catch(() => {});
      }, 120);
      reloadTimer.unref?.();
    });
    if (state.tts.desiredEnabled) void enqueue(() => startTts('startup'));
    if (state.character.desiredEnabled) void enqueue(() => startCharacter('startup'));
    return snapshot();
  }

  function reload(reason = 'manual') {
    return enqueue(() => loadLatestConfig({ initial: false, reason }));
  }

  function setEnabled(service, enabled) {
    requireServiceId(service);
    if (typeof enabled !== 'boolean') throw new TypeError('MCP service enabled state must be boolean');
    return enqueue(async () => {
      await loadLatestConfig({ initial: false, reason: `${service}-toggle`, applyServices: false });
      const target = state[service];
      target.desiredEnabled = enabled;
      target.lastError = null;
      if (service === 'tts') {
        pendingTtsReload = false;
        if (enabled) await startTts('enable');
        else await stopTts();
      }
      else if (enabled) await startCharacter('enable');
      else await stopCharacter();
      emit();
      return snapshot();
    });
  }

  function test(service) {
    requireServiceId(service);
    return enqueue(async () => {
      const result = await runConnectionTest(service);
      emit();
      if (result.status === 'failed') throw new Error(result.details);
      return result;
    });
  }

  function testAll() {
    return enqueue(async () => {
      const entries = await Promise.all(['character', 'tts'].map(async service => (
        [service, await runConnectionTest(service)]
      )));
      emit();
      return Object.fromEntries(entries);
    });
  }

  async function runConnectionTest(service) {
    const startedAt = performance.now();
    try {
      if (!state[service].desiredEnabled) {
        throw new Error(service === 'tts' ? '语音合成 MCP 服务未启用' : '角色接入 MCP 服务未启用');
      }
      const details = service === 'tts' ? await testTtsConnection() : await testCharacterConnection();
      state[service].lastTest = {
        status: 'passed',
        testedAt: clock(),
        latencyMs: Math.round(performance.now() - startedAt),
        details,
      };
    }
    catch (error) {
      state[service].lastTest = {
        status: 'failed',
        testedAt: clock(),
        latencyMs: Math.round(performance.now() - startedAt),
        details: errorMessage(error),
      };
      if (state[service].desiredEnabled) {
        if (service === 'tts') await handleTtsFailure(error);
        else await handleCharacterFailure(error);
      }
    }
    return structuredClone(state[service].lastTest);
  }

  async function listTtsTools(options = {}) {
    await waitForTtsSession();
    try {
      const result = await ttsSession.client.listTools(undefined, { timeout: options.timeoutMs ?? config.tts.timeoutMs });
      return result.tools;
    }
    catch (error) {
      await handleTtsFailure(error);
      throw error;
    }
  }

  async function callTtsTool(name, args, options = {}) {
    if (typeof name !== 'string' || !name.trim() || !isRecord(args)) throw new TypeError('Invalid MCP tool call');
    await waitForTtsSession();
    try {
      return await ttsSession.client.callTool(
        { name, arguments: args },
        undefined,
        { timeout: options.timeoutMs ?? config.tts.timeoutMs, signal: options.signal },
      );
    }
    catch (error) {
      if (isConnectionFailure(error)) await handleTtsFailure(error);
      throw error;
    }
  }

  function updateAvatarState(nextState) {
    avatarState = structuredClone(nextState);
    avatarBusy = Boolean(nextState.ready && nextState.snapshot?.state !== 'idle');
    characterService?.updateState(avatarState);
    if (!avatarBusy && pendingTtsReload && state.tts.desiredEnabled) {
      pendingTtsReload = false;
      void enqueue(() => startTts('deferred-reload'));
    }
  }

  function currentTtsConfig() {
    return ttsRuntimeConfig(activeTtsConfig ?? config?.tts, state.tts.endpoint);
  }

  function currentDesktopConfig() {
    return config ? structuredClone(config) : null;
  }

  function close() {
    disposed = true;
    stopWatching?.();
    stopWatching = undefined;
    if (reloadTimer) clearTimeout(reloadTimer);
    clearReconnect('tts');
    clearReconnect('character');
    return enqueue(async () => {
      await Promise.allSettled([closeTtsResources(), closeCharacterResources()]);
      state.tts.phase = 'disabled';
      state.character.phase = 'disabled';
      setTtsContext(config?.tts, null, 'disabled');
      emit();
    });
  }

  async function loadLatestConfig({ initial, reason, applyServices = true }) {
    let loaded;
    try {
      loaded = await loadDesktopConfig({ filePath: configFilePath, env });
    }
    catch (error) {
      state.config.status = 'error';
      state.config.error = errorMessage(error);
      emit();
      throw error;
    }
    const signature = JSON.stringify(loaded.config);
    const changed = signature !== configSignature;
    const nextServicesSignature = JSON.stringify({ tts: loaded.config.tts, character: loaded.config.character });
    const servicesChanged = nextServicesSignature !== servicesSignature;
    config = loaded.config;
    state.config.exists = loaded.exists;
    state.config.status = 'ready';
    state.config.error = null;
    state.config.loadedAt = clock();
    if (changed) state.config.revision += 1;
    configSignature = signature;
    servicesSignature = nextServicesSignature;
    if (changed || initial) onDesktopConfigChanged(structuredClone(config), {
      initial,
      reason,
      revision: state.config.revision,
    });
    if (initial) {
      state.tts.desiredEnabled = config.tts.autoStart;
      state.character.desiredEnabled = config.character.autoStart;
    }
    state.tts.configRevision = state.config.revision;
    state.character.configRevision = state.config.revision;
    emit();
    if (!changed || initial || !applyServices || !servicesChanged) return snapshot();
    if (state.tts.desiredEnabled) {
      if (avatarBusy) {
        pendingTtsReload = true;
        state.tts.phase = 'reload-pending';
        state.tts.lastError = null;
      }
      else await startTts(reason === 'watch' ? 'hot-reload' : 'reload');
    }
    if (state.character.desiredEnabled) await startCharacter(reason === 'watch' ? 'hot-reload' : 'reload');
    emit();
    return snapshot();
  }

  async function startTts(reason) {
    if (disposed || !state.tts.desiredEnabled) return;
    clearReconnect('tts');
    state.tts.phase = reason.includes('reload') ? 'reloading' : reason === 'reconnect' ? 'reconnecting' : 'starting';
    state.tts.lastError = null;
    emit();
    await closeTtsResources();
    let candidateLocal;
    let candidateSession;
    try {
      let endpoint = config.tts.url;
      if (config.tts.mode === 'local') {
        candidateLocal = createTtsService(config.tts.local);
        const address = await candidateLocal.listen();
        endpoint = address.mcpUrl;
      }
      candidateSession = await connectClient(endpoint, {
        name: 'desktop-char-tts-supervisor',
        version: options.version ?? '0.1.0',
        timeoutMs: Math.min(config.tts.timeoutMs, 10_000),
      });
      const result = await candidateSession.client.listTools(undefined, { timeout: config.tts.timeoutMs });
      const tool = result.tools.find(item => item.name === config.tts.toolName);
      if (!tool) throw new Error(`语音合成 MCP 未发布工具 ${config.tts.toolName}`);
      localTtsService = candidateLocal;
      ttsSession = candidateSession;
      activeTtsConfig = config.tts;
      state.tts.phase = tool.outputSchema ? 'ready' : 'degraded';
      state.tts.endpoint = endpoint;
      state.tts.provider = config.tts.mode === 'local' ? 'desktop-char-local-tts' : 'external-tts-mcp';
      state.tts.reconnectAttempt = 0;
      state.tts.nextReconnectAt = null;
      state.tts.lastError = null;
      setTtsContext(config.tts, endpoint, state.tts.phase);
      emit();
    }
    catch (error) {
      await Promise.allSettled([candidateSession?.client.close(), candidateLocal?.close()]);
      await handleTtsFailure(error);
    }
  }

  async function stopTts() {
    clearReconnect('tts');
    state.tts.phase = 'stopping';
    emit();
    await closeTtsResources();
    activeTtsConfig = undefined;
    state.tts.phase = 'disabled';
    state.tts.endpoint = null;
    state.tts.provider = null;
    state.tts.reconnectAttempt = 0;
    state.tts.nextReconnectAt = null;
    setTtsContext(config?.tts, null, 'disabled');
  }

  async function startCharacter(reason) {
    if (disposed || !state.character.desiredEnabled) return;
    clearReconnect('character');
    state.character.phase = reason.includes('reload') ? 'reloading' : reason === 'reconnect' ? 'reconnecting' : 'starting';
    state.character.lastError = null;
    emit();
    await closeCharacterResources();
    let candidate;
    try {
      candidate = createCharacterService({
        ...config.character,
        initialState: avatarState,
        ttsContext: () => structuredClone(ttsContext),
        onCommand: onCharacterCommand,
      });
      const address = await candidate.listen();
      characterService = candidate;
      state.character.endpoint = address.mcpUrl;
      state.character.provider = 'desktop-char-character';
      const testStartedAt = performance.now();
      const details = await testCharacterConnection();
      state.character.phase = 'ready';
      state.character.reconnectAttempt = 0;
      state.character.nextReconnectAt = null;
      state.character.lastError = null;
      state.character.lastTest = {
        status: 'passed', testedAt: clock(), latencyMs: Math.round(performance.now() - testStartedAt), details,
      };
      emit();
    }
    catch (error) {
      await candidate?.close().catch(() => {});
      if (characterService === candidate) characterService = undefined;
      await handleCharacterFailure(error);
    }
  }

  async function stopCharacter() {
    clearReconnect('character');
    state.character.phase = 'stopping';
    emit();
    await closeCharacterResources();
    state.character.phase = 'disabled';
    state.character.endpoint = null;
    state.character.provider = null;
    state.character.reconnectAttempt = 0;
    state.character.nextReconnectAt = null;
  }

  async function testTtsConnection() {
    if (!ttsSession) await startTts('connection-test');
    if (!ttsSession) throw new Error(state.tts.lastError ?? '语音合成 MCP session 不可用');
    const result = await ttsSession.client.listTools(undefined, { timeout: config.tts.timeoutMs });
    const tool = result.tools.find(item => item.name === config.tts.toolName);
    if (!tool) throw new Error(`语音合成 MCP 未发布工具 ${config.tts.toolName}`);
    return `${result.tools.length} tools; ${config.tts.toolName} available`;
  }

  async function testCharacterConnection() {
    const endpoint = state.character.endpoint;
    if (!endpoint) throw new Error('角色接入 MCP endpoint 不可用');
    const probe = await connectClient(endpoint, {
      name: 'desktop-char-character-probe',
      version: options.version ?? '0.1.0',
      timeoutMs: 5_000,
    });
    try {
      const result = await probe.client.listTools(undefined, { timeout: 5_000 });
      const names = new Set(result.tools.map(tool => tool.name));
      const missing = CHARACTER_MCP_TOOLS.filter(name => !names.has(name));
      if (missing.length) throw new Error(`角色接入 MCP 缺少工具：${missing.join(', ')}`);
      return `${result.tools.length} tools available`;
    }
    finally {
      await probe.client.close().catch(() => {});
    }
  }

  async function waitForTtsSession() {
    if (!state.tts.desiredEnabled) throw new Error('语音合成 MCP 服务未启用');
    await operation.catch(() => {});
    if (ttsSession) return;
    await enqueue(() => startTts('request'));
    if (!ttsSession) throw new Error(state.tts.lastError ?? '语音合成 MCP session 不可用');
  }

  async function handleTtsFailure(error) {
    await closeTtsResources();
    state.tts.lastError = errorMessage(error);
    state.tts.endpoint = null;
    setTtsContext(config?.tts, null, 'reconnecting');
    scheduleReconnect('tts');
  }

  async function handleCharacterFailure(error) {
    await closeCharacterResources();
    state.character.lastError = errorMessage(error);
    state.character.endpoint = null;
    scheduleReconnect('character');
  }

  function scheduleReconnect(service) {
    const target = state[service];
    if (disposed || !target.desiredEnabled) {
      target.phase = 'disabled';
      return;
    }
    target.phase = 'reconnecting';
    target.reconnectAttempt += 1;
    const reconnect = config[service].reconnect;
    const delayMs = Math.min(reconnect.maximumDelayMs, reconnect.initialDelayMs * 2 ** (target.reconnectAttempt - 1));
    target.nextReconnectAt = new Date(Date.now() + delayMs).toISOString();
    const timer = setTimeout(() => {
      if (service === 'tts') ttsReconnectTimer = undefined;
      else characterReconnectTimer = undefined;
      void enqueue(() => service === 'tts' ? startTts('reconnect') : startCharacter('reconnect'));
    }, delayMs);
    timer.unref?.();
    if (service === 'tts') ttsReconnectTimer = timer;
    else characterReconnectTimer = timer;
    emit();
  }

  function clearReconnect(service) {
    const timer = service === 'tts' ? ttsReconnectTimer : characterReconnectTimer;
    if (timer) clearTimeout(timer);
    if (service === 'tts') ttsReconnectTimer = undefined;
    else characterReconnectTimer = undefined;
  }

  async function closeTtsResources() {
    const session = ttsSession;
    const local = localTtsService;
    ttsSession = undefined;
    localTtsService = undefined;
    await session?.client.close().catch(() => {});
    await local?.close().catch(() => {});
  }

  async function closeCharacterResources() {
    const service = characterService;
    characterService = undefined;
    await service?.close().catch(() => {});
  }

  function setTtsContext(ttsConfig, endpoint, phase) {
    ttsContext.requestedMode = ttsConfig?.mode ?? 'local';
    ttsContext.activeMode = phase === 'ready' || phase === 'degraded' ? 'mcp' : phase;
    ttsContext.provider = ttsConfig?.mode === 'local' ? 'desktop-char-local-tts' : 'external-tts-mcp';
    ttsContext.mcpTool = ttsConfig?.toolName ?? 'tts_open_stream';
    ttsContext.mcpCancelTool = ttsConfig?.cancelToolName ?? 'tts_cancel_synthesis';
    ttsContext.transport = endpoint;
  }

  function enqueue(task) {
    const next = operation.catch(() => {}).then(task);
    operation = next.catch(() => {});
    return next;
  }

  return {
    start,
    reload,
    setEnabled,
    test,
    testAll,
    snapshot,
    currentTtsConfig,
    currentDesktopConfig,
    listTtsTools,
    callTtsTool,
    updateAvatarState,
    close,
  };
}

export async function connectMcpClient(endpoint, options = {}) {
  const transport = new StreamableHTTPClientTransport(new URL(endpoint));
  const client = new Client({ name: options.name ?? 'desktop-char', version: options.version ?? '0.1.0' });
  const timeoutMs = options.timeoutMs ?? 10_000;
  let timer;
  try {
    await Promise.race([
      client.connect(transport),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`MCP connection timed out after ${timeoutMs} ms`)), timeoutMs);
        timer.unref?.();
      }),
    ]);
    return { client, transport };
  }
  catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
  finally {
    if (timer) clearTimeout(timer);
  }
}

function serviceState(id) {
  return {
    id,
    desiredEnabled: false,
    phase: 'disabled',
    provider: null,
    endpoint: null,
    configRevision: 0,
    reconnectAttempt: 0,
    nextReconnectAt: null,
    lastError: null,
    lastTest: null,
    ...(id === 'tts' ? { runtimeConfig: null } : {}),
  };
}

function ttsRuntimeConfig(config, endpoint) {
  if (!config) return null;
  return {
    mode: config.mode,
    mcpUrl: endpoint ?? config.url,
    mcpTool: config.toolName,
    mcpCancelTool: config.cancelToolName,
    timeoutMs: config.timeoutMs,
    requestIdArgument: config.requestIdArgument,
    textArgument: config.textArgument,
    format: config.format,
    ...(config.voice ? { voice: config.voice } : {}),
  };
}

function requireServiceId(value) {
  if (value !== 'tts' && value !== 'character') throw new TypeError('MCP service id must be tts or character');
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isConnectionFailure(error) {
  const code = error && typeof error === 'object' ? error.code : undefined;
  if (['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ENOTFOUND', 'ETIMEDOUT'].includes(code)) return true;
  return /(fetch failed|network|socket|connection|transport|session.+(?:closed|expired)|terminated)/i.test(errorMessage(error));
}
