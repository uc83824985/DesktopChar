import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createTaskManagerRuntime, TaskManagerError } from './task-manager-runtime.mjs';

test('latest submission generation completes only after changed and stable waiting snapshots', async () => {
  const monitor = new FakeMonitor(session({ agentState: 'active', hash: 'A', changed: 1 }));
  let now = 1_000;
  const runtime = createTaskManagerRuntime({
    monitor,
    now: () => now++,
    idFactory: cursor => `event-${cursor}`,
  });
  await runtime.pollOnce();
  assert.equal(runtime.eventsAfter().events.length, 0);

  const first = await runtime.submitCommand(command('command-1', '第一条补充'));
  assert.equal(first.submissionGeneration, 1);
  assert.equal(first.status, 'observing');
  monitor.current = session({ agentState: 'active', hash: 'B', changed: 2, text: '第一轮生成中' });
  await runtime.pollOnce();
  assert.equal(runtime.eventsAfter().events.length, 0);

  const second = await runtime.submitCommand(command('command-2', '只回复最后请求'));
  assert.equal(second.submissionGeneration, 2);
  assert.equal(runtime.getSnapshot().commands[0].status, 'superseded');
  assert.deepEqual(monitor.submissions.map(item => item.text), ['第一条补充', '只回复最后请求']);

  monitor.current = session({
    agentState: 'waiting_input',
    hash: 'C',
    changed: 3,
    text: '已完成最后请求\n> ',
  });
  await runtime.pollOnce();
  assert.equal(runtime.eventsAfter().events.length, 0);
  await runtime.pollOnce();
  assert.equal(runtime.eventsAfter().events.length, 0);
  monitor.current = session({
    agentState: 'waiting_input',
    hash: 'C',
    changed: 3,
    observed: 2,
    text: '已完成最后请求\n> ',
  });
  await runtime.pollOnce();
  assert.equal(runtime.eventsAfter().events.length, 0);
  monitor.current = session({
    agentState: 'waiting_input',
    hash: 'C',
    changed: 3,
    observed: 4,
    text: '已完成最后请求\n> ',
  });
  await runtime.pollOnce();
  const completed = runtime.eventsAfter().events;
  assert.equal(completed.length, 1);
  assert.equal(completed[0].type, 'task-completed');
  assert.equal(completed[0].submissionGeneration, 2);
  assert.equal(completed[0].visibleTextTail, '已完成最后请求\n> ');
  assert.equal(runtime.getSnapshot().activeObservationCount, 0);
});

test('command idempotency prevents repeated input and conflicts fail closed', async () => {
  const monitor = new FakeMonitor(session({ agentState: 'waiting_input', hash: 'A', changed: 1 }));
  const runtime = createTaskManagerRuntime({ monitor });
  await runtime.pollOnce();
  const input = command('same-command', '继续');
  const first = await runtime.submitCommand(input);
  const repeated = await runtime.submitCommand(input);
  assert.equal(repeated.submissionGeneration, first.submissionGeneration);
  assert.equal(monitor.submissions.length, 1);
  await assert.rejects(
    runtime.submitCommand({ ...input, text: '不同内容' }),
    error => error instanceof TaskManagerError && error.code === 'idempotency-conflict',
  );
  assert.equal(monitor.submissions.length, 1);
});

test('waiting-input editor changes never masquerade as task completion', async () => {
  const monitor = new FakeMonitor(
    session({ agentState: 'waiting_input', hash: 'A', changed: 1, text: '> ' }),
  );
  let now = 1_000;
  const runtime = createTaskManagerRuntime({
    monitor,
    now: () => now,
    activationTimeoutMs: 5_000,
  });
  await runtime.pollOnce();
  const submitted = await runtime.submitCommand(
    command('editor-only-command', '这段文字只进入了输入框'),
  );
  assert.equal(submitted.status, 'observing');

  monitor.current = session({
    agentState: 'waiting_input',
    hash: 'B',
    changed: 2,
    text: '> 这段文字只进入了输入框',
  });
  await runtime.pollOnce();
  await runtime.pollOnce();
  assert.equal(runtime.eventsAfter().events.length, 0);
  assert.equal(runtime.getSnapshot().activeObservationCount, 1);

  now = 6_001;
  await runtime.pollOnce();
  const [failed] = runtime.eventsAfter().events;
  assert.equal(failed.type, 'task-failed');
  assert.match(failed.error, /did not enter active state/);
  assert.equal(runtime.getSnapshot().commands[0].status, 'failed');
});

test('a fast Codex reply can complete when polling misses the active state', async () => {
  const request = '只回复：快速完成';
  const monitor = new FakeMonitor(
    session({ agentState: 'waiting_input', hash: 'A', changed: 1, text: '› ' }),
  );
  const runtime = createTaskManagerRuntime({ monitor });
  await runtime.pollOnce();
  const submitted = await runtime.submitCommand(command('fast-command', request));
  assert.equal(submitted.status, 'observing');

  monitor.current = session({
    agentState: 'waiting_input',
    hash: 'B',
    changed: 2,
    text: `› ${request}\n\n• 快速完成\n\n› `,
  });
  await runtime.pollOnce();
  assert.equal(runtime.eventsAfter().events.length, 0);
  await runtime.pollOnce();
  assert.equal(runtime.eventsAfter().events.length, 0);
  monitor.current = session({
    agentState: 'waiting_input',
    hash: 'B',
    changed: 2,
    observed: 3,
    text: `› ${request}\n\n• 快速完成\n\n› `,
  });
  await runtime.pollOnce();
  const [completed] = runtime.eventsAfter().events;
  assert.equal(completed.type, 'task-completed');
  assert.equal(completed.status, 'completed');
  assert.equal(runtime.getSnapshot().commands[0].status, 'completed');
});

test('completion captures a reply that arrives after a duplicated waiting snapshot', async () => {
  const monitor = new FakeMonitor(
    session({ agentState: 'active', hash: 'A', changed: 1, text: '处理中' }),
  );
  const runtime = createTaskManagerRuntime({ monitor });
  await runtime.pollOnce();
  await runtime.submitCommand(command('delayed-reply-command', '只回复：最终回复'));

  monitor.current = session({
    agentState: 'waiting_input',
    hash: 'B',
    changed: 2,
    observed: 2,
    text: '› 只回复：最终回复\n\n◦ Working (3s)\n\n› ',
  });
  await runtime.pollOnce();
  await runtime.pollOnce();
  assert.equal(runtime.eventsAfter().events.length, 0);

  monitor.current = session({
    agentState: 'waiting_input',
    hash: 'C',
    changed: 3,
    observed: 3,
    text: '› 只回复：最终回复\n\n• 最终回复\n\n› ',
  });
  await runtime.pollOnce();
  assert.equal(runtime.eventsAfter().events.length, 0);
  monitor.current = session({
    agentState: 'waiting_input',
    hash: 'C',
    changed: 3,
    observed: 4,
    text: '› 只回复：最终回复\n\n• 最终回复\n\n› ',
  });
  await runtime.pollOnce();
  const [completed] = runtime.eventsAfter().events;
  assert.equal(completed.type, 'task-completed');
  assert.equal(completed.visibleTextTail, '› 只回复：最终回复\n\n• 最终回复\n\n› ');
});

test('out-of-order submit acknowledgements cannot replace the latest generation observer', async () => {
  const monitor = new DeferredSubmitMonitor(
    session({ agentState: 'active', hash: 'A', changed: 1 }),
  );
  const runtime = createTaskManagerRuntime({ monitor });
  await runtime.pollOnce();
  const firstPromise = runtime.submitCommand(command('command-1', '第一条'));
  await waitUntil(() => monitor.pending.length === 1);
  const secondPromise = runtime.submitCommand(command('command-2', '第二条'));
  await waitUntil(() => monitor.pending.length === 2);
  monitor.complete(1);
  const second = await secondPromise;
  monitor.complete(0);
  const first = await firstPromise;
  assert.equal(second.submissionGeneration, 2);
  assert.equal(second.status, 'observing');
  assert.equal(first.submissionGeneration, 1);
  assert.equal(first.status, 'superseded');

  monitor.current = session({
    agentState: 'waiting_input',
    hash: 'B',
    changed: 2,
    text: '第二条完成\n> ',
  });
  await runtime.pollOnce();
  monitor.current = session({
    agentState: 'waiting_input',
    hash: 'B',
    changed: 2,
    observed: 3,
    text: '第二条完成\n> ',
  });
  await runtime.pollOnce();
  assert.equal(runtime.eventsAfter().events[0].submissionGeneration, 2);
});

test('input failure becomes a bounded failed event and is not retried automatically', async () => {
  const monitor = new FakeMonitor(session({ agentState: 'active', hash: 'A', changed: 1 }));
  monitor.submitError = new Error('console input write failed');
  const runtime = createTaskManagerRuntime({ monitor });
  await runtime.pollOnce();
  const failed = await runtime.submitCommand(command('failed-command', '继续'));
  assert.equal(failed.status, 'failed');
  assert.equal(runtime.getSnapshot().activeObservationCount, 0);
  const events = runtime.eventsAfter().events;
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'task-failed');
  await runtime.pollOnce();
  assert.equal(monitor.submissions.length, 1);
});

test('session changes emit deduplicated bounded facts with cursor and ack', async () => {
  const monitor = new FakeMonitor(session({ agentState: 'waiting_input', hash: 'A', changed: 1 }));
  const runtime = createTaskManagerRuntime({
    monitor,
    maxVisibleTextTailChars: 100,
    idFactory: cursor => `event-${cursor}`,
    now: () => 7_000,
  });
  await runtime.pollOnce();
  monitor.current = session({
    agentState: 'active',
    hash: 'B',
    changed: 2,
    text: `${'前'.repeat(100)}${'后'.repeat(100)}`,
  });
  await runtime.pollOnce();
  await runtime.pollOnce();
  const page = runtime.eventsAfter(0);
  assert.equal(page.events.length, 1);
  assert.equal(page.events[0].eventId, 'event-1');
  assert.equal(page.events[0].visibleTextTail, '后'.repeat(100));
  assert.equal(page.events[0].acknowledgedAtMs, undefined);
  assert.equal(runtime.ackEvent('event-1').acknowledgedAtMs, 7_000);
  assert.equal(runtime.ackEvent('event-1').acknowledgedAtMs, 7_000);
});

test('passive watch emits one completion after a streaming external turn returns to input', async () => {
  const monitor = new FakeMonitor(session({
    agentState: 'waiting_input',
    hash: 'A',
    changed: 1,
    text: '• 上一轮\n\n› ',
  }));
  const runtime = createTaskManagerRuntime({
    monitor,
    idFactory: cursor => `event-${cursor}`,
    now: () => 8_000,
  });
  await runtime.pollOnce();
  const initialWatch = await runtime.watchSession('session-a');
  assert.equal(initialWatch.sessionId, 'session-a');
  assert.equal(initialWatch.phase, 'waiting');
  assert.equal(initialWatch.turnSequence, 0);
  assert.equal(initialWatch.sourceHash, 'A');
  assert.equal(initialWatch.sourceRevision, '2026-07-29T10:00:01Z');
  assert.equal(initialWatch.review.state.completion, 'complete');
  assert.equal(initialWatch.review.content.latestReply, '上一轮');

  monitor.current = session({
    agentState: 'active',
    hash: 'B',
    changed: 2,
    text: '• 上一轮\n\n› 手动请求\n\n• 流式',
  });
  await runtime.pollOnce();
  monitor.current = session({
    agentState: 'active',
    hash: 'C',
    changed: 3,
    text: '• 上一轮\n\n› 手动请求\n\n• 流式结果尚未结束',
  });
  await runtime.pollOnce();
  assert.equal(runtime.eventsAfter().events.length, 0);

  monitor.current = session({
    agentState: 'waiting_input',
    hash: 'D',
    changed: 4,
    text: '• 上一轮\n\n› 手动请求\n\n• 完整结果\n\n› ',
  });
  await runtime.pollOnce();
  await runtime.pollOnce();
  const firstTurn = runtime.eventsAfter().events;
  assert.equal(firstTurn.length, 1);
  assert.equal(firstTurn[0].type, 'external-turn-completed');
  assert.equal(firstTurn[0].externalTurnSequence, 1);
  assert.equal(firstTurn[0].visibleTextTail, '• 上一轮\n\n› 手动请求\n\n• 完整结果\n\n› ');
  assert.equal(firstTurn[0].latestReply, '完整结果');

  monitor.current = session({
    agentState: 'active',
    hash: 'E',
    changed: 5,
    text: '› 第二轮\n\n• 处理中',
  });
  await runtime.pollOnce();
  monitor.current = session({
    agentState: 'waiting_input',
    hash: 'F',
    changed: 6,
    text: '› 第二轮\n\n• 第二轮结果\n\n› ',
  });
  await runtime.pollOnce();
  const turns = runtime.eventsAfter().events;
  assert.deepEqual(
    turns.map(event => [event.type, event.externalTurnSequence]),
    [
      ['external-turn-completed', 1],
      ['external-turn-completed', 2],
    ],
  );
});

test('session review returns a fresh bounded snapshot without advancing its passive watch', async () => {
  const monitor = new FakeMonitor(session({
    agentState: 'waiting_input',
    hash: 'A',
    changed: 1,
    text: '› 已有问题\n\n• 已有最后回复\n第二行\n\n› ',
  }));
  const runtime = createTaskManagerRuntime({ monitor, now: () => 8_500 });
  await runtime.pollOnce();
  await runtime.watchSession('session-a');

  const review = await runtime.reviewSession('session-a');
  assert.deepEqual(review, {
    schemaVersion: 'desktop-char.task-session-review.v1',
    sessionId: 'session-a',
    capturedAtMs: 8_500,
    metadata: {
      agent: 'Codex',
      title: '测试会话',
      workDir: 'C:\\workspace',
    },
    state: {
      session: 'running',
      monitor: 'observed',
      agent: 'waiting_input',
      completion: 'complete',
    },
    source: {
      hash: 'A',
      screenChangedAtUtc: '2026-07-29T10:00:01Z',
      observedAtUtc: '2026-07-29T10:00:11Z',
    },
    content: {
      lastVisibleLine: '›',
      visibleTextTail: '› 已有问题\n\n• 已有最后回复\n第二行\n\n› ',
      latestReply: '已有最后回复\n第二行',
    },
  });
  assert.equal(runtime.getSnapshot().passiveWatches[0].turnSequence, 0);
  assert.equal(runtime.eventsAfter().events.length, 0);

  monitor.current = session({
    agentState: 'active',
    hash: 'B',
    changed: 2,
    text: '› 新问题\n\n• 流式回复',
  });
  const activeReview = await runtime.reviewSession('session-a');
  assert.equal(activeReview.state.completion, 'in-progress');
  assert.equal(activeReview.content.latestReply, undefined);
  assert.equal(runtime.eventsAfter().events.length, 0);
});

test('passive watch conservatively recovers a fast Codex turn missed between polls', async () => {
  const monitor = new FakeMonitor(session({
    agentState: 'waiting_input',
    hash: 'A',
    changed: 1,
    text: '• 旧结果\n\n› ',
  }));
  const runtime = createTaskManagerRuntime({ monitor });
  await runtime.pollOnce();
  await runtime.watchSession('session-a');

  monitor.current = session({
    agentState: 'waiting_input',
    hash: 'B',
    changed: 2,
    observed: 2,
    text: '• 旧结果\n\n› 快速请求\n\n• 快速结果\n\n› ',
  });
  await runtime.pollOnce();
  await runtime.pollOnce();
  const events = runtime.eventsAfter().events;
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'external-turn-completed');
  assert.equal(events[0].latestReply, '快速结果');

  await runtime.pollOnce();
  assert.equal(runtime.eventsAfter().events.length, 1);
});

test('passive polling recovers a completed turn after the terminal tail loses overlap', async () => {
  const monitor = new FakeMonitor(session({
    agentState: 'waiting_input',
    hash: 'A',
    changed: 1,
    text: `${'旧内容'.repeat(1_000)}\n\n› `,
  }));
  const runtime = createTaskManagerRuntime({ monitor });
  await runtime.pollOnce();
  await runtime.watchSession('session-a');

  monitor.current = session({
    agentState: 'waiting_input',
    hash: 'B',
    changed: 2,
    text: `› 外部窗口自行发送\n\n• ${'新回复'.repeat(900)}\n\n› `,
  });
  await runtime.pollOnce();
  await runtime.pollOnce();

  const events = runtime.eventsAfter().events;
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'external-turn-completed');
  assert.match(events[0].latestReply, /新回复/u);
});

test('passive watch ignores waiting-input edits and suppresses command-owned turns', async () => {
  const monitor = new FakeMonitor(session({
    agentState: 'waiting_input',
    hash: 'A',
    changed: 1,
    text: '› ',
  }));
  const runtime = createTaskManagerRuntime({ monitor });
  await runtime.pollOnce();
  await runtime.watchSession('session-a');

  monitor.current = session({
    agentState: 'waiting_input',
    hash: 'B',
    changed: 2,
    observed: 2,
    text: '› 尚未提交',
  });
  await runtime.pollOnce();
  monitor.current = session({
    agentState: 'waiting_input',
    hash: 'B',
    changed: 2,
    observed: 3,
    text: '› 尚未提交',
  });
  await runtime.pollOnce();
  assert.equal(runtime.eventsAfter().events.length, 0);

  await runtime.submitCommand(command('owned-command', '由 DesktopChar 提交'));
  monitor.current = session({
    agentState: 'active',
    hash: 'C',
    changed: 3,
    text: '› 由 DesktopChar 提交\n\n• 处理中',
  });
  await runtime.pollOnce();
  monitor.current = session({
    agentState: 'waiting_input',
    hash: 'D',
    changed: 4,
    observed: 4,
    text: '› 由 DesktopChar 提交\n\n• 已完成\n\n› ',
  });
  await runtime.pollOnce();
  monitor.current = session({
    agentState: 'waiting_input',
    hash: 'D',
    changed: 4,
    observed: 5,
    text: '› 由 DesktopChar 提交\n\n• 已完成\n\n› ',
  });
  await runtime.pollOnce();
  assert.deepEqual(
    runtime.eventsAfter().events.map(event => event.type),
    ['task-completed'],
  );

  assert.equal(runtime.unwatchSession('session-a').removed, true);
  assert.equal(runtime.getSnapshot().passiveWatchCount, 0);
});

test('declared result artifact is validated before submit and again at completion', async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'desktop-char-task-artifact-'));
  const resultPath = path.join(temporaryDirectory, 'result.md');
  const monitor = new FakeMonitor(session({ agentState: 'active', hash: 'A', changed: 1 }));
  const runtime = createTaskManagerRuntime({
    monitor,
    allowedArtifactRoots: [temporaryDirectory],
  });
  try {
    await runtime.pollOnce();
    const observing = await runtime.submitCommand({
      ...command('artifact-command', '生成结果文档'),
      resultArtifact: { path: resultPath, openOnCompletion: true },
    });
    assert.equal(observing.status, 'observing');
    await writeFile(resultPath, '# 完成\n', 'utf8');
    monitor.current = session({
      agentState: 'waiting_input',
      hash: 'B',
      changed: 2,
      text: '文档已生成\n> ',
    });
    await runtime.pollOnce();
    monitor.current = session({
      agentState: 'waiting_input',
      hash: 'B',
      changed: 2,
      observed: 3,
      text: '文档已生成\n> ',
    });
    await runtime.pollOnce();
    const event = runtime.eventsAfter().events[0];
    assert.equal(event.status, 'completed');
    assert.equal(event.resultArtifactPath, resultPath);
    assert.equal(event.openArtifactOnCompletion, true);
  }
  finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test('result artifact outside allowed roots is rejected before Session Monitor input', async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'desktop-char-task-root-'));
  const monitor = new FakeMonitor(session({ agentState: 'waiting_input', hash: 'A', changed: 1 }));
  const runtime = createTaskManagerRuntime({
    monitor,
    allowedArtifactRoots: [temporaryDirectory],
  });
  try {
    await runtime.pollOnce();
    await assert.rejects(
      runtime.submitCommand({
        ...command('escaped-artifact', '生成文档'),
        resultArtifact: {
          path: path.resolve(temporaryDirectory, '..', 'outside.md'),
          openOnCompletion: false,
        },
      }),
      error => error instanceof TaskManagerError && error.code === 'artifact-path-rejected',
    );
    assert.equal(monitor.submissions.length, 0);
  }
  finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

class FakeMonitor {
  submissions = [];
  submitError;

  constructor(current) {
    this.current = current;
  }

  async discover() {
    return { intervalMs: 1_000 };
  }

  async listSessions() {
    return [structuredClone(this.current)];
  }

  async getSession(sessionId) {
    if (sessionId !== this.current.sessionId) throw new Error('session unavailable');
    return structuredClone(this.current);
  }

  async submitInput(sessionId, text) {
    this.submissions.push({ sessionId, text });
    if (this.submitError) throw this.submitError;
    return { sessionId, submitted: true, agentState: this.current.agentState };
  }
}

class DeferredSubmitMonitor extends FakeMonitor {
  pending = [];

  async submitInput(sessionId, text) {
    this.submissions.push({ sessionId, text });
    return new Promise(resolve => {
      this.pending.push({ sessionId, resolve });
    });
  }

  complete(index) {
    const item = this.pending[index];
    item.resolve({ sessionId: item.sessionId, submitted: true, agentState: 'active' });
  }
}

function command(commandId, text) {
  return {
    commandId,
    sessionId: 'session-a',
    text,
    mode: 'submit',
    contextRevision: 7,
  };
}

function session({
  agentState,
  hash,
  changed,
  observed = changed,
  text = '处理中',
}) {
  return {
    sessionId: 'session-a',
    state: 'running',
    monitorState: 'observed',
    agentState,
    agent: 'Codex',
    title: '测试会话',
    workDir: 'C:\\workspace',
    lastVisibleText: text,
    lastVisibleNonEmptyLine: text.trim().split('\n').at(-1),
    lastVisibleTextHash: hash,
    lastScreenChangedAtUtc: `2026-07-29T10:00:0${changed}Z`,
    lastObservedAtUtc: `2026-07-29T10:00:1${observed}Z`,
  };
}

async function waitUntil(predicate) {
  for (let index = 0; index < 100; index++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  throw new Error('Condition was not reached');
}
