import assert from 'node:assert/strict';
import test from 'node:test';
import type { PerformancePlan } from '../../contracts/src/index.ts';
import { AvatarRuntime, DefaultAvatarPlanner, ParameterMixer, projectSpeechBubble } from '../src/index.ts';
import { ControlledEffects } from './fakes.ts';
import { capabilities } from './helpers.ts';

function setup(dismissDelayMs?: number): { runtime: AvatarRuntime; effects: ControlledEffects } {
  const effects = new ControlledEffects();
  const runtime = new AvatarRuntime({
    planner: new DefaultAvatarPlanner(), mixer: new ParameterMixer(), effects,
  });
  runtime.dispatch({ type: 'renderer.ready', capabilities });
  const bubble = { mode: 'stream' as const, charactersPerSecond: 4, ...(dismissDelayMs === undefined ? {} : { dismissDelayMs }) };
  const plan: PerformancePlan = {
    id: `bubble-${dismissDelayMs ?? 'default'}`,
    segments: [{ id: 'speech', sequence: 0, displayText: '语音同步', speechText: '语音同步', bubble }],
  };
  runtime.dispatch({ type: 'plan.submitted', plan });
  return { runtime, effects };
}

test('speech bubble starts only when audio playback starts and follows its clock', () => {
  const { runtime, effects } = setup();
  assert.equal(runtime.getSnapshot().speechBubble.phase, 'hidden');

  effects.resolveTts(0);
  assert.equal(runtime.getSnapshot().speechBubble.phase, 'playing');
  assert.equal(projectSpeechBubble(runtime.getSnapshot().speechBubble).visible, true);

  effects.progress(500);
  assert.equal(runtime.getSnapshot().speechBubble.positionMs, 500);
  assert.equal(projectSpeechBubble(runtime.getSnapshot().speechBubble).visibleText, '语音');
});

test('completed speech holds complete text until the configured dismissal fires', () => {
  const { runtime, effects } = setup(350);
  effects.resolveTts(0);
  effects.complete(900);

  const holding = runtime.getSnapshot().speechBubble;
  assert.equal(runtime.getSnapshot().state, 'idle');
  assert.equal(holding.phase, 'holding');
  assert.equal(projectSpeechBubble(holding).visibleText, '语音同步');
  assert.equal(effects.pendingBubbleDismissals.get(holding.presentationId)?.effect.delayMs, 350);

  effects.dismissBubble(holding.presentationId);
  assert.equal(runtime.getSnapshot().speechBubble.phase, 'hidden');
  assert.equal(projectSpeechBubble(runtime.getSnapshot().speechBubble).visible, false);
});

test('new playback replaces a holding bubble and cancels its old dismissal', () => {
  const first = setup();
  first.effects.resolveTts(0);
  first.effects.complete();
  const oldPresentation = first.runtime.getSnapshot().speechBubble.presentationId;

  first.runtime.dispatch({ type: 'plan.submitted', plan: {
    id: 'next', segments: [{ id: 'next-speech', sequence: 0, displayText: '下一句', speechText: '下一句' }],
  } });
  first.effects.resolveTts(0);

  assert.equal(first.runtime.getSnapshot().speechBubble.segmentId, 'next-speech');
  assert.ok(first.runtime.getSnapshot().speechBubble.presentationId > oldPresentation);
  assert.deepEqual(first.effects.cancelledBubbleDismissals, [oldPresentation]);
});

test('TTS text cues override rate fallback when they match display text', () => {
  const { runtime, effects } = setup();
  effects.resolveTts(0, {
    delivery: 'stream', requestId: 'aligned', uri: 'memory://aligned', mimeType: 'audio/pcm',
    codec: 'pcm_s16le', sampleRateHz: 24_000, channels: 1,
    textCues: [
      { text: '语音', atMs: 0, durationMs: 700 },
      { text: '同步', atMs: 700, durationMs: 500 },
    ],
  });
  effects.progress(699);
  assert.equal(projectSpeechBubble(runtime.getSnapshot().speechBubble).visibleText, '语音');
  effects.progress(700);
  assert.equal(projectSpeechBubble(runtime.getSnapshot().speechBubble).visibleText, '语音同步');
});
