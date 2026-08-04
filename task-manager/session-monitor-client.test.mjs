import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createSessionMonitorClient,
  discoverSessionMonitor,
  SessionMonitorClientError,
} from './session-monitor-client.mjs';

test('Session Monitor client consumes v5 structured observation and submits UTF-8', async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'desktop-char-monitor-client-'));
  const markerPath = path.join(temporaryDirectory, 'session_monitor.json');
  const tokenPath = path.join(temporaryDirectory, 'session_monitor_token.txt');
  const expectedToken = 'monitor-secret-token';
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      body,
    });
    if (request.headers.authorization !== `Bearer ${expectedToken}`) {
      return json(response, 401, { ok: false, error: 'unauthorized' });
    }
    if (request.method === 'GET' && request.url === '/api/sessions?full=true') {
      return json(response, 200, { ok: true, sessions: [session()] });
    }
    if (request.method === 'GET' && request.url === '/api/sessions/session-a') {
      return json(response, 200, { ok: true, session: session() });
    }
    if (request.method === 'POST' && request.url === '/api/sessions/session-a/input') {
      const payload = JSON.parse(body);
      assert.deepEqual(payload, { text: '继续检查 UTF-8：你好', mode: 'submit' });
      return json(response, 200, {
        ok: true,
        sessionId: 'session-a',
        mode: 'submit',
        submitted: true,
        agentState: 'active',
      });
    }
    json(response, 404, { ok: false, error: 'not_found' });
  });
  await listen(server);
  const address = server.address();
  assert(address && typeof address !== 'string');
  try {
    await writeFile(tokenPath, `${expectedToken}\n`, 'utf8');
    await writeFile(markerPath, JSON.stringify({
      version: 5,
      role: 'session_monitor',
      intervalMs: 1_000,
      httpBaseUrl: `http://127.0.0.1:${address.port}`,
      httpTokenFile: tokenPath,
      capabilities: {
        sessionInput: {
          enabled: true,
          modes: ['insert', 'submit'],
          maxTextChars: 32_768,
        },
        sessionObservation: {
          enabled: true,
          structuredCodexRollout: true,
          fields: [
            'agentStateSource', 'turnRevision', 'submissionId', 'activeSubmissionId',
            'completionRevision', 'latestCompletedReply',
          ],
        },
      },
    }), 'utf8');
    const client = createSessionMonitorClient({ markerPath });
    const discovery = await client.discover();
    assert.equal(discovery.markerVersion, 5);
    assert.equal(discovery.structuredObservation, true);
    assert.equal('token' in discovery, false);
    const [listed] = await client.listSessions();
    assert.equal(listed.lastVisibleText, '任务处理中');
    assert.equal(listed.agent, 'Codex');
    assert.equal(listed.agentStateSource, 'codex_rollout');
    assert.equal(listed.turnRevision, 8);
    assert.equal(listed.completionRevision, 7);
    assert.equal(listed.activeSubmissionId, 'turn-8');
    assert.equal(listed.latestCompletedReply.text, '上一轮完成');
    assert.equal((await client.getSession('session-a')).agentState, 'active');
    assert.deepEqual(await client.submitInput('session-a', '继续检查 UTF-8：你好'), {
      sessionId: 'session-a',
      submitted: true,
      agentState: 'active',
    });
    assert.equal(requests.length, 3);
    assert(requests.every(request => request.authorization === `Bearer ${expectedToken}`));
  }
  finally {
    await new Promise(resolve => server.close(resolve));
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test('Session Monitor discovery rejects non-loopback endpoints and missing submit capability', async () => {
  const baseMarker = {
    version: 4,
    role: 'session_monitor',
    intervalMs: 1_000,
    httpBaseUrl: 'http://example.com:17365',
    httpTokenFile: 'C:\\token.txt',
    capabilities: {
      sessionInput: {
        enabled: true,
        modes: ['submit'],
        maxTextChars: 32_768,
      },
    },
  };
  await assert.rejects(
    discoverSessionMonitor('C:\\marker.json', {
      readText: async filePath =>
        filePath.endsWith('marker.json') ? JSON.stringify(baseMarker) : 'secret',
    }),
    (error) =>
      error instanceof SessionMonitorClientError && error.code === 'invalid-marker',
  );
  await assert.rejects(
    discoverSessionMonitor('C:\\marker.json', {
      readText: async filePath => filePath.endsWith('marker.json')
        ? JSON.stringify({
            ...baseMarker,
            httpBaseUrl: 'http://127.0.0.1:17365',
            capabilities: { sessionInput: { enabled: true, modes: ['insert'] } },
          })
        : 'secret',
    }),
    (error) =>
      error instanceof SessionMonitorClientError && error.code === 'input-unsupported',
  );
});

function session() {
  return {
    sessionId: 'session-a',
    state: 'running',
    monitorState: 'observed',
    agentState: 'active',
    agentStateSource: 'codex_rollout',
    agentStateChangedAtUtc: '2026-07-29T10:00:00Z',
    turnRevision: 8,
    submissionId: 'turn-8',
    activeSubmissionId: 'turn-8',
    completionRevision: 7,
    latestCompletedReply: {
      source: 'codex_rollout',
      submissionId: 'turn-7',
      completionRevision: 7,
      startedAtUtc: '2026-07-29T09:59:00Z',
      completedAtUtc: '2026-07-29T09:59:02Z',
      durationMs: 2_000,
      timeToFirstTokenMs: 300,
      text: '上一轮完成',
      textHash: 'REPLY-7',
      originalTextLength: 5,
      textTruncated: false,
    },
    agent: 'Codex',
    desiredTitle: '测试会话',
    workDir: 'C:\\workspace',
    lastVisibleText: '任务处理中',
    lastVisibleNonEmptyLine: '任务处理中',
    lastVisibleTextHash: 'HASH-A',
    lastScreenChangedAtUtc: '2026-07-29T10:00:00Z',
    lastObservedAtUtc: '2026-07-29T10:00:01Z',
  };
}

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  response.end(body);
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, resolve);
  });
}
