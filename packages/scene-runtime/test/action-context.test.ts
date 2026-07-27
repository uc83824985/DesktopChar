import assert from 'node:assert/strict';
import test from 'node:test';
import { projectSceneActionContext, SceneRuntime } from '../src/index.ts';

test('SceneRuntime owns context while AvatarRuntime receives only a versioned projection', () => {
  const runtime = new SceneRuntime();
  runtime.dispatch({
    type: 'scene.replace-requested',
    scene: {
      id: 'relaxed-desktop',
      actors: [],
      relations: [],
      actionContext: {
        tags: ['desktop', 'relaxed'],
        posture: 'standing',
        allowedActionTags: ['ambient', 'social'],
        blockedActionTags: ['sleeping'],
        triggerChanceMultipliers: { 'conversation.completed': 3 },
      },
    },
  });
  const projection = projectSceneActionContext(runtime.getSnapshot());
  assert.deepEqual(projection, {
    generation: 1,
    revision: 0,
    sceneId: 'relaxed-desktop',
    tags: ['desktop', 'relaxed'],
    posture: 'standing',
    allowedActionTags: ['ambient', 'social'],
    blockedActionTags: ['sleeping'],
    triggerChanceMultipliers: { 'conversation.completed': 3 },
  });
  assert.equal('actors' in projection, false);
  assert.equal('relations' in projection, false);
});

test('invalid scene action context is rejected atomically', () => {
  const runtime = new SceneRuntime();
  const before = runtime.getSnapshot();
  assert.throws(() => runtime.dispatch({
    type: 'scene.replace-requested',
    scene: {
      id: 'invalid',
      actors: [],
      relations: [],
      actionContext: {
        tags: ['desktop'],
        allowedActionTags: ['ambient'],
        blockedActionTags: ['ambient'],
        triggerChanceMultipliers: {},
      },
    },
  }), /both allow and block/);
  assert.strictEqual(runtime.getSnapshot(), before);
});

test('scene trigger chance multipliers must be finite and non-negative', () => {
  const runtime = new SceneRuntime();
  const before = runtime.getSnapshot();
  assert.throws(() => runtime.dispatch({
    type: 'scene.replace-requested',
    scene: {
      id: 'invalid-multiplier',
      actors: [],
      relations: [],
      actionContext: {
        tags: ['desktop'],
        allowedActionTags: [],
        blockedActionTags: [],
        triggerChanceMultipliers: { 'conversation.completed': -1 },
      },
    },
  }), /trigger multiplier/);
  assert.strictEqual(runtime.getSnapshot(), before);
});
