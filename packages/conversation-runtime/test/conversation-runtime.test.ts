import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AgentConnectionManager,
  ConversationRuntime,
  type PresentationPort,
  type PresentationUnit,
  type PreparationPort,
  type CharAgentEndpoint,
  type CharReplyResult,
  type CharReplyTask,
} from '../src/index.ts';

test('multi-agent connection manager uses separate reply capacity concurrently', async () => {
  const manager = new AgentConnectionManager();
  const first = new ControlledAgent();
  const second = new ControlledAgent();
  manager.register(registration('agent-a'), first);
  manager.register(registration('agent-b'), second);

  const abort = new AbortController();
  const firstExecution = manager.dispatch(replyTask(0), abort.signal);
  const secondExecution = manager.dispatch(replyTask(1), abort.signal);
  await waitUntil(() => first.calls.length === 1 && second.calls.length === 1);

  assert.deepEqual(manager.getSnapshot().map(agent => agent.active), [1, 1]);
  second.complete(0, 'second');
  first.complete(0, 'first');
  assert.deepEqual(
    (await Promise.all([firstExecution, secondExecution])).map(execution => execution.agentId),
    ['agent-a', 'agent-b'],
  );
  manager.close();
});

test('multi-agent replies prepare out of order but commit and present in turn order', async () => {
  const manager = new AgentConnectionManager();
  const first = new ControlledAgent();
  const second = new ControlledAgent();
  manager.register(registration('agent-a'), first);
  manager.register(registration('agent-b'), second);
  const preparation = new RecordingPreparation();
  const presentation = new ControlledPresentation();
  let id = 0;
  const runtime = new ConversationRuntime({
    conversationId: 'conversation-test',
    connections: manager,
    preparation,
    presentation,
    persona: persona(),
    personaRevision: 3,
    replyTimeoutMs: 5_000,
    applicationFallbackText: '上一轮的回复没有收到，可以再说一次吗？',
    idFactory: kind => `${kind}-${id++}`,
  });

  runtime.submitUserMessage('第一条');
  runtime.submitUserMessage('第二条');
  await waitUntil(() => first.calls.length === 1 && second.calls.length === 1);

  second.complete(0, '第二条回复');
  await waitUntil(() => runtime.getSnapshot().responses[1]?.reply === 'sealed');
  await waitUntil(() => preparation.started.filter(item => item.turnSequence === 1).length === 2);
  const blocked = runtime.getSnapshot().responses[1];
  assert.equal(blocked?.commit, 'blocked');
  assert.deepEqual(presentation.started, []);

  first.complete(0, '第一条回复');
  await waitUntil(() => presentation.started.length === 1);
  assert.deepEqual(presentation.started, [0]);
  assert.deepEqual(
    runtime.getSnapshot().messages.filter(message => message.role === 'assistant').map(message => message.text),
    ['第一条回复', '第二条回复'],
  );

  presentation.complete(0);
  await waitUntil(() => presentation.started.length === 2);
  assert.deepEqual(presentation.started, [0, 1]);
  presentation.complete(1);
  await runtime.waitForIdle();

  const snapshot = runtime.getSnapshot();
  assert.deepEqual(snapshot.responses.map(response => response.agentId), ['agent-a', 'agent-b']);
  assert.deepEqual(snapshot.responses.map(response => response.presentation), ['completed', 'completed']);
  assert.ok(snapshot.responses.every(response =>
    response.segments.every(segment => segment.speech === 'ready' && segment.performance === 'ready')));
  runtime.dispose();
  manager.close();
});

test('failed char reply seals its turn-specific application fallback and unblocks later turns', async () => {
  const manager = new AgentConnectionManager();
  const first = new ControlledAgent();
  const second = new ControlledAgent();
  manager.register(registration('char-worker-a'), first);
  manager.register(registration('char-worker-b'), second);
  const preparation = new RecordingPreparation();
  const presentation = new ControlledPresentation();
  let id = 0;
  const runtime = new ConversationRuntime({
    conversationId: 'conversation-fallback',
    connections: manager,
    preparation,
    presentation,
    persona: persona(),
    personaRevision: 3,
    replyTimeoutMs: 5_000,
    applicationFallbackText: '上一轮的回复没有收到，可以再说一次吗？',
    idFactory: kind => `${kind}-${id++}`,
  });

  runtime.submitUserMessage('第一条', { applicationFallbackText: '「任务一」已完成。' });
  runtime.submitUserMessage('第二条');
  await waitUntil(() => first.calls.length === 1 && second.calls.length === 1);
  second.complete(0, '第二条回复');
  first.fail(0, new Error('provider unavailable'));
  await waitUntil(() => presentation.started.length === 1);

  const failed = runtime.getSnapshot().responses[0];
  assert.equal(failed?.reply, 'sealed');
  assert.equal(failed?.error, 'provider unavailable');
  assert.equal(failed?.segments[0]?.source, 'application-fallback');
  assert.equal(failed?.segments[0]?.text, '「任务一」已完成。');

  presentation.complete(0);
  await waitUntil(() => presentation.started.length === 2);
  presentation.complete(1);
  await runtime.waitForIdle();
  assert.deepEqual(
    runtime.getSnapshot().messages.filter(message => message.role === 'assistant').map(message => message.text),
    ['「任务一」已完成。', '第二条回复'],
  );
  runtime.dispose();
  manager.close();
});

class ControlledAgent implements CharAgentEndpoint {
  readonly calls: Array<{
    task: CharReplyTask;
    resolve: (result: CharReplyResult) => void;
    reject: (error: unknown) => void;
  }> = [];

  execute(task: CharReplyTask, signal: AbortSignal): Promise<CharReplyResult> {
    return new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      this.calls.push({ task, resolve, reject });
    });
  }

  complete(index: number, text: string): void {
    const call = this.calls[index];
    if (!call) throw new Error(`Missing controlled call ${index}`);
    call.resolve({
      conversationId: call.task.conversationId,
      turnId: call.task.turnId,
      taskId: call.task.taskId,
      attemptId: call.task.attemptId,
      generation: call.task.generation,
      baseContextRevision: call.task.context.baseContextRevision,
      personaRevision: call.task.context.personaRevision,
      segments: [{ segmentId: `segment-${call.task.turnSequence}`, text }],
    });
  }

  fail(index: number, error: Error): void {
    const call = this.calls[index];
    if (!call) throw new Error(`Missing controlled call ${index}`);
    call.reject(error);
  }
}

class RecordingPreparation implements PreparationPort {
  readonly started: Array<{ kind: 'speech' | 'performance'; turnSequence: number }> = [];

  async prepareSpeech(request: Parameters<PreparationPort['prepareSpeech']>[0]): Promise<{ preparationId: string }> {
    this.started.push({ kind: 'speech', turnSequence: request.turnSequence });
    return { preparationId: `speech-${request.segmentId}` };
  }

  async preparePerformance(request: Parameters<PreparationPort['preparePerformance']>[0]): Promise<{ preparationId: string }> {
    this.started.push({ kind: 'performance', turnSequence: request.turnSequence });
    return { preparationId: `performance-${request.segmentId}` };
  }
}

class ControlledPresentation implements PresentationPort {
  readonly started: number[] = [];
  private readonly pending = new Map<number, () => void>();

  present(unit: PresentationUnit): Promise<void> {
    this.started.push(unit.turnSequence);
    return new Promise(resolve => this.pending.set(unit.turnSequence, resolve));
  }

  complete(turnSequence: number): void {
    const resolve = this.pending.get(turnSequence);
    if (!resolve) throw new Error(`Presentation ${turnSequence} is not pending`);
    this.pending.delete(turnSequence);
    resolve();
  }
}

function registration(agentId: string) {
  return {
    agentId,
    instanceId: `${agentId}-instance`,
    protocolVersion: 'desktop-char.char-reply.v1',
    capabilities: ['char-reply'] as const,
    maxConcurrency: 1,
  };
}

function replyTask(sequence: number): CharReplyTask {
  const messageId = `message-${sequence}`;
  return {
    conversationId: 'conversation',
    turnId: `turn-${sequence}`,
    turnSequence: sequence,
    taskId: `task-${sequence}`,
    attemptId: `attempt-${sequence}`,
    generation: 0,
    deadlineAtMs: Date.now() + 5_000,
    context: {
      schemaVersion: 'desktop-char.char-context.v1',
      baseContextRevision: sequence + 1,
      personaRevision: 3,
      persona: persona(),
      messages: [{
        messageId,
        sequence,
        role: 'user',
        text: `message-${sequence}`,
        turnId: `turn-${sequence}`,
      }],
      focusMessageId: messageId,
    },
  };
}

function persona() {
  return {
    name: '测试角色',
    instructions: ['使用简短自然的中文回复。'],
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for test condition');
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}
