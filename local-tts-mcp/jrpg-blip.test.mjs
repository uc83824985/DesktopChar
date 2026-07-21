import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createJrpgBlipPcmStream,
  createJrpgBlipPlan,
  JRPG_BLIP_VARIED_VOICE,
  segmentGraphemes,
} from './jrpg-blip.mjs';

test('jrpg-blip creates one sample-aligned cue per grapheme and pauses at punctuation', () => {
  const text = '你，好。👩‍💻';
  const plan = createJrpgBlipPlan(text, { sampleRateHz: 24_000, minimumDurationMs: 1 });
  assert.deepEqual(plan.cues.map(cue => cue.text), segmentGraphemes(text));
  assert.equal(plan.cues.map(cue => cue.text).join(''), text);
  assert.equal(plan.tones.length, 3, 'Chinese glyphs and the joined emoji sound; punctuation stays silent');
  assert.equal(plan.cues[0].duration_ms, 232);
  assert.equal(plan.cues[1].duration_ms - plan.cues[0].duration_ms, 160);
  assert.equal(plan.cues[3].duration_ms - plan.cues[2].duration_ms, 260);
  assert.ok(plan.tones.every(tone => tone.frequencyHz === 560), 'all graphemes use the voice profile base pitch');
  for (const cue of plan.cues) {
    assert.ok(Number.isInteger(cue.at_ms * plan.sampleRateHz / 1_000));
    assert.ok(Number.isInteger(cue.duration_ms * plan.sampleRateHz / 1_000));
  }
  for (let index = 1; index < plan.cues.length; index++) {
    const previous = plan.cues[index - 1];
    assert.equal(plan.cues[index].at_ms, previous.at_ms + previous.duration_ms);
  }
});

test('jrpg-blip PCM contains a short pulse per sounding grapheme and silence during pauses', async () => {
  const plan = createJrpgBlipPlan('甲，乙。', { sampleRateHz: 24_000, minimumDurationMs: 1 });
  const pcm = await collect(createJrpgBlipPcmStream(plan, { chunkDelayMs: 0 }));
  assert.equal(pcm.byteLength, plan.totalFrames * 2);
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 2);
  assert.ok(peak(samples, frameAt(plan.cues[0].at_ms)) > 5_000);
  assert.equal(peak(samples, frameAt(plan.cues[1].at_ms) + frameAt(60), frameAt(70)), 0);
  assert.ok(peak(samples, frameAt(plan.cues[2].at_ms)) > 5_000);
  assert.equal(peak(samples, frameAt(plan.cues[3].at_ms) + frameAt(60), frameAt(70)), 0);
  assert.ok(peak(samples, 0, samples.length) <= 7_500, 'peak must reflect the 0.224 amplitude ceiling');
  assert.ok(maximumStep(samples) < 2_500, 'sine-dominant waveform must not contain square-wave discontinuities');
});

test('jrpg-blip rate scales character spacing and punctuation pauses', () => {
  const normal = createJrpgBlipPlan('你，好。', { minimumDurationMs: 1, rate: 1 });
  const fast = createJrpgBlipPlan('你，好。', { minimumDurationMs: 1, rate: 2 });
  assert.ok(fast.durationMs < normal.durationMs);
  assert.equal(fast.cues[1].duration_ms, normal.cues[1].duration_ms / 2);
  assert.equal(fast.cues[3].duration_ms, normal.cues[3].duration_ms / 2);
});

test('default pacing renders the 24-character acceptance phrase in about seven seconds', () => {
  const plan = createJrpgBlipPlan('提示音测试一二三，提示音测试一二三，提示音测试一二三。');
  assert.equal(plan.tones.length, 24);
  assert.equal(plan.cues.length, 27);
  assert.equal(plan.durationMs, 6_999);
});

test('optional varied voice is deterministic without changing timing or amplitude', () => {
  const text = '桌面角色提示音';
  const fixed = createJrpgBlipPlan(text);
  const first = createJrpgBlipPlan(text, { voice: JRPG_BLIP_VARIED_VOICE });
  const second = createJrpgBlipPlan(text, { voice: JRPG_BLIP_VARIED_VOICE });
  const pitches = first.tones.map(tone => tone.frequencyHz);
  assert.deepEqual(pitches, second.tones.map(tone => tone.frequencyHz));
  assert.ok(pitches.every(pitch => [500, 560, 620, 680].includes(pitch)));
  assert.ok(new Set(pitches).size > 1);
  assert.equal(first.durationMs, fixed.durationMs);
  assert.deepEqual(first.cues, fixed.cues);
  assert.ok(first.tones.every((tone, index) => tone.amplitude === fixed.tones[index].amplitude));
});

async function collect(stream) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    chunks.push(chunk);
    size += chunk.byteLength;
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function frameAt(milliseconds) { return Math.round(milliseconds * 24_000 / 1_000); }
function peak(samples, start, length = frameAt(50)) {
  let value = 0;
  for (let index = start; index < Math.min(samples.length, start + length); index++) {
    value = Math.max(value, Math.abs(samples[index]));
  }
  return value;
}
function maximumStep(samples) {
  let value = 0;
  for (let index = 1; index < samples.length; index++) {
    value = Math.max(value, Math.abs(samples[index] - samples[index - 1]));
  }
  return value;
}
