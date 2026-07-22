import assert from 'node:assert/strict';
import test from 'node:test';
import type { PerformanceSegment, SpeechBubbleState } from '../../contracts/src/index.ts';
import { estimateTextFallbackDurationMs, projectSpeechBubble } from '../src/index.ts';

function segment(mode: 'stream' | 'karaoke' | 'complete'): PerformanceSegment {
  return { id: 's', sequence: 0, displayText: '你好世界', speechText: '你好世界', bubble: { mode, charactersPerSecond: 2 } };
}

function playing(positionMs: number, value = segment('complete')): SpeechBubbleState {
  return {
    phase: 'playing', presentationId: 1, segmentId: value.id,
    displayText: value.displayText, ...(value.bubble ? { config: value.bubble } : {}), positionMs,
  };
}

test('complete speech bubble exposes the complete display text', () => {
  const result = projectSpeechBubble(playing(0));
  assert.equal(result.visibleText, '你好世界');
  assert.equal(result.activeText, '');
});

test('stream speech bubble reveals text from playback position', () => {
  const initial = projectSpeechBubble(playing(0, segment('stream')));
  const progressed = projectSpeechBubble(playing(1_100, segment('stream')));
  assert.equal(initial.visibleText, '');
  assert.equal(initial.trailingText, '你好世界');
  assert.equal(progressed.visibleText, '你好世');
  assert.equal(progressed.trailingText, '界');
});

test('known audio duration scales fallback text timing to the complete utterance', () => {
  const value = { ...playing(500, segment('stream')), durationMs: 2_000 };
  assert.equal(projectSpeechBubble(value).visibleText, '你');
  assert.equal(projectSpeechBubble({ ...value, positionMs: 2_000 }).visibleText, '你好世界');
});

test('stream speech bubble supports authored chunk timing', () => {
  const value = segment('stream');
  value.bubble!.cues = [{ text: '你好', atMs: 0 }, { text: '世界', atMs: 500 }];
  assert.equal(projectSpeechBubble(playing(0, value)).visibleText, '你好');
  assert.equal(projectSpeechBubble(playing(500, value)).visibleText, '你好世界');
});

test('karaoke speech bubble highlights authored cues from the playback clock', () => {
  const value = segment('karaoke');
  value.bubble!.cues = [
    { text: '你好', atMs: 0, durationMs: 400 },
    { text: '世界', atMs: 400, durationMs: 400 },
  ];
  const first = projectSpeechBubble(playing(200, value));
  assert.deepEqual([first.leadingText, first.activeText, first.trailingText], ['', '你好', '世界']);
  const second = projectSpeechBubble(playing(500, value));
  assert.deepEqual([second.leadingText, second.activeText, second.trailingText], ['你好', '世界', '']);
});

test('karaoke fallback uses known audio duration instead of an unrelated wall clock rate', () => {
  const value = { ...playing(1_000, segment('karaoke')), durationMs: 2_000 };
  assert.deepEqual(
    [projectSpeechBubble(value).leadingText, projectSpeechBubble(value).activeText],
    ['你好', '世'],
  );
});

test('holding completes stream text while waiting for the Runtime dismissal event', () => {
  const state = { ...playing(500, segment('stream')), phase: 'holding' as const };
  assert.equal(projectSpeechBubble(state).visibleText, '你好世界');
  assert.equal(projectSpeechBubble(state).mode, 'stream');
});

test('speech bubble hides without a Runtime-owned presentation', () => {
  assert.equal(projectSpeechBubble({
    phase: 'hidden', presentationId: 0, segmentId: null, displayText: '', positionMs: 0,
  }).visible, false);
});

test('non-speech chat-bubble presentations do not require a segment id', () => {
  assert.equal(projectSpeechBubble({
    phase: 'holding', presentationId: 1, segmentId: null,
    displayText: '连接测试通过', config: { mode: 'complete' }, positionMs: 0,
  }).visibleText, '连接测试通过');
});

test('text fallback visibility uses a bounded non-whitespace character heuristic', () => {
  assert.equal(estimateTextFallbackDurationMs(''), 2_000);
  assert.equal(estimateTextFallbackDurationMs('测'.repeat(24)), 5_520);
  assert.equal(estimateTextFallbackDurationMs(`测 试\n${'字'.repeat(22)}`), 5_520);
  assert.equal(estimateTextFallbackDurationMs('长'.repeat(100)), 12_000);
});
