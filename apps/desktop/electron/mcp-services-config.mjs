import { watchFile, unwatchFile } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const AUDIO_FORMATS = new Set(['wav', 'mp3', 'ogg', 'opus', 'pcm_s16le', 'pcm_f32le']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const TTS_PROFILE_DIRECTORY = 'tts-mcp-profiles';
const DEFAULT_TTS_PROFILE_NAME = 'local';
const DEFAULT_DESKTOP_CONFIG_EXAMPLE = 'desktop-char.config.example.json';
const DEFAULT_CHAR_PROVIDER_NAME = 'codex-managed';
const DEFAULT_CHAR_PROMPT_PROFILE = 'profiles/char/default.json';
const DEFAULT_ROUTER_PROVIDER_NAME = 'router-codex-managed';
const DEFAULT_ROUTER_PROMPT_PROFILE = 'profiles/router/session-routing.json';

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
  const agentRoles = optionalRecord(fileConfig.agentRoles, 'agentRoles');
  const charRole = optionalRecord(agentRoles.char, 'agentRoles.char');
  const charPromptProfilePath = assetPath(
    charRole.promptProfile ?? DEFAULT_CHAR_PROMPT_PROFILE,
    'agentRoles.char.promptProfile',
  );
  const charPromptProfile = await loadCharPromptProfile(charPromptProfilePath, { cwd });
  const routerRole = optionalRecord(agentRoles.router, 'agentRoles.router');
  const routerPromptProfilePath = assetPath(
    routerRole.promptProfile ?? DEFAULT_ROUTER_PROMPT_PROFILE,
    'agentRoles.router.promptProfile',
  );
  const routerPromptProfile = await loadRouterPromptProfile(routerPromptProfilePath, { cwd });
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
      charPromptProfilePath,
      charPromptProfileConfig: charPromptProfile,
      routerPromptProfilePath,
      routerPromptProfileConfig: routerPromptProfile,
    }),
  };
}

export function normalizeDesktopConfig(fileConfig = {}, env = {}, options = {}) {
  if (!isRecord(fileConfig)) throw new TypeError('Desktop config root must be an object');
  assertKnownKeys(fileConfig, [
    '$schema', 'version', 'interaction', 'window', 'applicationCommands', 'agentProviders', 'agentRoles',
    'agentHttp', 'taskManager', 'character', 'performanceInference', 'ttsMcp',
    'characterMcp',
  ], 'Desktop config');
  if (fileConfig.$schema !== undefined) text(fileConfig.$schema, '$schema');
  const version = fileConfig.version ?? 1;
  if (version !== 1) throw new TypeError('Desktop config version must be 1');
  const interaction = optionalRecord(fileConfig.interaction, 'interaction');
  assertKnownKeys(interaction, ['drag', 'conversationSidebar', 'textDisplay'], 'interaction');
  const drag = optionalRecord(interaction.drag, 'interaction.drag');
  assertKnownKeys(drag, ['holdDelayMs'], 'interaction.drag');
  const conversationSidebar = optionalRecord(
    interaction.conversationSidebar,
    'interaction.conversationSidebar',
  );
  assertKnownKeys(conversationSidebar, ['preferredSide'], 'interaction.conversationSidebar');
  const textDisplay = optionalRecord(interaction.textDisplay, 'interaction.textDisplay');
  assertKnownKeys(textDisplay, ['mode'], 'interaction.textDisplay');
  const window = optionalRecord(fileConfig.window, 'window');
  assertKnownKeys(window, ['defaultSize', 'defaultMarginDip', 'alwaysOnTop'], 'window');
  const defaultSize = optionalRecord(window.defaultSize, 'window.defaultSize');
  assertKnownKeys(defaultSize, ['width', 'height'], 'window.defaultSize');
  const applicationCommands = optionalRecord(fileConfig.applicationCommands, 'applicationCommands');
  assertKnownKeys(applicationCommands, ['bindings'], 'applicationCommands');
  const applicationCommandBindings = normalizeApplicationOperationBindings(
    optionalRecord(applicationCommands.bindings, 'applicationCommands.bindings'),
  );
  const agentProviders = optionalRecord(fileConfig.agentProviders, 'agentProviders');
  const agentRoles = optionalRecord(fileConfig.agentRoles, 'agentRoles');
  assertKnownKeys(agentRoles, ['char', 'router'], 'agentRoles');
  const charRole = optionalRecord(agentRoles.char, 'agentRoles.char');
  assertKnownKeys(charRole, ['provider', 'promptProfile', 'maxConcurrency'], 'agentRoles.char');
  const charProviderName = text(charRole.provider ?? DEFAULT_CHAR_PROVIDER_NAME, 'agentRoles.char.provider');
  const charProvider = normalizeAgentProvider(
    charProviderName,
    optionalRecord(agentProviders[charProviderName], `agentProviders.${charProviderName}`),
    'char',
  );
  const charPromptProfile = normalizeCharPromptProfile(
    options.charPromptProfileConfig ?? defaultCharPromptProfile(),
    options.charPromptProfilePath ?? charRole.promptProfile ?? DEFAULT_CHAR_PROMPT_PROFILE,
  );
  const routerRole = optionalRecord(agentRoles.router, 'agentRoles.router');
  assertKnownKeys(
    routerRole,
    [
      'provider', 'promptProfile', 'temperature', 'autoSubmitMinConfidence',
      'autoSubmitMinMargin', 'maxTimelineEntries', 'maxCandidates',
    ],
    'agentRoles.router',
  );
  const routerProviderName = text(
    routerRole.provider ?? DEFAULT_ROUTER_PROVIDER_NAME,
    'agentRoles.router.provider',
  );
  const routerProvider = normalizeAgentProvider(
    routerProviderName,
    optionalRecord(agentProviders[routerProviderName], `agentProviders.${routerProviderName}`),
    'router',
  );
  const routerPromptProfile = normalizeRouterPromptProfile(
    options.routerPromptProfileConfig ?? defaultRouterPromptProfile(),
    options.routerPromptProfilePath ?? routerRole.promptProfile ?? DEFAULT_ROUTER_PROMPT_PROFILE,
  );
  const agentHttp = optionalRecord(fileConfig.agentHttp, 'agentHttp');
  assertKnownKeys(agentHttp, ['enabled', 'host', 'port'], 'agentHttp');
  const taskManager = optionalRecord(fileConfig.taskManager, 'taskManager');
  assertKnownKeys(
    taskManager,
    [
      'enabled', 'lifecycle', 'markerPath', 'sessionMonitorMarkerPath', 'stateDirectory',
      'startupTimeoutMs', 'shutdownTimeoutMs', 'restartOnFailure', 'pollIntervalMs',
      'requestTimeoutMs', 'eventPageSize', 'maxEvents',
    ],
    'taskManager',
  );
  const configuredTaskManagerMarker =
    taskManager.markerPath ?? env.DESKTOP_CHAR_TASK_MANAGER_MARKER;
  const configuredSessionMonitorMarker =
    taskManager.sessionMonitorMarkerPath ?? env.SESSION_MONITOR_MARKER;
  const taskManagerLifecycle = taskManagerLifecycleType(
    taskManager.lifecycle,
    configuredTaskManagerMarker,
    configuredSessionMonitorMarker,
  );
  const taskManagerStateDirectory = path.resolve(
    optionalText(
      taskManager.stateDirectory ?? env.DESKTOP_CHAR_TASK_MANAGER_STATE_DIR,
      'taskManager.stateDirectory',
    ) ?? path.join(env.LOCALAPPDATA ?? os.tmpdir(), 'DesktopChar', 'task-manager'),
  );
  const managedTaskManagerMarkerPath = path.join(
    taskManagerStateDirectory,
    'task_manager.json',
  );
  if (
    taskManagerLifecycle === 'managed'
    && taskManager.markerPath !== undefined
    && path.resolve(text(taskManager.markerPath, 'taskManager.markerPath'))
      !== managedTaskManagerMarkerPath
  ) {
    throw new TypeError(
      'Managed taskManager.markerPath must be stateDirectory/task_manager.json',
    );
  }
  const taskManagerMarkerPath = optionalText(
    taskManagerLifecycle === 'managed'
      ? managedTaskManagerMarkerPath
      : configuredTaskManagerMarker,
    'taskManager.markerPath',
  );
  const sessionMonitorMarkerPath = optionalText(
    configuredSessionMonitorMarker,
    'taskManager.sessionMonitorMarkerPath',
  );
  const taskManagerEnabled = boolean(
    taskManager.enabled ?? env.DESKTOP_CHAR_TASK_MANAGER_ENABLED,
    true,
    'taskManager.enabled',
  );
  if (taskManagerEnabled && taskManagerLifecycle === 'external' && !taskManagerMarkerPath) {
    throw new TypeError('Enabled taskManager requires markerPath');
  }
  const characterProfile = optionalRecord(fileConfig.character, 'character');
  assertKnownKeys(characterProfile, ['profile'], 'character');
  const performanceInference = optionalRecord(fileConfig.performanceInference, 'performanceInference');
  assertKnownKeys(performanceInference, [
    'enabled', 'lifecycle', 'provider', 'baseUrl', 'healthUrl', 'model', 'timeoutMs',
    'maxOutputTokens', 'temperature', 'fallbackToRules',
  ], 'performanceInference');
  const performanceLifecycle = performanceInferenceLifecycle(performanceInference.lifecycle);
  const performanceLaunch = optionalRecord(performanceLifecycle.start, 'performanceInference.lifecycle.start');
  assertKnownKeys(
    performanceLifecycle,
    ['type', 'start', 'startupTimeoutMs', 'shutdownTimeoutMs', 'healthIntervalMs', 'restartOnFailure'],
    'performanceInference.lifecycle',
  );
  assertKnownKeys(
    performanceLaunch,
    ['executable', 'args', 'cwd', 'env'],
    'performanceInference.lifecycle.start',
  );
  const performanceModel = optionalText(performanceInference.model, 'performanceInference.model');
  const tts = optionalRecord(fileConfig.ttsMcp, 'ttsMcp');
  assertKnownKeys(tts, ['autoStart', 'profile'], 'ttsMcp');
  const selectedTtsProfileName = ttsProfileName(
    options.ttsProfileName ?? requestedTtsProfileName(tts),
  );
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
  const timing = optionalRecord(selectedTtsProfile.timing, 'ttsMcp.timing');
  assertKnownKeys(timing, ['fallbackCharactersPerSecond'], 'ttsMcp.timing');
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
  const fallbackCharactersPerSecond = positive(
    timing.fallbackCharactersPerSecond,
    1_000 / localCharacterMs,
    'ttsMcp.timing.fallbackCharactersPerSecond',
  );
  const localMinimumMs = positive(env.DESKTOP_CHAR_TTS_LOCAL_MIN_MS, 500, 'DESKTOP_CHAR_TTS_LOCAL_MIN_MS');
  const localSampleRate = positiveInteger(env.DESKTOP_CHAR_TTS_SAMPLE_RATE_HZ, 24_000, 'DESKTOP_CHAR_TTS_SAMPLE_RATE_HZ');
  const localChannels = monoChannels(env.DESKTOP_CHAR_TTS_CHANNELS);
  const defaultCwd = path.resolve(process.cwd());
  const defaultServerPath = path.resolve(defaultCwd, 'local-tts-mcp/server.mjs');
  const characterHost = loopbackHost(character.host ?? env.DESKTOP_CHAR_CHARACTER_MCP_HOST ?? '127.0.0.1', 'characterMcp.host');
  const characterPath = endpointPath(character.path ?? env.DESKTOP_CHAR_CHARACTER_MCP_PATH ?? '/mcp');
  const performanceBaseUrl = loopbackHttpUrl(
    performanceInference.baseUrl ?? 'http://127.0.0.1:18090/v1',
    'performanceInference.baseUrl',
  );
  const performanceHealthUrl = loopbackHttpUrl(
    performanceInference.healthUrl ?? `${performanceBaseUrl.replace(/\/+$/u, '')}/models`,
    'performanceInference.healthUrl',
  );
  const performancePort = Number(new URL(performanceBaseUrl).port || 80);
  const defaultPerformanceScript = path.resolve(defaultCwd, 'performance-model-service/start.ps1');
  const defaultPowerShell = path.join(
    env.SystemRoot ?? process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );

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
      conversationSidebar: {
        preferredSide: conversationSidebarSide(conversationSidebar.preferredSide),
      },
      textDisplay: {
        mode: textDisplayMode(textDisplay.mode),
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
    applicationCommands: {
      bindings: applicationCommandBindings,
    },
    agentProviders: {
      [charProviderName]: charProvider,
      [routerProviderName]: routerProvider,
    },
    agentRoles: {
      char: {
        provider: charProviderName,
        promptProfile: assetPath(
          charRole.promptProfile ?? DEFAULT_CHAR_PROMPT_PROFILE,
          'agentRoles.char.promptProfile',
        ),
        maxConcurrency: boundedInteger(
          charRole.maxConcurrency,
          2,
          1,
          8,
          'agentRoles.char.maxConcurrency',
        ),
        personaRevision: charPromptProfile.version,
        persona: {
          name: charPromptProfile.name,
          instructions: [...charPromptProfile.instructions],
        },
        applicationFallbackText: charPromptProfile.applicationFallbackText,
      },
      router: {
        provider: routerProviderName,
        promptProfile: assetPath(
          routerRole.promptProfile ?? DEFAULT_ROUTER_PROMPT_PROFILE,
          'agentRoles.router.promptProfile',
        ),
        profileRevision: routerPromptProfile.version,
        profile: {
          name: routerPromptProfile.name,
          instructions: [...routerPromptProfile.instructions],
        },
        temperature: boundedNumber(
          routerRole.temperature,
          0,
          0,
          2,
          'agentRoles.router.temperature',
        ),
        autoSubmitMinConfidence: boundedNumber(
          routerRole.autoSubmitMinConfidence,
          0.78,
          0,
          1,
          'agentRoles.router.autoSubmitMinConfidence',
        ),
        autoSubmitMinMargin: boundedNumber(
          routerRole.autoSubmitMinMargin,
          0.18,
          0,
          1,
          'agentRoles.router.autoSubmitMinMargin',
        ),
        maxTimelineEntries: boundedInteger(
          routerRole.maxTimelineEntries,
          12,
          1,
          100,
          'agentRoles.router.maxTimelineEntries',
        ),
        maxCandidates: boundedInteger(
          routerRole.maxCandidates,
          6,
          1,
          50,
          'agentRoles.router.maxCandidates',
        ),
      },
    },
    agentHttp: {
      enabled: boolean(agentHttp.enabled, true, 'agentHttp.enabled'),
      host: loopbackHost(agentHttp.host ?? '127.0.0.1', 'agentHttp.host'),
      port: port(agentHttp.port ?? env.DESKTOP_CHAR_AGENT_PORT, 17_373, 'agentHttp.port'),
    },
    taskManager: {
      enabled: taskManagerEnabled,
      lifecycle: taskManagerLifecycle,
      markerPath: taskManagerMarkerPath
        ? absoluteFilePath(taskManagerMarkerPath, 'taskManager.markerPath')
        : '',
      sessionMonitorMarkerPath: sessionMonitorMarkerPath
        ? absoluteFilePath(
            sessionMonitorMarkerPath,
            'taskManager.sessionMonitorMarkerPath',
          )
        : '',
      stateDirectory: absoluteDirectoryPath(
        taskManagerStateDirectory,
        'taskManager.stateDirectory',
      ),
      startupTimeoutMs: boundedInteger(
        taskManager.startupTimeoutMs,
        10_000,
        500,
        120_000,
        'taskManager.startupTimeoutMs',
      ),
      shutdownTimeoutMs: boundedInteger(
        taskManager.shutdownTimeoutMs,
        10_000,
        500,
        120_000,
        'taskManager.shutdownTimeoutMs',
      ),
      restartOnFailure: boolean(
        taskManager.restartOnFailure,
        true,
        'taskManager.restartOnFailure',
      ),
      pollIntervalMs: boundedInteger(
        taskManager.pollIntervalMs,
        250,
        250,
        60_000,
        'taskManager.pollIntervalMs',
      ),
      requestTimeoutMs: boundedInteger(
        taskManager.requestTimeoutMs,
        5_000,
        100,
        60_000,
        'taskManager.requestTimeoutMs',
      ),
      eventPageSize: boundedInteger(
        taskManager.eventPageSize,
        100,
        1,
        1_000,
        'taskManager.eventPageSize',
      ),
      maxEvents: boundedInteger(
        taskManager.maxEvents,
        200,
        10,
        2_000,
        'taskManager.maxEvents',
      ),
    },
    characterProfile: {
      url: assetPath(characterProfile.profile ?? 'models/Mao/DesktopChar.character.json', 'character.profile'),
    },
    performanceInference: {
      enabled: boolean(performanceInference.enabled, false, 'performanceInference.enabled'),
      lifecycle: {
        type: performanceLifecycle.type,
        ...(performanceLifecycle.type === 'managed' ? {
          start: {
            executable: text(
              performanceLaunch.executable ?? defaultPowerShell,
              'performanceInference.lifecycle.start.executable',
            ),
            args: stringArray(
              performanceLaunch.args ?? [
                '-NoProfile',
                '-ExecutionPolicy', 'Bypass',
                '-File', defaultPerformanceScript,
                '-Port', String(performancePort),
              ],
              'performanceInference.lifecycle.start.args',
            ),
            cwd: path.resolve(text(
              performanceLaunch.cwd ?? defaultCwd,
              'performanceInference.lifecycle.start.cwd',
            )),
            env: environmentRecord(
              performanceLaunch.env ?? {},
              'performanceInference.lifecycle.start.env',
            ),
          },
        } : {}),
        startupTimeoutMs: positive(
          performanceLifecycle.startupTimeoutMs,
          180_000,
          'performanceInference.lifecycle.startupTimeoutMs',
        ),
        shutdownTimeoutMs: positive(
          performanceLifecycle.shutdownTimeoutMs,
          10_000,
          'performanceInference.lifecycle.shutdownTimeoutMs',
        ),
        healthIntervalMs: positive(
          performanceLifecycle.healthIntervalMs,
          10_000,
          'performanceInference.lifecycle.healthIntervalMs',
        ),
        restartOnFailure: boolean(
          performanceLifecycle.restartOnFailure,
          true,
          'performanceInference.lifecycle.restartOnFailure',
        ),
      },
      provider: text(performanceInference.provider ?? 'qwen35-transformers', 'performanceInference.provider'),
      baseUrl: performanceBaseUrl,
      healthUrl: performanceHealthUrl,
      ...(performanceModel ? { model: performanceModel } : {}),
      timeoutMs: positive(performanceInference.timeoutMs, 10_000, 'performanceInference.timeoutMs'),
      maxOutputTokens: positiveInteger(
        performanceInference.maxOutputTokens,
        64,
        'performanceInference.maxOutputTokens',
      ),
      temperature: boundedNumber(
        performanceInference.temperature,
        0.1,
        0,
        2,
        'performanceInference.temperature',
      ),
      fallbackToRules: boolean(
        performanceInference.fallbackToRules,
        true,
        'performanceInference.fallbackToRules',
      ),
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
      timing: { fallbackCharactersPerSecond },
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

export async function loadCharPromptProfile(profilePath, options = {}) {
  const safePath = assetPath(profilePath, 'agentRoles.char.promptProfile');
  const filePath = path.resolve(options.cwd ?? process.cwd(), safePath);
  const parsed = await readConfigObject(filePath, `Char prompt profile ${safePath}`);
  return parsed;
}

export async function loadRouterPromptProfile(profilePath, options = {}) {
  const safePath = assetPath(profilePath, 'agentRoles.router.promptProfile');
  const filePath = path.resolve(options.cwd ?? process.cwd(), safePath);
  const parsed = await readConfigObject(filePath, `Router prompt profile ${safePath}`);
  return normalizeRouterPromptProfile(parsed, safePath);
}

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
  return ttsProfileName(tts.profile ?? DEFAULT_TTS_PROFILE_NAME);
}

function ttsProfileName(value) {
  const result = text(value, 'ttsMcp.profile');
  if (!/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u.test(result)) {
    throw new TypeError('ttsMcp.profile must be a safe lowercase profile name');
  }
  return result;
}

function normalizeSelectedTtsProfile(value, profileName) {
  const profile = optionalRecord(value, `tts profile ${profileName}`);
  assertKnownKeys(profile, ['$schema', 'version', 'lifecycle', 'connection', 'contract', 'synthesis', 'timing', 'reconnect'], `tts profile ${profileName}`);
  if (profile.$schema !== undefined) text(profile.$schema, `tts profile ${profileName}.$schema`);
  const version = profile.version ?? 1;
  if (version !== 1) throw new TypeError(`tts profile ${profileName} version must be 1`);
  return profile;
}

function ttsProfileCandidates(profileName, options = {}) {
  profileName = ttsProfileName(profileName);
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

function normalizeCharPromptProfile(value, profilePath) {
  const label = `Char prompt profile ${profilePath}`;
  const profile = optionalRecord(value, label);
  assertKnownKeys(
    profile,
    ['$schema', 'version', 'name', 'instructions', 'applicationFallbackText'],
    label,
  );
  if (profile.$schema !== undefined) text(profile.$schema, `${label}.$schema`);
  const version = profile.version ?? 1;
  if (!Number.isInteger(version) || version < 1) throw new TypeError(`${label}.version must be a positive integer`);
  const instructions = profile.instructions === undefined
    ? defaultCharPromptProfile().instructions
    : stringArray(profile.instructions, `${label}.instructions`).map((item, index) =>
      text(item, `${label}.instructions[${index}]`));
  return {
    version,
    name: text(profile.name ?? 'DesktopChar', `${label}.name`),
    instructions,
    applicationFallbackText: text(
      profile.applicationFallbackText ?? '上一轮的回复没有收到，可以再说一次吗？',
      `${label}.applicationFallbackText`,
    ),
  };
}

export function normalizeRouterPromptProfile(value, profilePath = DEFAULT_ROUTER_PROMPT_PROFILE) {
  const label = `Router prompt profile ${profilePath}`;
  const profile = optionalRecord(value, label);
  assertKnownKeys(profile, ['$schema', 'version', 'name', 'instructions'], label);
  if (profile.$schema !== undefined) text(profile.$schema, `${label}.$schema`);
  const version = profile.version ?? 1;
  if (!Number.isInteger(version) || version < 1) {
    throw new TypeError(`${label}.version must be a positive integer`);
  }
  const instructions = profile.instructions === undefined
    ? defaultRouterPromptProfile().instructions
    : stringArray(profile.instructions, `${label}.instructions`).map((item, index) =>
      text(item, `${label}.instructions[${index}]`));
  return {
    version,
    name: text(profile.name ?? 'session-routing', `${label}.name`),
    instructions,
  };
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

function performanceInferenceLifecycle(value) {
  const result = typeof value === 'string'
    ? { type: value }
    : optionalRecord(value, 'performanceInference.lifecycle');
  const type = result.type ?? 'external';
  if (type !== 'external' && type !== 'managed') {
    throw new TypeError('performanceInference.lifecycle.type must be external or managed');
  }
  return { ...result, type };
}

function defaultLocalTtsProfile() {
  return {
    lifecycle: { type: 'managed' },
    connection: { transport: 'streamable-http' },
    contract: { profile: 'desktop-char.tts.streaming', version: 1 },
    synthesis: { format: 'pcm_s16le', voice: 'jrpg-blip', rate: 1 },
    timing: { fallbackCharactersPerSecond: 1_000 / 232 },
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

function normalizeApplicationOperationBindings(value) {
  return Object.fromEntries(Object.entries(value).map(([bindingId, bindingValue]) => {
    const id = text(bindingId, 'applicationCommands binding id');
    const binding = optionalRecord(bindingValue, `applicationCommands.bindings.${id}`);
    assertKnownKeys(
      binding,
      ['operation', 'arguments', 'result'],
      `applicationCommands.bindings.${id}`,
    );
    return [id, {
      operation: text(binding.operation, `applicationCommands.bindings.${id}.operation`),
      arguments: normalizeApplicationOperationFieldRules(
        optionalRecord(binding.arguments, `applicationCommands.bindings.${id}.arguments`),
        `applicationCommands.bindings.${id}.arguments`,
      ),
      result: normalizeApplicationOperationFieldRules(
        optionalRecord(binding.result, `applicationCommands.bindings.${id}.result`),
        `applicationCommands.bindings.${id}.result`,
      ),
    }];
  }));
}

function normalizeApplicationOperationFieldRules(value, label) {
  return Object.fromEntries(Object.entries(value).map(([destination, ruleValue]) => {
    const normalizedDestination = applicationOperationFieldPath(destination, `${label} destination`);
    const rule = optionalRecord(ruleValue, `${label}.${normalizedDestination}`);
    assertKnownKeys(rule, ['source', 'required'], `${label}.${normalizedDestination}`);
    return [normalizedDestination, {
      source: applicationOperationFieldPath(
        rule.source,
        `${label}.${normalizedDestination}.source`,
      ),
      ...(rule.required !== undefined
        ? { required: boolean(rule.required, true, `${label}.${normalizedDestination}.required`) }
        : {}),
    }];
  }));
}

function applicationOperationFieldPath(value, label) {
  const result = text(value, label);
  const invalid = result.split('.').some(segment =>
    !/^[A-Za-z][A-Za-z0-9_-]*$/u.test(segment)
    || segment === '__proto__'
    || segment === 'prototype'
    || segment === 'constructor');
  if (invalid) throw new TypeError(`${label} must be a safe dotted field path`);
  return result;
}

function conversationSidebarSide(value) {
  const side = value ?? 'right';
  if (side !== 'left' && side !== 'right') {
    throw new TypeError('interaction.conversationSidebar.preferredSide must be left or right');
  }
  return side;
}

function textDisplayMode(value) {
  const mode = value ?? 'stream';
  if (mode !== 'complete' && mode !== 'stream' && mode !== 'karaoke') {
    throw new TypeError('interaction.textDisplay.mode must be complete, stream or karaoke');
  }
  return mode;
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

function absoluteFilePath(value, label) {
  const result = text(value, label);
  if (!path.isAbsolute(result)) throw new TypeError(`${label} must be an absolute path`);
  return path.resolve(result);
}

function absoluteDirectoryPath(value, label) {
  const result = text(value, label);
  if (!path.isAbsolute(result)) throw new TypeError(`${label} must be an absolute path`);
  return path.resolve(result);
}

function taskManagerLifecycleType(value, markerPath, sessionMonitorMarkerPath) {
  if (value === undefined || value === '') {
    return markerPath && !sessionMonitorMarkerPath ? 'external' : 'managed';
  }
  const result = text(value, 'taskManager.lifecycle');
  if (result !== 'managed' && result !== 'external') {
    throw new TypeError('taskManager.lifecycle must be managed or external');
  }
  return result;
}

function defaultCharPromptProfile() {
  return {
    version: 1,
    name: 'DesktopChar',
    instructions: ['使用简短、自然、适合桌面角色说出的中文回复。'],
    applicationFallbackText: '上一轮的回复没有收到，可以再说一次吗？',
  };
}

function defaultRouterPromptProfile() {
  return {
    version: 1,
    name: 'session-routing',
    instructions: [
      '判断当前消息应发送给桌面角色，还是发送给候选任务会话。',
      '只能选择请求中给出的候选 sessionId；没有合适候选时返回 no-match。',
      '仅在多个候选确实接近且无法可靠区分时请求用户确认。',
    ],
  };
}

function normalizeAgentProvider(providerName, provider, role) {
  const label = `agentProviders.${providerName}`;
  const adapter = text(provider.adapter ?? 'codex-app-server', `${label}.adapter`);
  if (adapter === 'codex-app-server') {
    assertKnownKeys(provider, ['adapter', 'lifecycle', 'launcherScript', 'requestTimeoutMs'], label);
    const lifecycle = text(provider.lifecycle ?? 'managed', `${label}.lifecycle`);
    if (lifecycle !== 'managed') {
      throw new TypeError(`${label}.lifecycle must be managed`);
    }
    return {
      adapter,
      lifecycle,
      ...(provider.launcherScript
        ? {
            launcherScript: absoluteFilePath(
              provider.launcherScript,
              `${label}.launcherScript`,
            ),
          }
        : {}),
      requestTimeoutMs: boundedInteger(
        provider.requestTimeoutMs,
        180_000,
        1_000,
        600_000,
        `${label}.requestTimeoutMs`,
      ),
    };
  }
  if (adapter === 'openai-compatible' && role === 'router') {
    assertKnownKeys(provider, ['adapter', 'baseUrl', 'model', 'apiKeyEnv', 'requestTimeoutMs'], label);
    return {
      adapter,
      baseUrl: httpUrl(provider.baseUrl, `${label}.baseUrl`),
      model: text(provider.model, `${label}.model`),
      apiKeyEnv: environmentVariableName(provider.apiKeyEnv, `${label}.apiKeyEnv`),
      requestTimeoutMs: boundedInteger(
        provider.requestTimeoutMs,
        8_000,
        1_000,
        600_000,
        `${label}.requestTimeoutMs`,
      ),
    };
  }
  if (role === 'char') {
    throw new TypeError(`${label}.adapter must be codex-app-server for the char role`);
  }
  throw new TypeError(`${label}.adapter must be codex-app-server or openai-compatible for the router role`);
}

function environmentVariableName(value, label) {
  const result = text(value, label);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(result)) {
    throw new TypeError(`${label} must be an environment variable name`);
  }
  return result;
}

function loopbackHttpUrl(value, label) {
  const result = new URL(text(value, label));
  if (result.protocol !== 'http:' || !LOOPBACK_HOSTS.has(result.hostname)) {
    throw new TypeError(`${label} must use a loopback HTTP origin`);
  }
  return result.href;
}

function boundedNumber(value, fallback, minimum, maximum, label) {
  const result = number(value, fallback, label);
  if (result < minimum || result > maximum) {
    throw new TypeError(`${label} must be from ${minimum} to ${maximum}`);
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
