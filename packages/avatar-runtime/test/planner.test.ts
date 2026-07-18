import assert from 'node:assert/strict';
import test from 'node:test';
import { DefaultAvatarPlanner } from '../src/planner.ts';
import { capabilities } from './helpers.ts';

test('planner sorts segments, clamps intensity, and removes unsupported cues', () => {
  const normalized = new DefaultAvatarPlanner().normalize({
    id: 'plan',
    segments: [
      {
        id: 'second', sequence: 1, displayText: '2', speechText: '2',
        emotion: { emotion: 'sad', intensity: 1 },
        actions: [{ id: 'shake', action: 'shake' }],
      },
      {
        id: 'first', sequence: 0, displayText: '1', speechText: '1',
        emotion: { emotion: 'happy', intensity: 2 },
        actions: [
          { id: 'nod', action: 'nod' },
          { id: 'tap', action: 'tap' },
        ],
      },
    ],
  }, capabilities);

  assert.deepEqual(normalized.segments.map(segment => segment.id), ['first', 'second']);
  assert.equal(normalized.segments[0]!.emotion!.intensity, 1);
  assert.deepEqual(normalized.segments[0]!.actions?.map(cue => cue.action), ['nod']);
  assert.equal(normalized.segments[1]!.emotion, undefined);
  assert.equal(normalized.segments[1]!.actions, undefined);
});

test('planner rejects duplicate sequencing identities', () => {
  assert.throws(() => new DefaultAvatarPlanner().normalize({
    id: 'bad',
    segments: [
      { id: 'same', sequence: 0, displayText: '', speechText: '' },
      { id: 'same', sequence: 1, displayText: '', speechText: '' },
    ],
  }, capabilities), /Duplicate or empty segment id/);
});
