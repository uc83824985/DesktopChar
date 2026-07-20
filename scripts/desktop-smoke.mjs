import path from 'node:path';
import { _electron as electron } from 'playwright-core';

const root = process.cwd();
const application = await electron.launch({
  args: [path.join(root, 'apps/desktop/electron/main.mjs')],
  cwd: root,
  env: { ...process.env, DESKTOP_CHAR_DESKTOP_SMOKE: '1' },
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

  const initial = await page.evaluate(() => window.desktopChar?.getWindowState());
  if (!initial || !initial.alwaysOnTop || initial.bounds.width > 500 || initial.bounds.height > 740) {
    throw new Error(`Unexpected floating window state: ${JSON.stringify(initial)}`);
  }
  if (!initial.mousePassthrough) throw new Error('Floating window must start in desktop passthrough mode');

  await page.evaluate(async () => {
    const api = window.desktopChar;
    if (!api) throw new Error('Desktop preload bridge is missing');
    const state = await api.getWindowState();
    const start = { x: state.bounds.x + state.bounds.width / 2, y: state.bounds.y + state.bounds.height / 2 };
    await api.beginDrag(start);
    api.dragTo({ x: start.x - 36, y: start.y - 28 });
    await new Promise(resolve => setTimeout(resolve, 120));
    await api.endDrag();
  });

  const moved = await page.evaluate(async () => {
    const body = document.body;
    const canvas = document.querySelector('#avatar');
    const modelScaleBeforeResize = body.dataset.modelScale;
    window.dispatchEvent(new Event('resize'));
    const modelScaleAfterResize = body.dataset.modelScale;
    const selectionBeforeCursorCheck = body.dataset.pixelSelection;
    body.dataset.pixelSelection = 'covered';
    const selectedCursor = getComputedStyle(canvas).cursor;
    body.dataset.pixelSelection = 'transparent';
    const transparentCursor = getComputedStyle(canvas).cursor;
    body.dataset.pixelSelection = selectionBeforeCursorCheck;
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
      selectedCursor,
      transparentCursor,
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
  if (!['async-pbo', 'sync-one-pixel'].includes(moved.pixelReadback)) {
    throw new Error(`Pixel coverage adapter is not active: ${JSON.stringify(moved)}`);
  }
  if (!['outside', 'pending', 'covered', 'transparent'].includes(moved.pixelSelection)) {
    throw new Error(`Pixel coverage state is not updating: ${JSON.stringify(moved)}`);
  }
  if (!moved.modelScaleBeforeResize || moved.modelScaleBeforeResize !== moved.modelScaleAfterResize) {
    throw new Error(`Avatar scale is not stable across resize: ${JSON.stringify(moved)}`);
  }
  if (moved.selectedCursor !== 'grab' || moved.transparentCursor !== 'default') {
    throw new Error(`Pixel selection does not change cursor feedback: ${JSON.stringify(moved)}`);
  }
  if (errors.length) throw new Error(`Desktop renderer errors:\n${errors.join('\n')}`);
  console.log(`Electron floating smoke passed (${movedState.bounds.width}x${movedState.bounds.height} at ${movedState.bounds.x},${movedState.bounds.y}; pixel readback ${moved.pixelReadback}).`);
}
finally {
  await application.close();
}
