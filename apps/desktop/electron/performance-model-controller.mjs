import { startManagedProcess } from './managed-process.mjs';

const DEFAULT_RESTART_DELAY_MS = 1_000;
const READINESS_POLL_MS = 100;
const HEALTH_REQUEST_TIMEOUT_MS = 2_000;

export function createPerformanceModelController(initialConfig, options = {}) {
  const launchProcess = options.launchProcess ?? startManagedProcess;
  const fetcher = options.fetcher ?? fetch;
  const onStateChanged = options.onStateChanged ?? (() => {});
  const restartDelayMs = options.restartDelayMs ?? DEFAULT_RESTART_DELAY_MS;
  let config = validatedConfig(initialConfig);
  let enabledOverride;
  let phase = 'disabled';
  let processId = null;
  let lastError = null;
  let activeProcess;
  let activeSignature = '';
  let operation = Promise.resolve();
  let disposed = false;
  let restartTimer;
  let healthTimer;

  function desiredEnabled() {
    return enabledOverride ?? config.enabled;
  }

  function snapshot() {
    const desired = desiredEnabled();
    return {
      enabled: desired,
      operational: desired && (config.lifecycle.type === 'external' || phase === 'ready'),
      lifecycle: config.lifecycle.type,
      phase,
      processId,
      lastError,
      provider: config.provider,
      baseUrl: config.baseUrl,
      ...(config.model ? { model: config.model } : {}),
      timeoutMs: config.timeoutMs,
      maxOutputTokens: config.maxOutputTokens,
      temperature: config.temperature,
      fallbackToRules: config.fallbackToRules,
    };
  }

  function emit() {
    onStateChanged(snapshot());
  }

  function enqueue(task) {
    const next = operation.catch(() => {}).then(task);
    operation = next.catch(() => {});
    return next;
  }

  function start() {
    return enqueue(() => reconcile('startup'));
  }

  function replace(nextConfig) {
    config = validatedConfig(nextConfig);
    enabledOverride = undefined;
    emit();
    return enqueue(() => reconcile('config-reload'));
  }

  function setEnabled(enabled) {
    if (typeof enabled !== 'boolean') {
      throw new TypeError('Performance inference enabled state must be boolean');
    }
    enabledOverride = enabled;
    emit();
    return enqueue(() => reconcile('runtime-toggle'));
  }

  async function reconcile(reason) {
    if (disposed) return snapshot();
    clearRestart();
    clearHealth();
    if (!desiredEnabled()) {
      await stopManagedProcess();
      phase = 'disabled';
      lastError = null;
      emit();
      return snapshot();
    }
    if (config.lifecycle.type === 'external') {
      await stopManagedProcess();
      phase = 'ready';
      lastError = null;
      emit();
      return snapshot();
    }

    const signature = managedSignature(config);
    if (activeProcess && activeSignature === signature && phase === 'ready') {
      scheduleHealthCheck();
      return snapshot();
    }
    await stopManagedProcess();
    phase = reason === 'failure-restart' ? 'restarting' : 'starting';
    processId = null;
    lastError = null;
    emit();

    let candidate;
    const targetConfig = config;
    try {
      candidate = await launchProcess(targetConfig.lifecycle.start, {
        onOutput: options.onOutput,
      });
      if (disposed || !desiredEnabled() || config !== targetConfig) {
        await candidate.close(targetConfig.lifecycle.shutdownTimeoutMs);
        return snapshot();
      }
      activeProcess = candidate;
      activeSignature = signature;
      processId = candidate.pid;
      observeExit(candidate);
      emit();
      await waitUntilReady(candidate, targetConfig);
      if (
        disposed
        || activeProcess !== candidate
        || !desiredEnabled()
        || config !== targetConfig
      ) {
        if (activeProcess === candidate) await stopManagedProcess();
        return snapshot();
      }
      phase = 'ready';
      lastError = null;
      emit();
      scheduleHealthCheck();
    }
    catch (error) {
      if (activeProcess === candidate) {
        activeProcess = undefined;
        activeSignature = '';
        processId = null;
      }
      await candidate?.close(targetConfig.lifecycle.shutdownTimeoutMs).catch(() => {});
      handleFailure(error);
    }
    return snapshot();
  }

  async function waitUntilReady(process, targetConfig) {
    const deadline = Date.now() + targetConfig.lifecycle.startupTimeoutMs;
    let latestError;
    while (Date.now() < deadline) {
      if (
        disposed
        || activeProcess !== process
        || !desiredEnabled()
        || config !== targetConfig
      ) {
        throw new Error('Managed performance Provider startup was cancelled');
      }
      if (process.exitInfo) throw processExitError(process.exitInfo);
      try {
        await probeHealth(targetConfig.healthUrl);
        return;
      }
      catch (error) {
        latestError = error;
        await delay(READINESS_POLL_MS);
      }
    }
    throw new Error(
      `Managed performance Provider did not become ready within `
      + `${targetConfig.lifecycle.startupTimeoutMs} ms: ${errorMessage(latestError)}`,
    );
  }

  async function probeHealth(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_REQUEST_TIMEOUT_MS);
    timer.unref?.();
    try {
      const response = await fetcher(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Performance Provider health endpoint returned HTTP ${response.status}`);
      }
    }
    finally {
      clearTimeout(timer);
    }
  }

  function observeExit(process) {
    void process.exited.then(info => {
      if (activeProcess !== process || disposed) return;
      activeProcess = undefined;
      activeSignature = '';
      processId = null;
      clearHealth();
      handleFailure(processExitError(info));
    });
  }

  function handleFailure(error) {
    lastError = errorMessage(error);
    if (
      !disposed
      && desiredEnabled()
      && config.lifecycle.type === 'managed'
      && config.lifecycle.restartOnFailure
    ) {
      phase = 'restarting';
      scheduleRestart();
    }
    else {
      phase = desiredEnabled() ? 'failed' : 'disabled';
    }
    emit();
  }

  function scheduleRestart() {
    clearRestart();
    restartTimer = setTimeout(() => {
      restartTimer = undefined;
      void enqueue(() => reconcile('failure-restart'));
    }, restartDelayMs);
    restartTimer.unref?.();
  }

  function clearRestart() {
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = undefined;
  }

  function scheduleHealthCheck() {
    clearHealth();
    const process = activeProcess;
    if (
      !process
      || disposed
      || !desiredEnabled()
      || config.lifecycle.type !== 'managed'
      || phase !== 'ready'
    ) {
      return;
    }
    const targetConfig = config;
    healthTimer = setTimeout(() => {
      healthTimer = undefined;
      void enqueue(async () => {
        if (
          activeProcess !== process
          || disposed
          || !desiredEnabled()
          || config !== targetConfig
        ) {
          return;
        }
        try {
          await probeHealth(targetConfig.healthUrl);
          scheduleHealthCheck();
        }
        catch (error) {
          await stopManagedProcess();
          handleFailure(error);
        }
      });
    }, targetConfig.lifecycle.healthIntervalMs);
    healthTimer.unref?.();
  }

  function clearHealth() {
    if (healthTimer) clearTimeout(healthTimer);
    healthTimer = undefined;
  }

  async function stopManagedProcess() {
    clearHealth();
    const process = activeProcess;
    const shutdownTimeoutMs = config.lifecycle.shutdownTimeoutMs;
    activeProcess = undefined;
    activeSignature = '';
    processId = null;
    if (!process) return;
    phase = 'stopping';
    emit();
    await process.close(shutdownTimeoutMs).catch(() => {});
  }

  function close() {
    disposed = true;
    enabledOverride = false;
    clearRestart();
    clearHealth();
    return enqueue(async () => {
      await stopManagedProcess();
      phase = 'disabled';
      processId = null;
      emit();
      return snapshot();
    });
  }

  return {
    start,
    replace,
    setEnabled,
    snapshot,
    close,
  };
}

function validatedConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Performance model config must be an object');
  }
  if (!value.lifecycle || !['external', 'managed'].includes(value.lifecycle.type)) {
    throw new TypeError('Performance model lifecycle must be external or managed');
  }
  if (value.lifecycle.type === 'managed' && !value.lifecycle.start?.executable) {
    throw new TypeError('Managed performance model requires a start executable');
  }
  return value;
}

function managedSignature(config) {
  return JSON.stringify({
    lifecycle: config.lifecycle,
    baseUrl: config.baseUrl,
    healthUrl: config.healthUrl,
    provider: config.provider,
    model: config.model,
  });
}

function processExitError(info) {
  const detail = info?.stderrTail?.trim() || info?.stdoutTail?.trim();
  return new Error(
    `Managed performance Provider exited (code=${String(info?.code)}, `
    + `signal=${String(info?.signal)})${detail ? `: ${detail}` : ''}`,
  );
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
