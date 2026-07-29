import { randomBytes, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { _electron as electron } from 'playwright-core';
import koffi from 'koffi';
import { createTaskManagerHttpService } from '../task-manager/http-service.mjs';

const root = process.cwd();
const temporaryDirectory = path.join(
  os.tmpdir(),
  `desktop-char-routing-foreground-${process.pid}-${Date.now()}`,
);
const markerPath = path.join(temporaryDirectory, 'task_manager.json');
const tokenPath = path.join(temporaryDirectory, 'task_manager_token.txt');
const configPath = path.join(temporaryDirectory, 'desktop-char.config.json');
const userDataPath = path.join(temporaryDirectory, 'electron-user-data');
const token = randomBytes(32).toString('base64url');
const instanceId = randomUUID();
const sessionId = 'session-routing-smoke';
const commands = [];
const runtime = {
  getSnapshot() {
    return { phase: 'ready', lastPollAtMs: Date.now(), lastError: null };
  },
  listSessions() {
    return [{
      sessionId,
      state: 'running',
      monitorState: 'observed',
      agentState: 'waiting_input',
      title: '路由隔离会话',
      workDir: temporaryDirectory,
      lastScreenChangedAtUtc: '2026-07-29T12:00:00Z',
    }];
  },
  eventsAfter() {
    return { earliestCursor: 1, latestCursor: 0, gap: false, events: [] };
  },
  ackEvent(eventId) {
    throw new Error(`No event should be acknowledged: ${eventId}`);
  },
  submitCommand(command) {
    commands.push(structuredClone(command));
    return {
      ...command,
      submissionGeneration: commands.length,
      status: 'observing',
      createdAtMs: Date.now(),
      submittedAtMs: Date.now(),
    };
  },
};
const service = createTaskManagerHttpService({
  runtime,
  token,
  host: '127.0.0.1',
  port: 0,
});
let application;
const nativePointer = createNativePointer();
let originalCursorPoint;

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
  originalCursorPoint = await application.evaluate(({ screen }) => screen.getCursorScreenPoint());
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
      + '[data-task-manager-phase="ready"][data-routing-candidates="1"]',
  ).waitFor({ timeout: 20_000 });

  const shellState = await page.evaluate(() => window.desktopChar?.getWindowState());
  if (!shellState) throw new Error('Desktop shell state is unavailable');
  await openConversationPanel(page, shellState.bounds, nativePointer);
  const selector = page.locator('.conversation-panel__route-controls select');
  await selector.selectOption(`session:${sessionId}`);
  await page.locator(`body[data-routing-selection="session:${sessionId}"]`).waitFor();
  const input = page.locator('.conversation-panel__form textarea');
  const firstText = '第一条直接提交';
  const secondText = '第二条继续提交';
  await input.fill(firstText);
  await input.press('Control+Enter');
  await page.locator('body[data-routing-phase="sent"]').waitFor({ timeout: 5_000 });
  await page.waitForFunction(() =>
    document.querySelector('.conversation-panel__form textarea')?.value === '');
  await input.fill(secondText);
  await input.press('Control+Enter');
  await page.waitForFunction(expected => {
    const status = document.querySelector('.conversation-panel__route-status')?.textContent ?? '';
    return document.body.dataset.routingPhase === 'sent' && status.includes(expected);
  }, secondText, { timeout: 5_000 }).catch(async error => {
    const diagnostics = await page.evaluate(() => ({
      routingPhase: document.body.dataset.routingPhase,
      routingSelection: document.body.dataset.routingSelection,
      routeStatus: document.querySelector('.conversation-panel__route-status')?.textContent,
      input: document.querySelector('.conversation-panel__form textarea')?.value,
      panelPhase: document.body.dataset.interactionPanel,
    }));
    throw new Error(
      `Second sticky submission did not settle: ${JSON.stringify({ diagnostics, commands, rendererErrors })}`,
      { cause: error },
    );
  });
  if (
    commands.length !== 2
    || commands.some(command => command.sessionId !== sessionId || command.mode !== 'submit')
    || commands[0].text !== firstText
    || commands[1].text !== secondText
    || commands[1].contextRevision <= commands[0].contextRevision
  ) {
    throw new Error(`Sticky session routing failed: ${JSON.stringify(commands)}`);
  }

  await selector.selectOption('auto');
  const autoText = '这条 Auto 消息不能静默回退';
  await input.fill(autoText);
  await input.press('Control+Enter');
  await page.locator('body[data-routing-selection="auto"][data-routing-phase="error"]')
    .waitFor({ timeout: 5_000 });
  if (commands.length !== 2 || await input.inputValue() !== autoText) {
    throw new Error('Router failure changed target, cleared input, or produced a session side effect');
  }

  await selector.selectOption('character');
  const charText = `路由前台 Codex 测试 ${Date.now()}：请简短确认。`;
  await input.fill(charText);
  await input.press('Control+Enter');
  await page.locator(
    'body[data-routing-selection="character"][data-routing-last-target="character"]'
      + '[data-conversation-turns="1"]',
  ).waitFor({ timeout: 5_000 });
  await page.waitForFunction(async expectedInput => {
    const state = await window.desktopChar?.getConversationAgentState();
    return state?.activities.some(activity =>
      activity.input === expectedInput
      && activity.providerAgentId === 'codex-app-server'
      && activity.state === 'completed'
      && Boolean(activity.reply?.trim()));
  }, charText, { timeout: 180_000 });

  if (commands.length !== 2) {
    throw new Error(`Char routing unexpectedly submitted a Task Manager command: ${commands.length}`);
  }
  if (rendererErrors.length) {
    throw new Error(`Foreground routing renderer errors:\n${rendererErrors.join('\n')}`);
  }
  console.log(
    `Foreground routing smoke passed: sticky ${sessionId}, strict Auto failure, managed Char Codex`,
  );
}
finally {
  if (originalCursorPoint) nativePointer.move(originalCursorPoint);
  await application?.close().catch(() => {});
  await service.close().catch(() => {});
  await rm(temporaryDirectory, { recursive: true, force: true });
}

async function openConversationPanel(page, bounds, pointer) {
  for (const local of [
    { x: 230, y: 350 },
    { x: 230, y: 270 },
    { x: 230, y: 450 },
  ]) {
    const absolute = { x: bounds.x + local.x, y: bounds.y + local.y };
    pointer.move(absolute);
    await page.waitForTimeout(250);
    if (await page.locator('body').getAttribute('data-pixel-selection') !== 'covered') continue;
    pointer.click();
    try {
      const panel = page.locator('.scene-interaction-panel');
      await panel.waitFor({ state: 'visible', timeout: 3_000 });
      const panelBounds = await panel.boundingBox();
      if (panelBounds) {
        pointer.move({
          x: bounds.x + panelBounds.x + panelBounds.width / 2,
          y: bounds.y + panelBounds.y + Math.min(24, panelBounds.height / 2),
        });
      }
      return;
    }
    catch {
      // Try another covered point because the animated model can move between sampling and click.
    }
  }
  throw new Error('Could not open the conversation panel from a covered avatar pixel');
}

function createNativePointer() {
  const user32 = koffi.load('user32.dll');
  const setCursorPos = user32.func('int __stdcall SetCursorPos(int x, int y)');
  const mouseEvent = user32.func(
    'void __stdcall mouse_event(uint32_t flags, uint32_t dx, uint32_t dy, uint32_t data, uintptr_t extra)',
  );
  return {
    move(point) {
      if (!setCursorPos(Math.round(point.x), Math.round(point.y))) {
        throw new Error('SetCursorPos failed');
      }
    },
    click() {
      mouseEvent(0x0002, 0, 0, 0, 0n);
      mouseEvent(0x0004, 0, 0, 0, 0n);
    },
  };
}
