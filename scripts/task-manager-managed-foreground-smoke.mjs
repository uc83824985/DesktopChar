import os from 'node:os';
import path from 'node:path';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { _electron as electron } from 'playwright-core';

const root = process.cwd();
const currentConfig = JSON.parse(await readFile(
  path.join(root, 'desktop-char.config.json'),
  'utf8',
));
const sessionMonitorMarkerPath = process.env.SESSION_MONITOR_MARKER
  ?? currentConfig.taskManager?.sessionMonitorMarkerPath;
if (!sessionMonitorMarkerPath) {
  throw new Error('Managed foreground smoke requires a Session Monitor marker path');
}
await access(sessionMonitorMarkerPath);

const temporaryDirectory = path.join(
  os.tmpdir(),
  `desktop-char-managed-task-manager-${process.pid}-${Date.now()}`,
);
const configPath = path.join(temporaryDirectory, 'desktop-char.config.json');
const stateDirectory = path.join(temporaryDirectory, 'task-manager');
const markerPath = path.join(stateDirectory, 'task_manager.json');
const userDataPath = path.join(temporaryDirectory, 'electron-user-data');
let application;

try {
  await mkdir(temporaryDirectory, { recursive: true });
  await writeFile(configPath, JSON.stringify({
    agentHttp: { enabled: false },
    taskManager: {
      enabled: true,
      lifecycle: 'managed',
      sessionMonitorMarkerPath,
      stateDirectory,
      startupTimeoutMs: 10_000,
      shutdownTimeoutMs: 5_000,
      restartOnFailure: true,
      pollIntervalMs: 250,
      requestTimeoutMs: 2_000,
      eventPageSize: 20,
      maxEvents: 50,
    },
    performanceInference: { enabled: false, lifecycle: 'external' },
    ttsMcp: { autoStart: false },
    characterMcp: { autoStart: false, port: 0 },
  }, null, 2), 'utf8');

  application = await electron.launch({
    args: [
      `--user-data-dir=${userDataPath}`,
      path.join(root, 'apps/desktop/electron/main.mjs'),
    ],
    cwd: root,
    env: {
      ...process.env,
      DESKTOP_CHAR_CONFIG_PATH: configPath,
    },
  });
  const page = await application.firstWindow({ timeout: 20_000 });
  const rendererErrors = [];
  page.on('console', message => {
    if (message.type() === 'error' && !message.text().includes('404')) {
      rendererErrors.push(message.text());
    }
  });
  page.on('pageerror', error => rendererErrors.push(error.stack ?? error.message));

  await page.locator(
    'body[data-ready="true"][data-desktop-shell="ready"]'
      + '[data-task-manager-enabled="true"][data-task-manager-lifecycle="managed"]'
      + '[data-task-manager-phase="ready"]',
  ).waitFor({ timeout: 20_000 });
  await page.waitForFunction(
    () => Number(document.body.dataset.conversationExternalCandidates) > 0,
    undefined,
    { timeout: 10_000 },
  );
  const initial = await page.evaluate(() => window.desktopChar?.getTaskManagerState());
  if (
    initial?.lifecycle !== 'managed'
    || initial.phase !== 'ready'
    || !Number.isInteger(initial.processId)
    || initial.processId <= 0
    || initial.sessions.length === 0
  ) {
    throw new Error(`Managed Task Manager did not start: ${JSON.stringify(initial)}`);
  }

  await page.evaluate(() => document.querySelector('#avatar')?.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true }),
  ));
  const toggle = page.locator(
    'body[data-context-menu="open"] [data-item-id="task-manager-enabled"]',
  );
  await toggle.waitFor({ timeout: 2_000 });
  if (await toggle.getAttribute('aria-checked') !== 'true') {
    throw new Error('Task Manager context-menu item did not reflect its enabled state');
  }
  await toggle.click();
  await page.locator(
    'body[data-context-menu="open"][data-task-manager-enabled="false"]'
      + '[data-task-manager-phase="disabled"] '
      + '[data-item-id="task-manager-enabled"][aria-checked="false"]',
  ).waitFor({ timeout: 10_000 });
  await page.locator('body[data-conversation-external-candidates="0"]').waitFor({
    timeout: 5_000,
  });
  const disabled = await page.evaluate(() => window.desktopChar?.getTaskManagerState());
  if (disabled?.processId !== null || disabled?.sessions.length !== 0) {
    throw new Error(`Managed Task Manager did not stop cleanly: ${JSON.stringify(disabled)}`);
  }

  await toggle.click();
  await page.locator(
    'body[data-context-menu="open"][data-task-manager-enabled="true"]'
      + '[data-task-manager-phase="ready"] '
      + '[data-item-id="task-manager-enabled"][aria-checked="true"]',
  ).waitFor({ timeout: 20_000 });
  await page.waitForFunction(
    () => Number(document.body.dataset.conversationExternalCandidates) > 0,
    undefined,
    { timeout: 10_000 },
  );
  const restarted = await page.evaluate(() => window.desktopChar?.getTaskManagerState());
  if (
    restarted?.processId === initial.processId
    || restarted?.phase !== 'ready'
    || restarted.sessions.length === 0
  ) {
    throw new Error(`Managed Task Manager did not restart: ${JSON.stringify(restarted)}`);
  }
  if (rendererErrors.length) {
    throw new Error(`Managed Task Manager renderer errors:\n${rendererErrors.join('\n')}`);
  }
  console.log(
    `Managed Task Manager foreground smoke passed: ${restarted.sessions.length} sessions; `
    + `pid ${initial.processId} -> ${restarted.processId}`,
  );
}
finally {
  await application?.close().catch(() => {});
  await rm(temporaryDirectory, { recursive: true, force: true });
}
