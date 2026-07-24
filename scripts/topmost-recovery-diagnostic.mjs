import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { rm } from 'node:fs/promises';
import { _electron as electron } from 'playwright-core';
import { createNativeWindowTopmost } from '../apps/desktop/electron/native-window-topmost.mjs';

if (process.platform !== 'win32') {
  throw new Error('Native TOPMOST recovery diagnostic requires Windows');
}

const root = process.cwd();
const stamp = `${process.pid}-${Date.now()}`;
const configPath = path.join(os.tmpdir(), `desktop-char-topmost-missing-${stamp}.json`);
const userDataPath = path.join(os.tmpdir(), `desktop-char-topmost-user-data-${stamp}`);
const [agentPort, characterPort, ttsPort] = await reserveUniqueLoopbackPorts(3);
const application = await electron.launch({
  args: [
    path.join(root, 'apps/desktop/electron/main.mjs'),
    `--user-data-dir=${userDataPath}`,
  ],
  cwd: root,
  env: {
    ...process.env,
    DESKTOP_CHAR_CONFIG_PATH: configPath,
    DESKTOP_CHAR_AGENT_PORT: String(agentPort),
    DESKTOP_CHAR_CHARACTER_MCP_PORT: String(characterPort),
    DESKTOP_CHAR_TTS_LOCAL_MCP_PORT: String(ttsPort),
  },
});
const topmost = createNativeWindowTopmost();

try {
  const page = await application.firstWindow({ timeout: 20_000 });
  await page.locator('body[data-ready="true"][data-desktop-shell="ready"]').waitFor({
    timeout: 20_000,
  });
  const before = await page.evaluate(() => window.desktopChar?.getWindowState());
  const windowHandle = BigInt(await application.evaluate(({ BrowserWindow }) => {
    const buffer = BrowserWindow.getAllWindows()[0]?.getNativeWindowHandle();
    if (!buffer) return '0';
    return (buffer.length >= 8
      ? buffer.readBigUInt64LE(0)
      : BigInt(buffer.readUInt32LE(0))).toString();
  }));
  const nativeBefore = topmost.inspect(windowHandle);
  if (!before?.visible || before.nativeWindow?.topmost !== true || nativeBefore.topmost !== true) {
    throw new Error(`Avatar did not start in a native topmost state: ${JSON.stringify({
      before,
      nativeBefore,
    })}`);
  }

  const removed = topmost.set(windowHandle, false);
  if (removed.topmost !== false) {
    throw new Error(`Could not simulate external TOPMOST loss: ${JSON.stringify(removed)}`);
  }
  await waitForTopmost(topmost, windowHandle, true);

  const after = await page.evaluate(() => window.desktopChar?.getWindowState());
  if (!after?.visible
    || after.visibilityIntent !== true
    || after.nativeWindow?.topmost !== true
    || after.presentation.phase !== 'visible'
    || after.presentation.opacity !== 1
    || after.presentation.requestId !== before.presentation.requestId) {
    throw new Error(`TOPMOST recovery changed presentation state: ${JSON.stringify({
      before,
      removed,
      after,
    })}`);
  }
  console.log(JSON.stringify({
    passed: true,
    backend: after.nativeWindow.backend,
    before: nativeBefore,
    removed,
    after: topmost.inspect(windowHandle),
    presentationRequestId: after.presentation.requestId,
  }, null, 2));
}
finally {
  await application.close().catch(() => {});
  await Promise.all([
    rm(configPath, { force: true }),
    rm(userDataPath, { recursive: true, force: true }),
  ]);
}

async function waitForTopmost(bridge, windowHandle, expected) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (bridge.inspect(windowHandle).topmost === expected) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Native TOPMOST did not recover to ${expected}`);
}

async function reserveLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Could not reserve a loopback port');
  }
  const { port } = address;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function reserveUniqueLoopbackPorts(count) {
  const ports = new Set();
  while (ports.size < count) ports.add(await reserveLoopbackPort());
  return [...ports];
}
