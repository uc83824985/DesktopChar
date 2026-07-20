import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';

const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', 'apps/desktop', '--config', 'apps/desktop/vite.config.ts'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
let output = '';
server.stdout.on('data', chunk => { output += chunk; });
server.stderr.on('data', chunk => { output += chunk; });

let browser;
try {
  await waitForServer('http://127.0.0.1:4173', 15_000);
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('console', message => {
    if (message.type() === 'error' && !message.text().includes('404')) errors.push(message.text());
  });
  page.on('pageerror', error => errors.push(error.stack ?? error.message));
  await page.goto('http://127.0.0.1:4173', { waitUntil: 'networkidle' });
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
  await page.getByRole('button', { name: '模拟说话' }).click();
  await page.getByRole('button', { name: '播放动作' }).click();
  await page.getByRole('button', { name: '恢复中立' }).click();
  const canvas = await page.locator('#avatar').boundingBox();
  if (!canvas || canvas.width < 1 || canvas.height < 1) throw new Error('Avatar canvas has no visible area');
  if (errors.length) throw new Error(`Browser errors:\n${errors.join('\n')}`);
  const maximumTimingErrorMs = Math.max(
    ...toneAcceptance.metrics.player.transitionErrorsMs,
    ...toneAcceptance.metrics.model.transitionErrorsMs,
  );
  console.log(
    `Live2D smoke test passed (${canvas.width}x${canvas.height}); known-tone lip sync matched within ${maximumTimingErrorMs.toFixed(1)} ms.`,
  );
}
catch (error) {
  console.error(output);
  throw error;
}
finally {
  await browser?.close();
  server.kill();
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
