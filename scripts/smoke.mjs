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
  await page.goto(`http://127.0.0.1:4173/?ttsMcpUrl=${encodeURIComponent(ttsAddress.mcpUrl)}`, { waitUntil: 'networkidle' });
  await page.locator('body[data-ready="true"]').waitFor({ timeout: 20_000 });
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
  await page.locator('body[data-runtime-state="idle"]').waitFor({ timeout: 3_000 });

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
