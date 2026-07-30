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
const registeredSessionId = `external:${sessionId}`;
const commands = [];
let taskManagerAvailable = true;
const runtime = {
  getSnapshot() {
    return { phase: 'ready', lastPollAtMs: Date.now(), lastError: null };
  },
  listSessions() {
    if (!taskManagerAvailable) throw new Error('simulated Task Manager connection interruption');
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
  await writeFile(configPath, JSON.stringify(smokeConfig(markerPath, {
    providerName: 'router-failing',
    provider: {
      adapter: 'openai-compatible',
      baseUrl: `${address.baseUrl}/v1`,
      model: 'router-smoke',
      apiKeyEnv: 'DESKTOP_CHAR_ROUTER_SMOKE_KEY',
      requestTimeoutMs: 2_000,
    },
  }), null, 2), 'utf8');

  application = await electron.launch({
    args: [
      `--user-data-dir=${userDataPath}`,
      path.join(root, 'apps/desktop/electron/main.mjs'),
    ],
    cwd: root,
    env: {
      ...process.env,
      DESKTOP_CHAR_CONFIG_PATH: configPath,
      DESKTOP_CHAR_TASK_MANAGER_MARKER: markerPath,
      DESKTOP_CHAR_TASK_MANAGER_ENABLED: '1',
      DESKTOP_CHAR_ROUTER_SMOKE_KEY: 'foreground-smoke-only',
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
      + '[data-task-manager-phase="ready"][data-conversation-external-candidates="1"]'
      + '[data-routing-candidates="0"]',
  ).waitFor({ timeout: 20_000 });

  const shellState = await page.evaluate(() => window.desktopChar?.getWindowState());
  if (!shellState) throw new Error('Desktop shell state is unavailable');
  const sidebarState = await openConversationPanel(page, shellState, nativePointer);
  if (
    sidebarState.conversationSidebar.mode === 'sidecar'
    && (
      sidebarState.bounds.x !== shellState.bounds.x
      || sidebarState.bounds.width !== shellState.bounds.width
      || sidebarState.conversationSidebar.avatarViewport.width
        !== shellState.conversationSidebar.avatarViewport.width
    )
  ) {
    throw new Error(`Conversation sidebar geometry drifted: ${JSON.stringify(sidebarState)}`);
  }
  await page.locator('button[data-action="bind-external"]').click();
  await page.locator('.conversation-panel__bind-controls select').selectOption(sessionId);
  await page.locator('.conversation-panel__bind-controls button:not([data-action])').click();
  await page.locator(
    `body[data-routing-selection="session:${registeredSessionId}"]`
      + '[data-routing-candidates="1"][data-conversation-sessions="1"]',
  ).waitFor({ timeout: 5_000 });
  const sessionActionCursors = await page.evaluate(() => ({
    bind: getComputedStyle(document.querySelector('button[data-action="bind-external"]')).cursor,
    close: getComputedStyle(document.querySelector('button[data-action="close-session"]')).cursor,
  }));
  if (sessionActionCursors.bind !== 'default' || sessionActionCursors.close !== 'pointer') {
    throw new Error(`Unexpected session action cursors: ${JSON.stringify(sessionActionCursors)}`);
  }
  const selector = page.getByLabel('消息目标');
  await selector.selectOption(`session:${registeredSessionId}`);
  await page.locator(`body[data-routing-selection="session:${registeredSessionId}"]`).waitFor();
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

  taskManagerAvailable = false;
  await page.locator('body[data-task-manager-phase="reconnecting"]').waitFor({ timeout: 5_000 });
  await page.waitForFunction(async registeredId => {
    const state = await window.desktopChar?.getConversationSessionsState();
    const status = document.querySelector('.conversation-panel__route-status')?.textContent ?? '';
    const session = state?.sessions.find(item => item.sessionId === registeredId);
    return document.body.dataset.routingSelection === `session:${registeredId}`
      && session?.status === 'unavailable'
      && session.lastError === 'Task Manager connection was interrupted'
      && status.includes('连接中断')
      && status.includes('绑定已保留');
  }, registeredSessionId, { timeout: 5_000 });
  const interruptedText = '连接中断期间不应发送';
  await input.fill(interruptedText);
  await input.press('Control+Enter');
  await page.locator('body[data-routing-phase="error"]').waitFor({ timeout: 5_000 });
  if (commands.length !== 2 || await input.inputValue() !== interruptedText) {
    throw new Error('Interrupted external binding accepted a command or cleared its input');
  }

  taskManagerAvailable = true;
  await page.locator('body[data-task-manager-phase="ready"]').waitFor({ timeout: 5_000 });
  await page.waitForFunction(async registeredId => {
    const state = await window.desktopChar?.getConversationSessionsState();
    const status = document.querySelector('.conversation-panel__route-status')?.textContent ?? '';
    const session = state?.sessions.find(item => item.sessionId === registeredId);
    return document.body.dataset.routingSelection === `session:${registeredId}`
      && session?.status === 'waiting-input'
      && session.lastError === null
      && status.includes('已恢复')
      && status.includes('继续发送');
  }, registeredSessionId, { timeout: 5_000 });

  await selector.selectOption('auto');
  const autoText = '这条 Auto 消息不能静默回退';
  await input.fill(autoText);
  await input.press('Control+Enter');
  await page.locator('body[data-routing-selection="auto"][data-routing-phase="error"]')
    .waitFor({ timeout: 5_000 });
  if (commands.length !== 2 || await input.inputValue() !== autoText) {
    throw new Error('Router failure changed target, cleared input, or produced a session side effect');
  }

  await writeFile(configPath, JSON.stringify(smokeConfig(markerPath), null, 2), 'utf8');
  await page.evaluate(() => window.desktopChar?.reloadDesktopConfig());
  await page.waitForFunction(async () => {
    const state = await window.desktopChar?.getWindowState();
    return state?.agentRoles.router.provider === 'router-codex-managed'
      && state?.routerAgent.adapter === 'codex-app-server';
  }, undefined, { timeout: 10_000 });
  const managedAutoText = '请把这条补充说明立即发给候选列表中唯一的任务会话，不要发给角色。';
  await input.fill(managedAutoText);
  await input.press('Control+Enter');
  await page.waitForFunction(() => {
    return ['sent', 'error', 'no-match', 'confirm'].includes(
      document.body.dataset.routingPhase ?? '',
    );
  }, undefined, { timeout: 180_000 });
  const managedAutoDiagnostics = await page.evaluate(async () => ({
    phase: document.body.dataset.routingPhase,
    selection: document.body.dataset.routingSelection,
    status: document.querySelector('.conversation-panel__route-status')?.textContent ?? '',
    input: document.querySelector('.conversation-panel__form textarea')?.value ?? '',
    router: await window.desktopChar?.getRouterAgentState(),
  }));
  if (
    managedAutoDiagnostics.phase !== 'sent'
    || managedAutoDiagnostics.router?.lastDecisionSource !== 'provider'
  ) {
    throw new Error(
      `Managed Router Codex did not produce a sent route: ${JSON.stringify({
        managedAutoDiagnostics,
        commands,
        rendererErrors,
      })}`,
    );
  }
  await page.waitForFunction(() => {
    const status = document.querySelector('.conversation-panel__route-status')?.textContent ?? '';
    return document.body.dataset.routingPhase === 'sent'
      && document.querySelector('.conversation-panel__form textarea')?.value === ''
      && status.includes('路由隔离会话');
  }, undefined, { timeout: 5_000 });
  if (
    commands.length !== 3
    || commands[2].sessionId !== sessionId
    || commands[2].text !== managedAutoText
    || commands[2].mode !== 'submit'
  ) {
    throw new Error(`Managed Router Codex did not submit the unique session: ${JSON.stringify(commands)}`);
  }
  const routerState = await page.evaluate(() => window.desktopChar?.getRouterAgentState());
  if (
    routerState?.adapter !== 'codex-app-server'
    || routerState.phase !== 'ready'
    || !routerState.lastDecisionAt
    || routerState.lastError
  ) {
    throw new Error(`Managed Router state is invalid: ${JSON.stringify(routerState)}`);
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

  if (commands.length !== 3) {
    throw new Error(`Char routing unexpectedly submitted a Task Manager command: ${commands.length}`);
  }

  await page.locator('button[data-action="create-managed"]').click();
  await page.locator('body[data-conversation-sessions="2"]').waitFor({ timeout: 20_000 });
  await page.waitForFunction(() =>
    document.body.dataset.routingSelection?.startsWith('session:managed:'),
  );
  const managedSnapshot = await page.evaluate(async () => {
    const state = await window.desktopChar?.getConversationSessionsState();
    return {
      state,
      selection: document.body.dataset.routingSelection,
      routeStatus: document.querySelector('.conversation-panel__route-status')?.textContent,
    };
  });
  const managedSession = managedSnapshot.state?.sessions.find(
    session => session.ownership === 'managed',
  );
  if (!managedSession?.threadId || managedSession.status !== 'waiting-input') {
    throw new Error(`Managed conversation was not created: ${JSON.stringify(managedSnapshot)}`);
  }
  const browserWindowCount = await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().length);
  if (browserWindowCount !== 1) {
    throw new Error(`Managed conversation created an unexpected Electron window: ${browserWindowCount}`);
  }
  if (!await input.isVisible().catch(() => false)) {
    const currentShellState = await page.evaluate(() => window.desktopChar?.getWindowState());
    if (!currentShellState) throw new Error('Desktop shell state was lost before Managed routing');
    await openConversationPanel(page, currentShellState, nativePointer);
  }
  const managedText = `Managed 回复通知链路测试 ${Date.now()}：请只回复“收到”。`;
  await input.fill(managedText);
  await input.press('Control+Enter');
  await page.waitForFunction(managedSessionId => {
    return document.body.dataset.routingPhase === 'sent'
      && document.body.dataset.routingLastTarget === `task-session:${managedSessionId}`;
  }, managedSession.sessionId, { timeout: 10_000 });
  await page.waitForFunction(() => {
    return document.body.dataset.taskNotificationEvent?.startsWith('managed:managed-event-')
      && document.body.dataset.taskNotification === 'completed';
  }, undefined, { timeout: 180_000 });
  const completedManaged = await page.evaluate(async managedSessionId => {
    const state = await window.desktopChar?.getConversationSessionsState();
    return state?.sessions.find(session => session.sessionId === managedSessionId);
  }, managedSession.sessionId);
  if (
    completedManaged?.status !== 'waiting-input'
    || !completedManaged.lastResponse?.trim()
  ) {
    throw new Error(
      `Managed completion did not return through the Char presentation chain: ${
        JSON.stringify(completedManaged)
      }`,
    );
  }
  const managedTranscript = await page.evaluate(expectedText => ({
    users: [...document.querySelectorAll('.conversation-panel__transcript [data-role="user"]')]
      .map(node => node.textContent ?? ''),
    assistants: [...document.querySelectorAll('.conversation-panel__transcript [data-role="assistant"]')]
      .map(node => node.textContent ?? ''),
    visibleTaskManager: [...document.querySelectorAll('.conversation-panel__transcript')]
      .some(node => node.textContent?.includes('Task Manager')),
    routedMessageVisible: [...document.querySelectorAll('.conversation-panel__transcript [data-role="user"]')]
      .some(node => node.textContent?.includes(expectedText) && node.textContent?.includes('Managed')),
  }), managedText);
  if (
    managedTranscript.visibleTaskManager
    || !managedTranscript.routedMessageVisible
    || !managedTranscript.assistants.some(text => text.includes('Managed'))
  ) {
    throw new Error(`Managed transcript leaked internals or lost routing context: ${
      JSON.stringify(managedTranscript)
    }`);
  }
  const closeButton = page.locator('button[data-action="close-session"]');
  await closeButton.click();
  await page.locator('button[data-action="close-session"][data-confirming="true"]').waitFor();
  await closeButton.click();
  await page.waitForFunction(async managedSessionId => {
    const state = await window.desktopChar?.getConversationSessionsState();
    return document.body.dataset.routingSelection === 'auto'
      && !state?.sessions.some(session => session.sessionId === managedSessionId);
  }, managedSession.sessionId, { timeout: 20_000 });

  await selector.selectOption('character');
  await page.locator('body[data-routing-selection="character"]').waitFor({ timeout: 5_000 });
  await selector.selectOption(`session:${registeredSessionId}`);
  await closeButton.click();
  await page.locator('button[data-action="close-session"][data-confirming="true"]').waitFor();
  await closeButton.click();
  await page.waitForFunction(async sourceSessionId => {
    const registry = await window.desktopChar?.getConversationSessionsState();
    const manager = await window.desktopChar?.getTaskManagerState();
    return document.body.dataset.routingSelection === 'auto'
      && registry?.sessions.length === 0
      && registry.availableExternalSessions.some(
        candidate => candidate.sourceSessionId === sourceSessionId,
      )
      && manager?.sessions.some(session => session.sessionId === sourceSessionId);
  }, sessionId, { timeout: 10_000 });

  if (rendererErrors.length) {
    throw new Error(`Foreground routing renderer errors:\n${rendererErrors.join('\n')}`);
  }
  console.log(
    `Foreground routing smoke passed: bound ${registeredSessionId}, sticky routing, strict failure, managed Router + Char Codex`,
  );
}
finally {
  if (originalCursorPoint) nativePointer.move(originalCursorPoint);
  await application?.close().catch(() => {});
  await service.close().catch(() => {});
  await rm(temporaryDirectory, { recursive: true, force: true });
}

async function openConversationPanel(page, shellState, pointer) {
  const bounds = shellState.bounds;
  const avatarViewport = shellState.conversationSidebar.avatarViewport;
  for (const local of [
    { x: 230, y: 350 },
    { x: 230, y: 270 },
    { x: 230, y: 450 },
  ]) {
    const absolute = {
      x: bounds.x + avatarViewport.x + local.x,
      y: bounds.y + local.y,
    };
    pointer.move(absolute);
    await page.waitForTimeout(250);
    if (await page.locator('body').getAttribute('data-pixel-selection') !== 'covered') continue;
    pointer.click();
    try {
      const panel = page.locator('.scene-interaction-panel');
      await panel.waitFor({ state: 'visible', timeout: 3_000 });
      const sidebarState = await page.evaluate(() => window.desktopChar?.getWindowState());
      if (!sidebarState?.conversationSidebar.visible) {
        throw new Error('Conversation sidebar did not publish a visible layout');
      }
      const panelBounds = await panel.boundingBox();
      if (panelBounds) {
        pointer.move({
          x: sidebarState.bounds.x + panelBounds.x + panelBounds.width / 2,
          y: sidebarState.bounds.y + panelBounds.y + Math.min(24, panelBounds.height / 2),
        });
      }
      return sidebarState;
    }
    catch {
      // Try another covered point because the animated model can move between sampling and click.
    }
  }
  throw new Error('Could not open the conversation panel from a covered avatar pixel');
}

function smokeConfig(taskManagerMarkerPath, routerOverride) {
  const launcherScript = process.env.DESKTOP_CHAR_CODEX_LAUNCHER_SCRIPT;
  const managedProviders = launcherScript ? {
    'codex-managed': {
      adapter: 'codex-app-server',
      lifecycle: 'managed',
      launcherScript,
      requestTimeoutMs: 180_000,
    },
    'router-codex-managed': {
      adapter: 'codex-app-server',
      lifecycle: 'managed',
      launcherScript,
      requestTimeoutMs: 180_000,
    },
  } : {};
  return {
    ...(routerOverride || launcherScript ? {
      agentProviders: {
        ...managedProviders,
        ...(routerOverride ? {
          [routerOverride.providerName]: routerOverride.provider,
        } : {}),
      },
    } : {}),
    ...(routerOverride ? {
      agentRoles: {
        router: {
          provider: routerOverride.providerName,
        },
      },
    } : {}),
    agentHttp: {
      enabled: false,
      host: '127.0.0.1',
      port: 0,
    },
    taskManager: {
      enabled: true,
      lifecycle: 'external',
      markerPath: taskManagerMarkerPath,
      pollIntervalMs: 250,
      requestTimeoutMs: 2_000,
      eventPageSize: 10,
      maxEvents: 20,
    },
  };
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
