import os from 'node:os';
import path from 'node:path';
import { rm, writeFile } from 'node:fs/promises';
import { _electron as electron } from 'playwright-core';
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
  const workArea = await application.evaluate(
    ({ screen }, bounds) => screen.getDisplayMatching(bounds).workArea,
    initial.state.bounds,
  );
  const expected = conversationSidebarLayout(
    initial.state.bounds,
    workArea,
    initial.state.interaction.conversationSidebar.preferredSide,
  );

  const opened = await page.evaluate(async () => {
    const layout = await window.desktopChar?.setConversationSidebarVisible(true);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return {
      layout,
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
  assertBounds(opened.state.bounds, expected.windowBounds, 'expanded window');
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
    const layout = await window.desktopChar?.setConversationSidebarVisible(false);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return {
      layout,
      state: await window.desktopChar?.getWindowState(),
      viewport: document.body.dataset.avatarViewport,
      innerWidth,
    };
  });
  if (closed.layout.visible || closed.layout.mode !== 'overlay') {
    throw new Error(`Sidebar did not close: ${JSON.stringify(closed.layout)}`);
  }
  assertBounds(closed.state.bounds, initial.state.bounds, 'restored avatar window');
  if (closed.viewport !== `0,${initial.state.bounds.width}` || closed.innerWidth !== initial.state.bounds.width) {
    throw new Error(`Avatar viewport did not restore: ${JSON.stringify(closed)}`);
  }

  console.log(
    `Conversation sidebar foreground smoke passed: preferred `
      + `${expected.preferredSide}, used ${expected.side} (${expected.mode})`,
  );
}
finally {
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
