import assert from 'node:assert/strict';
import test from 'node:test';
import { createApplicationServiceTestRegistry } from './application-service-test-registry.mjs';

test('application service tests preserve registration order and isolate failures', async () => {
  const registry = createApplicationServiceTestRegistry([
    { id: 'performance', label: '表现推理', enabled: () => true, test: async () => '模型可用' },
    { id: 'character', label: '外部角色控制', enabled: () => false, test: async () => assert.fail() },
    { id: 'tts', label: '文本语音合成', enabled: () => true, test: async () => { throw new Error('设备离线'); } },
  ], { clock: () => '2026-08-04T00:00:00.000Z', now: incrementingClock() });

  const results = await registry.testAll();
  assert.deepEqual(results.map(item => [item.id, item.enabled, item.status]), [
    ['performance', true, 'passed'],
    ['character', false, 'skipped'],
    ['tts', true, 'failed'],
  ]);
  assert.equal(results[0].details, '模型可用');
  assert.equal(results[1].details, '服务未启用');
  assert.equal(results[2].details, '设备离线');
});

test('all enablement combinations remain terminal without invoking disabled services', async () => {
  for (let mask = 0; mask < 8; mask++) {
    const calls = [];
    const registry = createApplicationServiceTestRegistry(
      ['performance', 'character', 'tts'].map((id, index) => ({
        id,
        label: id,
        enabled: () => Boolean(mask & (1 << index)),
        test: async () => { calls.push(id); return 'ok'; },
      })),
    );
    const results = await registry.testAll();
    assert.equal(results.length, 3);
    assert.ok(results.every(item => item.status === (item.enabled ? 'passed' : 'skipped')));
    assert.deepEqual(calls.sort(), results.filter(item => item.enabled).map(item => item.id).sort());
  }
});

test('duplicate service ids fail during registration', () => {
  assert.throws(() => createApplicationServiceTestRegistry([
    { id: 'same', label: 'One', enabled: () => true, test: async () => 'ok' },
    { id: 'same', label: 'Two', enabled: () => true, test: async () => 'ok' },
  ]), /Duplicate/);
});

test('a broken enablement probe is isolated as one failed result', async () => {
  const registry = createApplicationServiceTestRegistry([
    { id: 'broken', label: 'Broken', enabled: () => { throw new Error('state unavailable'); }, test: async () => 'ok' },
    { id: 'healthy', label: 'Healthy', enabled: () => true, test: async () => 'ok' },
  ]);
  const results = await registry.testAll();
  assert.deepEqual(results.map(item => item.status), ['failed', 'passed']);
  assert.equal(results[0].details, 'state unavailable');
});

function incrementingClock() {
  let value = 0;
  return () => value++;
}
