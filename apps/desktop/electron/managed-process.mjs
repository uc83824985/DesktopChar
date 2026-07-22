import { spawn } from 'node:child_process';

const OUTPUT_TAIL_LIMIT = 8_192;

export async function startManagedProcess(spec, options = {}) {
  const spawnProcess = options.spawnProcess ?? spawn;
  const child = spawnProcess(spec.executable, spec.args, {
    cwd: spec.cwd,
    env: { ...process.env, ...spec.env },
    windowsHide: true,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdoutTail = '';
  let stderrTail = '';
  let exitInfo;
  let resolveExit;
  const exited = new Promise(resolve => { resolveExit = resolve; });
  child.stdout?.on('data', chunk => {
    stdoutTail = appendTail(stdoutTail, chunk);
    options.onOutput?.('stdout', String(chunk));
  });
  child.stderr?.on('data', chunk => {
    stderrTail = appendTail(stderrTail, chunk);
    options.onOutput?.('stderr', String(chunk));
  });
  child.once('exit', (code, signal) => {
    exitInfo = Object.freeze({ code, signal, stdoutTail, stderrTail });
    resolveExit(exitInfo);
  });
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });

  let closing = false;
  return {
    pid: child.pid,
    get exitInfo() { return exitInfo; },
    exited,
    async close(timeoutMs = 10_000) {
      if (closing) return exited;
      closing = true;
      if (exitInfo) return exitInfo;
      child.kill('SIGTERM');
      const graceful = await Promise.race([
        exited.then(result => ({ result })),
        delay(timeoutMs).then(() => null),
      ]);
      if (graceful) return graceful.result;
      child.kill('SIGKILL');
      return await Promise.race([
        exited,
        delay(Math.min(timeoutMs, 2_000)).then(() => ({ code: null, signal: 'SIGKILL-timeout', stdoutTail, stderrTail })),
      ]);
    },
  };
}

function appendTail(previous, chunk) {
  const next = previous + String(chunk);
  return next.length <= OUTPUT_TAIL_LIMIT ? next : next.slice(-OUTPUT_TAIL_LIMIT);
}

function delay(ms) {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
