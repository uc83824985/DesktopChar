import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { createLocalTtsMcpService } from '../local-tts-mcp/service.mjs';

const ttsService = createLocalTtsMcpService({ port: 0, delayMs: 0, chunkDelayMs: 1 });
const ttsAddress = await ttsService.listen();

const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', 'apps/desktop', '--config', 'apps/desktop/vite.config.ts'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
let output = '';
const errors = [];
server.stdout.on('data', chunk => { output += chunk; });
server.stderr.on('data', chunk => { output += chunk; });

let browser;
try {
  await waitForServer('http://127.0.0.1:4173', 15_000);
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('console', message => {
    if (message.type() === 'error' && !message.text().includes('404')) errors.push(message.text());
  });
  page.on('pageerror', error => errors.push(error.stack ?? error.message));
  await page.goto(
    `http://127.0.0.1:4173/?ttsMcpUrl=${encodeURIComponent(ttsAddress.mcpUrl)}&ttsTestFixtures=known-tone-v1`,
    { waitUntil: 'networkidle' },
  );
  await page.locator(
    'body[data-ready="true"]'
      + '[data-live2d-update-pipeline="ordered-v1"]'
      + '[data-asset-preview-isolation="unlocked"]'
      + '[data-asset-preview-breath="active"]',
  ).waitFor({ timeout: 20_000 });
  await page.locator('body[data-gaze-head-response-ms="120"][data-gaze-eye-response-ms="45"]').waitFor({ timeout: 1_000 });
  await page.locator('body[data-tts-health="ready"]').waitFor({ timeout: 5_000 });
  await page.getByRole('button', { name: '口型同步验收' }).click();
  await page.waitForFunction(() => ['passed', 'failed'].includes(document.body.dataset.toneAcceptance ?? ''), undefined, { timeout: 8_000 });
  const toneAcceptance = await page.locator('body').evaluate(body => ({
    status: body.dataset.toneAcceptance,
    metrics: JSON.parse(body.dataset.toneAcceptanceMetrics ?? '{}'),
  }));
  if (toneAcceptance.status !== 'passed') {
    throw new Error(`Known-tone lip-sync acceptance failed: ${JSON.stringify(toneAcceptance.metrics)}`);
  }
  const traceDisplay = await page.locator('#tone-debug').evaluate(panel => ({
    hidden: panel.hidden,
    playback: panel.querySelector('#tone-playback-point')?.textContent,
    model: panel.querySelector('#tone-model-point')?.textContent,
    frame: panel.querySelector('#tone-frame-point')?.textContent,
    logEntries: panel.querySelectorAll('#tone-sync-log li').length,
  }));
  if (traceDisplay.hidden || traceDisplay.logEntries < 5 || !traceDisplay.model?.includes('ParamA')) {
    throw new Error(`Known-tone on-screen trace is incomplete: ${JSON.stringify(traceDisplay)}`);
  }
  await page.locator('body[data-runtime-state="idle"]').waitFor({ timeout: 3_000 });
  await page.locator('body[data-gaze-follow="enabled"]').waitFor({ timeout: 1_000 });

  await page.getByRole('button', { name: '本地语音测试' }).click();
  await page.locator('body[data-runtime-state="speaking"]').waitFor({ timeout: 2_000 });
  await page.locator('body[data-live2d-expression="exp_02"]').waitFor({ timeout: 2_000 });
  await page.locator('body[data-runtime-state="idle"]').waitFor({ timeout: 3_000 });
  await page.locator('body[data-live2d-expression="exp_01"]').waitFor({ timeout: 1_000 });

  // The dynamic character catalog restores its authored neutral expression.
  // Repeating the same bound emotion must still be accepted.
  await page.getByRole('button', { name: '本地语音测试' }).click();
  await page.locator('body[data-runtime-state="speaking"]').waitFor({ timeout: 2_000 });
  await page.locator('body[data-live2d-expression="exp_02"]').waitFor({ timeout: 2_000 });
  await page.locator('body[data-runtime-state="idle"]').waitFor({ timeout: 3_000 });
  await page.locator('body[data-live2d-expression="exp_01"]').waitFor({ timeout: 1_000 });

  await page.getByRole('button', { name: '播放动作' }).click();
  await page.locator('body[data-motion-state="playing"]').waitFor({ timeout: 3_000 });
  await page.locator('body[data-gaze-follow="enabled"]').waitFor({ timeout: 1_000 });
  await page.locator('body[data-motion-state="completed"]').waitFor({ timeout: 3_000 });
  await page.locator('body[data-runtime-state="idle"]').waitFor({ timeout: 12_000 });

  await page.getByRole('button', { name: '眼部跟随：开' }).click();
  await page.locator('body[data-gaze-follow="disabled"]').waitFor({ timeout: 1_000 });
  await page.mouse.move(1_100, 120);
  await page.locator('body[data-gaze-follow="disabled"]').waitFor({ timeout: 1_000 });
  await page.getByRole('button', { name: '眼部跟随：关' }).click();
  await page.locator('body[data-gaze-follow="enabled"]').waitFor({ timeout: 1_000 });

  await page.getByRole('button', { name: '恢复中立' }).click();
  const interactionPanel = page.locator('.scene-interaction-panel');
  for (const point of [
    { x: 870, y: 400 },
    { x: 870, y: 300 },
    { x: 820, y: 500 },
  ]) {
    await page.mouse.click(point.x, point.y);
    if (await interactionPanel.count()) break;
  }
  await interactionPanel.waitFor({ state: 'visible', timeout: 2_000 });
  const previewCatalog = await page.locator('body').evaluate(body => ({
    expressionResources: Number(body.dataset.assetPreviewExpressions),
    motionResources: Number(body.dataset.assetPreviewMotions),
    expressionButtons: document.querySelectorAll(
      '.scene-interaction-panel [data-item-id^="expression-"]',
    ).length,
    motionButtons: document.querySelectorAll(
      '.scene-interaction-panel [data-item-id^="motion-"]',
    ).length,
  }));
  if (previewCatalog.expressionResources !== 8
    || previewCatalog.motionResources !== 8
    || previewCatalog.expressionButtons !== 9
    || previewCatalog.motionButtons !== 8) {
    throw new Error(`Interaction panel resource catalog is incomplete: ${JSON.stringify(previewCatalog)}`);
  }
  await interactionPanel.hover();
  await page.waitForTimeout(3_200);
  const hoveredPanelPhase = await page.locator('body').getAttribute('data-interaction-panel');
  if (!await interactionPanel.isVisible() || hoveredPanelPhase !== 'visible') {
    throw new Error(`Interaction panel disappeared while the pointer remained inside (${hoveredPanelPhase})`);
  }
  const isolationToggle = page.locator('[data-item-id="asset-preview-isolation"]');
  await isolationToggle.click();
  await page.locator(
    'body[data-asset-preview-isolation="locked"]'
      + '[data-asset-preview-breath="suppressed"]'
      + '[data-gaze-follow="disabled"]'
      + '[data-motion-state="debug-suppressed"]',
  ).waitFor({ timeout: 2_000 });
  if (await isolationToggle.getAttribute('aria-pressed') !== 'true') {
    throw new Error('Asset preview baseline lock did not refresh its checked state');
  }
  await page.getByRole('button', { name: '播放动作' }).evaluate(button => button.click());
  await page.locator('body[data-runtime-state="speaking"]').waitFor({ timeout: 2_000 });
  await page.locator(
    'body[data-runtime-state="idle"]'
      + '[data-asset-preview-isolation="locked"]'
      + '[data-live2d-expression="debug-neutral"]'
      + '[data-motion-state="debug-suppressed"]',
  ).waitFor({ timeout: 12_000 });
  await page.locator('[data-item-id="expression-exp_02"]').click({ timeout: 2_000 });
  await page.locator(
    'body[data-asset-preview-kind="expression"]'
      + '[data-asset-preview-resource="exp_02"]'
      + '[data-asset-preview-state="applied"]',
  ).waitFor({ timeout: 2_000 });
  if (!await interactionPanel.isVisible()) {
    throw new Error('Expression preview dismissed the interaction panel');
  }
  await page.locator('[data-item-id="motion-TapBody-0"]').click();
  await page.locator(
    'body[data-asset-preview-kind="motion"]'
      + '[data-asset-preview-resource="TapBody:0"]'
      + '[data-asset-preview-state="playing"]',
  ).waitFor({ timeout: 2_000 });
  if (!await interactionPanel.isVisible()) {
    throw new Error('Motion preview dismissed the interaction panel');
  }
  await page.locator(
    'body[data-asset-preview-isolation="locked"][data-asset-preview-state="completed"]',
  ).waitFor({ timeout: 12_000 });
  await isolationToggle.click();
  await page.locator(
    'body[data-asset-preview-isolation="unlocked"]'
      + '[data-asset-preview-breath="active"]'
      + '[data-gaze-follow="enabled"]',
  ).waitFor({ timeout: 2_000 });
  if (process.env.DESKTOP_CHAR_INTERACTION_PANEL_SCREENSHOT) {
    await page.screenshot({ path: process.env.DESKTOP_CHAR_INTERACTION_PANEL_SCREENSHOT });
  }
  await page.mouse.move(10, 10);
  await page.waitForTimeout(2_200);
  await interactionPanel.hover();
  await page.waitForTimeout(1_200);
  if (!await interactionPanel.isVisible()) {
    throw new Error('Re-entering the interaction panel did not refresh its leave timeout');
  }
  await page.mouse.move(10, 10);
  await interactionPanel.waitFor({ state: 'detached', timeout: 4_000 });
  if (await page.locator('body').getAttribute('data-interaction-panel') !== 'hidden') {
    throw new Error('Interaction panel did not finish its delayed fade-out');
  }

  const canvas = await page.locator('#avatar').boundingBox();
  if (!canvas || canvas.width < 1 || canvas.height < 1) throw new Error('Avatar canvas has no visible area');
  if (errors.length) throw new Error(`Browser errors:\n${errors.join('\n')}`);
  const maximumTimingErrorMs = Math.max(
    ...toneAcceptance.metrics.player.transitionErrorsMs,
    ...toneAcceptance.metrics.model.transitionErrorsMs,
  );
  const modelResponseMs = toneAcceptance.metrics.response.maximumModelResponseMs;
  const frameResponseMs = toneAcceptance.metrics.response.maximumFrameResponseMs;
  console.log(
    `Live2D smoke test passed (${canvas.width}x${canvas.height}); timeline ${maximumTimingErrorMs.toFixed(1)} ms, model response ${modelResponseMs.toFixed(2)} ms, rendered frame ${frameResponseMs.toFixed(2)} ms.`,
  );
}
catch (error) {
  console.error(output);
  if (errors.length) console.error(`Browser errors before failure:\n${errors.join('\n')}`);
  throw error;
}
finally {
  await browser?.close();
  server.kill();
  await ttsService.close();
}

async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    }
    catch {}
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`Preview server did not start within ${timeoutMs} ms`);
}
