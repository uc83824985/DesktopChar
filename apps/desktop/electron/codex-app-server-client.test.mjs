import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';
import {
  createAppServerSpawnOptions,
  createCodexAppServerClient,
} from './codex-app-server-client.mjs';

test('managed app-server stays hidden while retaining piped stdio', () => {
  const options = createAppServerSpawnOptions({ cwd: 'C:\\workspace' });
  assert.equal(options.cwd, 'C:\\workspace');
  assert.equal(options.windowsHide, true);
  assert.deepEqual(options.stdio, ['pipe', 'pipe', 'pipe']);
});

test('one app-server process serves concurrent logical reply threads', async () => {
  const messages = [];
  const launches = [];
  const lifecycle = [];
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
    client.execute(
      { prompt: 'one', outputSchema: replySchema() },
      new AbortController().signal,
      {
        onThreadStarted: threadId => lifecycle.push(['thread', threadId]),
        onTurnStarted: turnId => lifecycle.push(['turn', turnId]),
      },
    ),
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
  assert.deepEqual(lifecycle, [['thread', 'thread-1'], ['turn', 'turn-1']]);
  await client.close();
});

test('managed conversation keeps one persisted thread, steers active work, and archives on close', async () => {
  const messages = [];
  const turnCompletion = Promise.withResolvers();
  const client = createCodexAppServerClient({
    cwd: process.cwd(),
    invocation: { command: 'codex-test', args: [] },
    spawnProcess() {
      return fakeAppServer(message => {
        messages.push(message);
        if (message.method === 'initialize') {
          return [{ id: message.id, result: { userAgent: 'test' } }];
        }
        if (message.method === 'thread/start') {
          return [{ id: message.id, result: { thread: { id: 'managed-thread' } } }];
        }
        if (message.method === 'turn/start') {
          return [{
            id: message.id,
            result: { turn: { id: 'managed-turn', status: 'inProgress', items: [] } },
          }];
        }
        if (message.method === 'turn/steer') {
          return [{ id: message.id, result: { turnId: 'managed-turn' } }];
        }
        if (message.method === 'turn/interrupt') {
          turnCompletion.resolve();
          return [{ id: message.id, result: {} }];
        }
        if (message.method === 'thread/archive' || message.method === 'thread/unsubscribe') {
          return [{ id: message.id, result: {} }];
        }
        return [];
      });
    },
  });

  const thread = await client.createThread();
  const turnStarted = Promise.withResolvers();
  const turn = client.executeThread(
    thread.threadId,
    { prompt: 'start managed work' },
    new AbortController().signal,
    { onTurnStarted: turnStarted.resolve },
  );
  await turnStarted.promise;
  await client.steerThread(thread.threadId, 'use this correction');
  await client.archiveThread(thread.threadId);
  await assert.rejects(turn, error => error?.name === 'AbortError');
  await turnCompletion.promise;

  const start = messages.find(message => message.method === 'thread/start');
  assert.equal(start.params.ephemeral, false);
  assert.deepEqual(
    messages.find(message => message.method === 'turn/steer')?.params,
    {
      threadId: 'managed-thread',
      input: [{ type: 'text', text: 'use this correction' }],
      expectedTurnId: 'managed-turn',
    },
  );
  assert.equal(messages.some(message => message.method === 'turn/interrupt'), true);
  assert.equal(messages.some(message => message.method === 'thread/archive'), true);
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
