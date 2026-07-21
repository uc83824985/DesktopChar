import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentHttpServer, parseAgentPort } from './agent-http-server.mjs';

test('accepts a valid performance and interrupt on loopback HTTP', async t => {
  const commands = [];
  const service = createAgentHttpServer({ port: 0, onCommand: command => commands.push(command) });
  const address = await service.listen();
  t.after(() => service.close());
  const base = `http://127.0.0.1:${address.port}`;

  assert.equal((await fetch(`${base}/v1/health`).then(response => response.json())).status, 'starting');
  service.updateState({ ready: true, snapshot: { state: 'idle', capabilities: { emotions: ['happy'], actions: ['nod'] } } });
  const capabilities = await fetch(`${base}/v1/capabilities`).then(result => result.json());
  assert.deepEqual(capabilities.presentation.speechBubbleModes, ['complete', 'stream', 'karaoke']);
  const response = await fetch(`${base}/v1/performances`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'reply-1', segments: [{
      id: 'reply-1-0', sequence: 0, displayText: '你好', speechText: '你好',
      emotion: { emotion: 'happy', intensity: 0.7 },
      bubble: { mode: 'karaoke', cues: [{ text: '你', atMs: 0 }, { text: '好', atMs: 200 }] },
    }] }),
  });
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { accepted: true, planId: 'reply-1' });
  assert.equal(commands[0].type, 'performance.submit');
  assert.equal(commands[0].plan.segments[0].bubble.mode, 'karaoke');

  const interrupt = await fetch(`${base}/v1/interrupt`, { method: 'POST' });
  assert.equal(interrupt.status, 202);
  assert.deepEqual(commands[1], { type: 'performance.interrupt' });
});

test('rejects busy, malformed and non-json requests', async t => {
  const service = createAgentHttpServer({ port: 0, onCommand() {} });
  const address = await service.listen();
  t.after(() => service.close());
  const base = `http://127.0.0.1:${address.port}`;
  service.updateState({ ready: true, snapshot: { state: 'speaking', capabilities: null } });
  assert.equal((await fetch(`${base}/v1/performances`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 409);
  service.updateState({ ready: true, snapshot: { state: 'idle', capabilities: null } });
  assert.equal((await fetch(`${base}/v1/performances`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })).status, 415);
  assert.equal((await fetch(`${base}/v1/performances`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 400);
  assert.equal((await fetch(`${base}/v1/performances`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'bad-cue', segments: [{ id: 's', sequence: 0, displayText: '', speechText: 'x', actions: 'nod' }] }),
  })).status, 400);
  assert.equal((await fetch(`${base}/v1/performances`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: 'bad-bubble',
      segments: [{ id: 's', sequence: 0, displayText: '完整', speechText: '完整', bubble: { mode: 'karaoke', cues: [{ text: '不匹配', atMs: 0 }] } }],
    }),
  })).status, 400);
});

test('agent port parsing is bounded', () => {
  assert.equal(parseAgentPort(undefined), 17373);
  assert.equal(parseAgentPort('0'), 0);
  assert.throws(() => parseAgentPort('-1'), /integer/);
  assert.throws(() => parseAgentPort('70000'), /integer/);
});
