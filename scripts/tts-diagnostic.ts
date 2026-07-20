import {
  JsonConsoleTtsLogger,
  McpTtsAdapter,
  MockTtsAdapter,
  VirtualMcpClient,
} from '../packages/tts-mcp-adapter/src/index.ts';

const logger = new JsonConsoleTtsLogger();
const checks: Record<string, boolean> = {};

const mock = new MockTtsAdapter({ delayMs: 0, durationPerCharacterMs: 80, minimumDurationMs: 400, amplitudeIntervalMs: 40, logger });
const mockHealth = await mock.health();
const mockAudio = await mock.prepare({ requestId: 'diagnostic-mock', text: 'DesktopChar mock TTS diagnostic', delivery: 'stream-required' });
checks.mockHealth = mockHealth.status === 'ready';
checks.mockAudio = mockAudio.delivery === 'stream' && mockAudio.sampleRateHz === 24_000 && Boolean(mockAudio.amplitude?.length);

const virtualClient = new VirtualMcpClient([{ name: 'tts_open_stream', description: 'Virtual diagnostic TTS tool', outputSchema: { type: 'object' } }], () => ({
  content: [],
  structuredContent: { stream: {
    request_id: 'diagnostic-mcp', stream_url: 'http://127.0.0.1/audio/diagnostic-mcp',
    delivery: 'stream', mime_type: 'audio/pcm', codec: 'pcm_s16le', sample_rate_hz: 24000,
    channels: 1, amplitude: [{ at_ms: 0, value: 0 }, { at_ms: 100, value: 0.8 }],
  } },
}));
const mcp = new McpTtsAdapter({ client: virtualClient, logger, timeoutMs: 1_000, supportsAmplitude: true });
const mcpHealth = await mcp.health();
const mcpAudio = await mcp.prepare({ requestId: 'diagnostic-mcp', text: 'virtual MCP diagnostic', delivery: 'stream-required', voice: 'test-voice', format: 'pcm_s16le' });
checks.virtualMcpHealth = mcpHealth.status === 'ready';
checks.virtualMcpCall = virtualClient.calls[0]?.name === 'tts_open_stream' && virtualClient.calls[0]?.args.text === 'virtual MCP diagnostic';
checks.virtualMcpAudio = mcpAudio.delivery === 'stream' && mcpAudio.uri === 'http://127.0.0.1/audio/diagnostic-mcp';

const passed = Object.values(checks).every(Boolean);
console.log(JSON.stringify({ event: 'tts.diagnostic.result', passed, checks }));
if (!passed) process.exitCode = 1;
