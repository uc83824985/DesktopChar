import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SceneRuntime,
  buildSceneRenderFrame,
  routeSceneUiEvent,
  type SceneRuntimeEffect,
  type SceneUiSurfaceDefinition,
} from '../src/index.ts';
import { actor } from './helpers.ts';

function uiSurface(
  id: string,
  overrides: Partial<SceneUiSurfaceDefinition> = {},
): SceneUiSurfaceDefinition {
  return {
    id,
    presenter: `app.${id}`,
    layer: 'screen-overlay',
    order: 0,
    input: 'pass-through',
    events: {},
    config: {},
    ...overrides,
  };
}

test('UI surfaces project actor state into deterministic presentation layers', () => {
  const runtime = new SceneRuntime();
  runtime.dispatch({
    type: 'scene.replace-requested',
    scene: {
      id: 'ui-projection',
      actors: [
        actor({
          id: 'avatar',
          transform: { x: 12, y: 8 },
          state: { status: 'thinking', progress: 0.5 },
          behavior: { type: 'avatar', mode: 'busy', config: {} },
          uiSurfaces: [
            uiSurface('status', {
              presenter: 'desktop.avatar-status',
              order: 10,
              input: 'surface',
              events: { click: 'open-status' },
              config: { compact: true },
            }),
            uiSurface('nameplate', {
              presenter: 'desktop.nameplate',
              layer: 'world-underlay',
              order: 5,
            }),
          ],
        }),
        actor({
          id: 'dialog',
          uiSurfaces: [uiSurface('confirm', {
            presenter: 'desktop.confirmation',
            layer: 'modal',
            input: 'modal',
            events: { confirm: 'confirm', cancel: 'cancel' },
          })],
        }),
        actor({
          id: 'hidden',
          visible: false,
          uiSurfaces: [uiSurface('never-projected')],
        }),
      ],
      relations: [],
    },
  });

  const frame = buildSceneRenderFrame(runtime.getSnapshot());
  assert.deepEqual(frame.uiSurfaces.map(surface => surface.id), [
    'avatar:nameplate',
    'avatar:status',
    'dialog:confirm',
  ]);
  const status = frame.uiSurfaces[1]!;
  assert.equal(status.presenter, 'desktop.avatar-status');
  assert.deepEqual(status.actorState, { status: 'thinking', progress: 0.5 });
  assert.equal(status.behaviorMode, 'busy');
  assert.equal(status.transform.x, 12);
  assert.deepEqual(status.config, { compact: true });
});

test('stationary UI renderers only return facts and Runtime state drives later frames', () => {
  const effects: SceneRuntimeEffect[] = [];
  const runtime = new SceneRuntime({ effects: { execute: effect => { effects.push(effect); } } });
  runtime.dispatch({
    type: 'scene.replace-requested',
    scene: {
      id: 'dynamic-ui',
      actors: [actor({
        id: 'avatar',
        state: { status: 'idle' },
        uiSurfaces: [uiSurface('status', {
          input: 'surface',
          events: { activate: 'show-details' },
        })],
      })],
      relations: [],
    },
  });
  runtime.dispatch({
    type: 'scene.transaction-requested',
    transaction: {
      id: 'speaking-ui',
      generation: 1,
      operations: [{ type: 'patch-actor-state', actorId: 'avatar', patch: { status: 'speaking' } }],
    },
  });

  const frames = effects
    .filter((effect): effect is Extract<SceneRuntimeEffect, { type: 'scene.render-frame' }> => effect.type === 'scene.render-frame')
    .map(effect => effect.frame);
  assert.equal(frames.length, 2);
  assert.equal(frames[0]?.uiSurfaces[0]?.actorState.status, 'idle');
  assert.equal(frames[1]?.uiSurfaces[0]?.actorState.status, 'speaking');
  assert.equal(frames[1]?.revision, 1);

  const event = routeSceneUiEvent(frames[1]!, 'avatar:status', 'activate', { source: 'pointer' });
  assert.deepEqual(event, {
    type: 'actor.interacted',
    generation: 1,
    actorId: 'avatar',
    interaction: 'show-details',
    data: { source: 'pointer' },
  });
  assert.equal(routeSceneUiEvent(frames[1]!, 'avatar:status', 'unknown'), undefined);

  runtime.dispatch({
    type: 'scene.transaction-requested',
    transaction: {
      id: 'hide-avatar-ui',
      generation: 1,
      operations: [{ type: 'set-actor-visible', actorId: 'avatar', visible: false }],
    },
  });
  const hiddenFrame = (effects.at(-1) as Extract<SceneRuntimeEffect, { type: 'scene.render-frame' }>).frame;
  assert.deepEqual(hiddenFrame.uiSurfaces, []);
});

test('invalid UI declarations are rejected before replacing scene state', () => {
  const runtime = new SceneRuntime();
  assert.throws(() => runtime.dispatch({
    type: 'scene.replace-requested',
    scene: {
      id: 'invalid-ui',
      actors: [actor({
        id: 'panel',
        uiSurfaces: [
          uiSurface('duplicate'),
          uiSurface('duplicate'),
        ],
      })],
      relations: [],
    },
  }), /Duplicate Actor "panel" UI surface id/);
  assert.equal(runtime.getSnapshot().sceneId, null);

  assert.throws(() => runtime.dispatch({
    type: 'scene.replace-requested',
    scene: {
      id: 'invalid-input',
      actors: [actor({
        id: 'panel',
        uiSurfaces: [uiSurface('passive', { events: { click: 'unexpected' } })],
      })],
      relations: [],
    },
  }), /cannot declare events while input is pass-through/);
  assert.equal(runtime.getSnapshot().sceneId, null);
});
