import {
  defineSceneActor,
  IDENTITY_SCENE_TRANSFORM,
  type SceneActorInput,
  type SceneRelation,
  type SceneRenderPart,
  type SceneSlot,
} from '../src/index.ts';

export function actor(input: SceneActorInput) {
  return defineSceneActor(input);
}

export function part(
  id: string,
  overrides: Partial<SceneRenderPart> = {},
): SceneRenderPart {
  return {
    id,
    group: 'world',
    zOffset: 0,
    tieBreaker: 0,
    color: { type: 'asset', ref: `memory://${id}` },
    depth: { type: 'constant-plane', depthOffset: 0 },
    depthWrite: 'alpha-threshold',
    ...overrides,
  };
}

export function slot(id: string, x: number, capacity = 1, renderBand?: SceneSlot['renderBand']): SceneSlot {
  const result: SceneSlot = {
    id,
    localTransform: { ...IDENTITY_SCENE_TRANSFORM, x },
    capacity,
    tags: [],
  };
  if (renderBand) result.renderBand = renderBand;
  return result;
}

export function mounted(
  id: string,
  subjectId: string,
  hostId: string,
  slotId: string,
): SceneRelation {
  return {
    id,
    type: 'spatial-membership',
    participants: {
      subject: { actorId: subjectId },
      host: { actorId: hostId, slotId },
    },
    constraints: [
      {
        type: 'bind-transform',
        subjectRole: 'subject',
        targetRole: 'host',
        offset: IDENTITY_SCENE_TRANSFORM,
      },
      { type: 'reserve-slot', claimantRole: 'subject', slotRole: 'host' },
    ],
    state: {},
  };
}
