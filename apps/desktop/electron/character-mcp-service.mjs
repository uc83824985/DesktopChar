import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import * as z from 'zod/v4';
import { createAgentCapabilities, validatePerformancePlan } from './agent-http-server.mjs';

export const CHARACTER_MCP_TOOLS = Object.freeze([
  'desktop_char_get_state',
  'desktop_char_get_capabilities',
  'desktop_char_perform',
  'desktop_char_interrupt',
]);

export function createCharacterMcpService(options = {}) {
  const host = options.host ?? '127.0.0.1';
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new TypeError('Character MCP service may only bind to a loopback host');
  }
  const requestedPort = portNumber(options.port ?? 17_374);
  const endpointPath = mcpPath(options.path ?? '/mcp');
  const onCommand = typeof options.onCommand === 'function' ? options.onCommand : () => {};
  const ttsContext = typeof options.ttsContext === 'function' ? options.ttsContext : () => options.ttsContext;
  let currentState = structuredClone(options.initialState ?? { ready: false, snapshot: null });
  const sessions = new Map();
  const app = createMcpExpressApp({ host });
  let httpServer;
  let mcpUrl;

  app.all(endpointPath, async (request, response) => {
    try {
      const sessionId = singleHeader(request.headers['mcp-session-id']);
      let record = sessionId ? sessions.get(sessionId) : undefined;
      if (!record && !sessionId && request.method === 'POST' && isInitializeRequest(request.body)) {
        let transport;
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          enableJsonResponse: true,
          onsessioninitialized(id) { sessions.set(id, record); },
          onsessionclosed(id) { cleanupSession(id); },
        });
        const mcp = createServer();
        record = { mcp, transport };
        transport.onclose = () => {
          if (transport.sessionId) cleanupSession(transport.sessionId);
        };
        await mcp.connect(transport);
      }
      if (!record) {
        return jsonRpcError(response, sessionId ? 404 : 400, sessionId
          ? 'Unknown or expired MCP session'
          : 'A valid MCP initialization request or session ID is required');
      }
      await record.transport.handleRequest(request, response, request.body);
    }
    catch (error) {
      if (!response.headersSent) jsonRpcError(response, 500, error instanceof Error ? error.message : String(error));
      else response.destroy(error instanceof Error ? error : undefined);
    }
  });

  function createServer() {
    const mcp = new McpServer({ name: 'desktop-char-character', version: '1.0.0' });
    mcp.registerTool('desktop_char_get_state', {
      title: 'Get DesktopChar runtime state',
      description: 'Returns the current renderer readiness and Runtime-owned avatar snapshot.',
      inputSchema: {},
    }, async () => textResult(currentState));
    mcp.registerTool('desktop_char_get_capabilities', {
      title: 'Get DesktopChar capabilities',
      description: 'Returns the current character, presentation, TTS and command capabilities.',
      inputSchema: {},
    }, async () => textResult(createAgentCapabilities(currentState, ttsContext())));
    mcp.registerTool('desktop_char_perform', {
      title: 'Submit a character performance',
      description: 'Submits one validated PerformancePlan. The character must be ready and idle.',
      inputSchema: { plan: z.record(z.string(), z.unknown()) },
      outputSchema: { accepted: z.boolean(), plan_id: z.string() },
    }, async ({ plan }) => {
      if (!currentState.ready) throw new Error('avatar-not-ready');
      if (currentState.snapshot?.state !== 'idle') throw new Error('avatar-busy');
      const validated = validatePerformancePlan(plan);
      onCommand({ type: 'performance.submit', plan: validated });
      const result = { accepted: true, plan_id: validated.id };
      return structuredResult(result);
    });
    mcp.registerTool('desktop_char_interrupt', {
      title: 'Interrupt the active character performance',
      description: 'Requests a generation-safe Runtime interrupt.',
      inputSchema: {},
      outputSchema: { accepted: z.boolean() },
    }, async () => {
      if (!currentState.ready) throw new Error('avatar-not-ready');
      onCommand({ type: 'performance.interrupt' });
      return structuredResult({ accepted: true });
    });
    return mcp;
  }

  function cleanupSession(sessionId) {
    const record = sessions.get(sessionId);
    sessions.delete(sessionId);
    if (record && !record.transport.closed) void record.mcp.close().catch(() => {});
  }

  return {
    async listen() {
      if (httpServer) throw new Error('Character MCP service is already listening');
      httpServer = await new Promise((resolve, reject) => {
        const server = app.listen(requestedPort, host);
        server.once('error', reject);
        server.once('listening', () => {
          server.off('error', reject);
          resolve(server);
        });
      });
      const address = httpServer.address();
      if (!address || typeof address === 'string') throw new Error('Character MCP service has no TCP address');
      const origin = `http://${host === '::1' ? '[::1]' : host}:${address.port}`;
      mcpUrl = `${origin}${endpointPath}`;
      return { host, port: address.port, path: endpointPath, mcpUrl };
    },
    async close() {
      await Promise.allSettled([...sessions.values()].map(record => record.mcp.close()));
      sessions.clear();
      const server = httpServer;
      httpServer = undefined;
      mcpUrl = undefined;
      if (!server) return;
      server.closeAllConnections?.();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
    updateState(state) { currentState = structuredClone(state); },
    diagnostics() { return { mcpUrl: mcpUrl ?? null, sessions: sessions.size, stateReady: currentState.ready }; },
  };
}

function structuredResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

function textResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function singleHeader(value) {
  return Array.isArray(value) ? value[0] : value;
}

function jsonRpcError(response, status, message) {
  return response.status(status).json({ jsonrpc: '2.0', error: { code: -32_000, message }, id: null });
}

function mcpPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.includes('?') || value.includes('#')) {
    throw new TypeError('Character MCP path must be an absolute URL path');
  }
  return value;
}

function portNumber(value) {
  const result = Number(value);
  if (!Number.isInteger(result) || result < 0 || result > 65_535) throw new TypeError('Character MCP port must be from 0 to 65535');
  return result;
}
