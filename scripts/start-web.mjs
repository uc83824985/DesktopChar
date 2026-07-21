import path from 'node:path';
import { createServer, preview } from 'vite';
import { createLocalTtsMcpService } from '../local-tts-mcp/service.mjs';

const previewMode = process.argv.includes('--preview');
const open = !process.argv.includes('--no-open');
const port = environmentPort(process.env.DESKTOP_CHAR_TTS_LOCAL_MCP_PORT, 8766);
const service = createLocalTtsMcpService({
  host: '127.0.0.1',
  port,
  delayMs: environmentNumber(process.env.DESKTOP_CHAR_TTS_LOCAL_DELAY_MS, 15, true),
  durationPerCharacterMs: environmentNumber(process.env.DESKTOP_CHAR_TTS_LOCAL_CHAR_MS, 90),
  minimumDurationMs: environmentNumber(process.env.DESKTOP_CHAR_TTS_LOCAL_MIN_MS, 500),
  amplitudeIntervalMs: environmentNumber(process.env.DESKTOP_CHAR_TTS_LOCAL_AMPLITUDE_MS, 50),
  sampleRateHz: environmentNumber(process.env.DESKTOP_CHAR_TTS_SAMPLE_RATE_HZ, 24_000),
  channels: environmentNumber(process.env.DESKTOP_CHAR_TTS_CHANNELS, 1),
});
const address = await service.listen();
const configFile = path.resolve('apps/desktop/vite.config.ts');
const root = path.resolve('apps/desktop');
const ttsQuery = `?ttsMcpUrl=${encodeURIComponent(address.mcpUrl)}`;
const web = previewMode
  ? await preview({ root, configFile, preview: { open: open ? `/${ttsQuery}` : false } })
  : await createServer({ root, configFile, server: { open: open ? `/${ttsQuery}` : false } });
if (!previewMode) await web.listen();
web.printUrls();
console.log(`[local-tts-mcp] ${address.mcpUrl}`);
if (!open && port !== 8766) console.log(`[desktop-char] open the web UI with ${ttsQuery}`);

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await web.close();
  await service.close();
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

function environmentNumber(value, fallback, allowZero = false) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || (allowZero ? parsed < 0 : parsed <= 0)) {
    throw new TypeError(`value must be ${allowZero ? 'non-negative' : 'positive'}`);
  }
  return parsed;
}
