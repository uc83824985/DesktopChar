import type {
  AffectVector,
  AvatarState,
  CharacterExpressionCatalog,
  ExpressionCandidate,
  ExpressionDescriptor,
  ExpressionSelectionHistoryEntry,
  ResolvedExpression,
} from '../../contracts/src/index.ts';

export interface ExpressionResolutionInput {
  catalog: CharacterExpressionCatalog;
  avatarState: AvatarState;
  resolutionId: string;
  randomSeed: number;
  nowMs: number;
  candidates?: ExpressionCandidate[];
  affect?: Partial<AffectVector>;
  personaTags?: string[];
  sceneTags?: string[];
  currentExpressionKey?: string;
  history?: ExpressionSelectionHistoryEntry[];
}

interface ScoredExpression {
  descriptor: ExpressionDescriptor;
  candidate?: ExpressionCandidate;
  score: number;
  source: ResolvedExpression['source'];
}

const AFFECT_RANGES: Record<keyof AffectVector, readonly [number, number]> = {
  valence: [-1, 1],
  arousal: [0, 1],
  approval: [-1, 1],
  engagement: [0, 1],
  certainty: [0, 1],
};

/**
 * Resolves an asset-free expression key. Runtime supplies all mutable state
 * (time, current key and history), so the resolver remains deterministic and
 * cannot become a second state owner.
 */
export function resolveExpression(input: ExpressionResolutionInput): ResolvedExpression {
  validateResolutionInput(input);
  const descriptorByKey = new Map(
    input.catalog.descriptors.map(descriptor => [descriptor.expressionKey, descriptor]),
  );
  const candidates = validateCandidates(input.candidates ?? [], descriptorByKey);
  const candidateByKey = new Map(candidates.map(candidate => [candidate.expressionKey, candidate]));
  const recentByKey = mostRecentSelectionByKey(input.history ?? []);
  const contextTags = new Set([
    ...(input.personaTags ?? []),
    ...(input.sceneTags ?? []),
  ].map(normalizeTag));

  const compatible = input.catalog.descriptors.filter(descriptor => (
    descriptor.compatibleAvatarStates.includes(input.avatarState)
  ));
  const scored = compatible.map((descriptor): ScoredExpression => {
    const candidate = candidateByKey.get(descriptor.expressionKey);
    const affectScore = affectSimilarity(input.affect, descriptor.affectPrototype);
    const source: ResolvedExpression['source'] = candidate
      ? 'candidate'
      : affectScore === undefined ? 'fallback' : 'affect';
    let score = Math.log1p(descriptor.baseWeight);
    if (candidate) score += candidate.confidence * 4;
    if (affectScore !== undefined) score += affectScore * 2;
    score += tagOverlapScore(contextTags, descriptor.semanticTags);
    if (descriptor.expressionKey === input.currentExpressionKey) score -= 0.75;
    const selectedAtMs = recentByKey.get(descriptor.expressionKey);
    if (
      selectedAtMs !== undefined
      && input.nowMs - selectedAtMs < descriptor.cooldownMs
      && descriptor.expressionKey !== input.catalog.defaultExpressionKey
    ) {
      score -= 10;
    }
    return { descriptor, ...(candidate ? { candidate } : {}), score, source };
  });

  const defaultDescriptor = descriptorByKey.get(input.catalog.defaultExpressionKey)!;
  const viable = scored.filter(item => item.score > -5);
  const pool = viable.length
    ? viable
    : [{
        descriptor: defaultDescriptor,
        score: Math.log1p(defaultDescriptor.baseWeight),
        source: 'fallback' as const,
      }];
  const selected = selectScored(pool, input.randomSeed, input.resolutionId, input.catalog.revision);
  const intensity = selected.candidate?.intensity
    ?? (selected.descriptor.expressionKey === input.catalog.defaultExpressionKey ? 0.25 : 0.5);
  return {
    expressionKey: selected.descriptor.expressionKey,
    intensity,
    holdMs: interpolateHold(selected.descriptor, intensity),
    score: selected.score,
    source: selected.source,
  };
}

function selectScored(
  values: ScoredExpression[],
  seed: number,
  resolutionId: string,
  catalogRevision: number,
): ScoredExpression {
  const ordered = [...values].sort((left, right) => (
    right.score - left.score
    || left.descriptor.expressionKey.localeCompare(right.descriptor.expressionKey)
  ));
  const first = ordered[0]!;
  const second = ordered[1];
  if (
    first.candidate
    && first.candidate.confidence >= 0.75
    && (!second || first.score - second.score >= 0.8)
  ) {
    return first;
  }

  const nearBest = ordered.filter(value => first.score - value.score <= 1.5);
  if (nearBest.length === 1) return first;
  const total = nearBest.reduce((sum, value) => sum + Math.exp(value.score - first.score), 0);
  let cursor = deterministicUnit(`${seed}:${catalogRevision}:${resolutionId}`) * total;
  for (const value of nearBest) {
    cursor -= Math.exp(value.score - first.score);
    if (cursor <= 0) return value;
  }
  return nearBest[nearBest.length - 1]!;
}

function validateResolutionInput(input: ExpressionResolutionInput): void {
  if (!Number.isInteger(input.catalog.revision) || input.catalog.revision < 0) {
    throw new TypeError('Expression catalog revision must be a non-negative integer');
  }
  if (!input.resolutionId.trim()) throw new TypeError('Expression resolutionId is required');
  if (!Number.isInteger(input.randomSeed)) throw new TypeError('Expression randomSeed must be an integer');
  if (!Number.isFinite(input.nowMs) || input.nowMs < 0) {
    throw new TypeError('Expression nowMs must be finite and non-negative');
  }
  const keys = new Set<string>();
  for (const descriptor of input.catalog.descriptors) {
    if (!descriptor.expressionKey || keys.has(descriptor.expressionKey)) {
      throw new TypeError('Expression catalog descriptor keys must be non-empty and unique');
    }
    keys.add(descriptor.expressionKey);
  }
  if (!keys.has(input.catalog.defaultExpressionKey)) {
    throw new TypeError('Expression catalog default key is not described');
  }
  if (!input.catalog.descriptors.length) {
    throw new TypeError('Expression catalog must not be empty');
  }
  if (!input.catalog.descriptors.some(descriptor => (
    descriptor.compatibleAvatarStates.includes(input.avatarState)
  ))) {
    throw new TypeError(`Expression catalog has no entry compatible with ${input.avatarState}`);
  }
  validateAffect(input.affect, 'Expression resolution affect');
}

function validateCandidates(
  values: ExpressionCandidate[],
  descriptorByKey: ReadonlyMap<string, ExpressionDescriptor>,
): ExpressionCandidate[] {
  const keys = new Set<string>();
  return values.map((candidate, index) => {
    if (!descriptorByKey.has(candidate.expressionKey)) {
      throw new TypeError(`Expression candidate is not in the catalog: ${candidate.expressionKey}`);
    }
    if (keys.has(candidate.expressionKey)) {
      throw new TypeError(`Expression candidate is duplicated: ${candidate.expressionKey}`);
    }
    if (!unit(candidate.confidence) || !unit(candidate.intensity)) {
      throw new TypeError(`Expression candidate ${index} confidence and intensity must be from 0 to 1`);
    }
    keys.add(candidate.expressionKey);
    return candidate;
  });
}

function affectSimilarity(
  affect: Partial<AffectVector> | undefined,
  prototype: Partial<AffectVector> | undefined,
): number | undefined {
  if (!affect || !prototype) return undefined;
  let dimensions = 0;
  let distance = 0;
  for (const key of Object.keys(AFFECT_RANGES) as Array<keyof AffectVector>) {
    const actual = affect[key];
    const expected = prototype[key];
    if (actual === undefined || expected === undefined) continue;
    const [minimum, maximum] = AFFECT_RANGES[key];
    distance += Math.abs(actual - expected) / (maximum - minimum);
    dimensions++;
  }
  return dimensions ? Math.max(0, 1 - distance / dimensions) : undefined;
}

function validateAffect(value: Partial<AffectVector> | undefined, label: string): void {
  if (!value) return;
  for (const key of Object.keys(value) as Array<keyof AffectVector>) {
    if (!(key in AFFECT_RANGES)) throw new TypeError(`${label} has unknown dimension: ${key}`);
    const dimension = value[key];
    if (dimension === undefined) continue;
    const [minimum, maximum] = AFFECT_RANGES[key];
    if (!Number.isFinite(dimension) || dimension < minimum || dimension > maximum) {
      throw new TypeError(`${label}.${key} must be from ${minimum} to ${maximum}`);
    }
  }
}

function mostRecentSelectionByKey(
  history: ExpressionSelectionHistoryEntry[],
): Map<string, number> {
  const result = new Map<string, number>();
  for (const entry of history) {
    const current = result.get(entry.expressionKey);
    if (current === undefined || entry.selectedAtMs > current) {
      result.set(entry.expressionKey, entry.selectedAtMs);
    }
  }
  return result;
}

function tagOverlapScore(context: ReadonlySet<string>, semanticTags: string[]): number {
  if (!context.size) return 0;
  let score = 0;
  for (const tag of semanticTags) {
    if (context.has(normalizeTag(tag))) score += 0.25;
  }
  return Math.min(0.75, score);
}

function interpolateHold(descriptor: ExpressionDescriptor, intensity: number): number {
  return Math.round(
    descriptor.holdMs.minMs
    + (descriptor.holdMs.maxMs - descriptor.holdMs.minMs) * intensity,
  );
}

function deterministicUnit(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) / 0x1_0000_0000;
}

function normalizeTag(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function unit(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}
