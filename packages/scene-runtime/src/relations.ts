import { IDENTITY_SCENE_TRANSFORM } from './definitions.ts';
import type {
  ResolvedSceneActor,
  SceneActorDefinition,
  SceneEndpoint,
  SceneRelation,
  SceneTransform,
} from './types.ts';

export function resolveSceneActors(
  actors: Readonly<Record<string, SceneActorDefinition>>,
  relations: Readonly<Record<string, SceneRelation>>,
): ResolvedSceneActor[] {
  const bindings = collectBindings(relations);
  const resolved = new Map<string, SceneTransform>();
  const resolving = new Set<string>();

  const resolve = (actorId: string): SceneTransform => {
    const cached = resolved.get(actorId);
    if (cached) return cached;
    if (resolving.has(actorId)) throw new Error(`Transform binding cycle contains actor "${actorId}"`);
    const actor = actors[actorId];
    if (!actor) throw new Error(`Cannot resolve unknown actor "${actorId}"`);
    resolving.add(actorId);

    const binding = bindings.get(actorId);
    let transform = actor.transform;
    if (binding) {
      const targetActor = actors[binding.target.actorId];
      if (!targetActor) throw new Error(`Cannot resolve unknown binding target "${binding.target.actorId}"`);
      const targetTransform = resolve(binding.target.actorId);
      const slotTransform = binding.target.slotId === undefined
        ? IDENTITY_SCENE_TRANSFORM
        : targetActor.slots.find(slot => slot.id === binding.target.slotId)?.localTransform;
      if (!slotTransform) throw new Error(`Cannot resolve unknown slot "${binding.target.actorId}:${binding.target.slotId}"`);
      transform = composeSceneTransforms(
        composeSceneTransforms(composeSceneTransforms(targetTransform, slotTransform), binding.offset),
        actor.transform,
      );
    }

    resolving.delete(actorId);
    resolved.set(actorId, transform);
    return transform;
  };

  return Object.keys(actors).sort().map(actorId => ({ actorId, transform: resolve(actorId) }));
}

export function composeSceneTransforms(parent: SceneTransform, child: SceneTransform): SceneTransform {
  const cos = Math.cos(parent.rotationZ);
  const sin = Math.sin(parent.rotationZ);
  const localX = child.x * parent.scaleX;
  const localY = child.y * parent.scaleY;
  return {
    x: parent.x + localX * cos - localY * sin,
    y: parent.y + localX * sin + localY * cos,
    z: parent.z + child.z,
    scaleX: parent.scaleX * child.scaleX,
    scaleY: parent.scaleY * child.scaleY,
    rotationZ: parent.rotationZ + child.rotationZ,
  };
}

interface TransformBinding {
  target: SceneEndpoint;
  offset: SceneTransform;
}

function collectBindings(relations: Readonly<Record<string, SceneRelation>>): Map<string, TransformBinding> {
  const bindings = new Map<string, TransformBinding>();
  for (const relation of Object.values(relations)) {
    for (const constraint of relation.constraints) {
      if (constraint.type !== 'bind-transform') continue;
      const subject = relation.participants[constraint.subjectRole];
      const target = relation.participants[constraint.targetRole];
      if (!subject || !target) continue;
      bindings.set(subject.actorId, { target, offset: constraint.offset });
    }
  }
  return bindings;
}
