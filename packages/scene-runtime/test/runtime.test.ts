import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SceneRuntime,
  resolveSceneActors,
  type SceneBehavior,
  type SceneRuntimeEffect,
} from '../src/index.ts';
import { actor, mounted, part, slot } from './helpers.ts';

class Effects {
  readonly values: SceneRuntimeEffect[] = [];

  execute(effect: SceneRuntimeEffect): void {
    this.values.push(effect);
  }
}

test('scene replacement and invalid transactions are atomic', () => {
  const effects = new Effects();
  const runtime = new SceneRuntime({ effects });
  runtime.dispatch({
    type: 'scene.replace-requested',
    scene: { id: 'base', actors: [actor({ id: 'root' })], relations: [] },
  });

  const before = runtime.getSnapshot();
  assert.equal(before.generation, 1);
  assert.equal(before.revision, 0);
  assert.equal(effects.values.at(-1)?.type, 'scene.render-frame');
  assert.throws(() => runtime.dispatch({
    type: 'scene.transaction-requested',
    transaction: {
      id: 'invalid',
      generation: 1,
      operations: [
        { type: 'spawn-actor', actor: actor({ id: 'temporary' }) },
        {
          type: 'create-relation',
          relation: {
            id: 'broken',
            type: 'capability-binding',
            participants: { target: { actorId: 'root' } },
            constraints: [{ type: 'require-capability', actorRole: 'target', capability: 'missing' }],
            state: {},
          },
        },
      ],
    },
  }), /does not provide required capability/);

  assert.strictEqual(runtime.getSnapshot(), before);
  assert.equal(runtime.getSnapshot().actors.temporary, undefined);
  assert.equal(effects.values.length, 1);
});

test('generic slot bindings resolve transforms and enforce capacity', () => {
  const runtime = new SceneRuntime();
  const host = actor({ id: 'host', transform: { x: 4 }, slots: [slot('mount', 6)] });
  runtime.dispatch({
    type: 'scene.replace-requested',
    scene: {
      id: 'bound',
      actors: [host, actor({ id: 'subject', transform: { x: 2 } })],
      relations: [mounted('membership-a', 'subject', 'host', 'mount')],
    },
  });
  const subject = resolveSceneActors(runtime.getSnapshot().actors, runtime.getSnapshot().relations)
    .find(candidate => candidate.actorId === 'subject');
  assert.equal(subject?.transform.x, 12);

  assert.throws(() => runtime.dispatch({
    type: 'scene.transaction-requested',
    transaction: {
      id: 'over-capacity',
      generation: 1,
      operations: [
        { type: 'spawn-actor', actor: actor({ id: 'other' }) },
        { type: 'create-relation', relation: mounted('membership-b', 'other', 'host', 'mount') },
      ],
    },
  }), /capacity 1 is exceeded/);
  assert.equal(runtime.getSnapshot().actors.other, undefined);
});

test('moving an actor between slots commits as one observable revision', () => {
  const runtime = new SceneRuntime();
  runtime.dispatch({
    type: 'scene.replace-requested',
    scene: {
      id: 'transfer',
      actors: [
        actor({ id: 'source', slots: [slot('content', 10)] }),
        actor({ id: 'destination', slots: [slot('content', 30)] }),
        actor({ id: 'item' }),
      ],
      relations: [mounted('location-a', 'item', 'source', 'content')],
    },
  });
  const revisions: number[] = [];
  const unsubscribe = runtime.subscribe(snapshot => revisions.push(snapshot.revision));
  runtime.dispatch({
    type: 'scene.transaction-requested',
    transaction: {
      id: 'move',
      generation: 1,
      operations: [
        { type: 'remove-relation', relationId: 'location-a' },
        { type: 'create-relation', relation: mounted('location-b', 'item', 'destination', 'content') },
      ],
    },
  });
  unsubscribe();

  assert.deepEqual(revisions, [0, 1]);
  assert.equal(runtime.getSnapshot().relations['location-a'], undefined);
  assert.ok(runtime.getSnapshot().relations['location-b']);
  assert.equal(
    resolveSceneActors(runtime.getSnapshot().actors, runtime.getSnapshot().relations)
      .find(candidate => candidate.actorId === 'item')?.transform.x,
    30,
  );
});

test('registered behavior maps interaction to mode changes and capability effects', () => {
  const effects = new Effects();
  const behavior: SceneBehavior = {
    handle(event, context) {
      if (event.type !== 'interaction' || event.name !== 'activate') return;
      return {
        operations: [{ type: 'set-behavior-mode', actorId: context.actor.id, mode: 'engaged' }],
        invocations: [{
          actorId: 'target',
          capability: 'respond',
          command: 'begin',
          data: { source: context.actor.id },
        }],
      };
    },
  };
  const runtime = new SceneRuntime({ behaviors: { interactive: behavior }, effects });
  runtime.dispatch({
    type: 'scene.replace-requested',
    scene: {
      id: 'behavior',
      actors: [
        actor({ id: 'trigger', behavior: { type: 'interactive', mode: 'available', config: {} } }),
        actor({ id: 'target', capabilities: ['respond'] }),
      ],
      relations: [],
    },
  });
  runtime.dispatch({
    type: 'actor.interacted',
    generation: 1,
    actorId: 'trigger',
    interaction: 'activate',
  });

  assert.equal(runtime.getSnapshot().actors.trigger?.behavior?.mode, 'engaged');
  assert.deepEqual(effects.values.at(-1), {
    type: 'actor.capability-command',
    generation: 1,
    actorId: 'target',
    capability: 'respond',
    command: 'begin',
    data: { source: 'trigger' },
  });
});

test('stale events cannot mutate a replacement scene even when actor ids are reused', () => {
  const runtime = new SceneRuntime({
    behaviors: {
      mutable: {
        handle: () => ({ operations: [{ type: 'patch-actor-state', actorId: 'same-id', patch: { changed: true } }] }),
      },
    },
  });
  const definition = () => ({
    id: 'scene',
    actors: [actor({ id: 'same-id', behavior: { type: 'mutable', mode: 'idle', config: {} } })],
    relations: [],
  });
  runtime.dispatch({ type: 'scene.replace-requested', scene: definition() });
  runtime.dispatch({ type: 'scene.replace-requested', scene: definition() });
  const accepted = runtime.dispatch({
    type: 'actor.event',
    generation: 1,
    actorId: 'same-id',
    name: 'late',
  });
  assert.equal(accepted, false);
  assert.deepEqual(runtime.getSnapshot().actors['same-id']?.state, {});
});

test('fragments add and remove generic scene content as atomic units', () => {
  const runtime = new SceneRuntime();
  runtime.dispatch({
    type: 'scene.replace-requested',
    scene: { id: 'base', actors: [actor({ id: 'root', slots: [slot('extension', 2)] })], relations: [] },
  });
  runtime.dispatch({
    type: 'scene.fragment-apply-requested',
    generation: 1,
    fragment: {
      id: 'optional-content',
      actors: [actor({ id: 'addition', renderParts: [part('surface')] })],
      relations: [mounted('fragment-membership', 'addition', 'root', 'extension')],
    },
  });
  assert.equal(runtime.getSnapshot().revision, 1);
  assert.ok(runtime.getSnapshot().actors.addition);
  assert.deepEqual(runtime.getSnapshot().fragments['optional-content']?.actorIds, ['addition']);

  runtime.dispatch({ type: 'scene.fragment-remove-requested', generation: 1, fragmentId: 'optional-content' });
  assert.equal(runtime.getSnapshot().revision, 2);
  assert.equal(runtime.getSnapshot().actors.addition, undefined);
  assert.equal(runtime.getSnapshot().relations['fragment-membership'], undefined);
  assert.equal(runtime.getSnapshot().fragments['optional-content'], undefined);
});

test('lifecycle ownership can cascade without introducing business-specific actor types', () => {
  const runtime = new SceneRuntime();
  runtime.dispatch({
    type: 'scene.replace-requested',
    scene: {
      id: 'ownership',
      actors: [actor({ id: 'owner' }), actor({ id: 'dependent' }), actor({ id: 'independent' })],
      relations: [{
        id: 'ownership-link',
        type: 'lifecycle-ownership',
        participants: { child: { actorId: 'dependent' }, parent: { actorId: 'owner' } },
        constraints: [{ type: 'destroy-with', subjectRole: 'child', ownerRole: 'parent' }],
        state: {},
      }],
    },
  });
  runtime.dispatch({
    type: 'scene.transaction-requested',
    transaction: {
      id: 'remove-owner',
      generation: 1,
      operations: [{ type: 'destroy-actor', actorId: 'owner' }],
    },
  });

  assert.equal(runtime.getSnapshot().actors.owner, undefined);
  assert.equal(runtime.getSnapshot().actors.dependent, undefined);
  assert.ok(runtime.getSnapshot().actors.independent);
  assert.equal(runtime.getSnapshot().relations['ownership-link'], undefined);
});
