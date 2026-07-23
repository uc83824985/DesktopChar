import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUTPUT_TAIL_LIMIT = 8_192;
const directory = path.dirname(fileURLToPath(import.meta.url));
const WINDOWS_PROCESS_HOST = path.join(directory, 'managed-process-host.mjs');

export async function startManagedProcess(spec, options = {}) {
  const spawnProcess = options.spawnProcess ?? spawn;
  const platform = options.platform ?? process.platform;
  const closeProcessTree = options.closeProcessTree ?? defaultCloseProcessTree;
  const wrapped = platform === 'win32' && (options.useProcessHost ?? true);
  const childSpec = wrapped ? windowsProcessHostSpec(spec, options) : spec;
  const child = spawnProcess(childSpec.executable, childSpec.args, {
    cwd: childSpec.cwd,
    env: { ...process.env, ...childSpec.env },
    windowsHide: true,
    shell: false,
    detached: wrapped,
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
  if (wrapped) child.unref?.();

  let closing = false;
  return {
    pid: child.pid,
    get exitInfo() { return exitInfo; },
    exited,
    async close(timeoutMs = 10_000) {
      if (closing) return exited;
      closing = true;
      if (exitInfo) return exitInfo;
      if (platform === 'win32') {
        // Windows does not reliably deliver a graceful termination signal to
        // console processes. The process is owned by DesktopChar, so terminate
        // its complete tree immediately instead of waiting for a no-op grace
        // period before doing the same work forcefully.
        await closeProcessTree(child.pid, { force: true });
      }
      else {
        child.kill('SIGTERM');
      }
      const stopped = await Promise.race([
        exited.then(result => ({ result })),
        delay(timeoutMs).then(() => null),
      ]);
      if (stopped) return stopped.result;
      if (platform === 'win32') {
        await closeProcessTree(child.pid, { force: true });
      }
      else {
        child.kill('SIGKILL');
      }
      return await Promise.race([
        exited,
        delay(Math.min(timeoutMs, 2_000)).then(() => ({ code: null, signal: 'SIGKILL-timeout', stdoutTail, stderrTail })),
      ]);
    },
  };
}

async function defaultCloseProcessTree(pid, { force }) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  const args = ['/PID', String(pid), '/T'];
  if (force) args.unshift('/F');
  await new Promise(resolve => {
    const killer = spawn('taskkill', args, {
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    killer.once('error', () => resolve());
    killer.once('exit', () => resolve());
  });
}

function windowsProcessHostSpec(spec, options) {
  const payload = Buffer.from(JSON.stringify({
    parentPid: process.pid,
    spec,
  }), 'utf8').toString('base64');
  const executable = options.hostExecutable ?? process.execPath;
  const env = { ...spec.env };
  if (/\belectron(?:\.exe)?$/i.test(path.basename(executable))) env.ELECTRON_RUN_AS_NODE = '1';
  return {
    executable,
    args: [WINDOWS_PROCESS_HOST, payload],
    cwd: spec.cwd,
    env,
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
