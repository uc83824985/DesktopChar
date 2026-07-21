import path from 'node:path';
import { spawn } from 'node:child_process';
import { _electron as electron } from 'playwright-core';
import koffi from 'koffi';

const root = process.cwd();
const requestedApi = process.argv[2] ?? 'native';
const application = await electron.launch({
  args: [path.join(root, 'apps/desktop/electron/main.mjs')],
  cwd: root,
  env: { ...process.env, DESKTOP_CHAR_DRAG_WINDOW_API: requestedApi },
});
let physicalMouse;
let originalCursor;
let physicalMouseDown = false;

try {
  const page = await application.firstWindow({ timeout: 20_000 });
  await page.locator('body[data-ready="true"][data-desktop-shell="ready"]').waitFor({ timeout: 20_000 });
  await page.waitForTimeout(300);
  physicalMouse = createPhysicalMouse();
  originalCursor = physicalMouse.position();
  const state = await page.evaluate(() => window.desktopChar?.getWindowState());
  if (!state) throw new Error('Desktop preload bridge is missing');
  let dragOrigin;
  const selectionAttempts = [];
  for (const yRatio of [0.3, 0.4, 0.5, 0.6, 0.7]) {
    // The diagnostic Node process is DPI-unaware, so Win32 virtualizes these
    // SetCursorPos coordinates in the same DIP space returned by Electron.
    const point = {
      x: Math.round(state.bounds.x + state.bounds.width * 0.5),
      y: Math.round(state.bounds.y + state.bounds.height * yRatio),
    };
    physicalMouse.move(point);
    await page.waitForTimeout(180);
    const selection = await page.evaluate(() => ({
      state: document.body.dataset.pixelSelection,
      alpha: document.body.dataset.pixelAlpha,
      sample: document.body.dataset.pixelSample,
    }));
    selectionAttempts.push({ yRatio, point, selection });
    if (selection.state === 'covered') {
      dragOrigin = point;
      break;
    }
  }
  if (!dragOrigin) throw new Error(`No covered drag origin found: ${JSON.stringify(selectionAttempts)}`);
  const electronProcessId = await application.evaluate(() => process.pid);
  const sampler = spawn('python', [
    path.join(root, 'scripts/drag-screen-sampler.py'),
    '1.4',
    String(electronProcessId),
  ], {
    cwd: root, windowsHide: true,
  });
  let samplerOutput = '';
  let samplerError = '';
  sampler.stdout.on('data', chunk => { samplerOutput += chunk; });
  sampler.stderr.on('data', chunk => { samplerError += chunk; });
  const samplerClosed = new Promise(resolve => sampler.once('close', resolve));

  await page.waitForTimeout(100);
  physicalMouse.leftDown();
  physicalMouseDown = true;
  await page.waitForTimeout(300);
  for (const [x, y] of [[-3, -2], [-8, -5], [-15, -10], [-24, -15], [-32, -20]]) {
    physicalMouse.move({ x: dragOrigin.x + x, y: dragOrigin.y + y });
    await page.waitForTimeout(22);
  }
  physicalMouse.leftUp();
  physicalMouseDown = false;
  await page.locator('body[data-drag-state="moved"]').waitFor({ timeout: 2_000 });
  physicalMouse.move(originalCursor);

  const exitCode = await samplerClosed;
  if (exitCode !== 0) throw new Error(`Screen sampler failed (${exitCode}): ${samplerError}`);
  const capture = JSON.parse(samplerOutput);
  const summary = summarize(capture.frames);
  console.log(JSON.stringify({ requestedApi, summary }, null, 2));
  if (summary.suspectedBlankFrames > 0) process.exitCode = 2;
}
finally {
  if (physicalMouseDown) physicalMouse?.leftUp();
  if (originalCursor) physicalMouse?.move(originalCursor);
  await application.close();
}

function summarize(frames) {
  const baseline = frames.filter(frame => frame.atMs >= 40 && frame.atMs < 280);
  const movement = frames.filter(frame => frame.atMs >= 340 && frame.atMs < 900);
  if (!baseline.length || !movement.length) throw new Error(`Insufficient composed frames: ${frames.length}`);
  const baselineChroma = median(baseline.map(frame => frame.chromaticRatio));
  const baselineDeviation = median(baseline.map(frame => frame.lumaDeviation));
  const suspected = movement.filter(frame => (
    frame.chromaticRatio < baselineChroma * 0.45
    && frame.lumaDeviation < baselineDeviation * 0.55
  ) || frame.nearBlackRatio > 0.96);
  return {
    totalFrames: frames.length,
    baselineFrames: baseline.length,
    movementFrames: movement.length,
    baselineChroma,
    baselineDeviation,
    minimumMovementChroma: Math.min(...movement.map(frame => frame.chromaticRatio)),
    minimumMovementDeviation: Math.min(...movement.map(frame => frame.lumaDeviation)),
    maximumMovementNearBlack: Math.max(...movement.map(frame => frame.nearBlackRatio)),
    suspectedBlankFrames: suspected.length,
    suspected: suspected.slice(0, 8),
  };
}

function createPhysicalMouse() {
  const user32 = koffi.load('user32.dll');
  const POINT = koffi.struct('DragDiagnostic_POINT', { x: 'long', y: 'long' });
  const getCursorPos = user32.func('int __stdcall GetCursorPos(_Out_ DragDiagnostic_POINT *point)');
  const setCursorPos = user32.func('int __stdcall SetCursorPos(int x, int y)');
  const mouseEvent = user32.func('void __stdcall mouse_event(uint32_t flags, uint32_t dx, uint32_t dy, uint32_t data, uintptr_t extraInfo)');
  return {
    position() {
      const point = {};
      if (!getCursorPos(point)) throw new Error('GetCursorPos failed');
      return point;
    },
    move(point) {
      if (!setCursorPos(point.x, point.y)) throw new Error('SetCursorPos failed');
    },
    leftDown() { mouseEvent(0x0002, 0, 0, 0, 0n); },
    leftUp() { mouseEvent(0x0004, 0, 0, 0, 0n); },
  };
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
