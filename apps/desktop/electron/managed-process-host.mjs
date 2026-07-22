import { spawn } from 'node:child_process';

const [, , payloadBase64] = process.argv;

if (!payloadBase64) throw new Error('managed-process-host requires a base64 payload');

const payload = JSON.parse(Buffer.from(payloadBase64, 'base64').toString('utf8'));
const parentPid = Number(payload.parentPid);
const spec = payload.spec;

if (!spec?.executable || !Array.isArray(spec?.args)) {
  throw new TypeError('managed-process-host payload is invalid');
}

const child = spawn(spec.executable, spec.args, {
  cwd: spec.cwd,
  env: { ...process.env, ...spec.env },
  windowsHide: true,
  shell: false,
  stdio: ['ignore', 'pipe', 'pipe'],
});

child.stdout?.on('data', chunk => {
  try { process.stdout.write(chunk); }
  catch {}
});
child.stderr?.on('data', chunk => {
  try { process.stderr.write(chunk); }
  catch {}
});

let shuttingDown = false;
const watcher = setInterval(() => {
  if (shuttingDown) return;
  if (!isAlive(parentPid)) {
    shuttingDown = true;
    void killTree(child.pid).finally(() => process.exit(0));
  }
}, 500);
watcher.unref?.();

child.once('exit', (code, signal) => {
  clearInterval(watcher);
  process.exitCode = code ?? (signal ? 1 : 0);
});

process.once('SIGINT', () => terminateChild());
process.once('SIGTERM', () => terminateChild());
process.once('disconnect', () => terminateChild());

async function terminateChild() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(watcher);
  await killTree(child.pid);
  process.exit(0);
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  }
  catch {
    return false;
  }
}

async function killTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  await new Promise(resolve => {
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    killer.once('error', () => resolve());
    killer.once('exit', () => resolve());
  });
}
