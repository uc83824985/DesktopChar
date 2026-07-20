import { resolveSceneActors } from './relations.ts';
import type {
  SceneData,
  SceneRenderFrame,
  SceneRuntimeEvent,
  SceneSnapshot,
  SceneUiLayer,
  SceneUiSurfaceInstance,
} from './types.ts';

const UI_LAYER_RANK: Record<SceneUiLayer, number> = {
  'world-underlay': 0,
  'world-overlay': 1,
  'screen-overlay': 2,
  modal: 3,
};

/** Projects immutable scene state into framework-neutral UI presenter inputs. */
export function buildSceneUiSurfaces(snapshot: SceneSnapshot): SceneUiSurfaceInstance[] {
  const resolvedActors = resolveSceneActors(snapshot.actors, snapshot.relations);
  const transforms = new Map(resolvedActors.map(actor => [actor.actorId, actor.transform]));
  const surfaces: SceneUiSurfaceInstance[] = [];

  for (const actorId of Object.keys(snapshot.actors).sort()) {
    const actor = snapshot.actors[actorId]!;
    if (!actor.visible) continue;
    const transform = transforms.get(actorId)!;
    for (const surface of actor.uiSurfaces) {
      const instance: SceneUiSurfaceInstance = {
        id: `${actorId}:${surface.id}`,
        actorId,
        surfaceId: surface.id,
        presenter: surface.presenter,
        layer: surface.layer,
        order: surface.order,
        input: surface.input,
        events: surface.events,
        config: surface.config,
        actorState: actor.state,
        transform,
      };
      if (actor.behavior) instance.behaviorMode = actor.behavior.mode;
      surfaces.push(instance);
    }
  }

  return surfaces.sort(compareUiSurfaces);
}

/** Converts a renderer UI fact into the existing generation-safe actor event. */
export function routeSceneUiEvent(
  frame: Pick<SceneRenderFrame, 'generation' | 'uiSurfaces'>,
  surfaceInstanceId: string,
  eventName: string,
  data?: SceneData,
): Extract<SceneRuntimeEvent, { type: 'actor.interacted' }> | undefined {
  const surface = frame.uiSurfaces.find(candidate => candidate.id === surfaceInstanceId);
  if (!surface || surface.input === 'pass-through') return undefined;
  const interaction = surface.events[eventName];
  if (!interaction) return undefined;
  const event: Extract<SceneRuntimeEvent, { type: 'actor.interacted' }> = {
    type: 'actor.interacted',
    generation: frame.generation,
    actorId: surface.actorId,
    interaction,
  };
  if (data) event.data = data;
  return event;
}

function compareUiSurfaces(left: SceneUiSurfaceInstance, right: SceneUiSurfaceInstance): number {
  return UI_LAYER_RANK[left.layer] - UI_LAYER_RANK[right.layer]
    || left.order - right.order
    || left.id.localeCompare(right.id);
}
