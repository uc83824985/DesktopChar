import assert from 'node:assert/strict';
import test from 'node:test';
import { ImmediateUiRegistry } from '../src/index.ts';

test('objects contribute immediate UI in deterministic order for a target', () => {
  const registry = new ImmediateUiRegistry();
  registry.register({
    id: 'window', target: '*', order: 100,
    build: () => ({ label: 'Window', items: [{ type: 'action', id: 'quit', label: 'Quit', invoke() {} }] }),
  });
  registry.register({
    id: 'avatar', target: 'avatar', order: 10,
    build: () => ({ label: 'Avatar', items: [{ type: 'action', id: 'reset', label: 'Reset', invoke() {} }] }),
  });

  assert.deepEqual(
    registry.resolve({ targetId: 'avatar', clientX: 0, clientY: 0 }).map(section => section.registrationId),
    ['avatar', 'window'],
  );
  assert.deepEqual(
    registry.resolve({ targetId: 'prop', clientX: 0, clientY: 0 }).map(section => section.registrationId),
    ['window'],
  );
});

test('providers read current owner state each time the UI is opened', () => {
  const registry = new ImmediateUiRegistry();
  let enabled = false;
  registry.register({
    id: 'avatar', target: 'avatar',
    build: () => ({
      items: [{ type: 'checkbox', id: 'gaze', label: 'Gaze', checked: enabled, invoke: value => { enabled = value; } }],
    }),
  });

  const first = registry.resolve({ targetId: 'avatar', clientX: 0, clientY: 0 });
  const checkbox = first[0]!.items[0]!;
  assert.equal(checkbox.type, 'checkbox');
  if (checkbox.type === 'checkbox') checkbox.invoke(true);
  const second = registry.resolve({ targetId: 'avatar', clientX: 0, clientY: 0 });
  assert.equal(second[0]!.items[0]!.type === 'checkbox' && second[0]!.items[0]!.checked, true);
});

test('registration disposal and duplicate validation are explicit', () => {
  const registry = new ImmediateUiRegistry();
  const dispose = registry.register({
    id: 'avatar', target: 'avatar',
    build: () => ({ items: [{ type: 'action', id: 'reset', label: 'Reset', invoke() {} }] }),
  });
  assert.throws(() => registry.register({ id: 'avatar', target: '*', build: () => null }), /already exists/);
  dispose();
  assert.deepEqual(registry.resolve({ targetId: 'avatar', clientX: 0, clientY: 0 }), []);

  registry.register({
    id: 'invalid', target: 'avatar',
    build: () => ({ items: [
      { type: 'action', id: 'same', label: 'One', invoke() {} },
      { type: 'action', id: 'same', label: 'Two', invoke() {} },
    ] }),
  });
  assert.throws(
    () => registry.resolve({ targetId: 'avatar', clientX: 0, clientY: 0 }),
    /duplicate item "same"/,
  );
});
