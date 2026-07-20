import { resolveSceneActors } from './relations.ts';
import type {
  SceneDrawItem,
  SceneInteractionPolicy,
  SceneRenderFrame,
  SceneRelation,
  SceneSnapshot,
} from './types.ts';

const DISABLED_INTERACTION: SceneInteractionPolicy = Object.freeze({ enabled: false, coverage: 'none' });
const GROUP_RANK = { background: 0, world: 1, overlay: 2 } as const;

export function buildSceneRenderFrame(snapshot: SceneSnapshot): SceneRenderFrame {
  const resolvedActors = resolveSceneActors(snapshot.actors, snapshot.relations);
  const transforms = new Map(resolvedActors.map(actor => [actor.actorId, actor.transform]));
  const baseItems: SceneDrawItem[] = [];

  for (const actorId of Object.keys(snapshot.actors).sort()) {
    const actor = snapshot.actors[actorId]!;
    if (!actor.visible) continue;
    const transform = transforms.get(actorId)!;
    for (const part of actor.renderParts) {
      const item: SceneDrawItem = {
        id: itemId(actorId, part.id),
        actorId,
        partId: part.id,
        group: part.group,
        transform,
        depth: part.depth,
        depthWrite: part.depthWrite,
        color: part.color,
        interaction: part.interaction ?? DISABLED_INTERACTION,
        z: transform.z + part.zOffset,
        tieBreaker: part.tieBreaker,
        pickingId: 0,
      };
      if (part.material) item.material = part.material;
      baseItems.push(item);
    }
  }

  baseItems.sort(compareDrawItems);
  const edges = collectRenderEdges(snapshot.relations, snapshot.actors);
  const drawItems = stableTopologicalSort(baseItems, edges);
  let nextPickingId = 1;
  for (const item of drawItems) {
    if (item.interaction.enabled && item.interaction.coverage !== 'none') item.pickingId = nextPickingId++;
  }

  return {
    generation: snapshot.generation,
    revision: snapshot.revision,
    actors: resolvedActors,
    drawItems,
    orderEdges: edges,
    passes: [
      {
        id: 'actor-surfaces',
        reads: [],
        writes: ['actor-color-surfaces', 'actor-depth-surfaces', 'actor-coverage-surfaces'],
        dependsOn: [],
      },
      {
        id: 'world-depth-composite',
        reads: ['actor-color-surfaces', 'actor-depth-surfaces'],
        writes: ['world-color', 'world-depth'],
        dependsOn: ['actor-surfaces'],
      },
      {
        id: 'coverage-picking',
        reads: ['actor-coverage-surfaces', 'world-depth'],
        writes: ['scene-coverage', 'scene-picking'],
        dependsOn: ['world-depth-composite'],
      },
      {
        id: 'overlay-composite',
        reads: ['world-color'],
        writes: ['final-color'],
        dependsOn: ['coverage-picking'],
      },
    ],
  };
}

function collectRenderEdges(
  relations: Readonly<Record<string, SceneRelation>>,
  actors: SceneSnapshot['actors'],
): Array<{ before: string; after: string }> {
  const edges: Array<{ before: string; after: string }> = [];
  const seen = new Set<string>();
  for (const relation of Object.values(relations)) {
    for (const constraint of relation.constraints) {
      if (constraint.type !== 'insert-render-band') continue;
      const subject = relation.participants[constraint.subjectRole];
      const host = relation.participants[constraint.slotRole];
      if (!subject || !host?.slotId) continue;
      const subjectParts = actors[subject.actorId]?.renderParts ?? [];
      const band = actors[host.actorId]?.slots.find(slot => slot.id === host.slotId)?.renderBand;
      if (!band) continue;
      for (const subjectPart of subjectParts) {
        for (const hostPart of band.after) addEdge(itemId(host.actorId, hostPart), itemId(subject.actorId, subjectPart.id));
        for (const hostPart of band.before) addEdge(itemId(subject.actorId, subjectPart.id), itemId(host.actorId, hostPart));
      }
    }
  }
  return edges;

  function addEdge(before: string, after: string): void {
    const key = `${before}\u0000${after}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ before, after });
  }
}

function stableTopologicalSort(
  items: readonly SceneDrawItem[],
  edges: readonly { before: string; after: string }[],
): SceneDrawItem[] {
  const byId = new Map(items.map(item => [item.id, item]));
  const baseIndex = new Map(items.map((item, index) => [item.id, index]));
  const outgoing = new Map<string, string[]>();
  const indegree = new Map(items.map(item => [item.id, 0]));
  for (const edge of edges) {
    if (!byId.has(edge.before) || !byId.has(edge.after)) continue;
    outgoing.set(edge.before, [...(outgoing.get(edge.before) ?? []), edge.after]);
    indegree.set(edge.after, (indegree.get(edge.after) ?? 0) + 1);
  }
  const ready = items.filter(item => indegree.get(item.id) === 0);
  const result: SceneDrawItem[] = [];
  while (ready.length > 0) {
    ready.sort((left, right) => baseIndex.get(left.id)! - baseIndex.get(right.id)!);
    const item = ready.shift()!;
    result.push(item);
    for (const target of outgoing.get(item.id) ?? []) {
      const next = indegree.get(target)! - 1;
      indegree.set(target, next);
      if (next === 0) ready.push(byId.get(target)!);
    }
  }
  if (result.length !== items.length) throw new Error('Render-band constraints contain an ordering cycle');
  return result;
}

function compareDrawItems(left: SceneDrawItem, right: SceneDrawItem): number {
  return GROUP_RANK[left.group] - GROUP_RANK[right.group]
    || right.z - left.z
    || left.tieBreaker - right.tieBreaker
    || left.id.localeCompare(right.id);
}

function itemId(actorId: string, partId: string): string {
  return `${actorId}:${partId}`;
}
