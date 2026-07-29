import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import * as z from 'zod/v4';
import { validateCharReplyTask } from './codex-conversation-agent.mjs';

export const CHAR_AGENT_MCP_TEST_TOOL = 'char_generate_reply';

export function createCharAgentMcpTestService(options = {}) {
  if (!options.endpoint || typeof options.endpoint.execute !== 'function') {
    throw new TypeError('Char Agent MCP test service requires an endpoint');
  }
  const host = options.host ?? '127.0.0.1';
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new TypeError('Char Agent MCP test service may only bind to a loopback host');
  }
  const requestedPort = portNumber(options.port ?? 0);
  const endpointPath = mcpPath(options.path ?? '/char-agent-mcp');
  const sessions = new Map();
  const app = createMcpExpressApp({ host });
  let httpServer;

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
      if (!response.headersSent) {
        jsonRpcError(response, 500, error instanceof Error ? error.message : String(error));
      }
      else response.destroy(error instanceof Error ? error : undefined);
    }
  });

  function createServer() {
    const mcp = new McpServer({ name: 'desktop-char-char-agent-test', version: '1.0.0' });
    mcp.registerTool(CHAR_AGENT_MCP_TEST_TOOL, {
      title: 'Generate one test Char reply',
      description: 'Contract-only test adapter for CharReplyTask and CharReplyResult.',
      inputSchema: { task: z.record(z.string(), z.unknown()) },
    }, async ({ task }, extra) => {
      const validated = validateCharReplyTask(task);
      const result = await options.endpoint.execute(validated, extra.signal);
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result,
      };
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
      if (httpServer) throw new Error('Char Agent MCP test service is already listening');
      httpServer = await new Promise((resolve, reject) => {
        const server = app.listen(requestedPort, host);
        server.once('error', reject);
        server.once('listening', () => {
          server.off('error', reject);
          resolve(server);
        });
      });
      const address = httpServer.address();
      if (!address || typeof address === 'string') throw new Error('Char Agent MCP test service has no TCP address');
      const origin = `http://${host === '::1' ? '[::1]' : host}:${address.port}`;
      return { host, port: address.port, path: endpointPath, mcpUrl: `${origin}${endpointPath}` };
    },
    async close() {
      await Promise.allSettled([...sessions.values()].map(record => record.mcp.close()));
      sessions.clear();
      const server = httpServer;
      httpServer = undefined;
      if (!server) return;
      server.closeAllConnections?.();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

function singleHeader(value) {
  return Array.isArray(value) ? value[0] : value;
}

function jsonRpcError(response, status, message) {
  return response.status(status).json({ jsonrpc: '2.0', error: { code: -32_000, message }, id: null });
}

function mcpPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.includes('?') || value.includes('#')) {
    throw new TypeError('Char Agent MCP test path must be an absolute URL path');
  }
  return value;
}

function portNumber(value) {
  const result = Number(value);
  if (!Number.isInteger(result) || result < 0 || result > 65_535) {
    throw new TypeError('Char Agent MCP test port must be from 0 to 65535');
  }
  return result;
}
