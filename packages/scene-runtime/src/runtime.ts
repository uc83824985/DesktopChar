import { buildSceneRenderFrame } from './render-plan.ts';
import type {
  ActorCapabilityInvocation,
  ActiveSceneFragment,
  SceneActorDefinition,
  SceneBehavior,
  SceneBehaviorEvent,
  SceneDefinition,
  SceneFragmentDefinition,
  SceneOperation,
  SceneRelation,
  SceneRuntimeEffect,
  SceneRuntimeEvent,
  SceneSnapshot,
  SceneTransaction,
} from './types.ts';
import { validateSceneState, validateUniqueDefinitions } from './validation.ts';

export interface SceneRuntimeEffectExecutor {
  execute(effect: SceneRuntimeEffect, dispatch: (event: SceneRuntimeEvent) => boolean): void | Promise<void>;
}

export interface SceneRuntimeOptions {
  behaviors?: Readonly<Record<string, SceneBehavior>>;
  effects?: SceneRuntimeEffectExecutor;
  onEffectError?: (error: unknown, effect: SceneRuntimeEffect) => void;
}

interface MutableSceneState {
  actors: Record<string, SceneActorDefinition>;
  relations: Record<string, SceneRelation>;
  fragments: Record<string, ActiveSceneFragment>;
}

export class SceneRuntime {
  private snapshot: SceneSnapshot = freezeSnapshot({
    generation: 0,
    revision: 0,
    sceneId: null,
    actors: {},
    relations: {},
    fragments: {},
  });
  private readonly listeners = new Set<(snapshot: SceneSnapshot) => void>();
  private readonly behaviors = new Map<string, SceneBehavior>();
  private readonly options: SceneRuntimeOptions;

  constructor(options: SceneRuntimeOptions = {}) {
    this.options = options;
    for (const [type, behavior] of Object.entries(options.behaviors ?? {})) this.registerBehavior(type, behavior);
  }

  getSnapshot(): SceneSnapshot {
    return this.snapshot;
  }

  subscribe(listener: (snapshot: SceneSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }

  registerBehavior(type: string, behavior: SceneBehavior): () => void {
    if (type.trim().length === 0) throw new Error('Behavior type must not be empty');
    if (this.behaviors.has(type)) throw new Error(`Behavior "${type}" is already registered`);
    this.behaviors.set(type, behavior);
    return () => {
      if (this.behaviors.get(type) === behavior) this.behaviors.delete(type);
    };
  }

  dispatch(event: SceneRuntimeEvent): boolean {
    if ('generation' in event && event.generation !== this.snapshot.generation) return false;

    switch (event.type) {
      case 'scene.replace-requested':
        this.replaceScene(event.scene);
        return true;
      case 'scene.unload-requested':
        this.commit({ actors: {}, relations: {}, fragments: {} }, null, this.snapshot.generation + 1, 0);
        return true;
      case 'scene.transaction-requested':
        return this.applyTransaction(event.transaction);
      case 'scene.fragment-apply-requested':
        this.applyFragment(event.fragment);
        return true;
      case 'scene.fragment-remove-requested':
        this.removeFragment(event.fragmentId);
        return true;
      case 'actor.interacted': {
        const behaviorEvent: SceneBehaviorEvent = { type: 'interaction', name: event.interaction };
        if (event.data) behaviorEvent.data = event.data;
        this.handleBehavior(event.actorId, behaviorEvent);
        return true;
      }
      case 'actor.event': {
        const behaviorEvent: SceneBehaviorEvent = { type: 'event', name: event.name };
        if (event.data) behaviorEvent.data = event.data;
        this.handleBehavior(event.actorId, behaviorEvent);
        return true;
      }
    }
  }

  private replaceScene(scene: SceneDefinition): void {
    if (scene.id.trim().length === 0) throw new Error('Scene id must not be empty');
    validateUniqueDefinitions(scene.actors, scene.relations);
    const state: MutableSceneState = {
      actors: table(scene.actors),
      relations: table(scene.relations),
      fragments: {},
    };
    validateSceneState(state.actors, state.relations);
    this.commit(state, scene.id, this.snapshot.generation + 1, 0);
  }

  private applyTransaction(transaction: SceneTransaction): boolean {
    if (transaction.generation !== this.snapshot.generation) return false;
    if (transaction.id.trim().length === 0) throw new Error('Transaction id must not be empty');
    if (transaction.operations.length === 0) throw new Error(`Transaction "${transaction.id}" has no operations`);
    const state = this.applyOperations(transaction.operations);
    this.commit(state, this.snapshot.sceneId, this.snapshot.generation, this.snapshot.revision + 1);
    return true;
  }

  private applyFragment(fragment: SceneFragmentDefinition): void {
    if (fragment.id.trim().length === 0) throw new Error('Fragment id must not be empty');
    if (this.snapshot.fragments[fragment.id]) throw new Error(`Fragment "${fragment.id}" is already active`);
    validateUniqueDefinitions(fragment.actors, fragment.relations);
    const operations: SceneOperation[] = [
      ...fragment.actors.map(actor => ({ type: 'spawn-actor' as const, actor })),
      ...fragment.relations.map(relation => ({ type: 'create-relation' as const, relation })),
    ];
    if (operations.length === 0) throw new Error(`Fragment "${fragment.id}" has no content`);
    const state = this.applyOperations(operations);
    state.fragments[fragment.id] = {
      id: fragment.id,
      actorIds: fragment.actors.map(actor => actor.id),
      relationIds: fragment.relations.map(relation => relation.id),
    };
    this.commit(state, this.snapshot.sceneId, this.snapshot.generation, this.snapshot.revision + 1);
  }

  private removeFragment(fragmentId: string): void {
    const fragment = this.snapshot.fragments[fragmentId];
    if (!fragment) throw new Error(`Fragment "${fragmentId}" is not active`);
    const actorIds = new Set(fragment.actorIds);
    const relationIds = new Set(fragment.relationIds);
    for (const relation of Object.values(this.snapshot.relations)) {
      if (relationIds.has(relation.id)) continue;
      if (Object.values(relation.participants).some(endpoint => actorIds.has(endpoint.actorId))) {
        throw new Error(`Fragment "${fragmentId}" actor is referenced by external relation "${relation.id}"`);
      }
    }
    const operations: SceneOperation[] = [
      ...fragment.relationIds.map(relationId => ({ type: 'remove-relation' as const, relationId })),
      ...fragment.actorIds.map(actorId => ({ type: 'destroy-actor' as const, actorId })),
    ];
    const state = this.applyOperations(operations);
    delete state.fragments[fragmentId];
    this.commit(state, this.snapshot.sceneId, this.snapshot.generation, this.snapshot.revision + 1);
  }

  private handleBehavior(actorId: string, event: SceneBehaviorEvent): void {
    const actor = this.snapshot.actors[actorId];
    if (!actor) throw new Error(`Unknown actor "${actorId}"`);
    if (!actor.behavior) return;
    const behavior = this.behaviors.get(actor.behavior.type);
    if (!behavior) throw new Error(`Behavior "${actor.behavior.type}" is not registered`);
    const result = behavior.handle(event, { actor, snapshot: this.snapshot });
    if (!result) return;

    let state: MutableSceneState | undefined;
    if (result.operations && result.operations.length > 0) {
      state = this.applyOperations(result.operations);
    }
    const candidateActors = state?.actors ?? this.snapshot.actors;
    this.validateInvocations(result.invocations ?? [], candidateActors);
    if (state) this.commit(state, this.snapshot.sceneId, this.snapshot.generation, this.snapshot.revision + 1);
    for (const invocation of result.invocations ?? []) this.executeInvocation(invocation);
  }

  private applyOperations(operations: readonly SceneOperation[]): MutableSceneState {
    const state = cloneState(this.snapshot);
    for (const operation of operations) {
      switch (operation.type) {
        case 'spawn-actor':
          if (state.actors[operation.actor.id]) throw new Error(`Actor "${operation.actor.id}" already exists`);
          state.actors[operation.actor.id] = structuredClone(operation.actor);
          break;
        case 'destroy-actor':
          if (!state.actors[operation.actorId]) throw new Error(`Unknown actor "${operation.actorId}"`);
          destroyActor(state, operation.actorId);
          break;
        case 'patch-actor-state': {
          const actor = requiredActor(state.actors, operation.actorId);
          actor.state = { ...actor.state, ...structuredClone(operation.patch) };
          break;
        }
        case 'set-actor-visible':
          requiredActor(state.actors, operation.actorId).visible = operation.visible;
          break;
        case 'set-behavior-mode': {
          const actor = requiredActor(state.actors, operation.actorId);
          if (!actor.behavior) throw new Error(`Actor "${operation.actorId}" has no behavior`);
          if (operation.mode.trim().length === 0) throw new Error('Behavior mode must not be empty');
          actor.behavior = { ...actor.behavior, mode: operation.mode };
          break;
        }
        case 'create-relation':
          if (state.relations[operation.relation.id]) throw new Error(`Relation "${operation.relation.id}" already exists`);
          state.relations[operation.relation.id] = structuredClone(operation.relation);
          break;
        case 'remove-relation':
          if (!state.relations[operation.relationId]) throw new Error(`Unknown relation "${operation.relationId}"`);
          delete state.relations[operation.relationId];
          break;
      }
    }
    validateSceneState(state.actors, state.relations);
    return state;
  }

  private validateInvocations(
    invocations: readonly ActorCapabilityInvocation[],
    actors: Readonly<Record<string, SceneActorDefinition>>,
  ): void {
    for (const invocation of invocations) {
      const actor = actors[invocation.actorId];
      if (!actor) throw new Error(`Capability invocation targets unknown actor "${invocation.actorId}"`);
      if (!actor.capabilities.includes(invocation.capability)) {
        throw new Error(`Actor "${invocation.actorId}" does not provide capability "${invocation.capability}"`);
      }
      if (invocation.command.trim().length === 0) throw new Error('Capability command must not be empty');
    }
  }

  private executeInvocation(invocation: ActorCapabilityInvocation): void {
    const effect: Extract<SceneRuntimeEffect, { type: 'actor.capability-command' }> = {
      type: 'actor.capability-command',
      generation: this.snapshot.generation,
      actorId: invocation.actorId,
      capability: invocation.capability,
      command: invocation.command,
    };
    if (invocation.data) effect.data = invocation.data;
    this.execute(effect);
  }

  private commit(
    state: MutableSceneState,
    sceneId: string | null,
    generation: number,
    revision: number,
  ): void {
    this.snapshot = freezeSnapshot({
      generation,
      revision,
      sceneId,
      actors: state.actors,
      relations: state.relations,
      fragments: state.fragments,
    });
    for (const listener of this.listeners) listener(this.snapshot);
    this.execute({ type: 'scene.render-frame', frame: buildSceneRenderFrame(this.snapshot) });
  }

  private execute(effect: SceneRuntimeEffect): void {
    if (!this.options.effects) return;
    try {
      const result = this.options.effects.execute(effect, event => this.dispatch(event));
      if (result instanceof Promise) void result.catch(error => this.options.onEffectError?.(error, effect));
    }
    catch (error) {
      this.options.onEffectError?.(error, effect);
    }
  }
}

function table<T extends { id: string }>(values: readonly T[]): Record<string, T> {
  return Object.fromEntries(values.map(value => [value.id, structuredClone(value)]));
}

function cloneState(snapshot: SceneSnapshot): MutableSceneState {
  return {
    actors: structuredClone(snapshot.actors),
    relations: structuredClone(snapshot.relations),
    fragments: structuredClone(snapshot.fragments),
  };
}

function freezeSnapshot(snapshot: SceneSnapshot): SceneSnapshot {
  return deepFreeze(structuredClone(snapshot));
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function requiredActor(actors: Record<string, SceneActorDefinition>, actorId: string): SceneActorDefinition {
  const actor = actors[actorId];
  if (!actor) throw new Error(`Unknown actor "${actorId}"`);
  return actor;
}

function destroyActor(state: MutableSceneState, rootActorId: string): void {
  const destroyed = new Set<string>();
  const visit = (actorId: string): void => {
    if (destroyed.has(actorId)) return;
    destroyed.add(actorId);
    for (const relation of Object.values(state.relations)) {
      for (const constraint of relation.constraints) {
        if (constraint.type !== 'destroy-with') continue;
        const owner = relation.participants[constraint.ownerRole];
        const subject = relation.participants[constraint.subjectRole];
        if (owner?.actorId === actorId && subject) visit(subject.actorId);
      }
    }
  };
  visit(rootActorId);
  for (const actorId of destroyed) delete state.actors[actorId];
  for (const relation of Object.values(state.relations)) {
    if (Object.values(relation.participants).some(endpoint => destroyed.has(endpoint.actorId))) {
      delete state.relations[relation.id];
    }
  }
  for (const fragment of Object.values(state.fragments)) {
    fragment.actorIds = fragment.actorIds.filter(actorId => !destroyed.has(actorId));
    fragment.relationIds = fragment.relationIds.filter(relationId => Boolean(state.relations[relationId]));
  }
}
