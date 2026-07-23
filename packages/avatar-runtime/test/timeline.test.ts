import assert from 'node:assert/strict';
import test from 'node:test';
import { PerformanceTimeline } from '../src/timeline.ts';
import { plan } from './helpers.ts';

test('timeline emits each cue once from playback position', () => {
  const timeline = new PerformanceTimeline(plan.segments[0]!);
  assert.deepEqual(timeline.advance(0).map(cue => cue.type), ['emotion']);
  assert.deepEqual(timeline.advance(199), []);
  assert.deepEqual(timeline.advance(200).map(cue => cue.type), ['action']);
  assert.deepEqual(timeline.advance(500), []);
});

test('timeline freezes while paused and never resumes after cancel', () => {
  const timeline = new PerformanceTimeline(plan.segments[0]!);
  timeline.pause();
  assert.deepEqual(timeline.advance(500), []);
  timeline.resume();
  assert.equal(timeline.advance(500).length, 2);
  timeline.cancel();
  assert.deepEqual(timeline.advance(1000), []);
});

test('timeline accepts late cues without replaying cues already emitted', () => {
  const segment = plan.segments[0]!;
  const timeline = new PerformanceTimeline(segment);
  assert.deepEqual(timeline.advance(0).map(cue => cue.type), ['emotion']);

  timeline.update({
    ...segment,
    actions: [
      ...(segment.actions ?? []),
      { id: 'late-greet', action: 'greet', atMs: 0 },
    ],
  });

  assert.deepEqual(timeline.advance(500).map(cue => cue.id), [
    'late-greet',
    segment.actions![0]!.id,
  ]);
  assert.deepEqual(timeline.advance(500), []);
});
