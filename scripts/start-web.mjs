import path from 'node:path';
import { createServer, preview } from 'vite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startManagedProcess } from '../apps/desktop/electron/managed-process.mjs';
import { parseTtsStatusResult, validateTtsMcpTools } from '../tts-mcp-profile/contract.mjs';

const previewMode = process.argv.includes('--preview');
const open = !process.argv.includes('--no-open');
const port = environmentPort(process.env.DESKTOP_CHAR_TTS_LOCAL_MCP_PORT, 8766);
const rootDirectory = process.cwd();
const mcpUrl = `http://127.0.0.1:${port}/mcp`;
const ttsProcess = await startManagedProcess({
  executable: process.execPath,
  args: [path.join(rootDirectory, 'local-tts-mcp/server.mjs')],
  cwd: rootDirectory,
  env: {
    ...process.env,
    DESKTOP_CHAR_TTS_LOCAL_MCP_HOST: '127.0.0.1',
    DESKTOP_CHAR_TTS_LOCAL_MCP_PORT: String(port),
  },
});
const ttsConnection = await connectTtsProvider(mcpUrl, ttsProcess, 10_000);
const configFile = path.resolve('apps/desktop/vite.config.ts');
const root = path.resolve('apps/desktop');
const ttsQueryParameters = new URLSearchParams({ ttsMcpUrl: mcpUrl });
const testFixtures = ttsConnection.status.capabilities?.test_fixtures;
if (Array.isArray(testFixtures) && testFixtures.length) ttsQueryParameters.set('ttsTestFixtures', testFixtures.join(','));
const ttsQuery = `?${ttsQueryParameters}`;
const web = previewMode
  ? await preview({ root, configFile, preview: { open: open ? `/${ttsQuery}` : false } })
  : await createServer({ root, configFile, server: { open: open ? `/${ttsQuery}` : false } });
if (!previewMode) await web.listen();
web.printUrls();
console.log(`[local-tts-mcp] ${mcpUrl}`);
if (!open && port !== 8766) console.log(`[desktop-char] open the web UI with ${ttsQuery}`);

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await web.close();
  await ttsConnection.client.close().catch(() => {});
  await ttsProcess.close(5_000);
}
process.once('SIGINT', () => void close().finally(() => process.exit(0)));
process.once('SIGTERM', () => void close().finally(() => process.exit(0)));

function environmentPort(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new TypeError('DESKTOP_CHAR_TTS_LOCAL_MCP_PORT must be an integer from 0 to 65535');
  }
  return parsed;
}

async function connectTtsProvider(url, process, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (process.exitInfo) throw new Error(`local-tts-mcp exited before readiness: ${process.exitInfo.stderrTail || process.exitInfo.stdoutTail}`);
    const client = new Client({ name: 'desktop-char-web-supervisor', version: '0.1.0' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(url)));
      const tools = await client.listTools();
      validateTtsMcpTools(tools.tools);
      const status = parseTtsStatusResult(await client.callTool({ name: 'tts_status', arguments: {} }));
      return { client, status };
    }
    catch (error) {
      lastError = error;
      await client.close().catch(() => {});
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  await process.close(2_000);
  throw new Error(`local-tts-mcp did not become ready: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}
