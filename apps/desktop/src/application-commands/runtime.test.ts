import assert from 'node:assert/strict';
import test from 'node:test';
import type { ApplicationData } from '../../../../packages/application-command-runtime/src/index.ts';
import type { ConfiguredApplicationOperationGateway } from './configured-operation-binding.ts';
import { createDesktopApplicationCommandRuntime } from './runtime.ts';

test('session window query maps gateway arguments and projected bounds through config', async () => {
  const calls: Array<{ operation: string; argumentsValue: Record<string, ApplicationData> }> = [];
  const gateway: ConfiguredApplicationOperationGateway = {
    invoke(operation, argumentsValue) {
      calls.push({ operation, argumentsValue: structuredClone(argumentsValue) });
      return {
        window: {
          rectangle: { left: 120, top: 80, width: 960, height: 720 },
          display: 'display-2',
          version: 'window:7',
        },
      };
    },
  };
  const runtime = createDesktopApplicationCommandRuntime({
    gateway,
    config: config({
      'session.window.bounds': binding('inspect-window', {
        session: { source: 'target.id' },
        revision: { source: 'target.expectedRevision', required: false },
      }, {
        x: { source: 'window.rectangle.left' },
        y: { source: 'window.rectangle.top' },
        width: { source: 'window.rectangle.width' },
        height: { source: 'window.rectangle.height' },
        displayId: { source: 'window.display', required: false },
        revision: { source: 'window.version', required: false },
      }),
    }),
  });

  const result = await runtime.queries.execute({
    schemaVersion: 'desktop-char.application-query.v1',
    type: 'session.window.bounds',
    parameters: {},
    contextRevision: 4,
    target: { kind: 'conversation-session', id: 'external:session-2', expectedRevision: 'session:4' },
  });

  assert.deepEqual(calls, [{
    operation: 'inspect-window',
    argumentsValue: { session: 'external:session-2', revision: 'session:4' },
  }]);
  assert.deepEqual(result, {
    x: 120, y: 80, width: 960, height: 720,
    displayId: 'display-2', revision: 'window:7',
  });
});

test('session window place maps semantic parameters without knowing gateway field names', async () => {
  let received: Record<string, ApplicationData> | undefined;
  const runtime = createDesktopApplicationCommandRuntime({
    gateway: {
      invoke(operation, argumentsValue) {
        assert.equal(operation, 'arrange-conversation');
        received = structuredClone(argumentsValue);
        return {
          changed: true,
          current: { left: 0, top: 0, width: 800, height: 600, screen: 'primary', version: '8' },
        };
      },
    },
    config: config({
      'session.window.place': binding('arrange-conversation', {
        conversation: { source: 'target.id' },
        expected: { source: 'target.expectedRevision' },
        quadrant: { source: 'parameters.region' },
        screen: { source: 'parameters.displayId', required: false },
        margin: { source: 'parameters.marginDip', required: false },
        context: { source: 'contextRevision' },
      }, {
        applied: { source: 'changed' },
        'bounds.x': { source: 'current.left' },
        'bounds.y': { source: 'current.top' },
        'bounds.width': { source: 'current.width' },
        'bounds.height': { source: 'current.height' },
        'bounds.displayId': { source: 'current.screen', required: false },
        'bounds.revision': { source: 'current.version', required: false },
      }),
    }),
  });

  const result = await runtime.commands.execute({
    schemaVersion: 'desktop-char.application-command.v1',
    commandId: 'place:1',
    type: 'session.window.place',
    parameters: { region: 'top-left', displayId: 'primary', marginDip: 16 },
    contextRevision: 9,
    target: { kind: 'conversation-session', id: 'managed:thread-1', expectedRevision: '7' },
  });

  assert.deepEqual(received, {
    conversation: 'managed:thread-1', expected: '7', quadrant: 'top-left',
    screen: 'primary', margin: 16, context: 9,
  });
  assert.deepEqual(result, {
    applied: true,
    bounds: { x: 0, y: 0, width: 800, height: 600, displayId: 'primary', revision: '8' },
  });
});

test('hot configuration replaces bindings and missing required sources fail before gateway call', async () => {
  const operations: string[] = [];
  const runtime = createDesktopApplicationCommandRuntime({
    gateway: {
      invoke(operation) {
        operations.push(operation);
        return { x: 1, y: 2, width: 3, height: 4 };
      },
    },
    config: config({
      'session.window.bounds': binding('old-inspect', {
        session: { source: 'target.id' },
        revision: { source: 'target.expectedRevision' },
      }, boundsProjection()),
    }),
  });

  await assert.rejects(runtime.queries.execute(query('q1')), /source is missing/);
  assert.deepEqual(operations, []);
  runtime.configure(config({
    'session.window.bounds': binding('new-inspect', {
      session: { source: 'target.id' },
    }, boundsProjection()),
  }));
  await runtime.queries.execute(query('q1'));
  assert.deepEqual(operations, ['new-inspect']);
});

test('place binding must forward target identity and expected revision', () => {
  assert.throws(() => createDesktopApplicationCommandRuntime({
    gateway: { invoke: () => ({}) },
    config: config({
      'session.window.place': binding('unsafe-place', {
        session: { source: 'target.id' },
      }, {}),
    }),
  }), /expectedRevision/);
});

function query(id: string) {
  return {
    schemaVersion: 'desktop-char.application-query.v1' as const,
    type: 'session.window.bounds',
    parameters: {},
    contextRevision: 0,
    target: { kind: 'conversation-session', id },
  };
}

function config(bindings: Record<string, ReturnType<typeof binding>>) {
  return { bindings };
}

function binding(
  operation: string,
  argumentsValue: Record<string, { source: string; required?: boolean }>,
  result: Record<string, { source: string; required?: boolean }>,
) {
  return { operation, arguments: argumentsValue, result };
}

function boundsProjection() {
  return {
    x: { source: 'x' },
    y: { source: 'y' },
    width: { source: 'width' },
    height: { source: 'height' },
  };
}
