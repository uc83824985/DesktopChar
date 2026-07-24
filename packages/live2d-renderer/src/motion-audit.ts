export type MotionAuditSampleKind = 'motion' | 'recovery';
export type MotionAuditSampleReason = 'fixed-cadence' | 'motion-end' | 'baseline-recovery';

export interface MotionAuditInput {
  id: string;
  durationMs: number;
}

export interface MotionAuditPlanOptions {
  intervalMs: number;
  recoveryMs: number;
  maxFrames: number;
  maxFramesPerMotion: number;
}

export interface MotionAuditSamplePoint {
  kind: MotionAuditSampleKind;
  reason: MotionAuditSampleReason;
  targetMs: number;
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
}

const VALUE_EPSILON = 1e-6;

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

export function summarizeLive2dMotionSource(source: unknown): Live2dMotionSourceSummary {
  const root = record(source, 'Live2D motion');
  const meta = record(root.Meta, 'Live2D motion Meta');
  const curves = array(root.Curves, 'Live2D motion Curves')
    .map((curve, index) => summarizeCurve(curve, index));
  return {
    durationMs: positiveNumber(meta.Duration, 'Live2D motion Meta.Duration') * 1_000,
    fps: positiveNumber(meta.Fps, 'Live2D motion Meta.Fps'),
    loop: boolean(meta.Loop, 'Live2D motion Meta.Loop'),
    fadeInMs: nonNegativeNumber(meta.FadeInTime ?? 0, 'Live2D motion Meta.FadeInTime') * 1_000,
    fadeOutMs: nonNegativeNumber(meta.FadeOutTime ?? 0, 'Live2D motion Meta.FadeOutTime') * 1_000,
    curveCount: curves.length,
    dynamicCurveCount: curves.filter(curve => curve.valueSpan > VALUE_EPSILON).length,
    curves,
  };
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

function summarizeCurve(value: unknown, index: number): Live2dMotionCurveSummary {
  const curve = record(value, `Live2D motion Curves[${index}]`);
  const segments = numberArray(curve.Segments, `Live2D motion Curves[${index}].Segments`);
  if (segments.length < 2) throw new TypeError(`Live2D motion Curves[${index}].Segments is incomplete`);
  const values = [segments[1]!];
  let keyframeCount = 1;
  let controlPointCount = 0;
  const segmentTypes = { linear: 0, bezier: 0, stepped: 0, inverseStepped: 0 };
  let cursor = 2;
  while (cursor < segments.length) {
    const type = segments[cursor++]!;
    if (type === 1) {
      requireRemaining(segments, cursor, 6, index);
      values.push(segments[cursor + 1]!, segments[cursor + 3]!, segments[cursor + 5]!);
      cursor += 6;
      keyframeCount++;
      controlPointCount += 2;
      segmentTypes.bezier++;
    }
    else if (type === 0 || type === 2 || type === 3) {
      requireRemaining(segments, cursor, 2, index);
      values.push(segments[cursor + 1]!);
      cursor += 2;
      keyframeCount++;
      if (type === 0) segmentTypes.linear++;
      else if (type === 2) segmentTypes.stepped++;
      else segmentTypes.inverseStepped++;
    }
    else throw new TypeError(`Live2D motion Curves[${index}] has unsupported segment type ${type}`);
  }
  const minimumValue = Math.min(...values);
  const maximumValue = Math.max(...values);
  return {
    target: text(curve.Target, `Live2D motion Curves[${index}].Target`),
    id: text(curve.Id, `Live2D motion Curves[${index}].Id`),
    minimumValue,
    maximumValue,
    valueSpan: maximumValue - minimumValue,
    keyframeCount,
    controlPointCount,
    segmentTypes,
  };
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
