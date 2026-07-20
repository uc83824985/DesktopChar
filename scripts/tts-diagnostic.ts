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
const mockAudio = await mock.synthesize({ text: 'DesktopChar mock TTS diagnostic' });
checks.mockHealth = mockHealth.status === 'ready';
checks.mockAudio = mockAudio.uri.startsWith('mock://') && Boolean(mockAudio.amplitude?.length);

const virtualClient = new VirtualMcpClient([{ name: 'tts.synthesize', description: 'Virtual diagnostic TTS tool' }], call => ({
  content: [{ type: 'text', text: JSON.stringify({ uri: 'memory://virtual-mcp.wav', durationMs: 640, amplitude: [{ atMs: 0, value: 0 }, { atMs: 100, value: 0.8 }] }) }],
  structuredContent: { uri: 'memory://virtual-mcp.wav', durationMs: 640, amplitude: [{ atMs: 0, value: 0 }, { atMs: 100, value: 0.8 }] },
}));
const mcp = new McpTtsAdapter({ client: virtualClient, logger, timeoutMs: 1_000, supportsAmplitude: true });
const mcpHealth = await mcp.health();
const mcpAudio = await mcp.synthesize({ text: 'virtual MCP diagnostic', voice: 'test-voice', format: 'wav' });
checks.virtualMcpHealth = mcpHealth.status === 'ready';
checks.virtualMcpCall = virtualClient.calls[0]?.name === 'tts.synthesize' && virtualClient.calls[0]?.args.text === 'virtual MCP diagnostic';
checks.virtualMcpAudio = mcpAudio.uri === 'memory://virtual-mcp.wav' && mcpAudio.durationMs === 640;

const passed = Object.values(checks).every(Boolean);
console.log(JSON.stringify({ event: 'tts.diagnostic.result', passed, checks }));
if (!passed) process.exitCode = 1;
