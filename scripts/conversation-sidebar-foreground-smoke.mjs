import os from 'node:os';
import path from 'node:path';
import { rm, writeFile } from 'node:fs/promises';
import { _electron as electron } from 'playwright-core';
import koffi from 'koffi';
import { conversationSidebarLayout } from '../apps/desktop/electron/window-policy.mjs';

const root = process.cwd();
const isolatedUserDataPath = path.join(
  os.tmpdir(),
  `desktop-char-sidebar-user-data-${process.pid}-${Date.now()}`,
);
const isolatedConfigPath = path.join(
  os.tmpdir(),
  `desktop-char-sidebar-config-${process.pid}-${Date.now()}.json`,
);
let application;
let nativePointer;
let originalCursorPoint;

try {
  await writeFile(isolatedConfigPath, JSON.stringify({
    agentHttp: { enabled: false },
    ttsMcp: { autoStart: false },
    characterMcp: { autoStart: false },
  }), 'utf8');
  application = await electron.launch({
    args: [
      `--user-data-dir=${isolatedUserDataPath}`,
      path.join(root, 'apps/desktop/electron/main.mjs'),
    ],
    cwd: root,
    env: {
      ...process.env,
      DESKTOP_CHAR_CONFIG_PATH: isolatedConfigPath,
    },
  });
  const page = await application.firstWindow({ timeout: 20_000 });
  await page.locator(
    'body[data-ready="true"][data-desktop-shell="ready"][data-runtime-state="idle"]',
  ).waitFor({ timeout: 20_000 });

  const initial = await page.evaluate(async () => ({
    state: await window.desktopChar?.getWindowState(),
    modelScale: document.body.dataset.modelScale,
  }));
  if (!initial.state) throw new Error('Desktop shell state is unavailable');
  const initialAvatarBounds = {
    x: initial.state.bounds.x + initial.state.conversationSidebar.avatarViewport.x,
    y: initial.state.bounds.y,
    width: initial.state.conversationSidebar.avatarViewport.width,
    height: initial.state.bounds.height,
  };
  const workArea = await application.evaluate(
    ({ screen }, bounds) => screen.getDisplayMatching(bounds).workArea,
    initialAvatarBounds,
  );
  const expected = conversationSidebarLayout(
    initialAvatarBounds,
    workArea,
    initial.state.interaction.conversationSidebar.preferredSide,
  );

  const opened = await page.evaluate(async () => {
    const frameSamples = [];
    let sampling = true;
    const sampleFrame = () => {
      frameSamples.push({
        screenX,
        innerWidth,
        modelPositionX: Number(document.body.dataset.modelPositionX),
        globalModelX: screenX + Number(document.body.dataset.modelPositionX),
      });
      if (sampling) requestAnimationFrame(sampleFrame);
    };
    requestAnimationFrame(sampleFrame);
    await new Promise(resolve => requestAnimationFrame(() => resolve()));
    const layout = await window.desktopChar?.setConversationSidebarVisible(true);
    await new Promise(resolve => {
      let frames = 0;
      const wait = () => {
        if (++frames >= 8) {
          resolve();
          return;
        }
        requestAnimationFrame(wait);
      };
      requestAnimationFrame(wait);
    });
    sampling = false;
    return {
      layout,
      frameSamples,
      state: await window.desktopChar?.getWindowState(),
      body: {
        mode: document.body.dataset.conversationSidebarMode,
        side: document.body.dataset.conversationSidebarSide,
        viewport: document.body.dataset.avatarViewport,
        modelScale: document.body.dataset.modelScale,
        modelPositionX: document.body.dataset.modelPositionX,
      },
      innerWidth,
    };
  });
  assertLayout(opened.layout, expected);
  assertBounds(opened.state.bounds, initial.state.bounds, 'stable allocated window');
  if (
    opened.body.mode !== expected.mode
    || opened.body.side !== expected.side
    || opened.body.viewport !== `${expected.avatarViewport.x},${expected.avatarViewport.width}`
    || opened.innerWidth !== expected.windowBounds.width
  ) {
    throw new Error(`Renderer did not adopt the sidebar viewport: ${JSON.stringify(opened)}`);
  }
  if (opened.body.modelScale !== initial.modelScale) {
    throw new Error(
      `Sidebar changed avatar scale ${initial.modelScale} -> ${opened.body.modelScale}`,
    );
  }
  const expectedModelX = expected.avatarViewport.x + expected.avatarViewport.width / 2;
  if (Number(opened.body.modelPositionX) !== expectedModelX) {
    throw new Error(
      `Model left its avatar lane: expected x=${expectedModelX}, got ${opened.body.modelPositionX}`,
    );
  }
  assertStableGlobalModelPosition(opened.frameSamples, 'opening');
  const panelCss = await page.evaluate(() => {
    const panel = document.createElement('section');
    panel.className = 'scene-interaction-panel';
    const content = document.createElement('div');
    content.style.height = '300px';
    panel.append(content);
    document.body.append(panel);
    const visibleAnimationName = getComputedStyle(panel).animationName;
    document.body.dataset.conversationSidebarPending = 'true';
    const pendingStyle = getComputedStyle(panel);
    const pending = {
      visibility: pendingStyle.visibility,
      opacity: pendingStyle.opacity,
      animationName: pendingStyle.animationName,
      transitionDuration: pendingStyle.transitionDuration,
    };
    document.body.dataset.conversationSidebarPending = 'false';
    panel.style.animation = 'none';
    const bounds = panel.getBoundingClientRect();
    const result = {
      visibleAnimationName,
      pending,
      centerY: bounds.top + bounds.height / 2,
      viewportCenterY: innerHeight / 2,
    };
    panel.remove();
    return result;
  });
  if (
    panelCss.visibleAnimationName !== 'scene-interaction-panel-sidecar-in'
    || panelCss.pending.visibility !== 'hidden'
    || panelCss.pending.opacity !== '0'
    || panelCss.pending.animationName !== 'none'
    || panelCss.pending.transitionDuration !== '0s'
    || Math.abs(panelCss.centerY - panelCss.viewportCenterY) > 1
  ) {
    throw new Error(`Sidebar panel CSS is not stable and centered: ${JSON.stringify(panelCss)}`);
  }

  const closed = await page.evaluate(async () => {
    const frameSamples = [];
    let sampling = true;
    const sampleFrame = () => {
      frameSamples.push({
        screenX,
        innerWidth,
        modelPositionX: Number(document.body.dataset.modelPositionX),
        globalModelX: screenX + Number(document.body.dataset.modelPositionX),
      });
      if (sampling) requestAnimationFrame(sampleFrame);
    };
    requestAnimationFrame(sampleFrame);
    await new Promise(resolve => requestAnimationFrame(() => resolve()));
    const layout = await window.desktopChar?.setConversationSidebarVisible(false);
    await new Promise(resolve => {
      let frames = 0;
      const wait = () => {
        if (++frames >= 8) {
          resolve();
          return;
        }
        requestAnimationFrame(wait);
      };
      requestAnimationFrame(wait);
    });
    sampling = false;
    return {
      layout,
      frameSamples,
      state: await window.desktopChar?.getWindowState(),
      viewport: document.body.dataset.avatarViewport,
      innerWidth,
    };
  });
  if (closed.layout.visible || closed.layout.mode !== expected.mode) {
    throw new Error(`Sidebar did not close: ${JSON.stringify(closed.layout)}`);
  }
  assertBounds(closed.state.bounds, initial.state.bounds, 'restored avatar window');
  if (
    closed.viewport !== `${expected.avatarViewport.x},${expected.avatarViewport.width}`
    || closed.innerWidth !== initial.state.bounds.width
  ) {
    throw new Error(`Avatar viewport did not restore: ${JSON.stringify(closed)}`);
  }
  assertStableGlobalModelPosition(closed.frameSamples, 'closing');

  if (process.env.DESKTOP_CHAR_SIDEBAR_NATIVE_SMOKE === '1') {
    nativePointer = createNativePointer();
    originalCursorPoint = nativePointer.position();
    await verifyActualPanelToggle(page, closed.state, nativePointer);
  }

  console.log(
    `Conversation sidebar foreground smoke passed: preferred `
      + `${expected.preferredSide}, used ${expected.side} (${expected.mode})`,
  );
}
finally {
  if (nativePointer && originalCursorPoint) nativePointer.move(originalCursorPoint);
  await application?.close().catch(() => {});
  await rm(isolatedUserDataPath, { recursive: true, force: true });
  await rm(isolatedConfigPath, { force: true });
}

function assertLayout(actual, expected) {
  if (
    !actual?.visible
    || actual.mode !== expected.mode
    || actual.side !== expected.side
    || actual.extentDip !== expected.extentDip
    || actual.avatarViewport.x !== expected.avatarViewport.x
    || actual.avatarViewport.width !== expected.avatarViewport.width
  ) {
    throw new Error(
      `Unexpected sidebar layout: ${JSON.stringify({ actual, expected })}`,
    );
  }
}

function assertBounds(actual, expected, label) {
  if (
    actual.x !== expected.x
    || actual.y !== expected.y
    || actual.width !== expected.width
    || actual.height !== expected.height
  ) {
    throw new Error(`Unexpected ${label}: ${JSON.stringify({ actual, expected })}`);
  }
}

function assertStableGlobalModelPosition(samples, label) {
  const positions = samples
    .map(sample => sample.globalModelX)
    .filter(Number.isFinite);
  const drift = Math.max(...positions) - Math.min(...positions);
  if (positions.length < 2 || drift > 2) {
    throw new Error(
      `Avatar moved ${drift} DIP while ${label} the sidebar: ${JSON.stringify(samples)}`,
    );
  }
}

async function verifyActualPanelToggle(page, state, pointer) {
  let coveredPoint;
  let coveredClientPoint;
  for (const local of [
    { x: 230, y: 350 },
    { x: 230, y: 270 },
    { x: 230, y: 450 },
  ]) {
    const absolute = {
      x: state.bounds.x + state.conversationSidebar.avatarViewport.x + local.x,
      y: state.bounds.y + local.y,
    };
    pointer.move(absolute);
    await page.waitForTimeout(250);
    if (await page.locator('body').getAttribute('data-pixel-selection') === 'covered') {
      coveredPoint = absolute;
      coveredClientPoint = {
        x: state.conversationSidebar.avatarViewport.x + local.x,
        y: local.y,
      };
      break;
    }
  }
  if (!coveredPoint) throw new Error('Could not locate a covered avatar pixel for sidebar toggle');
  await page.waitForFunction(async () =>
    (await window.desktopChar?.getWindowState())?.pointerPresentation.passthrough === false);
  pointer.move(coveredPoint);
  pointer.click();

  const panel = page.locator('.scene-interaction-panel');
  await panel.waitFor({ state: 'visible', timeout: 800 }).catch(async () => {
    await page.mouse.click(coveredClientPoint.x, coveredClientPoint.y);
    await panel.waitFor({ state: 'visible', timeout: 3_000 }).catch(async error => {
      const diagnostics = await page.evaluate(async () => ({
        dragState: document.body.dataset.dragState,
        lastAvatarClick: document.body.dataset.lastAvatarClick,
        interactionPanel: document.body.dataset.interactionPanel,
        sidebarPending: document.body.dataset.conversationSidebarPending,
        pixelSelection: document.body.dataset.pixelSelection,
        pointer: (await window.desktopChar?.getWindowState())?.pointerPresentation,
      }));
      throw new Error(`Could not open actual sidebar panel: ${JSON.stringify(diagnostics)}`, {
        cause: error,
      });
    });
  });
  await page.waitForTimeout(300);
  const opened = await page.evaluate(async () => {
    const element = document.querySelector('.scene-interaction-panel');
    const bounds = element.getBoundingClientRect();
    return {
      state: await window.desktopChar?.getWindowState(),
      panelCenterY: bounds.top + bounds.height / 2,
      viewportCenterY: innerHeight / 2,
    };
  });
  assertBounds(opened.state.bounds, state.bounds, 'native toggle window');
  if (
    !opened.state.conversationSidebar.visible
    || Math.abs(opened.panelCenterY - opened.viewportCenterY) > 1
  ) {
    throw new Error(`Actual sidebar panel was not stable and centered: ${JSON.stringify(opened)}`);
  }
  const panelBounds = await panel.boundingBox();
  pointer.move({
    x: opened.state.bounds.x + panelBounds.x + panelBounds.width / 2,
    y: opened.state.bounds.y + panelBounds.y + panelBounds.height / 2,
  });
  await page.waitForTimeout(100);
  pointer.move({
    x: opened.state.bounds.x + opened.state.bounds.width - 5,
    y: opened.state.bounds.y + 5,
  });
  await panel.waitFor({ state: 'detached', timeout: 5_000 });
  const closed = await page.evaluate(() => window.desktopChar?.getWindowState());
  assertBounds(closed.bounds, state.bounds, 'native toggle retained allocation');
  if (closed.conversationSidebar.visible) {
    throw new Error(`Actual sidebar did not close: ${JSON.stringify(closed.conversationSidebar)}`);
  }
}

function createNativePointer() {
  const user32 = koffi.load('user32.dll');
  const POINT = koffi.struct('ConversationSidebarSmoke_POINT', { x: 'long', y: 'long' });
  const getCursorPos = user32.func(
    'int __stdcall GetCursorPos(_Out_ ConversationSidebarSmoke_POINT *point)',
  );
  const setCursorPos = user32.func('int __stdcall SetCursorPos(int x, int y)');
  const mouseEvent = user32.func(
    'void __stdcall mouse_event(uint32_t flags, uint32_t dx, uint32_t dy, uint32_t data, uintptr_t extraInfo)',
  );
  return {
    position() {
      const point = {};
      if (!getCursorPos(point)) throw new Error('GetCursorPos failed');
      return point;
    },
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
