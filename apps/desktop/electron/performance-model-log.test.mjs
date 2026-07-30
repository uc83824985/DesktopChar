import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createPerformanceModelStateLogger,
  filterPerformanceModelOutput,
} from './performance-model-log.mjs';

test('successful performance health access logs are suppressed', () => {
  const healthUrl = 'http://127.0.0.1:18090/v1/models';
  const output = [
    'INFO:     127.0.0.1:61253 - "GET /v1/models HTTP/1.1" 200 OK',
    'WARNING:  model response was slow',
    'INFO:     127.0.0.1:61254 - "GET /v1/models HTTP/1.1" 503 Service Unavailable',
    '',
  ].join('\r\n');

  assert.equal(
    filterPerformanceModelOutput(output, healthUrl),
    [
      'WARNING:  model response was slow',
      'INFO:     127.0.0.1:61254 - "GET /v1/models HTTP/1.1" 503 Service Unavailable',
      '',
    ].join('\r\n'),
  );
});

test('performance output filter preserves unrelated and malformed output', () => {
  const completion =
    'INFO:     127.0.0.1:61255 - "POST /v1/chat/completions HTTP/1.1" 200 OK\n';
  assert.equal(
    filterPerformanceModelOutput(completion, 'http://127.0.0.1:18090/v1/models'),
    completion,
  );
  assert.equal(filterPerformanceModelOutput(completion, 'not-a-url'), completion);
});

test('performance state logger only writes when operational state changes', () => {
  const messages = [];
  const logState = createPerformanceModelStateLogger(message => messages.push(message));
  const ready = {
    enabled: true,
    lifecycle: 'managed',
    phase: 'ready',
    processId: 1234,
    lastError: null,
  };

  assert.equal(logState(ready), true);
  assert.equal(logState({ ...ready, processId: 5678 }), false);
  assert.equal(logState({ ...ready, enabled: false }), false);
  assert.equal(logState({ ...ready, phase: 'restarting', lastError: 'health timeout' }), true);
  assert.equal(logState({ ...ready, phase: 'ready', processId: 5678 }), true);
  assert.deepEqual(messages, [
    '[performance-model] lifecycle=managed phase=ready pid=1234',
    '[performance-model] lifecycle=managed phase=restarting pid=1234 error=health timeout',
    '[performance-model] lifecycle=managed phase=ready pid=5678',
  ]);
});
