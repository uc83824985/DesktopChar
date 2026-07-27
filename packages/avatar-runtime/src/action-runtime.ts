import type {
  ActionBinding,
  ActionDescriptor,
  ActionIntent,
  ActionTriggerRule,
  AvatarState,
  CharacterActionCatalog,
  GestureState,
  RuntimeEffect,
  SceneActionContext,
} from '../../contracts/src/index.ts';

export interface ActionRuntimeEnvironment {
  generation: number;
  avatarState: AvatarState;
  speechActive: boolean;
  blockedActionTags: readonly string[];
}

export interface ActionRuntimeTransition {
  gesture: GestureState;
  effects: RuntimeEffect[];
  selectedActionId?: string;
  rejection?: string;
}

interface ResolvedActionRequest {
  requestId: string;
  actionId: string;
  ruleId: string;
  binding: ActionBinding;
  priority: number;
  enqueuedAtMs: number;
  contextGeneration: number;
  contextRevision: number;
}

interface Candidate {
  descriptor: ActionDescriptor;
  binding: ActionBinding;
  rule: ActionTriggerRule;
  priority: number;
}

const EMPTY_GESTURE: GestureState = Object.freeze({
  requestId: null,
  actionId: null,
  queueLength: 0,
});

/**
 * AvatarRuntime-owned action selector and scheduler.
 *
 * It consumes character-owned asset declarations and a read-only scene
 * projection. Neither SceneRuntime nor Renderer can mutate its state.
 */
export class ActionRuntime {
  private catalog: CharacterActionCatalog;
  private descriptors = new Map<string, ActionDescriptor>();
  private scene: SceneActionContext;
  private current: ResolvedActionRequest | null = null;
  private queue: ResolvedActionRequest[] = [];
  private readonly lastCompletedAt = new Map<string, number>();

  constructor(catalog: CharacterActionCatalog, scene: SceneActionContext) {
    this.catalog = structuredClone(catalog);
    this.scene = structuredClone(scene);
    this.indexCatalog();
  }

  getCatalog(): Readonly<CharacterActionCatalog> {
    return this.catalog;
  }

  getSceneContext(): Readonly<SceneActionContext> {
    return this.scene;
  }

  getGesture(): GestureState {
    if (!this.current) return { ...EMPTY_GESTURE, queueLength: this.queue.length };
    return {
      requestId: this.current.requestId,
      actionId: this.current.actionId,
      queueLength: this.queue.length,
    };
  }

  updateSceneContext(context: SceneActionContext): ActionRuntimeTransition {
    this.scene = structuredClone(context);
    this.queue = this.queue.filter(request => this.isRequestValidForScene(request));
    return { gesture: this.getGesture(), effects: [] };
  }

  replaceCatalog(catalog: CharacterActionCatalog): ActionRuntimeTransition {
    this.catalog = structuredClone(catalog);
    this.indexCatalog();
    this.queue = this.queue.filter(request => (
      this.descriptors.has(request.actionId) && this.isRequestValidForScene(request)
    ));
    return { gesture: this.getGesture(), effects: [] };
  }

  request(intent: ActionIntent, environment: ActionRuntimeEnvironment): ActionRuntimeTransition {
    validateIntent(intent);
    const candidate = this.selectCandidate(intent, environment);
    if (!candidate) {
      return {
        gesture: this.getGesture(),
        effects: [],
        rejection: this.isIntentBlockedByExpression(intent, environment)
          ? 'action-expression-conflict'
          : 'no-eligible-action',
      };
    }
    const request: ResolvedActionRequest = {
      requestId: intent.requestId,
      actionId: candidate.descriptor.actionId,
      ruleId: candidate.rule.ruleId,
      binding: structuredClone(candidate.binding),
      priority: candidate.priority,
      enqueuedAtMs: intent.occurredAtMs,
      contextGeneration: this.scene.generation,
      contextRevision: this.scene.revision,
    };
    if (!this.current) {
      this.current = request;
      return this.started(request, environment.generation);
    }

    const policy = candidate.descriptor.busyPolicy;
    if (
      policy === 'replace'
      || (policy === 'interrupt-lower-priority' && request.priority > this.current.priority)
    ) {
      const previous = this.current;
      this.current = request;
      return {
        gesture: this.getGesture(),
        selectedActionId: request.actionId,
        effects: [
          {
            type: 'renderer.stop-motion',
            generation: environment.generation,
            requestId: previous.requestId,
            actionId: previous.actionId,
          },
          this.playEffect(request, environment.generation),
        ],
      };
    }
    if (policy === 'enqueue') {
      if (!this.queue.some(item => item.requestId === request.requestId)) this.queue.push(request);
      return {
        gesture: this.getGesture(),
        effects: [],
        selectedActionId: request.actionId,
      };
    }
    return { gesture: this.getGesture(), effects: [], rejection: 'action-runtime-busy' };
  }

  complete(
    requestId: string,
    completedAtMs: number,
    environment: ActionRuntimeEnvironment,
  ): ActionRuntimeTransition {
    if (this.current?.requestId !== requestId) return { gesture: this.getGesture(), effects: [] };
    this.lastCompletedAt.set(this.current.actionId, completedAtMs);
    this.current = null;
    return this.startNext(completedAtMs, environment);
  }

  fail(
    requestId: string,
    failedAtMs: number,
    environment: ActionRuntimeEnvironment,
  ): ActionRuntimeTransition {
    if (this.current?.requestId !== requestId) return { gesture: this.getGesture(), effects: [] };
    this.current = null;
    return this.startNext(failedAtMs, environment);
  }

  interrupt(generation: number): ActionRuntimeTransition {
    const current = this.current;
    this.current = null;
    this.queue = [];
    return {
      gesture: this.getGesture(),
      effects: current
        ? [{
            type: 'renderer.stop-motion',
            generation,
            requestId: current.requestId,
            actionId: current.actionId,
          }]
        : [],
    };
  }

  /**
   * Revalidates queued and active work after the surrounding avatar
   * environment changes. This is intentionally separate from Renderer
   * blending: semantic incompatibility is an application-level hard rule.
   */
  reconcile(
    nowMs: number,
    environment: ActionRuntimeEnvironment,
  ): ActionRuntimeTransition {
    this.queue = this.queue.filter(request => {
      const descriptor = this.descriptors.get(request.actionId);
      return Boolean(
        descriptor
        && nowMs - request.enqueuedAtMs <= descriptor.maxQueueAgeMs
        && this.isRequestValidForScene(request)
        && this.isDescriptorEligible(descriptor, environment)
      );
    });
    if (!this.current) return { gesture: this.getGesture(), effects: [] };

    const descriptor = this.descriptors.get(this.current.actionId);
    if (descriptor && this.isDescriptorEligible(descriptor, environment)) {
      return { gesture: this.getGesture(), effects: [] };
    }

    const previous = this.current;
    const expressionConflict = Boolean(
      descriptor && intersects(descriptor.semanticTags, environment.blockedActionTags),
    );
    this.current = null;
    const next = this.startNext(nowMs, environment);
    return {
      ...next,
      gesture: this.getGesture(),
      rejection: expressionConflict
        ? 'action-expression-conflict'
        : 'action-environment-conflict',
      effects: [{
        type: 'renderer.stop-motion',
        generation: environment.generation,
        requestId: previous.requestId,
        actionId: previous.actionId,
      }, ...next.effects],
    };
  }

  private selectCandidate(
    intent: ActionIntent,
    environment: ActionRuntimeEnvironment,
  ): Candidate | undefined {
    const candidates: Candidate[] = [];
    for (const descriptor of this.descriptors.values()) {
      if (intent.requestedActionId && descriptor.actionId !== intent.requestedActionId) continue;
      if (
        !intent.requestedActionId
        && intent.semanticTags?.length
        && !intersects(descriptor.semanticTags, intent.semanticTags)
      ) {
        continue;
      }
      if (!this.isDescriptorEligible(descriptor, environment)) continue;
      const binding = this.catalog.bindings[descriptor.actionId];
      if (!binding) continue;
      const rules = intent.source === 'debug'
        ? [debugRule(intent)]
        : descriptor.triggers.filter(rule => rule.trigger === intent.trigger);
      for (const rule of rules) {
        const completedAt = this.lastCompletedAt.get(descriptor.actionId);
        if (completedAt !== undefined && intent.occurredAtMs - completedAt < descriptor.cooldownMs) continue;
        candidates.push({
          descriptor,
          binding,
          rule,
          priority: intent.priority ?? rule.priority ?? descriptor.priority,
        });
      }
    }
    if (!candidates.length) return undefined;

    const required = candidates.filter(candidate => intent.mode === 'required' || candidate.rule.mode === 'required');
    const pool = required.length ? required : candidates;
    const highestPriority = Math.max(...pool.map(candidate => candidate.priority));
    const priorityPool = pool.filter(candidate => candidate.priority === highestPriority);
    const selected = weightedCandidate(priorityPool, intent.selectionRandomValue);
    if (!selected) return undefined;
    const chanceMultiplier = this.scene.triggerChanceMultipliers[intent.trigger] ?? 1;
    const effectiveChance = Math.min(1, selected.rule.chance * chanceMultiplier);
    if (
      !required.length
      && intent.chanceRandomValue >= effectiveChance
    ) {
      return undefined;
    }
    return selected;
  }

  private isIntentBlockedByExpression(
    intent: ActionIntent,
    environment: ActionRuntimeEnvironment,
  ): boolean {
    if (!environment.blockedActionTags.length) return false;
    return [...this.descriptors.values()].some(descriptor => {
      if (intent.requestedActionId && descriptor.actionId !== intent.requestedActionId) return false;
      if (
        !intent.requestedActionId
        && intent.semanticTags?.length
        && !intersects(descriptor.semanticTags, intent.semanticTags)
      ) {
        return false;
      }
      if (!intersects(descriptor.semanticTags, environment.blockedActionTags)) return false;
      if (!this.catalog.bindings[descriptor.actionId]) return false;
      return intent.source === 'debug'
        || descriptor.triggers.some(rule => rule.trigger === intent.trigger);
    });
  }

  private isDescriptorEligible(
    descriptor: ActionDescriptor,
    environment: ActionRuntimeEnvironment,
  ): boolean {
    if (!descriptor.compatibleAvatarStates.includes(environment.avatarState)) return false;
    if (environment.speechActive && descriptor.speech === 'deny') return false;
    if (intersects(descriptor.semanticTags, environment.blockedActionTags)) return false;
    if (
      this.scene.allowedActionTags.length
      && !intersects(descriptor.semanticTags, this.scene.allowedActionTags)
    ) {
      return false;
    }
    if (intersects(descriptor.semanticTags, this.scene.blockedActionTags)) return false;
    const applicability = descriptor.scene;
    if (applicability.allTags?.some(tag => !this.scene.tags.includes(tag))) return false;
    if (applicability.anyTags?.length && !intersects(applicability.anyTags, this.scene.tags)) return false;
    if (applicability.noneTags?.some(tag => this.scene.tags.includes(tag))) return false;
    if (
      applicability.postures?.length
      && (!this.scene.posture || !applicability.postures.includes(this.scene.posture))
    ) {
      return false;
    }
    return true;
  }

  private startNext(
    nowMs: number,
    environment: ActionRuntimeEnvironment,
  ): ActionRuntimeTransition {
    while (this.queue.length) {
      const request = this.queue.shift()!;
      const descriptor = this.descriptors.get(request.actionId);
      if (!descriptor) continue;
      if (nowMs - request.enqueuedAtMs > descriptor.maxQueueAgeMs) continue;
      if (!this.isRequestValidForScene(request) || !this.isDescriptorEligible(descriptor, environment)) continue;
      this.current = request;
      return this.started(request, environment.generation);
    }
    return { gesture: this.getGesture(), effects: [] };
  }

  private isRequestValidForScene(request: ResolvedActionRequest): boolean {
    const descriptor = this.descriptors.get(request.actionId);
    if (!descriptor) return false;
    return this.isDescriptorEligible(descriptor, {
      generation: 0,
      avatarState: descriptor.compatibleAvatarStates[0] ?? 'idle',
      speechActive: false,
      blockedActionTags: [],
    });
  }

  private started(request: ResolvedActionRequest, generation: number): ActionRuntimeTransition {
    return {
      gesture: this.getGesture(),
      selectedActionId: request.actionId,
      effects: [this.playEffect(request, generation)],
    };
  }

  private playEffect(request: ResolvedActionRequest, generation: number): RuntimeEffect {
    return {
      type: 'renderer.play-motion',
      generation,
      command: {
        requestId: request.requestId,
        actionId: request.actionId,
        binding: structuredClone(request.binding),
        priority: request.priority,
      },
    };
  }

  private indexCatalog(): void {
    this.descriptors = new Map(this.catalog.descriptors.map(descriptor => [descriptor.actionId, descriptor]));
  }
}

function weightedCandidate(candidates: readonly Candidate[], randomValue: number): Candidate | undefined {
  const total = candidates.reduce((sum, candidate) => sum + candidate.rule.weight, 0);
  let cursor = randomValue * total;
  for (const candidate of candidates) {
    cursor -= candidate.rule.weight;
    if (cursor < 0) return candidate;
  }
  return candidates.at(-1);
}

function intersects(left: readonly string[], right: readonly string[]): boolean {
  const values = new Set(right);
  return left.some(item => values.has(item));
}

function debugRule(intent: ActionIntent): ActionTriggerRule {
  return {
    ruleId: `debug:${intent.trigger}`,
    trigger: intent.trigger,
    mode: 'required',
    chance: 1,
    weight: 1,
  };
}

function validateIntent(intent: ActionIntent): void {
  if (!intent.requestId.trim()) throw new TypeError('Action intent requestId must not be empty');
  if (!intent.trigger.trim()) throw new TypeError('Action intent trigger must not be empty');
  if (!Number.isFinite(intent.occurredAtMs)) throw new TypeError('Action intent occurredAtMs must be finite');
  for (const [name, value] of [
    ['selectionRandomValue', intent.selectionRandomValue],
    ['chanceRandomValue', intent.chanceRandomValue],
  ] as const) {
    if (!Number.isFinite(value) || value < 0 || value >= 1) {
      throw new RangeError(`Action intent ${name} must be in [0, 1)`);
    }
  }
  if (!intent.requestedActionId && !intent.semanticTags?.length) {
    throw new TypeError('Action intent requires requestedActionId or semanticTags');
  }
}
