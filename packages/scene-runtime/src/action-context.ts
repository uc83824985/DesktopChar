import type { SceneActionContext } from '../../contracts/src/index.ts';
import type { SceneSnapshot } from './types.ts';

/** Creates the only scene representation that ActionRuntime is allowed to consume. */
export function projectSceneActionContext(snapshot: Readonly<SceneSnapshot>): SceneActionContext {
  return {
    generation: snapshot.generation,
    revision: snapshot.revision,
    sceneId: snapshot.sceneId,
    tags: [...snapshot.actionContext.tags],
    ...(snapshot.actionContext.posture ? { posture: snapshot.actionContext.posture } : {}),
    allowedActionTags: [...snapshot.actionContext.allowedActionTags],
    blockedActionTags: [...snapshot.actionContext.blockedActionTags],
    triggerChanceMultipliers: { ...snapshot.actionContext.triggerChanceMultipliers },
  };
}
