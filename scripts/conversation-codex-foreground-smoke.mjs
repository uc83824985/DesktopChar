import os from 'node:os';
import path from 'node:path';
import { rm } from 'node:fs/promises';
import { _electron as electron } from 'playwright-core';
import koffi from 'koffi';

const root = process.cwd();
const isolatedConfigPath = path.join(
  os.tmpdir(),
  `desktop-char-codex-foreground-missing-${process.pid}-${Date.now()}.json`,
);
const isolatedUserDataPath = path.join(
  os.tmpdir(),
  `desktop-char-codex-foreground-user-data-${process.pid}-${Date.now()}`,
);
const application = await electron.launch({
  args: [
    path.join(root, 'apps/desktop/electron/main.mjs'),
    `--user-data-dir=${isolatedUserDataPath}`,
  ],
  cwd: root,
  env: {
    ...process.env,
    DESKTOP_CHAR_CONFIG_PATH: isolatedConfigPath,
  },
});
const nativePointer = createNativePointer();
const originalCursorPoint = await application.evaluate(({ screen }) => screen.getCursorScreenPoint());

try {
  const page = await application.firstWindow({ timeout: 20_000 });
  const rendererErrors = [];
  page.on('console', message => {
    if (message.type() === 'error' && !message.text().includes('404')) {
      rendererErrors.push(message.text());
    }
  });
  page.on('pageerror', error => rendererErrors.push(error.stack ?? error.message));
  await page.locator(
    'body[data-ready="true"][data-desktop-shell="ready"][data-runtime-state="idle"]',
  ).waitFor({ timeout: 20_000 });

  const shellState = await page.evaluate(() => window.desktopChar?.getWindowState());
  if (!shellState || shellState.agentRoles.char.provider !== 'codex-managed'
    || shellState.agentRoles.char.maxConcurrency !== 2
    || shellState.agentRoles.char.persona.name !== 'DesktopChar') {
    throw new Error(`Unexpected Char role config: ${JSON.stringify(shellState?.agentRoles)}`);
  }

  const panel = page.locator('.scene-interaction-panel');
  let coveredPoint;
  for (const local of [
    { x: 230, y: 350 },
    { x: 230, y: 270 },
    { x: 230, y: 450 },
  ]) {
    const absolute = {
      x: shellState.bounds.x + local.x,
      y: shellState.bounds.y + local.y,
    };
    nativePointer.move(absolute);
    await page.waitForTimeout(250);
    if (await page.locator('body').getAttribute('data-pixel-selection') === 'covered') {
      coveredPoint = absolute;
      break;
    }
  }
  if (!coveredPoint) throw new Error('Could not locate a covered avatar pixel');
  await page.waitForFunction(async () => {
    const state = await window.desktopChar?.getWindowState();
    return state?.pointerPresentation?.passthrough === false;
  }, undefined, { timeout: 2_000 });
  nativePointer.move(coveredPoint);
  nativePointer.click();
  await page.waitForTimeout(50);
  try {
    await panel.waitFor({ state: 'visible', timeout: 3_000 });
  }
  catch (error) {
    const diagnostics = await page.evaluate(async () => ({
      dragState: document.body.dataset.dragState,
      lastAvatarClick: document.body.dataset.lastAvatarClick,
      interactionPanel: document.body.dataset.interactionPanel,
      pixelSelection: document.body.dataset.pixelSelection,
      pointer: (await window.desktopChar?.getWindowState())?.pointerPresentation,
    }));
    throw new Error(`Native avatar click did not open the panel: ${JSON.stringify(diagnostics)}`, {
      cause: error,
    });
  }

  const prompt = `前台 Codex 连通测试 ${Date.now()}：请用一句简短中文确认收到。`;
  const input = page.locator('.conversation-panel__form textarea');
  await input.fill(prompt);
  await input.press('Control+Enter');
  await page.locator('body[data-conversation-turns="1"]').waitFor({ timeout: 3_000 });
  await page.waitForFunction(async expectedInput => {
    const state = await window.desktopChar?.getConversationAgentState();
    return state?.activities.some(activity =>
      activity.input === expectedInput
      && activity.providerAgentId === 'codex-app-server'
      && activity.state === 'completed'
      && Boolean(activity.reply?.trim()));
  }, prompt, { timeout: 180_000 });
  await page.locator(
    '.conversation-panel__transcript [data-role="assistant"] span',
  ).waitFor({ timeout: 30_000 });

  const result = await page.evaluate(async expectedInput => {
    const state = await window.desktopChar?.getConversationAgentState();
    const activity = state?.activities.find(item => item.input === expectedInput);
    return {
      activity,
      assistantText: document.querySelector(
        '.conversation-panel__transcript [data-role="assistant"] span',
      )?.textContent ?? '',
      taskText: document.querySelector('.conversation-panel__task')?.textContent ?? '',
    };
  }, prompt);
  if (!result.activity || result.activity.state !== 'completed'
    || result.assistantText !== result.activity.reply
    || !result.taskText.includes('char-worker-1')
    || !result.taskText.includes('reply:sealed')) {
    throw new Error(`Foreground conversation did not complete through Codex: ${JSON.stringify(result)}`);
  }
  if (rendererErrors.length) {
    throw new Error(`Foreground conversation renderer errors:\n${rendererErrors.join('\n')}`);
  }
  console.log(
    `Foreground Codex conversation smoke passed (${result.activity.providerAgentId}): ${result.assistantText}`,
  );
}
finally {
  nativePointer.move(originalCursorPoint);
  try {
    await application.close();
  }
  finally {
    await rm(isolatedUserDataPath, { recursive: true, force: true });
  }
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
