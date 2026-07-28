import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';
import { createCodexAppServerClient } from './codex-app-server-client.mjs';

test('one hidden app-server process serves concurrent logical reply threads', async () => {
  const messages = [];
  const launches = [];
  let threadSequence = 0;
  let turnSequence = 0;
  const client = createCodexAppServerClient({
    cwd: process.cwd(),
    invocation: { command: 'codex-test', args: ['entry.js'] },
    spawnProcess(command, args, options) {
      launches.push({ command, args, options });
      return fakeAppServer(message => {
        messages.push(message);
        if (message.method === 'initialize') {
          return [{ id: message.id, result: { userAgent: 'test' } }];
        }
        if (message.method === 'thread/start') {
          return [{ id: message.id, result: { thread: { id: `thread-${++threadSequence}` } } }];
        }
        if (message.method === 'turn/start') {
          const turnId = `turn-${++turnSequence}`;
          return [
            { id: message.id, result: { turn: { id: turnId, status: 'inProgress', items: [] } } },
            {
              method: 'item/completed',
              params: {
                threadId: message.params.threadId,
                turnId,
                item: { id: `item-${turnId}`, type: 'agentMessage', phase: 'final_answer', text: `{"text":"${turnId}"}` },
              },
            },
            {
              method: 'turn/completed',
              params: {
                threadId: message.params.threadId,
                turn: { id: turnId, status: 'completed', items: [] },
              },
            },
          ];
        }
        if (message.method === 'thread/unsubscribe') {
          return [{ id: message.id, result: {} }];
        }
        return [];
      });
    },
  });

  const [first, second] = await Promise.all([
    client.execute({ prompt: 'one', outputSchema: replySchema() }, new AbortController().signal),
    client.execute({ prompt: 'two', outputSchema: replySchema() }, new AbortController().signal),
  ]);
  assert.deepEqual([first, second], ['{"text":"turn-1"}', '{"text":"turn-2"}']);
  assert.equal(launches.length, 1);
  assert.deepEqual(launches[0].args, [
    'entry.js',
    '--ask-for-approval', 'never',
    '--sandbox', 'read-only',
    'app-server',
    '--listen', 'stdio://',
  ]);
  const threadStarts = messages.filter(message => message.method === 'thread/start');
  assert.equal(threadStarts.length, 2);
  assert.equal(threadStarts.every(message => message.params.ephemeral === true), true);
  assert.equal(messages.filter(message => message.method === 'turn/start').length, 2);
  await client.close();
});

function fakeAppServer(handle) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let input = '';
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      input += chunk.toString('utf8');
      while (input.includes('\n')) {
        const newline = input.indexOf('\n');
        const line = input.slice(0, newline);
        input = input.slice(newline + 1);
        if (line) {
          for (const response of handle(JSON.parse(line))) {
            queueMicrotask(() => child.stdout.write(`${JSON.stringify(response)}\n`));
          }
        }
      }
      callback();
    },
  });
  child.kill = () => {
    queueMicrotask(() => child.emit('close', 0));
    return true;
  };
  return child;
}

function replySchema() {
  return {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false,
  };
}
