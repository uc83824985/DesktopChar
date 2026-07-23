import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { _electron as electron } from 'playwright-core';

const execFileAsync = promisify(execFile);
const root = process.cwd();
const mode = process.argv[2] ?? 'avatar-menu';
if (!['avatar-menu', 'force-main', 'sigint'].includes(mode)) {
  throw new TypeError('Exit mode must be avatar-menu, force-main, or sigint');
}
if (await endpointAvailable('http://127.0.0.1:18090/v1/models')) {
  throw new Error('Port 18090 is already serving a Provider; stop it before the managed exit diagnostic');
}

const application = await electron.launch({
  args: [path.join(root, 'apps/desktop/electron/main.mjs')],
  cwd: root,
});
const mainProcess = application.process();
const electronMainPid = await application.evaluate(() => process.pid);
const mainExit = new Promise(resolve => {
  mainProcess.once('exit', (code, signal) => resolve({ code, signal }));
});
let providerHostPid;

try {
  const page = await application.firstWindow({ timeout: 20_000 });
  await page.locator('body[data-ready="true"][data-shell="floating"]').waitFor({ timeout: 20_000 });
  await page.waitForFunction(async () => {
    const state = await window.desktopChar?.getWindowState();
    return state?.performanceInference?.phase === 'ready'
      && state.performanceInference.operational === true
      && Number.isInteger(state.performanceInference.processId);
  }, undefined, { timeout: 180_000 });
  const readyState = await page.evaluate(() => window.desktopChar?.getWindowState());
  providerHostPid = readyState.performanceInference.processId;
  if (readyState.performanceInference.lifecycle !== 'managed') {
    throw new Error(`Expected managed performance lifecycle: ${JSON.stringify(readyState.performanceInference)}`);
  }

  let visibleFeedbackMs = null;
  const exitStartedAt = performance.now();
  if (mode === 'avatar-menu') {
    await page.locator('#avatar').focus();
    await page.keyboard.press('Shift+F10');
    await page.locator('[data-item-id="quit"]').click({ noWaitAfter: true });
    visibleFeedbackMs = await waitForWindowHidden(application, exitStartedAt);
    if (visibleFeedbackMs > 500) {
      throw new Error(`Avatar window remained visible for ${Math.round(visibleFeedbackMs)} ms after quit`);
    }
  }
  else if (mode === 'force-main') {
    await execFileAsync('taskkill', ['/PID', String(electronMainPid), '/F'], {
      windowsHide: true,
    });
  }
  else {
    process.kill(electronMainPid, 'SIGINT');
  }

  const exit = await withTimeout(mainExit, 20_000, 'DesktopChar main process did not exit');
  const providerClosedMs = await waitForEndpointClosed(
    'http://127.0.0.1:18090/v1/models',
    exitStartedAt,
    20_000,
  );
  await waitForProcessExit(providerHostPid, 20_000);
  console.log(JSON.stringify({
    mode,
    mainProcessId: electronMainPid,
    providerHostPid,
    visibleFeedbackMs: visibleFeedbackMs === null ? null : Math.round(visibleFeedbackMs),
    providerClosedMs: Math.round(providerClosedMs),
    mainExit: exit,
    residualProviderHost: isProcessAlive(providerHostPid),
    residualEndpoint: await endpointAvailable('http://127.0.0.1:18090/v1/models'),
  }, null, 2));
}
finally {
  if (mainProcess.exitCode === null && mainProcess.signalCode === null) {
    await application.close().catch(() => {});
  }
  if (isProcessAlive(electronMainPid)) {
    await execFileAsync('taskkill', ['/PID', String(electronMainPid), '/T', '/F'], {
      windowsHide: true,
    }).catch(() => {});
  }
}

async function waitForWindowHidden(application, startedAt) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      const visible = await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some(window => window.isVisible()));
      if (!visible) return performance.now() - startedAt;
    }
    catch {
      return performance.now() - startedAt;
    }
    await delay(10);
  }
  throw new Error('Avatar window did not hide during shutdown');
}

async function waitForEndpointClosed(url, startedAt, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!await endpointAvailable(url)) return performance.now() - startedAt;
    await delay(50);
  }
  throw new Error(`Managed Provider endpoint remained available after ${timeoutMs} ms`);
}

async function endpointAvailable(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 500);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return response.ok;
  }
  catch {
    return false;
  }
  finally {
    clearTimeout(timer);
  }
}

async function waitForProcessExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return;
    await delay(50);
  }
  throw new Error(`Managed Provider host ${pid} remained alive after ${timeoutMs} ms`);
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  }
  catch {
    return false;
  }
}

async function withTimeout(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  }
  finally {
    if (timer) clearTimeout(timer);
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
