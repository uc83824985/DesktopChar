import assert from 'node:assert/strict';
import test from 'node:test';
import { FakeLive2DCore, Live2DRenderer } from '../src/index.ts';
import type { CoreModelDescriptor, Live2DCoreModel, Live2DCoreModelPort } from '../src/index.ts';

const descriptor: CoreModelDescriptor = {
  parameters: [
    { id: 'ParamA', minimum: 0, maximum: 1, defaultValue: 0 },
    { id: 'ParamAngleX', minimum: -30, maximum: 30, defaultValue: 0 },
    { id: 'ParamAngleY', minimum: -30, maximum: 30, defaultValue: 0 },
  ],
  aliases: { ParamMouthOpenY: 'ParamA' },
  emotions: { happy: 'exp_01' },
  actions: { nod: 'TapBody' },
  hitAreas: ['Head'],
};

test('discovers capabilities and applies aliased, clamped parameters', async () => {
  const core = new FakeLive2DCore({ mao: descriptor });
  const renderer = new Live2DRenderer(core);
  const capabilities = await renderer.load({ id: 'mao', modelJsonUrl: '/mao.model3.json' });
  assert.equal(capabilities.supportsMouthForm, false);
  assert.equal(capabilities.supportsGaze, true);
  assert.equal(capabilities.supportsHitTest, true);
  assert.deepEqual(capabilities.actions, ['nod']);
  renderer.applyFrame({ ParamMouthOpenY: 3, Unknown: 1 });
  assert.deepEqual([...core.models.get('mao')!.values], [['ParamA', 1]]);
});

test('delegates motion, hit testing, resize, and unload lifecycle', async () => {
  const core = new FakeLive2DCore({ mao: descriptor });
  const renderer = new Live2DRenderer(core);
  await renderer.load({ id: 'mao', modelJsonUrl: '/mao.model3.json' });
  assert.equal((await renderer.playMotion({ actionId: 'a', action: 'nod', priority: 1 })).completed, true);
  assert.equal((await renderer.playMotion({ actionId: 'b', action: 'greet', priority: 1 })).completed, false);
  assert.deepEqual(renderer.hitTest(0, 0), ['Head']);
  renderer.resize(800, 600);
  assert.deepEqual(core.models.get('mao')!.size, { width: 800, height: 600 });
  await renderer.unload();
  assert.equal(core.models.get('mao')!.disposed, true);
  assert.throws(() => renderer.applyFrame({ ParamA: 1 }), /not loaded/);
});

test('disposes a stale asynchronous model load', async () => {
  let resolveFirst!: (model: Live2DCoreModel) => void;
  const first = new Promise<Live2DCoreModel>(resolve => { resolveFirst = resolve; });
  const stale = new (await import('../src/index.ts')).FakeLive2DModel(descriptor);
  const current = new (await import('../src/index.ts')).FakeLive2DModel(descriptor);
  const core: Live2DCoreModelPort = {
    load: source => source.id === 'first' ? first : Promise.resolve(current),
  };
  const renderer = new Live2DRenderer(core);
  const oldLoad = renderer.load({ id: 'first', modelJsonUrl: '/first' });
  await renderer.load({ id: 'second', modelJsonUrl: '/second' });
  resolveFirst(stale);
  await assert.rejects(oldLoad, /superseded/);
  assert.equal(stale.disposed, true);
  assert.equal(current.disposed, false);
});

test('rejects invalid viewport dimensions', async () => {
  const renderer = new Live2DRenderer(new FakeLive2DCore({ mao: descriptor }));
  await renderer.load({ id: 'mao', modelJsonUrl: '/mao' });
  assert.throws(() => renderer.resize(0, 600), RangeError);
});
