import type {
  DepthRepresentation,
  SceneActorDefinition,
  SceneRelation,
  SceneTransform,
} from './types.ts';

type ActorTable = Readonly<Record<string, SceneActorDefinition>>;
type RelationTable = Readonly<Record<string, SceneRelation>>;

export function validateSceneState(actors: ActorTable, relations: RelationTable): void {
  for (const [id, actor] of Object.entries(actors)) {
    if (id !== actor.id) fail(`Actor table key "${id}" does not match actor id "${actor.id}"`);
    validateActor(actor);
  }

  const transformParents = new Map<string, string>();
  const slotReservations = new Map<string, number>();
  for (const [id, relation] of Object.entries(relations)) {
    if (id !== relation.id) fail(`Relation table key "${id}" does not match relation id "${relation.id}"`);
    validateRelation(relation, actors, transformParents, slotReservations);
  }

  for (const [slotKey, count] of slotReservations) {
    const [actorId, slotId] = splitSlotKey(slotKey);
    const slot = actors[actorId]?.slots.find(candidate => candidate.id === slotId);
    if (!slot || count > slot.capacity) {
      fail(`Slot "${slotKey}" capacity ${slot?.capacity ?? 0} is exceeded by ${count} reservations`);
    }
  }
  validateAcyclicTransformBindings(transformParents);
}

export function validateUniqueDefinitions(
  actors: readonly SceneActorDefinition[],
  relations: readonly SceneRelation[],
): void {
  unique(actors.map(actor => actor.id), 'actor id');
  unique(relations.map(relation => relation.id), 'relation id');
}

function validateActor(actor: SceneActorDefinition): void {
  nonEmpty(actor.id, 'Actor id');
  validateTransform(actor.transform, `Actor "${actor.id}" transform`);
  unique(actor.capabilities, `Actor "${actor.id}" capability`);
  unique(actor.components.map(component => component.type), `Actor "${actor.id}" component type`);
  unique(actor.slots.map(slot => slot.id), `Actor "${actor.id}" slot id`);
  unique(actor.renderParts.map(part => part.id), `Actor "${actor.id}" render part id`);

  for (const capability of actor.capabilities) nonEmpty(capability, 'Capability');
  for (const component of actor.components) nonEmpty(component.type, 'Component type');
  if (actor.behavior) {
    nonEmpty(actor.behavior.type, `Actor "${actor.id}" behavior type`);
    nonEmpty(actor.behavior.mode, `Actor "${actor.id}" behavior mode`);
  }

  const partIds = new Set(actor.renderParts.map(part => part.id));
  for (const slot of actor.slots) {
    nonEmpty(slot.id, `Actor "${actor.id}" slot id`);
    validateTransform(slot.localTransform, `Slot "${actor.id}:${slot.id}" transform`);
    if (!Number.isInteger(slot.capacity) || slot.capacity < 1) {
      fail(`Slot "${actor.id}:${slot.id}" capacity must be a positive integer`);
    }
    unique(slot.tags, `Slot "${actor.id}:${slot.id}" tag`);
    for (const referencedPart of [...(slot.renderBand?.after ?? []), ...(slot.renderBand?.before ?? [])]) {
      if (!partIds.has(referencedPart)) {
        fail(`Slot "${actor.id}:${slot.id}" render band references unknown part "${referencedPart}"`);
      }
    }
  }

  for (const part of actor.renderParts) {
    nonEmpty(part.id, `Actor "${actor.id}" render part id`);
    nonEmpty(part.color.ref, `Render part "${actor.id}:${part.id}" color reference`);
    finite(part.zOffset, `Render part "${actor.id}:${part.id}" zOffset`);
    finite(part.tieBreaker, `Render part "${actor.id}:${part.id}" tieBreaker`);
    validateDepth(part.depth, `Render part "${actor.id}:${part.id}" depth`);
    if (part.interaction?.alphaThreshold !== undefined) {
      range(part.interaction.alphaThreshold, 0, 1, `Render part "${actor.id}:${part.id}" alphaThreshold`);
    }
    if (part.interaction?.enabled && part.interaction.coverage === 'none') {
      fail(`Render part "${actor.id}:${part.id}" cannot be interactive with no coverage`);
    }
  }
}

function validateRelation(
  relation: SceneRelation,
  actors: ActorTable,
  transformParents: Map<string, string>,
  slotReservations: Map<string, number>,
): void {
  nonEmpty(relation.id, 'Relation id');
  nonEmpty(relation.type, `Relation "${relation.id}" type`);
  if (Object.keys(relation.participants).length === 0) fail(`Relation "${relation.id}" has no participants`);

  for (const [role, endpoint] of Object.entries(relation.participants)) {
    nonEmpty(role, `Relation "${relation.id}" participant role`);
    const actor = actors[endpoint.actorId];
    if (!actor) fail(`Relation "${relation.id}" role "${role}" references unknown actor "${endpoint.actorId}"`);
    if (endpoint.slotId !== undefined && !actor.slots.some(slot => slot.id === endpoint.slotId)) {
      fail(`Relation "${relation.id}" role "${role}" references unknown slot "${endpoint.actorId}:${endpoint.slotId}"`);
    }
  }

  for (const constraint of relation.constraints) {
    if (constraint.type === 'bind-transform') {
      const subject = endpointForRole(relation, constraint.subjectRole);
      const target = endpointForRole(relation, constraint.targetRole);
      validateTransform(constraint.offset, `Relation "${relation.id}" bind offset`);
      if (subject.slotId !== undefined) fail(`Transform subject role "${constraint.subjectRole}" cannot name a slot`);
      const previous = transformParents.get(subject.actorId);
      if (previous !== undefined) fail(`Actor "${subject.actorId}" has more than one transform binding`);
      transformParents.set(subject.actorId, target.actorId);
    }
    else if (constraint.type === 'reserve-slot') {
      endpointForRole(relation, constraint.claimantRole);
      const slot = endpointForRole(relation, constraint.slotRole);
      if (!slot.slotId) fail(`Reserved slot role "${constraint.slotRole}" must name a slot`);
      const key = slotKey(slot.actorId, slot.slotId);
      slotReservations.set(key, (slotReservations.get(key) ?? 0) + 1);
    }
    else if (constraint.type === 'insert-render-band') {
      endpointForRole(relation, constraint.subjectRole);
      const slot = endpointForRole(relation, constraint.slotRole);
      if (!slot.slotId) fail(`Render-band role "${constraint.slotRole}" must name a slot`);
      const definition = actors[slot.actorId]!.slots.find(candidate => candidate.id === slot.slotId)!;
      if (!definition.renderBand) fail(`Slot "${slot.actorId}:${slot.slotId}" has no render band`);
    }
    else if (constraint.type === 'require-capability') {
      const endpoint = endpointForRole(relation, constraint.actorRole);
      if (!actors[endpoint.actorId]!.capabilities.includes(constraint.capability)) {
        fail(`Actor "${endpoint.actorId}" does not provide required capability "${constraint.capability}"`);
      }
    }
    else {
      endpointForRole(relation, constraint.subjectRole);
      endpointForRole(relation, constraint.ownerRole);
    }
  }
}

function validateDepth(depth: DepthRepresentation, label: string): void {
  switch (depth.type) {
    case 'constant-plane':
      finite(depth.depthOffset, `${label} offset`);
      break;
    case 'plane':
      positive(depth.width, `${label} width`);
      positive(depth.height, `${label} height`);
      finite(depth.depthSlopeX, `${label} depthSlopeX`);
      finite(depth.depthSlopeY, `${label} depthSlopeY`);
      break;
    case 'box':
      positive(depth.width, `${label} width`);
      positive(depth.height, `${label} height`);
      positive(depth.depth, `${label} depth`);
      break;
    case 'ellipsoid':
      positive(depth.radiusX, `${label} radiusX`);
      positive(depth.radiusY, `${label} radiusY`);
      positive(depth.radiusZ, `${label} radiusZ`);
      break;
    case 'capsule':
      positive(depth.radius, `${label} radius`);
      positive(depth.length, `${label} length`);
      positive(depth.depth, `${label} depth`);
      break;
    case 'mesh': {
      if (depth.vertices.length < 9 || depth.vertices.length % 3 !== 0) {
        fail(`${label} vertices must contain at least one xyz triangle`);
      }
      if (depth.indices.length < 3 || depth.indices.length % 3 !== 0) {
        fail(`${label} indices must contain complete triangles`);
      }
      for (const value of depth.vertices) finite(value, `${label} vertex`);
      const vertexCount = depth.vertices.length / 3;
      for (const index of depth.indices) {
        if (!Number.isInteger(index) || index < 0 || index >= vertexCount) fail(`${label} has invalid vertex index ${index}`);
      }
      break;
    }
    case 'depth-map':
      nonEmpty(depth.source, `${label} source`);
      finite(depth.near, `${label} near`);
      finite(depth.far, `${label} far`);
      if (depth.near > depth.far) fail(`${label} near must not exceed far`);
      break;
  }
}

function validateTransform(transform: SceneTransform, label: string): void {
  finite(transform.x, `${label}.x`);
  finite(transform.y, `${label}.y`);
  finite(transform.z, `${label}.z`);
  positive(transform.scaleX, `${label}.scaleX`);
  positive(transform.scaleY, `${label}.scaleY`);
  finite(transform.rotationZ, `${label}.rotationZ`);
}

function validateAcyclicTransformBindings(parents: ReadonlyMap<string, string>): void {
  for (const start of parents.keys()) {
    const visited = new Set<string>();
    let current: string | undefined = start;
    while (current !== undefined) {
      if (visited.has(current)) fail(`Transform binding cycle contains actor "${current}"`);
      visited.add(current);
      current = parents.get(current);
    }
  }
}

function endpointForRole(relation: SceneRelation, role: string) {
  const endpoint = relation.participants[role];
  if (!endpoint) fail(`Relation "${relation.id}" constraint references missing role "${role}"`);
  return endpoint;
}

function slotKey(actorId: string, slotId: string): string {
  return `${actorId}\u0000${slotId}`;
}

function splitSlotKey(value: string): [string, string] {
  const [actorId, slotId] = value.split('\u0000');
  return [actorId!, slotId!];
}

function unique(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) fail(`Duplicate ${label} "${value}"`);
    seen.add(value);
  }
}

function nonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) fail(`${label} must not be empty`);
}

function finite(value: number, label: string): void {
  if (!Number.isFinite(value)) fail(`${label} must be finite`);
}

function positive(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) fail(`${label} must be positive`);
}

function range(value: number, min: number, max: number, label: string): void {
  if (!Number.isFinite(value) || value < min || value > max) fail(`${label} must be between ${min} and ${max}`);
}

function fail(message: string): never {
  throw new Error(message);
}
