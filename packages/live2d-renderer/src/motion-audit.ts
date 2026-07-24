export type MotionAuditSampleKind = 'motion' | 'recovery';
export type MotionAuditSampleReason =
  | 'fixed-cadence'
  | 'motion-end'
  | 'curve-event-before'
  | 'curve-event'
  | 'curve-event-after'
  | 'baseline-recovery';

export type MotionAuditImportanceSignal =
  | 'short-transition'
  | 'discrete-step'
  | 'effect-curve'
  | 'toggle-curve'
  | 'effect-phase-boundary'
  | 'dense-change-window';

export interface MotionAuditImportanceEvent {
  timeMs: number;
  score: number;
  signals: MotionAuditImportanceSignal[];
  curveIds: string[];
  nearbyChangedSegmentCount: number;
}

export interface MotionAuditSampleImportance {
  score: number;
  sourceEventMs: number;
  offsetMs: number;
  signals: MotionAuditImportanceSignal[];
  curveIds: string[];
}

export interface MotionAuditInput {
  id: string;
  durationMs: number;
  importanceEvents?: MotionAuditImportanceEvent[];
}

export interface MotionAuditPlanOptions {
  intervalMs: number;
  recoveryMs: number;
  maxFrames: number;
  maxFramesPerMotion: number;
}

export interface MotionAuditImportancePlanOptions extends MotionAuditPlanOptions {
  importanceRadiusMs: number;
  maxImportanceSamplesPerMotion: number;
}

export interface MotionAuditSamplePoint {
  kind: MotionAuditSampleKind;
  reason: MotionAuditSampleReason;
  targetMs: number;
  importance?: MotionAuditSampleImportance;
}

export interface MotionAuditMotionPlan {
  id: string;
  durationMs: number;
  requestedCount: number;
  omittedCount: number;
  omittedSamples: MotionAuditSamplePoint[];
  samples: MotionAuditSamplePoint[];
}

export interface MotionAuditPlan {
  requestedFrames: number;
  exportedFrames: number;
  omittedFrames: number;
  motions: MotionAuditMotionPlan[];
}

export interface Live2dMotionCurveSummary {
  target: string;
  id: string;
  minimumValue: number;
  maximumValue: number;
  valueSpan: number;
  keyframeCount: number;
  controlPointCount: number;
  segmentTypes: {
    linear: number;
    bezier: number;
    stepped: number;
    inverseStepped: number;
  };
}

export interface Live2dMotionSourceSummary {
  durationMs: number;
  fps: number;
  loop: boolean;
  fadeInMs: number;
  fadeOutMs: number;
  curveCount: number;
  dynamicCurveCount: number;
  curves: Live2dMotionCurveSummary[];
  importance: {
    changedSegmentCount: number;
    shortSegmentCount: number;
    discreteSegmentCount: number;
    events: MotionAuditImportanceEvent[];
  };
}

const VALUE_EPSILON = 1e-6;
const IMPORTANCE_CLUSTER_RADIUS_MS = 40;
const IMPORTANCE_DENSITY_WINDOW_MS = 500;
const IMPORTANCE_DENSITY_THRESHOLD = 8;
const IMPORTANCE_SAMPLE_DEDUPLICATION_MS = 110;

/**
 * Creates a fixed-cadence request first, then thins it evenly only when a
 * configured frame budget would otherwise be exceeded.
 */
export function createFixedMotionAuditPlan(
  inputs: MotionAuditInput[],
  options: MotionAuditPlanOptions,
): MotionAuditPlan {
  validatePlanInputs(inputs, options);
  const requested = inputs.map(input => ({
    input,
    samples: requestedSamples(input.durationMs, options.intervalMs, options.recoveryMs),
  }));
  const requestedFrames = requested.reduce((sum, motion) => sum + motion.samples.length, 0);
  const perMotionCapacity = requested.map(motion =>
    Math.min(motion.samples.length, options.maxFramesPerMotion));
  const allocations = allocateFrameBudget(perMotionCapacity, options.maxFrames);
  const motions = requested.map((motion, index): MotionAuditMotionPlan => {
    const samples = selectEvenly(motion.samples, allocations[index]!);
    const selected = new Set(samples);
    return {
      id: motion.input.id,
      durationMs: motion.input.durationMs,
      requestedCount: motion.samples.length,
      omittedCount: motion.samples.length - samples.length,
      omittedSamples: motion.samples.filter(sample => !selected.has(sample)),
      samples,
    };
  });
  const exportedFrames = motions.reduce((sum, motion) => sum + motion.samples.length, 0);
  return {
    requestedFrames,
    exportedFrames,
    omittedFrames: requestedFrames - exportedFrames,
    motions,
  };
}

/**
 * Preserves the fixed-cadence overview whenever the budget allows it, then
 * spends remaining frames on deterministic curve-derived event samples. When
 * the fixed overview alone exceeds the budget, a bounded reserve lets strong
 * importance events displace a small number of cadence frames.
 */
export function createImportanceMotionAuditPlan(
  inputs: MotionAuditInput[],
  options: MotionAuditImportancePlanOptions,
): MotionAuditPlan {
  validatePlanInputs(inputs, options);
  nonNegativeNumber(options.importanceRadiusMs, 'Motion audit importanceRadiusMs');
  nonNegativeInteger(
    options.maxImportanceSamplesPerMotion,
    'Motion audit maxImportanceSamplesPerMotion',
  );

  const requested = inputs.map(input => {
    const baseline = requestedSamples(input.durationMs, options.intervalMs, options.recoveryMs);
    const importance = requestedImportanceSamples(input, baseline, options);
    return { input, baseline, importance };
  });
  const requestedFrames = requested.reduce(
    (sum, motion) => sum + motion.baseline.length + motion.importance.length,
    0,
  );

  const baselineCapacities = requested.map(motion =>
    Math.min(motion.baseline.length, options.maxFramesPerMotion));
  const cappedBaselineTotal = baselineCapacities.reduce((sum, count) => sum + count, 0);
  const importanceCandidateCount = requested.reduce(
    (sum, motion, index) => sum + Math.min(
      motion.importance.length,
      Math.max(0, options.maxFramesPerMotion - baselineCapacities[index]!),
    ),
    0,
  );
  let baselineBudget = Math.min(cappedBaselineTotal, options.maxFrames);
  if (cappedBaselineTotal > options.maxFrames && importanceCandidateCount > 0) {
    const maximumReserve = Math.max(0, options.maxFrames - inputs.length);
    const importanceReserve = Math.min(
      importanceCandidateCount,
      maximumReserve,
      Math.max(1, Math.floor(options.maxFrames * 0.15)),
    );
    baselineBudget -= importanceReserve;
  }
  const baselineAllocations = allocateFrameBudget(baselineCapacities, baselineBudget);
  const selectedBaseline = requested.map((motion, index) =>
    selectEvenly(motion.baseline, baselineAllocations[index]!));

  const selectedImportance = requested.map((): MotionAuditSamplePoint[] => []);
  const rankedImportance = requested.flatMap((motion, motionIndex) =>
    motion.importance.map(sample => ({ motionIndex, sample })))
    .sort((left, right) =>
      (right.sample.importance?.score ?? 0) - (left.sample.importance?.score ?? 0)
      || left.motionIndex - right.motionIndex
      || left.sample.targetMs - right.sample.targetMs);
  let remainingFrames = options.maxFrames
    - selectedBaseline.reduce((sum, samples) => sum + samples.length, 0);
  for (const candidate of rankedImportance) {
    if (remainingFrames <= 0) break;
    const motionSamples = selectedImportance[candidate.motionIndex]!;
    const perMotionCapacity = options.maxFramesPerMotion
      - selectedBaseline[candidate.motionIndex]!.length;
    if (motionSamples.length >= perMotionCapacity) continue;
    motionSamples.push(candidate.sample);
    remainingFrames--;
  }

  const motions = requested.map((motion, index): MotionAuditMotionPlan => {
    const samples = [
      ...selectedBaseline[index]!,
      ...selectedImportance[index]!,
    ].sort(compareSamplePoints);
    const selected = new Set(samples);
    const allRequested = [...motion.baseline, ...motion.importance];
    return {
      id: motion.input.id,
      durationMs: motion.input.durationMs,
      requestedCount: allRequested.length,
      omittedCount: allRequested.length - samples.length,
      omittedSamples: allRequested.filter(sample => !selected.has(sample)).sort(compareSamplePoints),
      samples,
    };
  });
  const exportedFrames = motions.reduce((sum, motion) => sum + motion.samples.length, 0);
  return {
    requestedFrames,
    exportedFrames,
    omittedFrames: requestedFrames - exportedFrames,
    motions,
  };
}

export function summarizeLive2dMotionSource(source: unknown): Live2dMotionSourceSummary {
  const root = record(source, 'Live2D motion');
  const meta = record(root.Meta, 'Live2D motion Meta');
  const analyses = array(root.Curves, 'Live2D motion Curves')
    .map((curve, index) => analyzeCurve(curve, index));
  const curves = analyses.map(analysis => analysis.summary);
  const importance = summarizeImportanceEvents(analyses);
  return {
    durationMs: positiveNumber(meta.Duration, 'Live2D motion Meta.Duration') * 1_000,
    fps: positiveNumber(meta.Fps, 'Live2D motion Meta.Fps'),
    loop: boolean(meta.Loop, 'Live2D motion Meta.Loop'),
    fadeInMs: nonNegativeNumber(meta.FadeInTime ?? 0, 'Live2D motion Meta.FadeInTime') * 1_000,
    fadeOutMs: nonNegativeNumber(meta.FadeOutTime ?? 0, 'Live2D motion Meta.FadeOutTime') * 1_000,
    curveCount: curves.length,
    dynamicCurveCount: curves.filter(curve => curve.valueSpan > VALUE_EPSILON).length,
    curves,
    importance,
  };
}

function requestedImportanceSamples(
  input: MotionAuditInput,
  baseline: MotionAuditSamplePoint[],
  options: MotionAuditImportancePlanOptions,
): MotionAuditSamplePoint[] {
  if (options.maxImportanceSamplesPerMotion === 0 || !input.importanceEvents?.length) return [];
  const minimumEventSeparationMs = Math.max(options.intervalMs, options.importanceRadiusMs * 2);
  const rankedEvents = [...input.importanceEvents].sort((left, right) =>
    right.score - left.score || left.timeMs - right.timeMs);
  const selectedEvents: MotionAuditImportanceEvent[] = [];
  const candidates: MotionAuditSamplePoint[] = [];
  const finalMotionMs = Math.max(0, input.durationMs - Math.min(50, options.intervalMs / 4));
  for (const event of rankedEvents) {
    if (selectedEvents.some(selected =>
      Math.abs(selected.timeMs - event.timeMs) < minimumEventSeparationMs)) continue;
    selectedEvents.push(event);
    const offsets = options.importanceRadiusMs === 0
      ? [0]
      : [-options.importanceRadiusMs, 0, options.importanceRadiusMs];
    for (const offsetMs of offsets) {
      const targetMs = Math.max(0, Math.min(finalMotionMs, event.timeMs + offsetMs));
      if (isNearSample(targetMs, baseline) || isNearSample(targetMs, candidates)) continue;
      const reason: MotionAuditSampleReason = offsetMs < 0
        ? 'curve-event-before'
        : offsetMs > 0
          ? 'curve-event-after'
          : 'curve-event';
      candidates.push({
        kind: 'motion',
        reason,
        targetMs,
        importance: {
          score: event.score * (offsetMs === 0 ? 1 : 0.85),
          sourceEventMs: event.timeMs,
          offsetMs,
          signals: event.signals,
          curveIds: event.curveIds,
        },
      });
      if (candidates.length >= options.maxImportanceSamplesPerMotion) {
        return candidates.sort(compareSamplePoints);
      }
    }
  }
  return candidates.sort(compareSamplePoints);
}

function isNearSample(targetMs: number, samples: MotionAuditSamplePoint[]): boolean {
  return samples.some(sample =>
    sample.kind === 'motion'
    && Math.abs(sample.targetMs - targetMs) < IMPORTANCE_SAMPLE_DEDUPLICATION_MS);
}

function requestedSamples(
  durationMs: number,
  intervalMs: number,
  recoveryMs: number,
): MotionAuditSamplePoint[] {
  const samples: MotionAuditSamplePoint[] = [];
  const finalMotionMs = Math.max(0, durationMs - Math.min(50, intervalMs / 4));
  for (let targetMs = 0; targetMs <= finalMotionMs; targetMs += intervalMs) {
    samples.push({ kind: 'motion', reason: 'fixed-cadence', targetMs });
  }
  const lastMotionMs = samples.at(-1)?.targetMs ?? 0;
  const minimumUsefulSeparationMs = Math.min(100, intervalMs / 2);
  if (finalMotionMs - lastMotionMs >= minimumUsefulSeparationMs) {
    samples.push({ kind: 'motion', reason: 'motion-end', targetMs: finalMotionMs });
  }
  samples.push({
    kind: 'recovery',
    reason: 'baseline-recovery',
    targetMs: durationMs + recoveryMs,
  });
  return samples;
}

function allocateFrameBudget(capacities: number[], maximum: number): number[] {
  if (capacities.length === 0) return [];
  if (maximum < capacities.length) {
    throw new RangeError(
      `Motion audit maxFrames (${maximum}) must allow at least one frame for each selected motion (${capacities.length})`,
    );
  }
  const totalCapacity = capacities.reduce((sum, capacity) => sum + capacity, 0);
  if (totalCapacity <= maximum) return [...capacities];

  const allocations = capacities.map(() => 1);
  let remaining = maximum - allocations.length;
  while (remaining > 0) {
    let selected = -1;
    let selectedRatio = Number.POSITIVE_INFINITY;
    for (let index = 0; index < capacities.length; index++) {
      if (allocations[index]! >= capacities[index]!) continue;
      const ratio = allocations[index]! / capacities[index]!;
      if (ratio < selectedRatio) {
        selected = index;
        selectedRatio = ratio;
      }
    }
    if (selected < 0) break;
    allocations[selected]!++;
    remaining--;
  }
  return allocations;
}

function selectEvenly<T>(values: T[], count: number): T[] {
  if (count >= values.length) return [...values];
  if (count <= 0) return [];
  if (count === 1) return [values[0]!];
  const selected: T[] = [];
  const used = new Set<number>();
  for (let position = 0; position < count; position++) {
    let index = Math.round(position * (values.length - 1) / (count - 1));
    while (used.has(index) && index + 1 < values.length) index++;
    used.add(index);
    selected.push(values[index]!);
  }
  return selected;
}

interface AnalyzedCurve {
  summary: Live2dMotionCurveSummary;
  transitions: Array<{
    startMs: number;
    endMs: number;
    durationMs: number;
    type: number;
    changed: boolean;
  }>;
}

function analyzeCurve(value: unknown, index: number): AnalyzedCurve {
  const curve = record(value, `Live2D motion Curves[${index}]`);
  const segments = numberArray(curve.Segments, `Live2D motion Curves[${index}].Segments`);
  if (segments.length < 2) throw new TypeError(`Live2D motion Curves[${index}].Segments is incomplete`);
  const values = [segments[1]!];
  const transitions: AnalyzedCurve['transitions'] = [];
  let keyframeCount = 1;
  let controlPointCount = 0;
  const segmentTypes = { linear: 0, bezier: 0, stepped: 0, inverseStepped: 0 };
  let previousTime = segments[0]!;
  let previousValue = segments[1]!;
  let cursor = 2;
  while (cursor < segments.length) {
    const type = segments[cursor++]!;
    let endTime: number;
    let endValue: number;
    let controlValues: number[] = [];
    if (type === 1) {
      requireRemaining(segments, cursor, 6, index);
      controlValues = [segments[cursor + 1]!, segments[cursor + 3]!];
      endTime = segments[cursor + 4]!;
      endValue = segments[cursor + 5]!;
      values.push(...controlValues, endValue);
      cursor += 6;
      keyframeCount++;
      controlPointCount += 2;
      segmentTypes.bezier++;
    }
    else if (type === 0 || type === 2 || type === 3) {
      requireRemaining(segments, cursor, 2, index);
      endTime = segments[cursor]!;
      endValue = segments[cursor + 1]!;
      values.push(endValue);
      cursor += 2;
      keyframeCount++;
      if (type === 0) segmentTypes.linear++;
      else if (type === 2) segmentTypes.stepped++;
      else segmentTypes.inverseStepped++;
    }
    else throw new TypeError(`Live2D motion Curves[${index}] has unsupported segment type ${type}`);
    transitions.push({
      startMs: previousTime * 1_000,
      endMs: endTime * 1_000,
      durationMs: (endTime - previousTime) * 1_000,
      type,
      changed: Math.abs(endValue - previousValue) > VALUE_EPSILON
        || controlValues.some(controlValue =>
          Math.abs(controlValue - previousValue) > VALUE_EPSILON),
    });
    previousTime = endTime;
    previousValue = endValue;
  }
  const minimumValue = Math.min(...values);
  const maximumValue = Math.max(...values);
  return {
    summary: {
      target: text(curve.Target, `Live2D motion Curves[${index}].Target`),
      id: text(curve.Id, `Live2D motion Curves[${index}].Id`),
      minimumValue,
      maximumValue,
      valueSpan: maximumValue - minimumValue,
      keyframeCount,
      controlPointCount,
      segmentTypes,
    },
    transitions,
  };
}

function summarizeImportanceEvents(
  analyses: AnalyzedCurve[],
): Live2dMotionSourceSummary['importance'] {
  const changedTransitions = analyses.flatMap(analysis => {
    const dynamic = analysis.transitions.filter(transition => transition.changed);
    return dynamic.map((transition, dynamicIndex) => ({
      analysis,
      transition,
      isEffectPhaseBoundary: isEffectCurve(analysis.summary.id)
        && (dynamicIndex === 0 || dynamicIndex === dynamic.length - 1),
    }));
  });
  const rawEvents = changedTransitions.flatMap(({
    analysis,
    transition,
    isEffectPhaseBoundary,
  }) => {
    const eventTimeMs = transition.type === 3 ? transition.startMs : transition.endMs;
    const nearbyChangedSegmentCount = changedTransitions.filter(candidate => {
      const candidateTime = candidate.transition.type === 3
        ? candidate.transition.startMs
        : candidate.transition.endMs;
      return Math.abs(candidateTime - eventTimeMs) <= IMPORTANCE_DENSITY_WINDOW_MS / 2;
    }).length;
    const signals: MotionAuditImportanceSignal[] = [];
    if (transition.durationMs <= 250) signals.push('short-transition');
    if (transition.type === 2 || transition.type === 3) signals.push('discrete-step');
    if (isEffectCurve(analysis.summary.id)) signals.push('effect-curve');
    if (isToggleCurve(analysis.summary)) signals.push('toggle-curve');
    if (isEffectPhaseBoundary) signals.push('effect-phase-boundary');
    if (nearbyChangedSegmentCount >= IMPORTANCE_DENSITY_THRESHOLD) {
      signals.push('dense-change-window');
    }
    const shouldKeep = signals.includes('discrete-step')
      || signals.includes('short-transition')
      || (
        transition.durationMs <= 500
        && (signals.includes('effect-curve') || signals.includes('toggle-curve'))
      )
      || signals.includes('effect-phase-boundary')
      || signals.includes('dense-change-window');
    if (!shouldKeep) return [];
    let score = 10;
    if (transition.durationMs <= 125) score += 60;
    else if (transition.durationMs <= 250) score += 35;
    else if (transition.durationMs <= 500) score += 15;
    if (signals.includes('discrete-step')) score += 90;
    if (signals.includes('effect-curve')) score += 25;
    if (signals.includes('toggle-curve')) score += 45;
    if (signals.includes('effect-phase-boundary')) score += 100;
    if (signals.includes('dense-change-window')) {
      score += Math.min(120, nearbyChangedSegmentCount * 3);
    }
    return [{
      timeMs: eventTimeMs,
      score,
      signals,
      curveIds: [analysis.summary.id],
      nearbyChangedSegmentCount,
    }];
  }).sort((left, right) => left.timeMs - right.timeMs);

  const events: MotionAuditImportanceEvent[] = [];
  const clusterStartTimes: number[] = [];
  for (const event of rawEvents) {
    const current = events.at(-1);
    const clusterStartTime = clusterStartTimes.at(-1);
    if (
      !current
      || clusterStartTime === undefined
      || event.timeMs - clusterStartTime > IMPORTANCE_CLUSTER_RADIUS_MS
    ) {
      events.push({ ...event });
      clusterStartTimes.push(event.timeMs);
      continue;
    }
    if (event.score > current.score) current.timeMs = event.timeMs;
    current.score = Math.min(1_000, Math.max(current.score, event.score) + 8);
    current.signals = unique([...current.signals, ...event.signals]);
    current.curveIds = unique([...current.curveIds, ...event.curveIds]);
    current.nearbyChangedSegmentCount = Math.max(
      current.nearbyChangedSegmentCount,
      event.nearbyChangedSegmentCount,
    );
  }
  return {
    changedSegmentCount: changedTransitions.length,
    shortSegmentCount: changedTransitions.filter(item => item.transition.durationMs <= 250).length,
    discreteSegmentCount: changedTransitions.filter(item =>
      item.transition.type === 2 || item.transition.type === 3).length,
    events,
  };
}

function isEffectCurve(id: string): boolean {
  return /(?:Effect|Heart|Explosion|Smoke|Rabbit|Aura|Sphere|Light|Ink|Magic|Color)/iu.test(id);
}

function isToggleCurve(curve: Live2dMotionCurveSummary): boolean {
  return curve.target === 'PartOpacity'
    || /(?:On|Visible|Opacity|Appearance|Elimination|Draworder)$/iu.test(curve.id);
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function compareSamplePoints(
  left: MotionAuditSamplePoint,
  right: MotionAuditSamplePoint,
): number {
  return left.targetMs - right.targetMs
    || Number(left.kind === 'recovery') - Number(right.kind === 'recovery');
}

function validatePlanInputs(inputs: MotionAuditInput[], options: MotionAuditPlanOptions): void {
  const ids = new Set<string>();
  for (const input of inputs) {
    if (!input.id.trim() || ids.has(input.id)) {
      throw new TypeError('Motion audit inputs must have unique non-empty IDs');
    }
    ids.add(input.id);
    positiveNumber(input.durationMs, `Motion audit ${input.id} durationMs`);
  }
  positiveNumber(options.intervalMs, 'Motion audit intervalMs');
  nonNegativeNumber(options.recoveryMs, 'Motion audit recoveryMs');
  positiveInteger(options.maxFrames, 'Motion audit maxFrames');
  positiveInteger(options.maxFramesPerMotion, 'Motion audit maxFramesPerMotion');
}

function requireRemaining(values: number[], cursor: number, count: number, curveIndex: number): void {
  if (cursor + count > values.length) {
    throw new TypeError(`Live2D motion Curves[${curveIndex}].Segments is truncated`);
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value;
}

function numberArray(value: unknown, label: string): number[] {
  const values = array(value, label);
  if (!values.every(item => typeof item === 'number' && Number.isFinite(item))) {
    throw new TypeError(`${label} must contain finite numbers`);
  }
  return values as number[];
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be non-empty`);
  return value.trim();
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${label} must be a boolean`);
  return value;
}

function positiveNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive finite number`);
  }
  return value;
}

function nonNegativeNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative finite number`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return value as number;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new TypeError(`${label} must be a non-negative integer`);
  }
  return value as number;
}
