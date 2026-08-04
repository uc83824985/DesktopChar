import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AgentApplicationCommandBridge,
  ApplicationAccessScheduler,
  ApplicationCommandCatalog,
  ApplicationCommandRuntime,
  ApplicationCommandRuntimeError,
  ApplicationQueryCatalog,
  ApplicationQueryRuntime,
  createApplicationCommandFramework,
  type ApplicationCommand,
  type ApplicationCommandProposal,
  type ApplicationData,
  type ApplicationQuery,
} from '../src/index.ts';

test('framework composition root shares catalogs and access scheduler', () => {
  const framework = createApplicationCommandFramework();

  assert.equal(framework.queries.catalog, framework.queryCatalog);
  assert.equal(framework.commands.catalog, framework.commandCatalog);
  assert.equal(framework.queries.scheduler, framework.scheduler);
  assert.equal(framework.commands.scheduler, framework.scheduler);
});

test('read-only queries on the same resource execute concurrently', async () => {
  const catalog = new ApplicationQueryCatalog();
  const releases: Array<() => void> = [];
  let active = 0;
  let maximumActive = 0;
  catalog.register({
    type: 'application.state.read',
    validateParameters: value => value,
    async execute() {
      active++;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>(resolve => releases.push(resolve));
      active--;
      return { ok: true };
    },
  });
  const runtime = new ApplicationQueryRuntime({ catalog });

  const first = runtime.execute(query('application.state.read'));
  const second = runtime.execute(query('application.state.read'));
  await waitUntil(() => releases.length === 2);
  assert.equal(maximumActive, 2);
  assert.deepEqual(runtime.getSnapshot(), { queuedCount: 0, executingCount: 2 });

  releases.splice(0).forEach(release => release());
  assert.deepEqual(await Promise.all([first, second]), [{ ok: true }, { ok: true }]);
  assert.deepEqual(runtime.getSnapshot(), { queuedCount: 0, executingCount: 0 });
});

test('a queued writer blocks later readers without blocking unrelated resources', async () => {
  const scheduler = new ApplicationAccessScheduler();
  const queryCatalog = new ApplicationQueryCatalog();
  const commandCatalog = new ApplicationCommandCatalog();
  const order: string[] = [];
  const firstRead = deferred<void>();
  const writer = deferred<void>();
  queryCatalog.register({
    type: 'session.window.read',
    validateParameters: value => value,
    access: queryValue => [{
      resource: `session-window:${queryValue.target?.id ?? 'missing'}`,
      mode: 'read',
    }],
    async execute({ parameters }) {
      const label = (parameters as { label: string }).label;
      order.push(`${label}:start`);
      if (label === 'first') await firstRead.promise;
      order.push(`${label}:end`);
      return { label };
    },
  });
  commandCatalog.register({
    type: 'session.window.place',
    validateParameters: value => value,
    access: commandValue => [{
      resource: `session-window:${commandValue.target?.id ?? 'missing'}`,
      mode: 'write',
    }],
    async execute() {
      order.push('writer:start');
      await writer.promise;
      order.push('writer:end');
      return { placed: true };
    },
  });
  const queries = new ApplicationQueryRuntime({ catalog: queryCatalog, scheduler });
  const commands = new ApplicationCommandRuntime({ catalog: commandCatalog, scheduler });

  const first = queries.execute(query('session.window.read', { label: 'first' }, 'session-1'));
  await waitUntil(() => order.includes('first:start'));
  const write = commands.execute(command('place-1', 'session.window.place', {}, 'session-1'));
  const laterRead = queries.execute(query('session.window.read', { label: 'later' }, 'session-1'));
  const unrelatedRead = queries.execute(query(
    'session.window.read',
    { label: 'unrelated' },
    'session-2',
  ));
  await waitUntil(() => order.includes('unrelated:end'));
  assert.deepEqual(order, ['first:start', 'unrelated:start', 'unrelated:end']);

  firstRead.resolve();
  await waitUntil(() => order.includes('writer:start'));
  assert.equal(order.includes('later:start'), false);
  writer.resolve();
  await Promise.all([first, write, laterRead, unrelatedRead]);
  assert.deepEqual(order, [
    'first:start',
    'unrelated:start',
    'unrelated:end',
    'first:end',
    'writer:start',
    'writer:end',
    'later:start',
    'later:end',
  ]);
});

test('default command writes conflict with default reads and other writes', async () => {
  const scheduler = new ApplicationAccessScheduler();
  const queryCatalog = new ApplicationQueryCatalog();
  const commandCatalog = new ApplicationCommandCatalog();
  const releaseRead = deferred<void>();
  const releaseWrite = deferred<void>();
  const order: string[] = [];
  queryCatalog.register({
    type: 'application.read',
    validateParameters: value => value,
    async execute() {
      order.push('read:start');
      await releaseRead.promise;
      order.push('read:end');
      return null;
    },
  });
  commandCatalog.register({
    type: 'application.write',
    validateParameters: value => value,
    async execute({ command: commandValue }) {
      order.push(`${commandValue.commandId}:start`);
      if (commandValue.commandId === 'write-1') await releaseWrite.promise;
      order.push(`${commandValue.commandId}:end`);
      return null;
    },
  });
  const queries = new ApplicationQueryRuntime({ catalog: queryCatalog, scheduler });
  const commands = new ApplicationCommandRuntime({ catalog: commandCatalog, scheduler });

  const read = queries.execute(query('application.read'));
  await waitUntil(() => order.includes('read:start'));
  const firstWrite = commands.execute(command('write-1', 'application.write'));
  const secondWrite = commands.execute(command('write-2', 'application.write'));
  await Promise.resolve();
  assert.deepEqual(order, ['read:start']);
  releaseRead.resolve();
  await waitUntil(() => order.includes('write-1:start'));
  assert.equal(order.includes('write-2:start'), false);
  releaseWrite.resolve();
  await Promise.all([read, firstWrite, secondWrite]);
  assert.deepEqual(order, [
    'read:start',
    'read:end',
    'write-1:start',
    'write-1:end',
    'write-2:start',
    'write-2:end',
  ]);
});

test('authoritative commands execute directly and commandId is idempotent', async () => {
  const catalog = new ApplicationCommandCatalog();
  let executions = 0;
  catalog.register({
    type: 'session.window.place',
    validateParameters: value => value,
    execute({ parameters }) {
      executions++;
      return {
        accepted: true,
        placement: (parameters as { placement: string }).placement,
      };
    },
  });
  const runtime = new ApplicationCommandRuntime({ catalog, now: () => 5_000 });
  const input = command('place-once', 'session.window.place', { placement: 'top-left' }, 'session-1');

  const first = runtime.execute(input);
  const repeated = runtime.execute(structuredClone(input));
  assert.strictEqual(repeated, first);
  assert.deepEqual(await first, {
    accepted: true,
    placement: 'top-left',
  });
  assert.equal(executions, 1);
  assert.equal(runtime.getSnapshot().executions[0]?.state, 'succeeded');
  assert.throws(
    () => runtime.execute({ ...input, parameters: { placement: 'bottom-right' } }),
    error => error instanceof ApplicationCommandRuntimeError
      && error.code === 'idempotency-conflict',
  );
});

test('the agent bridge compiles proposals and exposes only projected receipts', async () => {
  const catalog = new ApplicationCommandCatalog();
  catalog.register({
    type: 'session.window.place',
    validateParameters: value => value,
    execute() {
      return {
        hwnd: 'must-not-reach-agent',
        bounds: { x: 0, y: 0, width: 960, height: 540 },
      };
    },
  });
  const runtime = new ApplicationCommandRuntime({ catalog });
  const bridge = new AgentApplicationCommandBridge({
    runtime,
    now: () => 6_000,
    receiptIdFactory: proposalId => `receipt:${proposalId}`,
    compileProposal(proposal) {
      return command(
        `command:${proposal.proposalId}`,
        proposal.type,
        proposal.parameters,
        proposal.targetReference?.reference,
      );
    },
    projectResult(_command, result) {
      const value = result as { bounds: ApplicationData };
      return { resultingBounds: value.bounds };
    },
  });
  const input = proposal('proposal-1');

  const first = bridge.executeProposal(input);
  const repeated = bridge.executeProposal(structuredClone(input));
  assert.strictEqual(repeated, first);
  const receipt = await first;
  assert.deepEqual(receipt, {
    schemaVersion: 'desktop-char.application-command-receipt.v1',
    receiptId: 'receipt:proposal-1',
    proposalId: 'proposal-1',
    commandId: 'command:proposal-1',
    type: 'session.window.place',
    status: 'succeeded',
    completedAtMs: 6_000,
    result: {
      resultingBounds: { x: 0, y: 0, width: 960, height: 540 },
    },
  });
  assert.doesNotMatch(JSON.stringify(receipt), /hwnd|must-not-reach-agent/u);
  assert.deepEqual(bridge.getReceipts(), [receipt]);
});

test('the agent bridge converts compilation failures into rejected receipts', async () => {
  const runtime = new ApplicationCommandRuntime();
  const bridge = new AgentApplicationCommandBridge({
    runtime,
    now: () => 7_000,
    receiptIdFactory: proposalId => `receipt:${proposalId}`,
    compileProposal() {
      throw new Error('候选目标不明确');
    },
    projectResult: (_command, result) => result,
    projectError: (_error, phase) => ({
      code: phase === 'compile' ? 'confirmation-required' : 'operation-failed',
      message: '需要确认目标窗口',
    }),
  });

  assert.deepEqual(await bridge.executeProposal(proposal('proposal-ambiguous')), {
    schemaVersion: 'desktop-char.application-command-receipt.v1',
    receiptId: 'receipt:proposal-ambiguous',
    proposalId: 'proposal-ambiguous',
    type: 'session.window.place',
    status: 'rejected',
    completedAtMs: 7_000,
    error: {
      code: 'confirmation-required',
      message: '需要确认目标窗口',
    },
  });
});

test('the agent bridge reports a pre-aborted proposal as cancelled without compiling it', async () => {
  const runtime = new ApplicationCommandRuntime();
  let compiled = false;
  const bridge = new AgentApplicationCommandBridge({
    runtime,
    now: () => 8_000,
    receiptIdFactory: proposalId => `receipt:${proposalId}`,
    compileProposal() {
      compiled = true;
      throw new Error('must not compile');
    },
    projectResult: (_command, result) => result,
  });
  const controller = new AbortController();
  controller.abort(new Error('caller cancelled'));

  const receipt = await bridge.executeProposal(proposal('proposal-cancelled'), {
    signal: controller.signal,
  });
  assert.equal(compiled, false);
  assert.equal(receipt.status, 'cancelled');
  assert.equal(receipt.error?.code, 'cancelled');
});

function query(
  type: string,
  parameters: ApplicationData = {},
  targetId?: string,
): ApplicationQuery {
  return {
    schemaVersion: 'desktop-char.application-query.v1',
    type,
    parameters,
    contextRevision: 1,
    ...(targetId ? { target: { kind: 'session', id: targetId } } : {}),
  };
}

function command(
  commandId: string,
  type: string,
  parameters: ApplicationData = {},
  targetId?: string,
): ApplicationCommand {
  return {
    schemaVersion: 'desktop-char.application-command.v1',
    commandId,
    type,
    parameters,
    contextRevision: 1,
    ...(targetId ? { target: { kind: 'session', id: targetId } } : {}),
  };
}

function proposal(proposalId: string): ApplicationCommandProposal {
  return {
    schemaVersion: 'desktop-char.application-command-proposal.v1',
    proposalId,
    type: 'session.window.place',
    parameters: { placement: 'top-left' },
    contextRevision: 1,
    confidence: 0.95,
    targetReference: { kind: 'session', reference: 'session-1' },
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  throw new Error('Condition was not reached');
}
