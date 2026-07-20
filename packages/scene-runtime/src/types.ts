export type ActorId = string;
export type RelationId = string;
export type SceneValue = null | boolean | number | string | SceneValue[] | { [key: string]: SceneValue };
export type SceneData = { [key: string]: SceneValue };

export interface SceneTransform {
  x: number;
  y: number;
  z: number;
  scaleX: number;
  scaleY: number;
  rotationZ: number;
}

export interface SceneEndpoint {
  actorId: ActorId;
  slotId?: string;
}

export interface SceneSlot {
  id: string;
  localTransform: SceneTransform;
  capacity: number;
  tags: string[];
  renderBand?: {
    after: string[];
    before: string[];
  };
}

export interface SceneCustomComponent {
  type: string;
  data: SceneData;
}

export type SceneRenderGroup = 'background' | 'world' | 'overlay';
export type DepthWritePolicy = 'opaque' | 'alpha-threshold' | 'test-only' | 'none';

export type DepthRepresentation =
  | { type: 'constant-plane'; depthOffset: number }
  | { type: 'plane'; width: number; height: number; depthSlopeX: number; depthSlopeY: number }
  | { type: 'box'; width: number; height: number; depth: number }
  | { type: 'ellipsoid'; radiusX: number; radiusY: number; radiusZ: number }
  | { type: 'capsule'; radius: number; length: number; depth: number }
  | { type: 'mesh'; vertices: number[]; indices: number[] }
  | { type: 'depth-map'; source: string; near: number; far: number };

export interface SceneColorSource {
  type: 'asset' | 'surface';
  ref: string;
}

export interface SceneInteractionPolicy {
  enabled: boolean;
  coverage: 'alpha' | 'bounds' | 'none';
  semanticId?: string;
  alphaThreshold?: number;
}

export interface SceneRenderPart {
  id: string;
  group: SceneRenderGroup;
  zOffset: number;
  tieBreaker: number;
  color: SceneColorSource;
  depth: DepthRepresentation;
  depthWrite: DepthWritePolicy;
  interaction?: SceneInteractionPolicy;
  material?: {
    feature: string;
    properties: SceneData;
  };
}

export interface SceneBehaviorReference {
  type: string;
  mode: string;
  config: SceneData;
}

export type SceneUiLayer = 'world-underlay' | 'world-overlay' | 'screen-overlay' | 'modal';
export type SceneUiInputPolicy = 'pass-through' | 'surface' | 'modal';

/**
 * References an application-owned presenter without embedding DOM, framework
 * components, or executable code in a scene definition.
 */
export interface SceneUiSurfaceDefinition {
  id: string;
  presenter: string;
  layer: SceneUiLayer;
  order: number;
  input: SceneUiInputPolicy;
  events: Record<string, string>;
  config: SceneData;
}

export interface SceneActorDefinition {
  id: ActorId;
  transform: SceneTransform;
  visible: boolean;
  capabilities: string[];
  state: SceneData;
  components: SceneCustomComponent[];
  slots: SceneSlot[];
  renderParts: SceneRenderPart[];
  uiSurfaces: SceneUiSurfaceDefinition[];
  behavior?: SceneBehaviorReference;
}

export type SceneConstraint =
  | { type: 'bind-transform'; subjectRole: string; targetRole: string; offset: SceneTransform }
  | { type: 'reserve-slot'; claimantRole: string; slotRole: string }
  | { type: 'insert-render-band'; subjectRole: string; slotRole: string }
  | { type: 'require-capability'; actorRole: string; capability: string }
  | { type: 'destroy-with'; subjectRole: string; ownerRole: string };

export interface SceneRelation {
  id: RelationId;
  type: string;
  participants: Record<string, SceneEndpoint>;
  constraints: SceneConstraint[];
  state: SceneData;
}

export interface SceneDefinition {
  id: string;
  actors: SceneActorDefinition[];
  relations: SceneRelation[];
}

export interface SceneFragmentDefinition {
  id: string;
  actors: SceneActorDefinition[];
  relations: SceneRelation[];
}

export type SceneOperation =
  | { type: 'spawn-actor'; actor: SceneActorDefinition }
  | { type: 'destroy-actor'; actorId: ActorId }
  | { type: 'patch-actor-state'; actorId: ActorId; patch: SceneData }
  | { type: 'set-actor-visible'; actorId: ActorId; visible: boolean }
  | { type: 'set-behavior-mode'; actorId: ActorId; mode: string }
  | { type: 'create-relation'; relation: SceneRelation }
  | { type: 'remove-relation'; relationId: RelationId };

export interface SceneTransaction {
  id: string;
  generation: number;
  operations: SceneOperation[];
}

export interface ActiveSceneFragment {
  id: string;
  actorIds: string[];
  relationIds: string[];
}

export interface SceneRuntimeError {
  code: string;
  message: string;
  recoverable: boolean;
}

export interface SceneSnapshot {
  generation: number;
  revision: number;
  sceneId: string | null;
  actors: Readonly<Record<ActorId, SceneActorDefinition>>;
  relations: Readonly<Record<RelationId, SceneRelation>>;
  fragments: Readonly<Record<string, ActiveSceneFragment>>;
  lastError?: SceneRuntimeError;
}

export type SceneRuntimeEvent =
  | { type: 'scene.replace-requested'; scene: SceneDefinition }
  | { type: 'scene.unload-requested' }
  | { type: 'scene.transaction-requested'; transaction: SceneTransaction }
  | { type: 'scene.fragment-apply-requested'; fragment: SceneFragmentDefinition; generation: number }
  | { type: 'scene.fragment-remove-requested'; fragmentId: string; generation: number }
  | { type: 'actor.interacted'; generation: number; actorId: ActorId; interaction: string; data?: SceneData }
  | { type: 'actor.event'; generation: number; actorId: ActorId; name: string; data?: SceneData };

export interface ResolvedSceneActor {
  actorId: ActorId;
  transform: SceneTransform;
}

export interface SceneDrawItem {
  id: string;
  actorId: ActorId;
  partId: string;
  group: SceneRenderGroup;
  transform: SceneTransform;
  depth: DepthRepresentation;
  depthWrite: DepthWritePolicy;
  color: SceneColorSource;
  material?: SceneRenderPart['material'];
  interaction: SceneInteractionPolicy;
  z: number;
  tieBreaker: number;
  pickingId: number;
}

export interface SceneRenderPass {
  id: string;
  reads: string[];
  writes: string[];
  dependsOn: string[];
}

export interface SceneUiSurfaceInstance {
  id: string;
  actorId: ActorId;
  surfaceId: string;
  presenter: string;
  layer: SceneUiLayer;
  order: number;
  input: SceneUiInputPolicy;
  events: Readonly<Record<string, string>>;
  config: Readonly<SceneData>;
  actorState: Readonly<SceneData>;
  behaviorMode?: string;
  transform: SceneTransform;
}

export interface SceneRenderFrame {
  generation: number;
  revision: number;
  actors: ResolvedSceneActor[];
  drawItems: SceneDrawItem[];
  uiSurfaces: SceneUiSurfaceInstance[];
  orderEdges: Array<{ before: string; after: string }>;
  passes: SceneRenderPass[];
}

export type SceneRuntimeEffect =
  | { type: 'scene.render-frame'; frame: SceneRenderFrame }
  | {
      type: 'actor.capability-command';
      generation: number;
      actorId: ActorId;
      capability: string;
      command: string;
      data?: SceneData;
    };

export interface ActorCapabilityInvocation {
  actorId: ActorId;
  capability: string;
  command: string;
  data?: SceneData;
}

export interface SceneBehaviorResult {
  operations?: SceneOperation[];
  invocations?: ActorCapabilityInvocation[];
}

export interface SceneBehaviorEvent {
  type: 'interaction' | 'event';
  name: string;
  data?: SceneData;
}

export interface SceneBehaviorContext {
  actor: Readonly<SceneActorDefinition>;
  snapshot: Readonly<SceneSnapshot>;
}

export interface SceneBehavior {
  handle(event: SceneBehaviorEvent, context: SceneBehaviorContext): SceneBehaviorResult | void;
}

export interface SceneScenario {
  id: string;
  operations: SceneOperation[];
  triggers: SceneScenarioTrigger[];
}

export interface SceneScenarioTrigger {
  event: string;
  priority: number;
  weight: number;
  cooldownMs: number;
}
