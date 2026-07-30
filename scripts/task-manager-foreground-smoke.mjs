import { randomBytes, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { _electron as electron } from 'playwright-core';
import { createTaskManagerHttpService } from '../task-manager/http-service.mjs';

const root = process.cwd();
const temporaryDirectory = path.join(
  os.tmpdir(),
  `desktop-char-task-manager-foreground-${process.pid}-${Date.now()}`,
);
const markerPath = path.join(temporaryDirectory, 'task_manager.json');
const tokenPath = path.join(temporaryDirectory, 'task_manager_token.txt');
const configPath = path.join(temporaryDirectory, 'desktop-char.config.json');
const userDataPath = path.join(temporaryDirectory, 'electron-user-data');
const token = randomBytes(32).toString('base64url');
const instanceId = randomUUID();
const event = {
  eventId: 'foreground-task-completed-1',
  cursor: 1,
  sessionId: 'session-foreground-smoke',
  type: 'task-completed',
  observedAtMs: Date.now(),
  status: 'completed',
  submissionGeneration: 1,
  commandId: 'foreground-smoke-command',
  title: '隔离前台任务',
  visibleTextTail: '› 只回复最终结果\n\n• 隔离前台任务已完成，最终结果为红色苹果。\n\n› ',
  resultArtifactPath: path.join(temporaryDirectory, 'result.md'),
  openArtifactOnCompletion: false,
};
let ackCount = 0;
let commandCount = 0;
const runtime = {
  getSnapshot() {
    return { phase: 'ready', lastPollAtMs: Date.now(), lastError: null };
  },
  listSessions() {
    return [{
      sessionId: event.sessionId,
      state: 'running',
      monitorState: 'observed',
      agentState: 'waiting_input',
      title: event.title,
      lastVisibleNonEmptyLine: 'terminal fact retained only in main state',
    }];
  },
  eventsAfter(after) {
    return {
      earliestCursor: 1,
      latestCursor: 1,
      gap: false,
      events: after < event.cursor ? [{ ...event }] : [],
    };
  },
  ackEvent(eventId) {
    if (eventId !== event.eventId) throw new Error(`Unexpected event ack: ${eventId}`);
    ackCount += 1;
    return { ...event, acknowledgedAtMs: Date.now() };
  },
  submitCommand() {
    commandCount += 1;
    throw new Error('Foreground notification smoke must not submit commands');
  },
};
const service = createTaskManagerHttpService({
  runtime,
  token,
  host: '127.0.0.1',
  port: 0,
});
let application;

try {
  await mkdir(temporaryDirectory, { recursive: true });
  await writeFile(tokenPath, `${token}\n`, 'utf8');
  const address = await service.listen();
  await writeFile(markerPath, JSON.stringify({
    version: 1,
    role: 'desktop_char_task_manager',
    instanceId,
    pid: process.pid,
    httpBaseUrl: address.baseUrl,
    httpTokenFile: tokenPath,
    persistence: 'memory-only',
    updatedAtUtc: new Date().toISOString(),
  }, null, 2), 'utf8');
  await writeFile(configPath, JSON.stringify({
    taskManager: {
      enabled: true,
      markerPath,
      pollIntervalMs: 250,
      requestTimeoutMs: 2_000,
      eventPageSize: 10,
      maxEvents: 20,
    },
  }, null, 2), 'utf8');

  application = await electron.launch({
    args: [
      path.join(root, 'apps/desktop/electron/main.mjs'),
      `--user-data-dir=${userDataPath}`,
    ],
    cwd: root,
    env: {
      ...process.env,
      DESKTOP_CHAR_CONFIG_PATH: configPath,
      DESKTOP_CHAR_TASK_MANAGER_MARKER: markerPath,
      DESKTOP_CHAR_TASK_MANAGER_ENABLED: '1',
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
    'body[data-ready="true"][data-desktop-shell="ready"][data-task-manager-phase="ready"]'
      + '[data-conversation-external-candidates="1"]',
  ).waitFor({ timeout: 20_000 });
  await page.evaluate(async sourceSessionId => {
    await window.desktopChar?.bindExternalConversationSession({ sourceSessionId });
  }, event.sessionId);
  await page.locator('body[data-conversation-sessions="1"]').waitFor({ timeout: 5_000 });
  await page.waitForFunction(() => {
    const state = document.body.dataset.taskNotification;
    return state === 'presenting' || state === 'completed';
  }, undefined, { timeout: 180_000 });
  const presenting = await page.evaluate(async () => ({
    notificationState: document.body.dataset.taskNotification,
    notificationText: document.body.dataset.taskNotificationText,
    notificationEvent: document.body.dataset.taskNotificationEvent,
    bubbleText: document.querySelector('#speech-bubble')?.textContent?.trim() ?? '',
    taskManager: await window.desktopChar?.getTaskManagerState(),
  }));
  await page.locator('body[data-task-notification="completed"]').waitFor({ timeout: 30_000 });
  const final = await page.evaluate(async () => ({
    notificationText: document.body.dataset.taskNotificationText ?? '',
    notificationSource: document.body.dataset.taskNotificationSource,
    agentState: await window.desktopChar?.getConversationAgentState(),
  }));

  const activity = final.agentState?.activities.find(item =>
    item.input.includes('"title":"隔离前台任务"'));
  if (!presenting.notificationEvent?.endsWith(`:${event.eventId}`)
    || presenting.taskManager?.instanceId !== instanceId
    || presenting.taskManager?.cursor !== 1
    || presenting.taskManager?.pendingAckCount !== 0
    || presenting.taskManager?.events.length !== 1
    || final.notificationSource !== 'char'
    || !activity
    || activity.providerAgentId !== 'codex-app-server'
    || activity.state !== 'completed'
    || !activity.reply
    || final.notificationText !== activity.reply
    || !activity.input.includes('最终结果为红色苹果')
    || !final.notificationText.includes('红色苹果')) {
    throw new Error(
      `Unexpected foreground Task Manager/Char state: ${JSON.stringify({ presenting, final })}`,
    );
  }
  if (activity.input.includes(event.resultArtifactPath)) {
    throw new Error('Task notification leaked the result path into Char context');
  }
  if (ackCount < 1 || commandCount !== 0) {
    throw new Error(`Unexpected Task Manager side effects: ${JSON.stringify({ ackCount, commandCount })}`);
  }
  if (rendererErrors.length) {
    throw new Error(`Foreground Task Manager renderer errors:\n${rendererErrors.join('\n')}`);
  }
  console.log(`Foreground Task Manager Char notification smoke passed: ${final.notificationText}`);
}
finally {
  await application?.close().catch(() => {});
  await service.close().catch(() => {});
  await rm(temporaryDirectory, { recursive: true, force: true });
}
