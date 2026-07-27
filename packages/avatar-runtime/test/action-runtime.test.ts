import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  ActionDescriptor,
  CharacterActionCatalog,
  SceneActionContext,
} from '../../contracts/src/index.ts';
import { ActionRuntime } from '../src/action-runtime.ts';

const defaultScene: SceneActionContext = {
  generation: 1,
  revision: 0,
  sceneId: 'desktop',
  tags: ['desktop', 'relaxed'],
  posture: 'standing',
  allowedActionTags: [],
  blockedActionTags: [],
  triggerChanceMultipliers: {},
};

test('asset applicability and scene context form a hard eligibility intersection', () => {
  const runtime = new ActionRuntime(catalog([
    descriptor('standing-wave', ['social'], { postures: ['standing'], anyTags: ['desktop'] }),
    descriptor('seated-wave', ['social'], { postures: ['seated'], anyTags: ['desktop'] }),
  ]), defaultScene);

  const transition = runtime.request({
    requestId: 'scene-1',
    source: 'scene',
    trigger: 'ambient.opportunity',
    mode: 'optional',
    occurredAtMs: 1_000,
    selectionRandomValue: 0,
    chanceRandomValue: 0,
    semanticTags: ['social'],
  }, environment());

  assert.equal(transition.selectedActionId, 'standing-wave');
  assert.deepEqual(transition.effects[0], {
    type: 'renderer.play-motion',
    generation: 2,
    command: {
      requestId: 'scene-1',
      actionId: 'standing-wave',
      binding: {
        type: 'live2d-motion',
        group: 'TapBody',
        index: 0,
        mode: 'once',
        expectedDurationMs: 1000,
      },
      priority: 10,
    },
  });
});

test('required intent bypasses chance while optional opportunity evaluates it once', () => {
  const action = descriptor('rare-action', ['ambient'], {}, 0);
  const optionalRuntime = new ActionRuntime(catalog([action]), defaultScene);
  const optional = optionalRuntime.request({
    requestId: 'optional',
    source: 'scene',
    trigger: 'ambient.opportunity',
    mode: 'optional',
    occurredAtMs: 1_000,
    selectionRandomValue: 0.5,
    chanceRandomValue: 0.5,
    semanticTags: ['ambient'],
  }, environment());
  assert.equal(optional.rejection, 'no-eligible-action');

  const requiredRuntime = new ActionRuntime(catalog([action]), defaultScene);
  const required = requiredRuntime.request({
    requestId: 'required',
    source: 'scene',
    trigger: 'ambient.opportunity',
    mode: 'required',
    occurredAtMs: 1_000,
    selectionRandomValue: 0.5,
    chanceRandomValue: 0.5,
    requestedActionId: 'rare-action',
  }, environment());
  assert.equal(required.selectedActionId, 'rare-action');
});

test('Renderer completion advances the queue and scene changes invalidate stale queued actions', () => {
  const first = descriptor('first', ['ambient'], {}, 1, 'enqueue');
  const second = descriptor('second', ['social'], { anyTags: ['relaxed'] }, 1, 'enqueue');
  const runtime = new ActionRuntime(catalog([first, second]), defaultScene);
  runtime.request(intent('r1', 'first', 1_000), environment());
  const queued = runtime.request(intent('r2', 'second', 1_100), environment());
  assert.equal(queued.gesture.queueLength, 1);

  runtime.updateSceneContext({
    ...defaultScene,
    revision: 1,
    tags: ['desktop', 'focused'],
  });
  const completed = runtime.complete('r1', 2_000, environment());
  assert.equal(completed.effects.length, 0);
  assert.deepEqual(completed.gesture, { requestId: null, actionId: null, queueLength: 0 });
});

test('cooldown is recorded from actual Renderer completion rather than request time', () => {
  const action = { ...descriptor('cooldown', ['ambient']), cooldownMs: 1_000 };
  const runtime = new ActionRuntime(catalog([action]), defaultScene);
  runtime.request(intent('r1', 'cooldown', 100), environment());
  runtime.complete('r1', 1_000, environment());
  const rejected = runtime.request(intent('r2', 'cooldown', 1_999), environment());
  assert.equal(rejected.rejection, 'no-eligible-action');
  const accepted = runtime.request(intent('r3', 'cooldown', 2_000), environment());
  assert.equal(accepted.selectedActionId, 'cooldown');
});

test('independent selection and chance samples keep every weighted ambient candidate reachable', () => {
  const descriptors = [
    descriptor('wave', ['ambient'], {}, 0.18, 'enqueue', 1),
    descriptor('sway', ['ambient'], {}, 0.14, 'enqueue', 1.2),
    descriptor('hat', ['ambient'], {}, 0.12, 'enqueue', 0.9),
  ];
  const selections = [
    [0.1, 'wave'],
    [0.5, 'sway'],
    [0.9, 'hat'],
  ] as const;
  for (const [selectionRandomValue, expected] of selections) {
    const runtime = new ActionRuntime(catalog(descriptors), defaultScene);
    const transition = runtime.request({
      requestId: expected,
      source: 'scene',
      trigger: 'ambient.opportunity',
      mode: 'optional',
      occurredAtMs: 1_000,
      selectionRandomValue,
      chanceRandomValue: 0,
      semanticTags: ['ambient'],
    }, environment());
    assert.equal(transition.selectedActionId, expected);
  }
});

test('weighted candidate selection produces the configured aggregate chance', () => {
  const descriptors = [
    descriptor('wave', ['ambient'], {}, 0.2, 'enqueue', 1),
    descriptor('sway', ['ambient'], {}, 0.4, 'enqueue', 2),
    descriptor('hat', ['ambient'], {}, 0.8, 'enqueue', 1),
  ];
  let selected = 0;
  const sampleSteps = 100;
  for (let selectionIndex = 0; selectionIndex < sampleSteps; selectionIndex++) {
    for (let chanceIndex = 0; chanceIndex < sampleSteps; chanceIndex++) {
      const runtime = new ActionRuntime(catalog(descriptors), defaultScene);
      const transition = runtime.request({
        requestId: `${selectionIndex}:${chanceIndex}`,
        source: 'scene',
        trigger: 'ambient.opportunity',
        mode: 'optional',
        occurredAtMs: 1_000,
        selectionRandomValue: (selectionIndex + 0.5) / sampleSteps,
        chanceRandomValue: (chanceIndex + 0.5) / sampleSteps,
        semanticTags: ['ambient'],
      }, environment());
      if (transition.selectedActionId) selected++;
    }
  }
  const successRate = selected / (sampleSteps * sampleSteps);
  const expectedRate = (0.2 * 1 + 0.4 * 2 + 0.8 * 1) / (1 + 2 + 1);
  assert.ok(
    Math.abs(successRate - expectedRate) <= 0.01,
    `expected aggregate rate ${expectedRate}, received ${successRate}`,
  );
});

test('scene context can significantly boost the same asset rule after conversation completion', () => {
  const action = descriptor('post-chat-wave', ['ambient'], {}, 0.18);
  action.triggers.push({
    ruleId: 'conversation',
    trigger: 'conversation.completed',
    mode: 'optional',
    chance: 0.18,
    weight: 1,
  });
  const intent = {
    requestId: 'post-chat',
    source: 'scene' as const,
    trigger: 'conversation.completed',
    mode: 'optional' as const,
    occurredAtMs: 1_000,
    selectionRandomValue: 0,
    chanceRandomValue: 0.4,
    semanticTags: ['ambient'],
  };
  const base = new ActionRuntime(catalog([action]), defaultScene).request(intent, environment());
  assert.equal(base.rejection, 'no-eligible-action');
  const boosted = new ActionRuntime(catalog([action]), {
    ...defaultScene,
    triggerChanceMultipliers: { 'conversation.completed': 3 },
  }).request(intent, environment());
  assert.equal(boosted.selectedActionId, 'post-chat-wave');
});

test('expression exclusions are hard eligibility rules even for required intents', () => {
  const runtime = new ActionRuntime(
    catalog([descriptor('idle-wave', ['ambient'])]),
    defaultScene,
  );
  const transition = runtime.request(
    intent('blocked', 'idle-wave', 1_000),
    { ...environment(), blockedActionTags: ['ambient'] },
  );

  assert.equal(transition.rejection, 'action-expression-conflict');
  assert.deepEqual(transition.effects, []);
  assert.deepEqual(transition.gesture, {
    requestId: null,
    actionId: null,
    queueLength: 0,
  });
});

test('expression changes stop an incompatible active action and discard incompatible queued work', () => {
  const active = { ...descriptor('active-ambient', ['ambient']), busyPolicy: 'enqueue' as const };
  const queued = { ...descriptor('queued-ambient', ['ambient']), busyPolicy: 'enqueue' as const };
  const runtime = new ActionRuntime(catalog([active, queued]), defaultScene);
  runtime.request(intent('active', 'active-ambient', 1_000), environment());
  runtime.request(intent('queued', 'queued-ambient', 1_100), environment());

  const transition = runtime.reconcile(
    1_200,
    { ...environment(), blockedActionTags: ['ambient'] },
  );

  assert.equal(transition.rejection, 'action-expression-conflict');
  assert.deepEqual(transition.effects, [{
    type: 'renderer.stop-motion',
    generation: 2,
    requestId: 'active',
    actionId: 'active-ambient',
  }]);
  assert.deepEqual(transition.gesture, {
    requestId: null,
    actionId: null,
    queueLength: 0,
  });
});

function descriptor(
  actionId: string,
  semanticTags: string[],
  scene: ActionDescriptor['scene'] = {},
  chance = 1,
  busyPolicy: ActionDescriptor['busyPolicy'] = 'enqueue',
  weight = 1,
): ActionDescriptor {
  return {
    actionId,
    label: actionId,
    semanticTags,
    prototypeTexts: [actionId],
    allowedAnchors: ['segment-start'],
    compatibleAvatarStates: ['idle'],
    scene,
    speech: 'deny',
    priority: 10,
    cooldownMs: 0,
    maxQueueAgeMs: 5_000,
    busyPolicy,
    triggers: [{
      ruleId: 'ambient',
      trigger: 'ambient.opportunity',
      mode: 'optional',
      chance,
      weight,
    }, {
      ruleId: 'scene',
      trigger: 'scene.action-requested',
      mode: 'required',
      chance: 1,
      weight: 1,
    }],
  };
}

function catalog(descriptors: ActionDescriptor[]): CharacterActionCatalog {
  return {
    revision: 1,
    descriptors,
    bindings: Object.fromEntries(descriptors.map((descriptor, index) => [
      descriptor.actionId,
      {
        type: 'live2d-motion' as const,
        group: 'TapBody',
        index,
        mode: 'once' as const,
        expectedDurationMs: 1_000,
      },
    ])),
  };
}

function environment() {
  return {
    generation: 2,
    avatarState: 'idle' as const,
    speechActive: false,
    blockedActionTags: [],
  };
}

function intent(requestId: string, requestedActionId: string, occurredAtMs: number) {
  return {
    requestId,
    source: 'scene' as const,
    trigger: 'scene.action-requested',
    mode: 'required' as const,
    occurredAtMs,
    selectionRandomValue: 0,
    chanceRandomValue: 0,
    requestedActionId,
  };
}
