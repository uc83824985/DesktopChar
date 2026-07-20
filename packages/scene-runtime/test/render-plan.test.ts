import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SceneRuntime,
  buildSceneRenderFrame,
  IDENTITY_SCENE_TRANSFORM,
  type SceneRelation,
} from '../src/index.ts';
import { actor, part, slot } from './helpers.ts';

test('render bands place actor parts between split host parts while preserving unsplit depth proxies', () => {
  const host = actor({
    id: 'host',
    slots: [slot('band', 0, 1, { after: ['rear'], before: ['front'] })],
    renderParts: [part('rear', { tieBreaker: 0 }), part('front', { tieBreaker: 2 })],
  });
  const subject = actor({ id: 'subject', renderParts: [part('body', { tieBreaker: 1 })] });
  const unsplit = actor({
    id: 'proxy',
    renderParts: [part('single-surface', { depth: { type: 'box', width: 2, height: 1, depth: 0.5 } })],
  });
  const relation: SceneRelation = {
    id: 'render-membership',
    type: 'spatial-membership',
    participants: { subject: { actorId: 'subject' }, host: { actorId: 'host', slotId: 'band' } },
    constraints: [{ type: 'insert-render-band', subjectRole: 'subject', slotRole: 'host' }],
    state: {},
  };
  const runtime = new SceneRuntime();
  runtime.dispatch({
    type: 'scene.replace-requested',
    scene: { id: 'render', actors: [host, subject, unsplit], relations: [relation] },
  });
  const frame = buildSceneRenderFrame(runtime.getSnapshot());
  const ids = frame.drawItems.map(item => item.id);

  assert.ok(ids.indexOf('host:rear') < ids.indexOf('subject:body'));
  assert.ok(ids.indexOf('subject:body') < ids.indexOf('host:front'));
  assert.deepEqual(frame.orderEdges, [
    { before: 'host:rear', after: 'subject:body' },
    { before: 'subject:body', after: 'host:front' },
  ]);
  const proxy = frame.drawItems.filter(item => item.actorId === 'proxy');
  assert.equal(proxy.length, 1);
  assert.equal(proxy[0]?.depth.type, 'box');
});

test('coverage picking is opt-in per visible render part and keeps material features data-only', () => {
  const runtime = new SceneRuntime();
  runtime.dispatch({
    type: 'scene.replace-requested',
    scene: {
      id: 'picking',
      actors: [
        actor({
          id: 'passive',
          renderParts: [part('background', {
            group: 'background',
            interaction: { enabled: false, coverage: 'none' },
          })],
        }),
        actor({
          id: 'interactive',
          renderParts: [part('surface', {
            interaction: { enabled: true, coverage: 'alpha', alphaThreshold: 0.2, semanticId: 'primary' },
            material: { feature: 'custom-surface', properties: { gain: 0.8 } },
          })],
        }),
        actor({ id: 'hidden', visible: false, renderParts: [part('never-drawn')] }),
      ],
      relations: [],
    },
  });
  const frame = buildSceneRenderFrame(runtime.getSnapshot());
  const passive = frame.drawItems.find(item => item.actorId === 'passive');
  const interactive = frame.drawItems.find(item => item.actorId === 'interactive');

  assert.equal(passive?.pickingId, 0);
  assert.equal(interactive?.pickingId, 1);
  assert.deepEqual(interactive?.material, { feature: 'custom-surface', properties: { gain: 0.8 } });
  assert.equal(frame.drawItems.some(item => item.actorId === 'hidden'), false);
  assert.deepEqual(frame.passes.map(pass => pass.id), [
    'actor-surfaces',
    'world-depth-composite',
    'coverage-picking',
    'overlay-composite',
  ]);
});

test('invalid depth geometry and transform-binding cycles are rejected before rendering', () => {
  const runtime = new SceneRuntime();
  assert.throws(() => runtime.dispatch({
    type: 'scene.replace-requested',
    scene: {
      id: 'bad-depth',
      actors: [actor({
        id: 'invalid',
        renderParts: [part('surface', { depth: { type: 'box', width: 0, height: 1, depth: 1 } })],
      })],
      relations: [],
    },
  }), /width must be positive/);

  const bind = (id: string, subject: string, target: string): SceneRelation => ({
    id,
    type: 'binding',
    participants: { subject: { actorId: subject }, target: { actorId: target } },
    constraints: [{
      type: 'bind-transform',
      subjectRole: 'subject',
      targetRole: 'target',
      offset: IDENTITY_SCENE_TRANSFORM,
    }],
    state: {},
  });
  assert.throws(() => runtime.dispatch({
    type: 'scene.replace-requested',
    scene: {
      id: 'cycle',
      actors: [actor({ id: 'a' }), actor({ id: 'b' })],
      relations: [bind('a-to-b', 'a', 'b'), bind('b-to-a', 'b', 'a')],
    },
  }), /Transform binding cycle/);
  assert.equal(runtime.getSnapshot().generation, 0);
});
