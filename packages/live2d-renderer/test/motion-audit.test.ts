import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
  createFixedMotionAuditPlan,
  summarizeLive2dMotionSource,
} from '../src/index.ts';

test('fixed motion audit plan keeps its cadence when the budget is sufficient', () => {
  const plan = createFixedMotionAuditPlan([
    { id: 'short', durationMs: 1_100 },
    { id: 'long', durationMs: 2_100 },
  ], {
    intervalMs: 500,
    recoveryMs: 150,
    maxFrames: 20,
    maxFramesPerMotion: 12,
  });

  assert.deepEqual(plan.motions[0]!.samples, [
    { kind: 'motion', reason: 'fixed-cadence', targetMs: 0 },
    { kind: 'motion', reason: 'fixed-cadence', targetMs: 500 },
    { kind: 'motion', reason: 'fixed-cadence', targetMs: 1_000 },
    { kind: 'recovery', reason: 'baseline-recovery', targetMs: 1_250 },
  ]);
  assert.deepEqual(plan.motions[1]!.samples, [
    { kind: 'motion', reason: 'fixed-cadence', targetMs: 0 },
    { kind: 'motion', reason: 'fixed-cadence', targetMs: 500 },
    { kind: 'motion', reason: 'fixed-cadence', targetMs: 1_000 },
    { kind: 'motion', reason: 'fixed-cadence', targetMs: 1_500 },
    { kind: 'motion', reason: 'fixed-cadence', targetMs: 2_000 },
    { kind: 'recovery', reason: 'baseline-recovery', targetMs: 2_250 },
  ]);
  assert.equal(plan.requestedFrames, 10);
  assert.equal(plan.exportedFrames, 10);
  assert.equal(plan.omittedFrames, 0);
});

test('fixed motion audit plan thins long motions fairly under a global budget', () => {
  const plan = createFixedMotionAuditPlan([
    { id: 'a', durationMs: 8_000 },
    { id: 'b', durationMs: 8_000 },
    { id: 'c', durationMs: 2_000 },
  ], {
    intervalMs: 500,
    recoveryMs: 150,
    maxFrames: 12,
    maxFramesPerMotion: 20,
  });

  assert.equal(plan.exportedFrames, 12);
  assert.equal(plan.motions.reduce((sum, motion) => sum + motion.samples.length, 0), 12);
  assert.ok(plan.motions.every(motion => motion.samples.length >= 2));
  assert.ok(Math.abs(plan.motions[0]!.samples.length - plan.motions[1]!.samples.length) <= 1);
  assert.ok(plan.omittedFrames > 0);
  assert.ok(plan.motions.every(motion => motion.samples[0]!.targetMs === 0));
  assert.equal(
    plan.motions.reduce((sum, motion) => sum + motion.omittedSamples.length, 0),
    plan.omittedFrames,
  );
});

test('fixed motion audit plan rejects a budget that cannot cover every selected motion', () => {
  assert.throws(() => createFixedMotionAuditPlan([
    { id: 'a', durationMs: 1_000 },
    { id: 'b', durationMs: 1_000 },
  ], {
    intervalMs: 500,
    recoveryMs: 150,
    maxFrames: 1,
    maxFramesPerMotion: 4,
  }), /at least one frame/);
});

test('motion source summary extracts curve dynamics and interpolation types', () => {
  const summary = summarizeLive2dMotionSource({
    Meta: {
      Duration: 2,
      Fps: 30,
      Loop: true,
      FadeInTime: 0.25,
      FadeOutTime: 0.5,
    },
    Curves: [
      {
        Target: 'Parameter',
        Id: 'ParamAngleX',
        Segments: [0, 0, 0, 1, 2, 1, 1.25, 3, 1.75, -1, 2, 0],
      },
      {
        Target: 'Parameter',
        Id: 'ParamStatic',
        Segments: [0, 1, 2, 2, 1],
      },
    ],
  });

  assert.equal(summary.durationMs, 2_000);
  assert.equal(summary.fadeInMs, 250);
  assert.equal(summary.fadeOutMs, 500);
  assert.equal(summary.dynamicCurveCount, 1);
  assert.deepEqual(summary.curves[0], {
    target: 'Parameter',
    id: 'ParamAngleX',
    minimumValue: -1,
    maximumValue: 3,
    valueSpan: 4,
    keyframeCount: 3,
    controlPointCount: 2,
    segmentTypes: { linear: 1, bezier: 1, stepped: 0, inverseStepped: 0 },
  });
  assert.equal(summary.curves[1]!.segmentTypes.stepped, 1);
});

test('Mao fixed-cadence audit covers every declared motion within the default frame budget', async () => {
  const modelDirectory = new URL('../../../apps/desktop/public/models/Mao/', import.meta.url);
  const settings = JSON.parse(await readFile(new URL('Mao.model3.json', modelDirectory), 'utf8')) as {
    FileReferences: { Motions: Record<string, Array<{ File: string }>> };
  };
  const inputs = [];
  for (const [group, motions] of Object.entries(settings.FileReferences.Motions)) {
    for (const [index, motion] of motions.entries()) {
      const source = JSON.parse(
        await readFile(new URL(motion.File, modelDirectory), 'utf8'),
      ) as unknown;
      const summary = summarizeLive2dMotionSource(source);
      inputs.push({ id: `${group}:${index}`, durationMs: summary.durationMs });
      assert.ok(summary.dynamicCurveCount > 0, `${path.basename(motion.File)} has no dynamic curves`);
    }
  }

  const plan = createFixedMotionAuditPlan(inputs, {
    intervalMs: 500,
    recoveryMs: 150,
    maxFrames: 120,
    maxFramesPerMotion: 32,
  });
  assert.equal(inputs.length, 8);
  assert.equal(plan.requestedFrames, 117);
  assert.equal(plan.exportedFrames, 117);
  assert.equal(plan.omittedFrames, 0);
});
