import assert from 'node:assert/strict';
import test from 'node:test';
import type { AvatarSnapshot, PerformanceSegment } from '../../contracts/src/index.ts';
import { createInitialSnapshot, projectSpeechBubble } from '../src/index.ts';

function speaking(positionMs: number): AvatarSnapshot {
  return { ...createInitialSnapshot(), state: 'speaking', segmentId: 's', playback: { status: 'playing', positionMs } };
}

function segment(mode: 'stream' | 'karaoke' | 'complete'): PerformanceSegment {
  return { id: 's', sequence: 0, displayText: '你好世界', speechText: '你好世界', bubble: { mode, charactersPerSecond: 2 } };
}

test('complete speech bubble exposes the complete display text', () => {
  const result = projectSpeechBubble(speaking(0), segment('complete'));
  assert.equal(result.visibleText, '你好世界');
  assert.equal(result.activeText, '');
});

test('stream speech bubble reveals text from playback position', () => {
  assert.equal(projectSpeechBubble(speaking(0), segment('stream')).visibleText, '');
  assert.equal(projectSpeechBubble(speaking(1_100), segment('stream')).visibleText, '你好世');
});

test('stream speech bubble supports authored chunk timing', () => {
  const value = segment('stream');
  value.bubble!.cues = [{ text: '你好', atMs: 0 }, { text: '世界', atMs: 500 }];
  assert.equal(projectSpeechBubble(speaking(0), value).visibleText, '你好');
  assert.equal(projectSpeechBubble(speaking(500), value).visibleText, '你好世界');
});

test('karaoke speech bubble highlights authored cues from the playback clock', () => {
  const value = segment('karaoke');
  value.bubble!.cues = [
    { text: '你好', atMs: 0, durationMs: 400 },
    { text: '世界', atMs: 400, durationMs: 400 },
  ];
  const first = projectSpeechBubble(speaking(200), value);
  assert.deepEqual([first.leadingText, first.activeText, first.trailingText], ['', '你好', '世界']);
  const second = projectSpeechBubble(speaking(500), value);
  assert.deepEqual([second.leadingText, second.activeText, second.trailingText], ['你好', '世界', '']);
});

test('speech bubble hides without an active Runtime segment', () => {
  assert.equal(projectSpeechBubble(createInitialSnapshot(), null).visible, false);
});
