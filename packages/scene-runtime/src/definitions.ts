import type {
  SceneActorDefinition,
  SceneBehaviorReference,
  SceneCustomComponent,
  SceneData,
  SceneRenderPart,
  SceneSlot,
  SceneTransform,
} from './types.ts';

export const IDENTITY_SCENE_TRANSFORM: SceneTransform = Object.freeze({
  x: 0, y: 0, z: 0, scaleX: 1, scaleY: 1, rotationZ: 0,
});

export interface SceneActorInput {
  id: string;
  transform?: Partial<SceneTransform>;
  visible?: boolean;
  capabilities?: string[];
  state?: SceneData;
  components?: SceneCustomComponent[];
  slots?: SceneSlot[];
  renderParts?: SceneRenderPart[];
  behavior?: SceneBehaviorReference;
}

export function defineSceneActor(input: SceneActorInput): SceneActorDefinition {
  const actor: SceneActorDefinition = {
    id: input.id,
    transform: { ...IDENTITY_SCENE_TRANSFORM, ...input.transform },
    visible: input.visible ?? true,
    capabilities: [...(input.capabilities ?? [])],
    state: { ...(input.state ?? {}) },
    components: [...(input.components ?? [])],
    slots: [...(input.slots ?? [])],
    renderParts: [...(input.renderParts ?? [])],
  };
  if (input.behavior) actor.behavior = input.behavior;
  return actor;
}
