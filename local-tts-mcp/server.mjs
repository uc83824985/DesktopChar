import { pathToFileURL } from 'node:url';
import { createLocalTtsMcpService } from './service.mjs';

export { createLocalTtsMcpService } from './service.mjs';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const service = createLocalTtsMcpService({
    host: process.env.DESKTOP_CHAR_TTS_LOCAL_MCP_HOST ?? '127.0.0.1',
    port: environmentPort(process.env.DESKTOP_CHAR_TTS_LOCAL_MCP_PORT, 8766),
    delayMs: environmentNumber(process.env.DESKTOP_CHAR_TTS_LOCAL_DELAY_MS, 15, true),
    durationPerCharacterMs: environmentNumber(process.env.DESKTOP_CHAR_TTS_LOCAL_CHAR_MS, 90),
    minimumDurationMs: environmentNumber(process.env.DESKTOP_CHAR_TTS_LOCAL_MIN_MS, 500),
    amplitudeIntervalMs: environmentNumber(process.env.DESKTOP_CHAR_TTS_LOCAL_AMPLITUDE_MS, 50),
    sampleRateHz: environmentNumber(process.env.DESKTOP_CHAR_TTS_SAMPLE_RATE_HZ, 24_000),
    channels: environmentNumber(process.env.DESKTOP_CHAR_TTS_CHANNELS, 1),
  });
  const address = await service.listen();
  console.log(`[local-tts-mcp] MCP endpoint ${address.mcpUrl}`);
  console.log(`[local-tts-mcp] PCM endpoint ${address.baseUrl}/audio/{stream-token}`);
  const shutdown = async () => {
    await service.close();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

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
