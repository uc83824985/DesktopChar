import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { createLocalTtsMcpService } from '../local-tts-mcp/service.mjs';

const ttsService = createLocalTtsMcpService({ port: 0, delayMs: 0, chunkDelayMs: 1 });
const ttsAddress = await ttsService.listen();
const server = spawn(process.execPath, [
  'node_modules/vite/bin/vite.js',
  'preview',
  'apps/desktop',
  '--config',
  'apps/desktop/vite.config.ts',
], {
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
  const page = await browser.newPage({ viewport: { width: 1_280, height: 800 } });
  const errors = [];
  page.on('console', message => {
    if (message.type() === 'error' && !message.text().includes('404')) errors.push(message.text());
  });
  page.on('pageerror', error => errors.push(error.stack ?? error.message));
  await page.goto(
    `http://127.0.0.1:4173/?ttsMcpUrl=${encodeURIComponent(ttsAddress.mcpUrl)}`,
    { waitUntil: 'networkidle' },
  );
  await page.locator('body[data-ready="true"][data-runtime-state="idle"]').waitFor({ timeout: 20_000 });

  const panel = page.locator('.scene-interaction-panel');
  for (const point of [
    { x: 870, y: 400 },
    { x: 870, y: 300 },
    { x: 820, y: 500 },
  ]) {
    await page.mouse.click(point.x, point.y);
    if (await panel.count()) break;
  }
  await panel.waitFor({ state: 'visible', timeout: 2_000 });
  const tabs = await page.locator('.scene-interaction-panel__tab').allTextContents();
  if (JSON.stringify(tabs) !== JSON.stringify(['角色对话', '资源调试'])) {
    throw new Error(`Unexpected interaction categories: ${JSON.stringify(tabs)}`);
  }
  if (await panel.getAttribute('data-view') !== 'conversation') {
    throw new Error('Conversation view must be selected by default');
  }
  const technicalLog = page.locator('.conversation-panel__agent-audit');
  const technicalLogSummary = technicalLog.locator('summary');
  await technicalLogSummary.click({ position: { x: 7, y: 12 } });
  if (await technicalLog.getAttribute('open') === null) {
    throw new Error('Technical log disclosure arrow did not expand the log');
  }
  await technicalLogSummary.click({ position: { x: 110, y: 12 } });
  if (await technicalLog.getAttribute('open') !== null) {
    throw new Error('Technical log disclosure body did not collapse the log');
  }

  const input = page.locator('.conversation-panel__form textarea');
  await input.fill('第一条前台并行测试');
  await input.press('Enter');
  await input.type('第二行');
  const turnsAfterEnter = Number(
    await page.locator('body').getAttribute('data-conversation-turns') ?? '0',
  );
  if (await input.inputValue() !== '第一条前台并行测试\n第二行'
    || turnsAfterEnter !== 0) {
    throw new Error('Enter must insert a newline without submitting the conversation');
  }
  await input.press('Control+Enter');
  await input.fill('第二条前台并行测试');
  await input.press('Control+Enter');
  await page.locator('body[data-conversation-turns="2"]').waitFor({ timeout: 2_000 });
  await page.waitForFunction(() => {
    const tasks = [...document.querySelectorAll('.conversation-panel__task')];
    return tasks[0]?.textContent?.includes('reply:running')
      && tasks[1]?.textContent?.includes('reply:sealed')
      && tasks[1]?.textContent?.includes('speech:ready')
      && tasks[1]?.textContent?.includes('play:waiting');
  }, undefined, { timeout: 2_000 });
  const transcript = page.locator('.conversation-panel__transcript');
  const transcriptCanScroll = await transcript.evaluate(element => element.scrollHeight > element.clientHeight);
  if (!transcriptCanScroll) throw new Error('Conversation transcript must be scrollable for scroll retention validation');
  await transcript.evaluate(element => { element.scrollTop = 0; });
  await page.locator('body[data-conversation-pending="0"]').waitFor({ timeout: 30_000 });
  if (await transcript.evaluate(element => element.scrollTop) > 12) {
    throw new Error('Conversation transcript forced the user back to the bottom');
  }

  const conversation = await page.evaluate(() => ({
    users: [...document.querySelectorAll('.conversation-panel__transcript [data-role="user"] span')]
      .map(node => node.textContent),
    userRoutes: [...document.querySelectorAll('.conversation-panel__transcript [data-role="user"] b')]
      .map(node => node.textContent),
    assistants: [...document.querySelectorAll('.conversation-panel__transcript [data-role="assistant"] span')]
      .map(node => node.textContent),
    tasks: [...document.querySelectorAll('.conversation-panel__task')].map(node => node.textContent),
    taskQueueIsInClosedLog: (() => {
      const queue = document.querySelector('.conversation-panel__queue');
      const log = queue?.closest('details');
      return Boolean(queue && log && !log.open);
    })(),
  }));
  if (JSON.stringify(conversation.users) !== JSON.stringify([
    '第一条前台并行测试\n第二行',
    '第二条前台并行测试',
  ]) || JSON.stringify(conversation.userRoutes) !== JSON.stringify([
    '你 · Auto → Char',
    '你 · Auto → Char',
  ]) || conversation.assistants.length !== 2
    || !conversation.taskQueueIsInClosedLog
    || !conversation.tasks[0]?.includes('#1 char-worker-1')
    || !conversation.tasks[1]?.includes('#2 char-worker-2')
    || conversation.tasks.some(task => !task.includes('play:completed'))) {
    throw new Error(`Conversation UI did not finish in order: ${JSON.stringify(conversation)}`);
  }

  await page.getByRole('button', { name: '资源调试', exact: true }).click();
  await page.locator('.scene-interaction-panel[data-view="resources"]').waitFor({ timeout: 2_000 });
  const resources = await page.evaluate(() => ({
    expressions: document.querySelectorAll('.scene-interaction-panel [data-item-id^="expression-"]').length,
    motions: document.querySelectorAll('.scene-interaction-panel [data-item-id^="motion-"]').length,
  }));
  if (resources.expressions !== 9 || resources.motions !== 8) {
    throw new Error(`Resource debug menu is incomplete: ${JSON.stringify(resources)}`);
  }
  await page.getByRole('button', { name: '角色对话', exact: true }).click();
  await page.locator('.scene-interaction-panel[data-view="conversation"] textarea').waitFor({ timeout: 2_000 });
  if (errors.length) throw new Error(`Conversation UI browser errors:\n${errors.join('\n')}`);
  if (process.env.DESKTOP_CHAR_CONVERSATION_SCREENSHOT) {
    await page.screenshot({ path: process.env.DESKTOP_CHAR_CONVERSATION_SCREENSHOT });
  }
  console.log('Conversation UI smoke passed (later Turn prepared early; presentation completed 0 -> 1).');
}
catch (error) {
  console.error(output);
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
