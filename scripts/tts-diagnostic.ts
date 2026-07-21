import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createLocalTtsMcpService } from '../local-tts-mcp/service.mjs';
import type { McpCallToolResult, McpClientPort } from '../packages/tts-mcp-adapter/src/index.ts';
import {
  JsonConsoleTtsLogger,
  McpTtsAdapter,
  VirtualMcpClient,
} from '../packages/tts-mcp-adapter/src/index.ts';

const logger = new JsonConsoleTtsLogger();
const checks: Record<string, boolean> = {};
const service = createLocalTtsMcpService({ port: 0, delayMs: 0, chunkDelayMs: 0 });
const address = await service.listen();
const sdkClient = new Client({ name: 'desktop-char-tts-diagnostic', version: '1.0.0' });
const transport = new StreamableHTTPClientTransport(new URL(address.mcpUrl));
await sdkClient.connect(transport as unknown as Parameters<Client['connect']>[0]);

try {
  const localClient: McpClientPort = {
    async listTools(options) {
      const result = await sdkClient.listTools(undefined, {
        ...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
        ...(options?.signal ? { signal: options.signal } : {}),
      });
      return result.tools.map(tool => ({
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        inputSchema: tool.inputSchema,
        ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
      }));
    },
    async callTool(name, args, options) {
      return await sdkClient.callTool(
        { name, arguments: args }, undefined,
        { timeout: options.timeoutMs, ...(options.signal ? { signal: options.signal } : {}) },
      ) as McpCallToolResult;
    },
  };
  const local = new McpTtsAdapter({
    client: localClient,
    providerName: 'desktop-char-local-tts',
    supportsAmplitude: false,
    supportsTextCues: true,
    logger,
  });
  const localHealth = await local.health();
  const localAudio = await local.prepare({
    requestId: 'diagnostic-local', text: 'DesktopChar local MCP TTS diagnostic',
    delivery: 'stream-required', format: 'pcm_s16le',
  });
  checks.localMcpHealth = localHealth.status === 'ready';
  checks.localMcpContract = localAudio.delivery === 'stream'
    && localAudio.uri.startsWith(address.baseUrl)
    && localAudio.sampleRateHz === 24_000
    && localAudio.durationMs !== undefined
    && localAudio.textCues?.map(cue => cue.text).join('') === 'DesktopChar local MCP TTS diagnostic'
    && localAudio.amplitude === undefined;
  checks.localMcpPcm = localAudio.delivery === 'stream'
    && (await fetch(localAudio.uri).then(response => response.arrayBuffer())).byteLength > 0;

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
  const mcpAudio = await mcp.prepare({ requestId: 'diagnostic-mcp', text: 'virtual MCP diagnostic', delivery: 'stream-required', voice: 'jrpg-blip', format: 'pcm_s16le' });
  checks.virtualMcpHealth = mcpHealth.status === 'ready';
  checks.virtualMcpCall = virtualClient.calls[0]?.name === 'tts_open_stream' && virtualClient.calls[0]?.args.text === 'virtual MCP diagnostic';
  checks.virtualMcpAudio = mcpAudio.delivery === 'stream' && mcpAudio.uri === 'http://127.0.0.1/audio/diagnostic-mcp';
}
finally {
  await sdkClient.close();
  await service.close();
}

const passed = Object.values(checks).every(Boolean);
console.log(JSON.stringify({ event: 'tts.diagnostic.result', passed, checks }));
if (!passed) process.exitCode = 1;
