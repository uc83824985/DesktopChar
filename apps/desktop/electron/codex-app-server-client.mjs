import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export function createCodexAppServerClient(options = {}) {
  const cwd = options.cwd;
  const invocationSource = options.invocation;
  const spawnProcess = options.spawnProcess ?? spawnAppServerProcess;
  const startupTimeoutMs = positive(options.startupTimeoutMs ?? 15_000, 'Codex app-server startupTimeoutMs');
  let child;
  let lineReader;
  let startPromise;
  let closed = false;
  let nextRequestId = 1;
  let stderrTail = '';
  const pendingRequests = new Map();
  const activeTurns = new Map();

  return {
    execute,
    createThread,
    executeThread,
    steerThread,
    archiveThread,
    close,
  };

  async function execute(request, signal, hooks = {}) {
    const thread = await createThread({ ephemeral: true }, signal);
    callHook(hooks.onThreadStarted, thread.threadId);
    try {
      return await executeThread(thread.threadId, request, signal, hooks);
    }
    finally {
      void requestRpc('thread/unsubscribe', { threadId: thread.threadId }).catch(() => {});
    }
  }

  async function createThread(options = {}, signal) {
    await ensureStarted();
    if (signal?.aborted) throw abortReason(signal);
    const threadResponse = await requestRpc('thread/start', {
      cwd,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      ephemeral: options.ephemeral === true,
      serviceName: 'desktop_char',
    });
    return {
      threadId: requiredText(threadResponse?.thread?.id, 'Codex app-server thread id'),
    };
  }

  async function executeThread(threadId, request, signal, hooks = {}) {
    await ensureStarted();
    const normalizedThreadId = requiredText(threadId, 'Codex app-server thread id');
    if (signal.aborted) throw abortReason(signal);
    if (activeTurns.has(normalizedThreadId)) {
      throw new Error(`Codex app-server thread already has an active turn: ${normalizedThreadId}`);
    }
    const completion = Promise.withResolvers();
    void completion.promise.catch(() => {});
    const turnReady = Promise.withResolvers();
    void turnReady.promise.catch(() => {});
    const active = {
      threadId: normalizedThreadId,
      turnId: null,
      finalText: '',
      settled: false,
      resolve: completion.resolve,
      reject: completion.reject,
      turnReady,
      removeAbortListener: () => {},
    };
    activeTurns.set(normalizedThreadId, active);
    try {
      const turnResponse = await requestRpc('turn/start', {
        threadId: normalizedThreadId,
        input: [{ type: 'text', text: request.prompt }],
        cwd,
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'readOnly' },
        ...(request.outputSchema ? { outputSchema: request.outputSchema } : {}),
      });
      active.turnId = requiredText(turnResponse?.turn?.id, 'Codex app-server turn id');
      active.turnReady.resolve(active.turnId);
      callHook(hooks.onTurnStarted, active.turnId);
      if (signal.aborted) {
        void requestRpc('turn/interrupt', {
          threadId: normalizedThreadId,
          turnId: active.turnId,
        }).catch(() => {});
        finishTurn(active, undefined, abortReason(signal));
      }
      else {
        const onAbort = () => {
          void requestRpc('turn/interrupt', {
            threadId: normalizedThreadId,
            turnId: active.turnId,
          }).catch(() => {});
          finishTurn(active, undefined, abortReason(signal));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        active.removeAbortListener = () => signal.removeEventListener('abort', onAbort);
      }
      return await completion.promise;
    }
    catch (error) {
      if (!active.turnId) active.turnReady.reject(error);
      finishTurn(active, undefined, error);
      throw error;
    }
    finally {
      active.removeAbortListener();
      if (activeTurns.get(normalizedThreadId) === active) {
        activeTurns.delete(normalizedThreadId);
      }
    }
  }

  async function steerThread(threadId, text, signal) {
    await ensureStarted();
    const normalizedThreadId = requiredText(threadId, 'Codex app-server thread id');
    const input = requiredText(text, 'Codex app-server steer text');
    if (signal?.aborted) throw abortReason(signal);
    const active = activeTurns.get(normalizedThreadId);
    if (!active) {
      throw new Error(`Codex app-server thread has no active turn: ${normalizedThreadId}`);
    }
    const turnId = await active.turnReady.promise;
    if (signal?.aborted) throw abortReason(signal);
    const response = await requestRpc('turn/steer', {
      threadId: normalizedThreadId,
      input: [{ type: 'text', text: input }],
      expectedTurnId: turnId,
    });
    return {
      turnId: requiredText(response?.turnId, 'Codex app-server steered turn id'),
    };
  }

  async function archiveThread(threadId) {
    await ensureStarted();
    const normalizedThreadId = requiredText(threadId, 'Codex app-server thread id');
    const active = activeTurns.get(normalizedThreadId);
    const activeTurnId = active
      ? await active.turnReady.promise.catch(() => undefined)
      : undefined;
    if (active && activeTurnId) {
      await requestRpc('turn/interrupt', {
        threadId: normalizedThreadId,
        turnId: activeTurnId,
      });
      finishTurn(active, undefined, new DOMException('Managed conversation closed', 'AbortError'));
    }
    try {
      await requestRpc('thread/archive', { threadId: normalizedThreadId });
    }
    finally {
      void requestRpc('thread/unsubscribe', { threadId: normalizedThreadId }).catch(() => {});
    }
  }

  async function ensureStarted() {
    if (closed) throw new Error('Codex app-server client is closed');
    if (startPromise) return startPromise;
    startPromise = withTimeout((async () => {
      const invocation = typeof invocationSource === 'function'
        ? invocationSource()
        : invocationSource;
      if (
        !invocation
        || typeof invocation.command !== 'string'
        || !invocation.command.trim()
        || !Array.isArray(invocation.args)
      ) {
        throw new TypeError('Codex app-server invocation is invalid');
      }
      child = spawnProcess(invocation.command, [
        ...invocation.args,
        '--ask-for-approval', 'never',
        '--sandbox', 'read-only',
        'app-server',
        '--listen', 'stdio://',
      ], { cwd });
      child.stderr.on('data', chunk => {
        stderrTail = `${stderrTail}${Buffer.from(chunk).toString('utf8')}`.slice(-8_192);
      });
      lineReader = createInterface({ input: child.stdout });
      lineReader.on('line', handleLine);
      child.once('error', error => failProcess(error));
      child.once('close', code => {
        if (closed) return;
        const detail = stderrTail.trim();
        failProcess(new Error(
          `Codex app-server exited with code ${code ?? -1}${detail ? `: ${detail}` : ''}`,
        ));
      });
      await requestRpc('initialize', {
        clientInfo: {
          name: 'desktop_char',
          title: 'DesktopChar',
          version: '0.1.0',
        },
      }, false);
      send({ method: 'initialized', params: {} });
    })(), startupTimeoutMs, 'Codex app-server initialization timed out');
    try {
      await startPromise;
    }
    catch (error) {
      startPromise = undefined;
      child?.kill();
      child = undefined;
      throw error;
    }
  }

  function requestRpc(method, params, requireStarted = true) {
    if (closed) return Promise.reject(new Error('Codex app-server client is closed'));
    if (requireStarted && !child) return Promise.reject(new Error('Codex app-server is not running'));
    const id = nextRequestId++;
    return new Promise((resolve, reject) => {
      pendingRequests.set(id, { resolve, reject, method });
      try {
        send({ method, id, params });
      }
      catch (error) {
        pendingRequests.delete(id);
        reject(error);
      }
    });
  }

  function send(message) {
    if (!child?.stdin.writable) throw new Error('Codex app-server stdin is unavailable');
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  function handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    }
    catch {
      failProcess(new Error(`Codex app-server emitted invalid JSON: ${line.slice(0, 200)}`));
      return;
    }
    if (message.id !== undefined) {
      const pending = pendingRequests.get(message.id);
      if (!pending) return;
      pendingRequests.delete(message.id);
      if (message.error) {
        pending.reject(new Error(
          `Codex app-server ${pending.method} failed: ${message.error.message ?? JSON.stringify(message.error)}`,
        ));
      }
      else pending.resolve(message.result);
      return;
    }
    const params = message.params;
    const active = params?.threadId ? activeTurns.get(params.threadId) : undefined;
    if (!active) return;
    if (message.method === 'item/completed'
      && params.item?.type === 'agentMessage'
      && (!params.item.phase || params.item.phase === 'final_answer')) {
      active.finalText = params.item.text ?? active.finalText;
      return;
    }
    if (message.method !== 'turn/completed') return;
    const turn = params.turn;
    if (active.turnId && turn?.id !== active.turnId) return;
    if (turn?.status === 'completed' && active.finalText.trim()) {
      finishTurn(active, active.finalText);
    }
    else {
      finishTurn(
        active,
        undefined,
        new Error(turn?.error?.message ?? `Codex turn ended with status ${turn?.status ?? 'unknown'}`),
      );
    }
  }

  function finishTurn(active, text, error) {
    if (active.settled) return;
    active.settled = true;
    if (!active.turnId) active.turnReady.reject(error ?? new Error('Codex turn ended before starting'));
    if (error === undefined) active.resolve(text);
    else active.reject(error);
  }

  function failProcess(error) {
    for (const pending of pendingRequests.values()) pending.reject(error);
    pendingRequests.clear();
    for (const active of activeTurns.values()) finishTurn(active, undefined, error);
    activeTurns.clear();
    lineReader?.close();
    lineReader = undefined;
    child = undefined;
    startPromise = undefined;
  }

  async function close() {
    if (closed) return;
    closed = true;
    const error = new Error('Codex app-server client closed');
    for (const pending of pendingRequests.values()) pending.reject(error);
    pendingRequests.clear();
    for (const active of activeTurns.values()) finishTurn(active, undefined, error);
    activeTurns.clear();
    lineReader?.close();
    lineReader = undefined;
    child?.kill();
    child = undefined;
    startPromise = undefined;
  }
}

function callHook(hook, value) {
  if (typeof hook !== 'function') return;
  try {
    hook(value);
  }
  catch {
    // Diagnostic hooks must never change App Server request semantics.
  }
}

export function spawnAppServerProcess(command, args, options) {
  return spawn(command, args, createAppServerSpawnOptions(options));
}

export function createAppServerSpawnOptions(options) {
  return {
    cwd: options.cwd,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    },
  };
}

function withTimeout(promise, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    void promise.then(resolve, reject).finally(() => clearTimeout(timeout));
  });
}

function abortReason(signal) {
  return signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
}

function requiredText(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} is missing`);
  return value;
}

function positive(value, label) {
  if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${label} must be positive and finite`);
  return value;
}
