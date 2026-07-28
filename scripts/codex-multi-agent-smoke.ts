import {
  AgentConnectionManager,
  CodexCliReplyAgent,
  ConversationRuntime,
  type PreparationPort,
  type PresentationPort,
} from '../packages/conversation-runtime/src/index.ts';

const workspace = process.cwd();
const manager = new AgentConnectionManager();
const preparationEvents: Array<{ kind: 'speech' | 'performance'; turnSequence: number; atMs: number }> = [];
const presentationOrder: number[] = [];
const startedAt = Date.now();

for (const suffix of ['a', 'b']) {
  manager.register({
    agentId: `codex-${suffix}`,
    instanceId: `codex-${suffix}-${process.pid}`,
    protocolVersion: 'desktop-char.reply.v1',
    capabilities: ['reply'],
    maxConcurrency: 1,
  }, new CodexCliReplyAgent({
    cwd: workspace,
    timeoutMs: 180_000,
  }));
}

const preparation: PreparationPort = {
  async prepareSpeech(request, signal) {
    preparationEvents.push({ kind: 'speech', turnSequence: request.turnSequence, atMs: Date.now() - startedAt });
    await delay(40, signal);
    return { preparationId: `smoke-speech-${request.segmentId}` };
  },
  async preparePerformance(request, signal) {
    preparationEvents.push({ kind: 'performance', turnSequence: request.turnSequence, atMs: Date.now() - startedAt });
    await delay(20, signal);
    return { preparationId: `smoke-performance-${request.segmentId}` };
  },
};

const presentation: PresentationPort = {
  async present(unit, signal) {
    presentationOrder.push(unit.turnSequence);
    await delay(20, signal);
  },
};

let id = 0;
const runtime = new ConversationRuntime({
  conversationId: `codex-smoke-${Date.now()}`,
  connections: manager,
  preparation,
  presentation,
  idFactory: kind => `${kind}-${id++}`,
});

runtime.submitUserMessage('这是第一条并行测试消息，请简短回应。');
runtime.submitUserMessage('这是第二条并行测试消息，请用不同措辞简短回应。');

try {
  await runtime.waitForIdle();
  const snapshot = runtime.getSnapshot();
  const agents = snapshot.responses.map(response => response.agentId);
  const errors = snapshot.responses.map(response => response.error ?? null);
  const assistantMessages = snapshot.messages
    .filter(message => message.role === 'assistant')
    .map(message => message.text);
  if (snapshot.responses.length !== 2) throw new Error('Expected two response slots');
  if (new Set(agents).size !== 2) {
    throw new Error(`Expected two Codex agents, received ${JSON.stringify(agents)}; errors=${JSON.stringify(errors)}`);
  }
  if (presentationOrder.join(',') !== '0,1') {
    throw new Error(`Presentation order is not stable: ${presentationOrder.join(',')}`);
  }
  if (!snapshot.responses.every(response => response.presentation === 'completed')) {
    throw new Error('Not every response completed presentation');
  }
  console.log(JSON.stringify({
    ok: true,
    elapsedMs: Date.now() - startedAt,
    agents,
    assistantMessages,
    preparationEvents,
    presentationOrder,
  }, null, 2));
}
finally {
  runtime.dispose();
  manager.close();
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
