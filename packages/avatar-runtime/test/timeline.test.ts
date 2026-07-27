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

test('clause cue identity remains stable when parallel results arrive out of order', () => {
  const base = {
    id: 'parallel-clauses',
    sequence: 0,
    displayText: '第一句。第二句。',
    speechText: '第一句。第二句。',
  };
  const second = {
    expressionKey: 'second',
    intensity: 0.5,
    textAnchor: {
      clauseIndex: 1,
      clauseCount: 2,
      startCharacter: 4,
      endCharacter: 8,
      totalCharacters: 8,
    },
  };
  const timeline = new PerformanceTimeline(
    { ...base, expressionCues: [second] },
    { durationMs: 800 },
  );
  assert.deepEqual(timeline.advance(400).map(cue => cue.id), [
    'parallel-clauses:expression:clause-1',
  ]);

  timeline.update({
    ...base,
    expressionCues: [{
      expressionKey: 'first',
      intensity: 0.5,
      textAnchor: {
        clauseIndex: 0,
        clauseCount: 2,
        startCharacter: 0,
        endCharacter: 4,
        totalCharacters: 8,
      },
    }, second],
  });

  assert.deepEqual(timeline.advance(400).map(cue => cue.id), [
    'parallel-clauses:expression:clause-0',
  ]);
  assert.deepEqual(timeline.advance(800), []);
});

test('unknown-duration audio uses the TTS profile fallback rate instead of a Runtime constant', () => {
  const segment = {
    id: 'configured-rate',
    sequence: 0,
    displayText: '第一句。第二句。',
    speechText: '第一句。第二句。',
    expressionCues: [{
      expressionKey: 'second',
      intensity: 0.5,
      textAnchor: {
        clauseIndex: 1,
        clauseCount: 2,
        startCharacter: 4,
        endCharacter: 8,
        totalCharacters: 8,
      },
    }],
  };
  const slow = new PerformanceTimeline(segment, { fallbackCharactersPerSecond: 4 });
  const fast = new PerformanceTimeline(segment, { fallbackCharactersPerSecond: 8 });

  assert.deepEqual(slow.advance(999), []);
  const slowCue = slow.advance(1_000).find(cue => cue.type === 'expression');
  assert.equal(slowCue?.timingBasis, 'configured-rate');
  assert.deepEqual(fast.advance(499), []);
  assert.equal(fast.advance(500)[0]?.atMs, 500);
});
