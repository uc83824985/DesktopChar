import path from 'node:path';
import { _electron as electron } from 'playwright-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const root = process.cwd();
const application = await electron.launch({
  args: [path.join(root, 'apps/desktop/electron/main.mjs')],
  cwd: root,
});

try {
  const page = await application.firstWindow({ timeout: 20_000 });
  const errors = [];
  page.on('console', message => {
    if (message.type() === 'error' && !message.text().includes('404')) errors.push(message.text());
  });
  page.on('pageerror', error => errors.push(error.stack ?? error.message));
  await page.locator('body[data-ready="true"][data-shell="floating"]').waitFor({ timeout: 20_000 });
  await page.locator('body[data-desktop-shell="ready"]').waitFor({ timeout: 2_000 });
  await page.locator('body[data-gaze-follow="enabled"]').waitFor({ timeout: 2_000 });
  await page.locator('body[data-pixel-selection]').waitFor({ timeout: 2_000 });
  await page.locator('body[data-drag-hold-delay-ms="180"]').waitFor({ timeout: 2_000 });
  await page.locator('body[data-drag-window-api][data-webgl-context-losses="0"]').waitFor({ timeout: 2_000 });
  await page.locator('body[data-tts-mcp-service="ready"][data-character-mcp-service="ready"]').waitFor({ timeout: 10_000 });

  const initial = await page.evaluate(() => window.desktopChar?.getWindowState());
  if (!initial || !initial.alwaysOnTop || !initial.visible || !initial.tray?.available
    || initial.bounds.width > 500 || initial.bounds.height > 740) {
    throw new Error(`Unexpected floating window state: ${JSON.stringify(initial)}`);
  }
  if (initial.presentation?.phase !== 'visible' || initial.presentation.opacity !== 1
    || initial.presentation.backgroundThrottling !== false) {
    throw new Error(`Avatar must be revealed only after an unthrottled presentation frame: ${JSON.stringify(initial.presentation)}`);
  }
  if (!initial.tray.iconScaleFactors.includes(1.5)) {
    throw new Error(`Tray icon must expose a native 24px representation at 150% DPI: ${JSON.stringify(initial.tray)}`);
  }
  if (!initial.mousePassthrough) throw new Error('Floating window must start in desktop passthrough mode');
  if (initial.tts?.mode !== 'local' || !/^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(initial.tts?.mcpUrl ?? '')) {
    throw new Error(`Desktop local TTS must use a real loopback MCP endpoint: ${JSON.stringify(initial.tts)}`);
  }
  if (initial.mcpServices?.tts?.phase !== 'ready' || initial.mcpServices?.character?.phase !== 'ready'
    || !/^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(initial.mcpServices.character.endpoint ?? '')) {
    throw new Error(`Both MCP services must auto-start with testable endpoints: ${JSON.stringify(initial.mcpServices)}`);
  }
  if (initial.interaction?.dragHoldDelayMs !== 180
    || !['native-set-window-pos', 'setBounds'].includes(initial.interaction?.dragWindowApi)) {
    throw new Error(`Unexpected drag interaction config: ${JSON.stringify(initial.interaction)}`);
  }

  const bubbleBeforePlayback = await page.evaluate(() => {
    document.querySelector('#speak')?.click();
    const paragraph = document.querySelector('#speech-bubble p');
    return {
      mode: document.body.dataset.speechBubble,
      text: document.querySelector('#speech-bubble')?.textContent?.trim(),
      structuralTextNodes: paragraph
        ? [...paragraph.childNodes].filter(node => node.nodeType === Node.TEXT_NODE && node.textContent).length
        : -1,
    };
  });
  if (bubbleBeforePlayback.mode !== 'hidden') {
    throw new Error(`Speech bubble must wait for playback.started: ${JSON.stringify(bubbleBeforePlayback)}`);
  }
  if (bubbleBeforePlayback.structuralTextNodes !== 0) {
    throw new Error(`Chat bubble template must not preserve source indentation as visible text: ${JSON.stringify(bubbleBeforePlayback)}`);
  }
  await page.locator('body[data-runtime-state="speaking"][data-speech-bubble="complete"]').waitFor({ timeout: 2_000 });
  const bubble = await page.evaluate(() => ({
    mode: document.body.dataset.speechBubble,
    text: document.querySelector('#speech-bubble')?.textContent?.trim(),
  }));
  if (bubble.mode !== 'complete' || bubble.text !== '运行时演示') {
    throw new Error(`Speech bubble presenter did not render Runtime text: ${JSON.stringify(bubble)}`);
  }
  await page.locator('body[data-runtime-state="idle"][data-speech-bubble="complete"]').waitFor({ timeout: 2_000 });
  await page.locator('body[data-speech-bubble="hidden"]').waitFor({ timeout: 1_500 });

  await page.locator('#avatar').focus();
  const keyboardMenuOpened = await page.evaluate(() => {
    const canvas = document.querySelector('#avatar');
    canvas?.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true }));
    return document.body.dataset.contextMenu;
  });
  if (keyboardMenuOpened !== 'open') throw new Error(`Keyboard context menu did not open: ${keyboardMenuOpened}`);
  await page.locator('body[data-context-menu="open"] .scene-context-menu[data-target-id="avatar"]').waitFor({ timeout: 2_000 });
  const menu = await page.evaluate(() => ({
    headings: [...document.querySelectorAll('.scene-context-menu__heading')].map(node => node.textContent),
    gazeChecked: document.querySelector('[data-item-id="gaze-follow"]')?.getAttribute('aria-checked'),
    bubbleItems: [...document.querySelectorAll('[data-item-id="complete"], [data-item-id="stream"], [data-item-id="karaoke"]')].map(node => node.textContent?.trim()),
    mcpItems: [...document.querySelectorAll('[data-item-id="character-mcp-enabled"], [data-item-id="tts-mcp-enabled"], [data-item-id="mcp-connection-test"]')].map(node => node.getAttribute('data-item-id')),
    configReload: document.querySelector('[data-item-id="desktop-config-reload"]')?.textContent?.trim(),
    hideAvatar: document.querySelector('[data-item-id="hide-avatar"]')?.textContent?.trim(),
  }));
  if (menu.gazeChecked !== 'true' || menu.bubbleItems.length !== 3
    || JSON.stringify(menu.mcpItems) !== JSON.stringify([
      'character-mcp-enabled', 'tts-mcp-enabled', 'mcp-connection-test',
    ])
    || menu.configReload !== '重新加载配置'
    || menu.hideAvatar !== '隐藏角色'
    || !menu.headings.includes('角色设置') || !menu.headings.includes('聊天气泡测试')
    || !menu.headings.includes('MCP 服务')
    || !menu.headings.some(label => label?.startsWith('应用配置 · r'))
    || !menu.headings.includes('桌面窗口')) {
    throw new Error(`Immediate context-menu registrations are incomplete: ${JSON.stringify(menu)}`);
  }
  await page.waitForTimeout(120);
  const stableMenuOrigin = await contextMenuOrigin(page);
  await page.locator('[data-item-id="character-mcp-enabled"]').click();
  await page.locator('body[data-context-menu="open"][data-character-mcp-service="disabled"] [data-item-id="character-mcp-enabled"][aria-checked="false"]').waitFor({ timeout: 5_000 });
  assertContextMenuOrigin(await contextMenuOrigin(page), stableMenuOrigin, 'disabling character-access MCP');
  await page.locator('[data-item-id="character-mcp-enabled"]').click();
  await page.locator('body[data-context-menu="open"][data-character-mcp-service="ready"] [data-item-id="character-mcp-enabled"][aria-checked="true"]').waitFor({ timeout: 5_000 });
  assertContextMenuOrigin(await contextMenuOrigin(page), stableMenuOrigin, 'enabling character-access MCP');
  await page.locator('[data-item-id="tts-mcp-enabled"]').click();
  await page.locator('body[data-context-menu="open"][data-tts-mcp-service="disabled"] [data-item-id="tts-mcp-enabled"][aria-checked="false"]').waitFor({ timeout: 5_000 });
  assertContextMenuOrigin(await contextMenuOrigin(page), stableMenuOrigin, 'disabling speech-synthesis MCP');
  const fallbackText = '中文回退';
  const fallbackClient = new Client({ name: 'desktop-char-text-fallback-smoke', version: '1.0.0' });
  await fallbackClient.connect(new StreamableHTTPClientTransport(new URL(initial.mcpServices.character.endpoint)));
  try {
    const suffix = Date.now();
    const performed = await fallbackClient.callTool({
      name: 'desktop_char_perform',
      arguments: { plan: {
        id: `text-fallback-${suffix}`,
        segments: [{
          id: `text-fallback-segment-${suffix}`,
          sequence: 0,
          displayText: fallbackText,
          speechText: fallbackText,
          bubble: { mode: 'karaoke' },
        }],
      } },
    });
    if (performed.structuredContent?.accepted !== true) {
      throw new Error(`Character MCP rejected the text fallback plan: ${JSON.stringify(performed)}`);
    }
  }
  finally {
    await fallbackClient.close();
  }
  await page.locator('body[data-runtime-state="presenting"][data-speech-bubble="complete"]').waitFor({ timeout: 2_000 });
  const fallbackBubbleText = await page.locator('#speech-bubble').textContent();
  if (fallbackBubbleText?.trim() !== fallbackText) {
    throw new Error(`Character MCP UTF-8 text fallback was corrupted: ${JSON.stringify(fallbackBubbleText)}`);
  }
  await page.locator('body[data-runtime-state="idle"][data-speech-bubble="hidden"]').waitFor({ timeout: 4_000 });
  assertContextMenuOrigin(await contextMenuOrigin(page), stableMenuOrigin, 'presenting the TTS text fallback');
  await page.locator('[data-item-id="tts-mcp-enabled"]').click();
  await page.locator('body[data-context-menu="open"][data-tts-mcp-service="ready"] [data-item-id="tts-mcp-enabled"][aria-checked="true"]').waitFor({ timeout: 5_000 });
  assertContextMenuOrigin(await contextMenuOrigin(page), stableMenuOrigin, 'enabling speech-synthesis MCP');
  await page.locator('[data-item-id="desktop-config-reload"]').click();
  await page.locator('body[data-context-menu="closed"][data-speech-bubble="complete"]').waitFor({ timeout: 5_000 });
  const reloadBubble = await page.locator('#speech-bubble').textContent();
  if (!reloadBubble?.includes('配置重新加载完成')
    || !/r\d+（无变化）/.test(reloadBubble)
    || !reloadBubble.includes('角色接入 MCP：已连接')
    || !reloadBubble.includes('语音合成 MCP：已连接')
    || !reloadBubble.includes('角色接入 MCP：已连接。\n语音合成 MCP：已连接')) {
    throw new Error(`Config reload result did not use the character chat bubble: ${reloadBubble}`);
  }
  await page.evaluate(() => document.querySelector('#avatar')?.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true }),
  ));
  await page.locator('body[data-context-menu="open"] [data-item-id="mcp-connection-test"]').waitFor({ timeout: 2_000 });
  await page.locator('[data-item-id="mcp-connection-test"]').click();
  await page.locator('body[data-context-menu="closed"][data-tts-mcp-test="passed"][data-character-mcp-test="passed"][data-speech-bubble="complete"]').waitFor({ timeout: 5_000 });
  const mcpTestBubble = await page.locator('#speech-bubble').textContent();
  if (!mcpTestBubble?.includes('角色接入 MCP：通过')
    || !mcpTestBubble.includes('语音合成 MCP：通过')
    || !/角色接入 MCP：通过（\d+ ms）。\n语音合成 MCP：通过/.test(mcpTestBubble)) {
    throw new Error(`Combined MCP result did not use the character chat bubble: ${mcpTestBubble}`);
  }
  await page.evaluate(() => document.querySelector('#avatar')?.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true }),
  ));
  await page.locator('body[data-context-menu="open"] [data-item-id="gaze-follow"]').waitFor({ timeout: 2_000 });
  await page.locator('[data-item-id="gaze-follow"]').click();
  await page.locator('body[data-context-menu="open"][data-gaze-follow="disabled"] [data-item-id="gaze-follow"][aria-checked="false"]').waitFor({ timeout: 2_000 });
  await page.locator('[data-item-id="gaze-follow"]').click();
  await page.locator('body[data-context-menu="open"][data-gaze-follow="enabled"] [data-item-id="gaze-follow"][aria-checked="true"]').waitFor({ timeout: 2_000 });
  await page.locator('[data-item-id="stream"]').click();
  await page.locator('body[data-context-menu="closed"][data-speech-bubble="stream"]').waitFor({ timeout: 2_000 });
  const streamDecoration = await page.evaluate(() => getComputedStyle(
    document.querySelector('#speech-bubble p'),
    '::after',
  ).content);
  if (!['none', 'normal'].includes(streamDecoration)) {
    throw new Error(`Stream bubble must not render a synthetic input caret: ${streamDecoration}`);
  }
  await page.waitForTimeout(180);
  const earlyStreamText = await page.locator('#speech-bubble-leading').textContent();
  const earlyStreamLayout = await chatBubbleLayout(page);
  await page.waitForTimeout(320);
  const laterStreamText = await page.locator('#speech-bubble-leading').textContent();
  const laterStreamLayout = await chatBubbleLayout(page);
  if (!earlyStreamText || !laterStreamText || laterStreamText.length <= earlyStreamText.length) {
    throw new Error(`Stream bubble did not advance with playback: ${JSON.stringify({ earlyStreamText, laterStreamText })}`);
  }
  if (earlyStreamLayout.textAlign !== 'left'
    || earlyStreamLayout.contentHeight < earlyStreamLayout.lineHeight * 1.5
    || !sameRect(earlyStreamLayout.rect, laterStreamLayout.rect)) {
    throw new Error(`Chat bubble must wrap with a stable left edge and keep its full-text layout while streaming: ${JSON.stringify({ earlyStreamLayout, laterStreamLayout })}`);
  }
  if (process.env.DESKTOP_CHAR_CHAT_BUBBLE_STREAM_SCREENSHOT) {
    await page.screenshot({ path: process.env.DESKTOP_CHAR_CHAT_BUBBLE_STREAM_SCREENSHOT });
  }
  await page.evaluate(() => document.querySelector('#avatar')?.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true }),
  ));
  await page.locator('body[data-context-menu="open"] [data-item-id="complete"][aria-disabled="true"]').waitFor({ timeout: 2_000 });
  await page.locator('body[data-runtime-state="idle"] [data-item-id="complete"][aria-disabled="false"]').waitFor({ timeout: 10_000 });
  await page.locator('[data-item-id="karaoke"]').click();
  await page.locator('body[data-speech-bubble="karaoke"] #speech-bubble-active').waitFor({ timeout: 2_000 });
  const karaokeActive = await page.locator('#speech-bubble-active').textContent();
  if (!karaokeActive) throw new Error(`Karaoke bubble did not expose its timed cue: ${karaokeActive}`);
  const karaokeText = await page.locator('#speech-bubble').textContent();
  if (!karaokeText?.includes('移动。\n完整文本')) {
    throw new Error(`Chat bubble must start a new visual line after sentence punctuation: ${JSON.stringify(karaokeText)}`);
  }
  if (process.env.DESKTOP_CHAR_CHAT_BUBBLE_SCREENSHOT) {
    await page.waitForTimeout(180);
    await page.screenshot({ path: process.env.DESKTOP_CHAR_CHAT_BUBBLE_SCREENSHOT });
  }
  await page.evaluate(() => document.querySelector('#avatar')?.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true }),
  ));
  await page.locator('body[data-context-menu="open"] [data-item-id="gaze-follow"]').click();
  await page.locator('body[data-context-menu="open"][data-gaze-follow="disabled"] [data-item-id="gaze-follow"][aria-checked="false"]').waitFor({ timeout: 2_000 });
  await page.locator('[data-item-id="gaze-follow"]').click();
  await page.locator('body[data-context-menu="open"][data-gaze-follow="enabled"] [data-item-id="gaze-follow"][aria-checked="true"]').waitFor({ timeout: 2_000 });
  await page.keyboard.press('Escape');
  await page.evaluate(() => document.querySelector('#reset')?.click());
  await page.locator('body[data-speech-bubble="hidden"]').waitFor({ timeout: 2_000 });

  const beforeVisibilityCycles = await page.evaluate(() => ({
    scale: document.body.dataset.modelScale,
    bounds: document.body.dataset.windowBounds,
    webglContextLosses: document.body.dataset.webglContextLosses,
  }));
  let previousPresentationRequestId = initial.presentation.requestId;
  for (let cycle = 1; cycle <= 4; cycle += 1) {
    await page.evaluate(() => window.desktopChar?.runWindowCommand('hide-avatar'));
    await waitForMainWindowVisibility(application, false);
    const hidden = await page.evaluate(() => window.desktopChar?.getWindowState());
    if (hidden?.visible !== false || hidden?.tray?.available !== true
      || hidden?.presentation?.phase !== 'hidden' || hidden.presentation.opacity !== 0) {
      throw new Error(`Tray-backed hide state is invalid in cycle ${cycle}: ${JSON.stringify(hidden)}`);
    }
    await page.evaluate(() => window.desktopChar?.runWindowCommand('show-avatar'));
    await waitForMainWindowVisibility(application, true);
    await waitForPresentationPhase(page, 'visible');
    const restored = await page.evaluate(async () => ({
      state: await window.desktopChar?.getWindowState(),
      scale: document.body.dataset.modelScale,
      bounds: document.body.dataset.windowBounds,
      webglContextLosses: document.body.dataset.webglContextLosses,
    }));
    if (restored.state?.presentation?.opacity !== 1
      || restored.state.presentation.requestId <= previousPresentationRequestId
      || restored.scale !== beforeVisibilityCycles.scale
      || restored.bounds !== beforeVisibilityCycles.bounds
      || restored.webglContextLosses !== beforeVisibilityCycles.webglContextLosses) {
      throw new Error(`Tray restore cycle ${cycle} changed renderer geometry or revealed an invalid frame: ${JSON.stringify({ beforeVisibilityCycles, restored })}`);
    }
    previousPresentationRequestId = restored.state.presentation.requestId;
  }

  await page.evaluate(async () => {
    const api = window.desktopChar;
    if (!api) throw new Error('Desktop preload bridge is missing');
    const state = await api.getWindowState();
    const start = { x: state.bounds.x + state.bounds.width / 2, y: state.bounds.y + state.bounds.height / 2 };
    await api.beginDrag(start);
    api.setPointerPresentation({ passthrough: false, cursor: 'move' });
    api.dragTo({ x: start.x - 36, y: start.y - 28 });
    await new Promise(resolve => setTimeout(resolve, 120));
    await api.endDrag();
    api.setPointerPresentation({ passthrough: true, cursor: 'default' });
    await new Promise(resolve => setTimeout(resolve, 20));
  });

  const moved = await page.evaluate(async () => {
    const body = document.body;
    const modelScaleBeforeResize = body.dataset.modelScale;
    window.dispatchEvent(new Event('resize'));
    const modelScaleAfterResize = body.dataset.modelScale;
    return {
      state: await window.desktopChar?.getWindowState(),
      reportedBounds: body.dataset.windowBounds,
      panelDisplay: getComputedStyle(document.querySelector('.panel')).display,
      rootBackground: getComputedStyle(document.documentElement).backgroundColor,
      bodyBackground: getComputedStyle(body).backgroundColor,
      background: getComputedStyle(document.querySelector('main')).backgroundColor,
      pixelReadback: body.dataset.pixelReadback,
      pixelSelection: body.dataset.pixelSelection,
      modelScaleBeforeResize,
      modelScaleAfterResize,
      cursorIntent: body.dataset.cursorIntent,
      computedCursor: body.dataset.computedCursor,
    };
  });
  const movedState = moved.state;
  if (!movedState || movedState.bounds.x !== initial.bounds.x - 36 || movedState.bounds.y !== initial.bounds.y - 28) {
    throw new Error(`Avatar bounds did not follow drag: ${JSON.stringify({ initial, movedState })}`);
  }
  if (moved.reportedBounds !== `${movedState.bounds.x},${movedState.bounds.y},${movedState.bounds.width},${movedState.bounds.height}`) {
    throw new Error(`Renderer bounds are not synchronized: ${JSON.stringify(moved)}`);
  }
  if (moved.panelDisplay !== 'none'
    || moved.rootBackground !== 'rgba(0, 0, 0, 0)'
    || moved.bodyBackground !== 'rgba(0, 0, 0, 0)'
    || moved.background !== 'rgba(0, 0, 0, 0)') {
    throw new Error(`Floating renderer is not transparent: ${JSON.stringify(moved)}`);
  }
  if (!['async-pbo', 'sync-readpixels'].includes(moved.pixelReadback)) {
    throw new Error(`Pixel coverage adapter is not active: ${JSON.stringify(moved)}`);
  }
  if (!['outside', 'pending', 'covered', 'transparent'].includes(moved.pixelSelection)) {
    throw new Error(`Pixel coverage state is not updating: ${JSON.stringify(moved)}`);
  }
  if (!moved.modelScaleBeforeResize || moved.modelScaleBeforeResize !== moved.modelScaleAfterResize) {
    throw new Error(`Avatar scale is not stable across resize: ${JSON.stringify(moved)}`);
  }
  if (moved.cursorIntent !== 'default' || moved.computedCursor !== 'default'
    || movedState.pointerPresentation?.cursor !== 'default') {
    throw new Error(`Pointer presentation is not synchronized: ${JSON.stringify(moved)}`);
  }
  if (errors.length) throw new Error(`Desktop renderer errors:\n${errors.join('\n')}`);
  console.log(`Electron floating smoke passed (${movedState.bounds.width}x${movedState.bounds.height} at ${movedState.bounds.x},${movedState.bounds.y}; pixel readback ${moved.pixelReadback}).`);
}
finally {
  await application.close();
}

async function waitForMainWindowVisibility(application, expected) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const visible = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible());
    if (visible === expected) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Avatar window did not become ${expected ? 'visible' : 'hidden'}`);
}

async function waitForPresentationPhase(page, expected) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => window.desktopChar?.getWindowState());
    if (state?.presentation?.phase === expected) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Avatar presentation did not become ${expected}`);
}

async function chatBubbleLayout(page) {
  return page.evaluate(() => {
    const bubble = document.querySelector('#speech-bubble');
    const paragraph = bubble?.querySelector('p');
    if (!(bubble instanceof HTMLElement) || !(paragraph instanceof HTMLElement)) {
      throw new Error('Chat bubble DOM is missing');
    }
    const style = getComputedStyle(paragraph);
    const rect = bubble.getBoundingClientRect();
    return {
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      contentHeight: paragraph.getBoundingClientRect().height,
      lineHeight: Number.parseFloat(style.lineHeight),
      textAlign: style.textAlign,
    };
  });
}

async function contextMenuOrigin(page) {
  return page.locator('.scene-context-menu').evaluate(menu => {
    const rect = menu.getBoundingClientRect();
    return { x: rect.x, y: rect.y };
  });
}

function assertContextMenuOrigin(actual, expected, phase, epsilon = 0.5) {
  if (Math.abs(actual.x - expected.x) > epsilon || Math.abs(actual.y - expected.y) > epsilon) {
    throw new Error(`Context menu moved while ${phase}: ${JSON.stringify({ expected, actual })}`);
  }
}

function sameRect(left, right, epsilon = 0.5) {
  return ['x', 'y', 'width', 'height'].every(key => Math.abs(left[key] - right[key]) <= epsilon);
}
