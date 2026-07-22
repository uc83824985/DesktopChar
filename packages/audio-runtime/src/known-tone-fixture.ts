import type { AmplitudeSample } from '../../contracts/src/index.ts';
export const KNOWN_TONE_SAMPLE_RATE_HZ = 24_000;
export const KNOWN_TONE_CHANNELS = 1;
export const KNOWN_TONE_DURATION_MS = 1_600;

export interface KnownTonePulse {
  startMs: number;
  endMs: number;
  frequencyHz: number;
  amplitude: number;
}

export const KNOWN_TONE_PULSES: readonly KnownTonePulse[] = [
  { startMs: 200, endMs: 400, frequencyHz: 660, amplitude: 0.25 },
  { startMs: 600, endMs: 850, frequencyHz: 880, amplitude: 0.55 },
  { startMs: 1_050, endMs: 1_400, frequencyHz: 1_100, amplitude: 0.85 },
];

export interface KnownToneStreamOptions {
  chunkDurationMs?: number;
  chunkDelayMs?: number;
  signal?: AbortSignal;
}

export interface KnownToneAcceptanceOptions {
  timingToleranceMs?: number;
  levelTolerance?: number;
  silenceLimit?: number;
  lipSyncGain?: number;
  /** Delay after a pulse end before a visually smoothed track must be silent. */
  silenceSettleMs?: number;
}

export interface KnownToneAcceptanceResult {
  passed: boolean;
  issues: string[];
  observedToneLevels: number[];
  transitionErrorsMs: number[];
  maximumSilenceLevel: number;
}

export interface KnownToneResponseTrace {
  atMs: number;
  playbackObservedAtMs: number;
  modelAppliedAtMs?: number;
  framePresentedAtMs?: number;
}

export interface KnownToneResponseTimingOptions {
  modelResponseLimitMs?: number;
  frameResponseLimitMs?: number;
}

export interface KnownToneResponseTimingResult {
  passed: boolean;
  issues: string[];
  sampleCount: number;
  modelResponseCount: number;
  frameResponseCount: number;
  maximumModelResponseMs: number | null;
  p95ModelResponseMs: number | null;
  maximumFrameResponseMs: number | null;
  p95FrameResponseMs: number | null;
}

export async function* createKnownTonePcmStream(
  options: KnownToneStreamOptions = {},
): AsyncGenerator<Uint8Array> {
  const chunkDurationMs = positive(options.chunkDurationMs ?? 20, 'chunkDurationMs');
  const chunkDelayMs = nonNegative(options.chunkDelayMs ?? 0, 'chunkDelayMs');
  const framesPerChunk = Math.max(1, Math.round(KNOWN_TONE_SAMPLE_RATE_HZ * chunkDurationMs / 1_000));
  const totalFrames = Math.round(KNOWN_TONE_SAMPLE_RATE_HZ * KNOWN_TONE_DURATION_MS / 1_000);

  for (let firstFrame = 0; firstFrame < totalFrames; firstFrame += framesPerChunk) {
    throwIfAborted(options.signal);
    if (firstFrame > 0 && chunkDelayMs > 0) await abortableDelay(chunkDelayMs, options.signal);
    const frameCount = Math.min(framesPerChunk, totalFrames - firstFrame);
    const bytes = new Uint8Array(frameCount * 2);
    const view = new DataView(bytes.buffer);
    for (let index = 0; index < frameCount; index++) {
      const value = knownToneSample((firstFrame + index) / KNOWN_TONE_SAMPLE_RATE_HZ * 1_000);
      view.setInt16(index * 2, Math.round(value * 32_767), true);
    }
    yield bytes;
  }
}

export function measurePcmS16LeLevel(bytes: Uint8Array): number {
  const sampleCount = Math.floor(bytes.byteLength / 2);
  if (!sampleCount) return 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, sampleCount * 2);
  let sumSquares = 0;
  for (let index = 0; index < sampleCount; index++) {
    const value = view.getInt16(index * 2, true) / 32_768;
    sumSquares += value * value;
  }
  return clamp01(Math.sqrt(sumSquares / sampleCount) * Math.SQRT2);
}

export function evaluateKnownToneAcceptance(
  samples: readonly AmplitudeSample[],
  options: KnownToneAcceptanceOptions = {},
): KnownToneAcceptanceResult {
  const timingToleranceMs = positive(options.timingToleranceMs ?? 90, 'timingToleranceMs');
  const levelTolerance = positive(options.levelTolerance ?? 0.12, 'levelTolerance');
  const silenceLimit = positive(options.silenceLimit ?? 0.08, 'silenceLimit');
  const lipSyncGain = positive(options.lipSyncGain ?? 1, 'lipSyncGain');
  const silenceSettleMs = nonNegative(options.silenceSettleMs ?? 50, 'silenceSettleMs');
  const ordered = [...samples].sort((left, right) => left.atMs - right.atMs);
  const issues: string[] = [];
  const observedToneLevels: number[] = [];
  const transitionErrorsMs: number[] = [];

  for (const [index, pulse] of KNOWN_TONE_PULSES.entries()) {
    const stable = valuesIn(ordered, pulse.startMs + 55, pulse.endMs - 55);
    const observedLevel = median(stable.map(sample => sample.value));
    observedToneLevels.push(observedLevel);
    const expectedLevel = clamp01(pulse.amplitude * lipSyncGain);
    if (!stable.length || Math.abs(observedLevel - expectedLevel) > levelTolerance) {
      issues.push(`tone ${index + 1} level ${observedLevel.toFixed(3)} does not match ${expectedLevel.toFixed(3)}`);
    }

    const threshold = Math.max(0.1, expectedLevel * 0.45);
    const active = valuesIn(ordered, pulse.startMs - timingToleranceMs, pulse.endMs + timingToleranceMs)
      .filter(sample => sample.value >= threshold);
    if (!active.length) {
      issues.push(`tone ${index + 1} has no active samples`);
      transitionErrorsMs.push(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
      continue;
    }
    const startError = Math.abs(active[0]!.atMs - pulse.startMs);
    const endError = Math.abs(active.at(-1)!.atMs - pulse.endMs);
    transitionErrorsMs.push(startError, endError);
    if (startError > timingToleranceMs) issues.push(`tone ${index + 1} starts ${startError.toFixed(1)} ms away from schedule`);
    if (endError > timingToleranceMs) issues.push(`tone ${index + 1} ends ${endError.toFixed(1)} ms away from schedule`);
  }

  const silenceWindows: Array<readonly [number, number]> = [[50, 150]];
  for (const [index, pulse] of KNOWN_TONE_PULSES.entries()) {
    const nextStartMs = KNOWN_TONE_PULSES[index + 1]?.startMs ?? KNOWN_TONE_DURATION_MS;
    const startMs = pulse.endMs + silenceSettleMs;
    const endMs = nextStartMs - 25;
    if (startMs <= endMs) silenceWindows.push([startMs, endMs]);
  }
  const silenceValues = silenceWindows.flatMap(([startMs, endMs]) => (
    valuesIn(ordered, startMs, endMs).map(sample => sample.value)
  ));
  const maximumSilenceLevel = silenceValues.length ? Math.max(...silenceValues) : Number.POSITIVE_INFINITY;
  if (maximumSilenceLevel > silenceLimit) {
    issues.push(`silence level ${maximumSilenceLevel.toFixed(3)} exceeds ${silenceLimit.toFixed(3)}`);
  }
  if (!silenceValues.length) issues.push('no silence samples were observed');

  for (let index = 1; index < observedToneLevels.length; index++) {
    const expectedDifference = clamp01(KNOWN_TONE_PULSES[index]!.amplitude * lipSyncGain)
      - clamp01(KNOWN_TONE_PULSES[index - 1]!.amplitude * lipSyncGain);
    if (expectedDifference >= 0.12 && observedToneLevels[index]! - observedToneLevels[index - 1]! < 0.12) {
      issues.push(`tone ${index + 1} is not observably louder than tone ${index}`);
    }
  }

  return { passed: issues.length === 0, issues, observedToneLevels, transitionErrorsMs, maximumSilenceLevel };
}

export function evaluateKnownToneResponseTiming(
  traces: readonly KnownToneResponseTrace[],
  options: KnownToneResponseTimingOptions = {},
): KnownToneResponseTimingResult {
  const modelResponseLimitMs = positive(options.modelResponseLimitMs ?? 34, 'modelResponseLimitMs');
  const frameResponseLimitMs = positive(options.frameResponseLimitMs ?? 50, 'frameResponseLimitMs');
  const issues: string[] = [];
  const modelLatencies = traces.flatMap(trace => trace.modelAppliedAtMs === undefined
    ? []
    : [trace.modelAppliedAtMs - trace.playbackObservedAtMs]);
  const frameLatencies = traces.flatMap(trace => trace.framePresentedAtMs === undefined
    ? []
    : [trace.framePresentedAtMs - trace.playbackObservedAtMs]);

  const invalidModel = modelLatencies.filter(value => !Number.isFinite(value) || value < 0);
  const invalidFrame = frameLatencies.filter(value => !Number.isFinite(value) || value < 0);
  if (!traces.length) issues.push('no playback response traces were captured');
  if (modelLatencies.length !== traces.length) issues.push(`${traces.length - modelLatencies.length} model responses are missing`);
  if (frameLatencies.length !== traces.length) issues.push(`${traces.length - frameLatencies.length} presentation frames are missing`);
  if (invalidModel.length) issues.push(`${invalidModel.length} model response latencies are invalid`);
  if (invalidFrame.length) issues.push(`${invalidFrame.length} frame response latencies are invalid`);

  const maximumModelResponseMs = maximumOrNull(modelLatencies);
  const p95ModelResponseMs = percentileOrNull(modelLatencies, 0.95);
  const maximumFrameResponseMs = maximumOrNull(frameLatencies);
  const p95FrameResponseMs = percentileOrNull(frameLatencies, 0.95);
  if (maximumModelResponseMs !== null && maximumModelResponseMs > modelResponseLimitMs) {
    issues.push(`model response ${maximumModelResponseMs.toFixed(2)} ms exceeds ${modelResponseLimitMs.toFixed(2)} ms`);
  }
  if (maximumFrameResponseMs !== null && maximumFrameResponseMs > frameResponseLimitMs) {
    issues.push(`frame response ${maximumFrameResponseMs.toFixed(2)} ms exceeds ${frameResponseLimitMs.toFixed(2)} ms`);
  }

  return {
    passed: issues.length === 0, issues, sampleCount: traces.length,
    modelResponseCount: modelLatencies.length, frameResponseCount: frameLatencies.length,
    maximumModelResponseMs, p95ModelResponseMs, maximumFrameResponseMs, p95FrameResponseMs,
  };
}

function knownToneSample(atMs: number): number {
  const pulse = KNOWN_TONE_PULSES.find(candidate => atMs >= candidate.startMs && atMs < candidate.endMs);
  if (!pulse) return 0;
  const localMs = atMs - pulse.startMs;
  const remainingMs = pulse.endMs - atMs;
  const fade = Math.min(1, localMs / 12, remainingMs / 12);
  return Math.sin(2 * Math.PI * pulse.frequencyHz * localMs / 1_000) * pulse.amplitude * fade;
}

function valuesIn(samples: readonly AmplitudeSample[], startMs: number, endMs: number): AmplitudeSample[] {
  return samples.filter(sample => sample.atMs >= startMs && sample.atMs <= endMs);
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle]! : (ordered[middle - 1]! + ordered[middle]!) / 2;
}

function maximumOrNull(values: number[]): number | null {
  return values.length ? Math.max(...values) : null;
}

function percentileOrNull(values: number[], percentile: number): number | null {
  if (!values.length) return null;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * percentile) - 1)]!;
}

function abortableDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, delayMs);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
}

function clamp01(value: number): number { return Math.max(0, Math.min(1, value)); }
function positive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be positive and finite`);
  return value;
}
function nonNegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be non-negative and finite`);
  return value;
}
