import assert from 'node:assert/strict';
import test from 'node:test';
import type { AmplitudeSample } from '../../contracts/src/index.ts';
import {
  KNOWN_TONE_DURATION_MS,
  KNOWN_TONE_PULSES,
  KNOWN_TONE_SAMPLE_RATE_HZ,
  createKnownTonePcmStream,
  evaluateKnownToneAcceptance,
  evaluateKnownToneResponseTiming,
  measurePcmS16LeLevel,
} from '../src/known-tone-fixture.ts';

test('known tone fixture produces deterministic 24kHz mono PCM with expected levels', async () => {
  const pcm = await collectKnownTone();
  assert.equal(pcm.byteLength, KNOWN_TONE_SAMPLE_RATE_HZ * KNOWN_TONE_DURATION_MS / 1_000 * 2);

  for (const pulse of KNOWN_TONE_PULSES) {
    const level = levelBetween(pcm, pulse.startMs + 60, pulse.endMs - 60);
    assert.ok(Math.abs(level - pulse.amplitude) < 0.015, `${level} should match ${pulse.amplitude}`);
  }
  assert.ok(levelBetween(pcm, 450, 550) < 0.001);
});

test('known tone response timing requires every playback level to reach the model and a frame', () => {
  const onTime = Array.from({ length: 10 }, (_, index) => ({
    atMs: index * 25,
    playbackObservedAtMs: 1_000 + index * 25,
    modelAppliedAtMs: 1_001 + index * 25,
    framePresentedAtMs: 1_012 + index * 25,
  }));
  const accepted = evaluateKnownToneResponseTiming(onTime);
  assert.equal(accepted.passed, true, accepted.issues.join('; '));
  assert.equal(accepted.maximumModelResponseMs, 1);
  assert.equal(accepted.maximumFrameResponseMs, 12);

  const delayed = onTime.map((trace, index) => index === 5
    ? { ...trace, modelAppliedAtMs: trace.playbackObservedAtMs + 40 }
    : trace);
  assert.equal(evaluateKnownToneResponseTiming(delayed).passed, false);

  const missingFrame = onTime.map((trace, index) => index === 3
    ? { atMs: trace.atMs, playbackObservedAtMs: trace.playbackObservedAtMs, modelAppliedAtMs: trace.modelAppliedAtMs }
    : trace);
  assert.equal(evaluateKnownToneResponseTiming(missingFrame).passed, false);
});

test('known tone acceptance detects correct playback timing and rejects a shifted mouth track', async () => {
  const pcm = await collectKnownTone();
  const measured: AmplitudeSample[] = [];
  for (let atMs = 25; atMs < KNOWN_TONE_DURATION_MS; atMs += 25) {
    measured.push({ atMs, value: levelBetween(pcm, atMs - 20, atMs) });
  }

  const accepted = evaluateKnownToneAcceptance(measured);
  assert.equal(accepted.passed, true, accepted.issues.join('; '));
  assert.ok(accepted.maximumSilenceLevel < 0.001);

  const shifted = evaluateKnownToneAcceptance(measured.map(sample => ({ ...sample, atMs: sample.atMs + 180 })));
  assert.equal(shifted.passed, false);
  assert.ok(shifted.issues.some(issue => issue.includes('schedule') || issue.includes('level')));
});

async function collectKnownTone(): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of createKnownTonePcmStream({ chunkDurationMs: 20 })) chunks.push(chunk);
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk)));
}

function levelBetween(pcm: Uint8Array, startMs: number, endMs: number): number {
  const startFrame = Math.round(startMs * KNOWN_TONE_SAMPLE_RATE_HZ / 1_000);
  const endFrame = Math.round(endMs * KNOWN_TONE_SAMPLE_RATE_HZ / 1_000);
  return measurePcmS16LeLevel(pcm.subarray(startFrame * 2, endFrame * 2));
}
