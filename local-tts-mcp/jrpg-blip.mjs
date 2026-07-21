export const JRPG_BLIP_VOICE = 'jrpg-blip';
export const JRPG_BLIP_VARIED_VOICE = 'jrpg-blip-varied';
export const JRPG_BLIP_VOICES = Object.freeze([JRPG_BLIP_VOICE, JRPG_BLIP_VARIED_VOICE]);

const DEFAULT_CHARACTER_INTERVAL_MS = 232;
const DEFAULT_MINIMUM_DURATION_MS = 500;
const LEAD_IN_MS = 45;
const TRAILING_SILENCE_MS = 110;
const COMMA_PAUSE_MS = 160;
const CLAUSE_PAUSE_MS = 200;
const SENTENCE_PAUSE_MS = 260;
const ELLIPSIS_PAUSE_MS = 320;
const TONE_DURATION_MS = 52;
const TONE_AMPLITUDE = 0.224;
const FREQUENCY_HZ = 560;
const VARIED_FREQUENCIES_HZ = [500, 560, 620, 680];

const COMMA = new Set([',', '，', '、']);
const CLAUSE = new Set([';', '；', ':', '：']);
const SENTENCE = new Set(['.', '。', '!', '！', '?', '？']);
const ELLIPSIS = new Set(['…']);

export function createJrpgBlipPlan(text, options = {}) {
  if (typeof text !== 'string' || !text) throw new TypeError('jrpg-blip text must not be empty');
  const sampleRateHz = positiveInteger(options.sampleRateHz ?? 24_000, 'sampleRateHz');
  const rate = positive(options.rate ?? 1, 'rate');
  const characterIntervalMs = positive(options.characterIntervalMs ?? DEFAULT_CHARACTER_INTERVAL_MS, 'characterIntervalMs');
  const minimumDurationMs = positive(options.minimumDurationMs ?? DEFAULT_MINIMUM_DURATION_MS, 'minimumDurationMs');
  const voice = options.voice ?? JRPG_BLIP_VOICE;
  if (!JRPG_BLIP_VOICES.includes(voice)) throw new RangeError(`voice must be one of: ${JRPG_BLIP_VOICES.join(', ')}`);
  const graphemes = segmentGraphemes(text);
  const cues = [];
  const tones = [];
  let cursorFrame = millisecondsToFrames(LEAD_IN_MS / rate, sampleRateHz);

  for (const grapheme of graphemes) {
    const slotMs = slotDurationMs(grapheme, characterIntervalMs) / rate;
    const slotFrames = Math.max(1, millisecondsToFrames(slotMs, sampleRateHz));
    const atMs = framesToMilliseconds(cursorFrame, sampleRateHz);
    cues.push({
      text: grapheme,
      at_ms: atMs,
      duration_ms: framesToMilliseconds(slotFrames, sampleRateHz),
    });
    if (shouldSound(grapheme)) {
      const requestedToneFrames = millisecondsToFrames(TONE_DURATION_MS / rate, sampleRateHz);
      const toneFrames = Math.max(1, Math.min(slotFrames, requestedToneFrames));
      tones.push({
        startFrame: cursorFrame,
        endFrame: cursorFrame + toneFrames,
        frequencyHz: voice === JRPG_BLIP_VARIED_VOICE ? variedFrequencyFor(grapheme) : FREQUENCY_HZ,
        amplitude: TONE_AMPLITUDE,
      });
    }
    cursorFrame += slotFrames;
  }

  cursorFrame += millisecondsToFrames(TRAILING_SILENCE_MS / rate, sampleRateHz);
  const totalFrames = Math.max(cursorFrame, millisecondsToFrames(minimumDurationMs / rate, sampleRateHz));
  return Object.freeze({
    voice,
    sampleRateHz,
    totalFrames,
    durationMs: framesToMilliseconds(totalFrames, sampleRateHz),
    cues: Object.freeze(cues.map(Object.freeze)),
    tones: Object.freeze(tones.map(Object.freeze)),
  });
}

export async function* createJrpgBlipPcmStream(plan, options = {}) {
  const chunkDurationMs = positive(options.chunkDurationMs ?? 20, 'chunkDurationMs');
  const chunkDelayMs = nonNegative(options.chunkDelayMs ?? 1, 'chunkDelayMs');
  const signal = options.signal;
  const chunkFrames = Math.max(1, millisecondsToFrames(chunkDurationMs, plan.sampleRateHz));
  let toneIndex = 0;

  for (let firstFrame = 0; firstFrame < plan.totalFrames; firstFrame += chunkFrames) {
    throwIfAborted(signal);
    if (firstFrame > 0) await abortableDelay(chunkDelayMs, signal);
    const frameCount = Math.min(chunkFrames, plan.totalFrames - firstFrame);
    const bytes = new Uint8Array(frameCount * 2);
    const view = new DataView(bytes.buffer);
    for (let index = 0; index < frameCount; index++) {
      const frame = firstFrame + index;
      while (toneIndex < plan.tones.length && frame >= plan.tones[toneIndex].endFrame) toneIndex++;
      const tone = plan.tones[toneIndex];
      const value = tone && frame >= tone.startFrame
        ? sampleTone(tone, frame, plan.sampleRateHz)
        : 0;
      view.setInt16(index * 2, Math.round(clamp(value) * 32_767), true);
    }
    yield bytes;
  }
}

export function segmentGraphemes(text) {
  if (typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });
    return Array.from(segmenter.segment(text), item => item.segment);
  }
  return Array.from(text);
}

function slotDurationMs(grapheme, characterIntervalMs) {
  if (/^\s+$/u.test(grapheme)) return characterIntervalMs;
  if (ELLIPSIS.has(grapheme)) return characterIntervalMs + ELLIPSIS_PAUSE_MS;
  if (SENTENCE.has(grapheme)) return characterIntervalMs + SENTENCE_PAUSE_MS;
  if (CLAUSE.has(grapheme)) return characterIntervalMs + CLAUSE_PAUSE_MS;
  if (COMMA.has(grapheme)) return characterIntervalMs + COMMA_PAUSE_MS;
  if (/^\p{P}+$/u.test(grapheme)) return characterIntervalMs + COMMA_PAUSE_MS;
  return characterIntervalMs;
}

function shouldSound(grapheme) {
  return !/^\s+$/u.test(grapheme) && !/^\p{P}+$/u.test(grapheme);
}

function variedFrequencyFor(grapheme) {
  let hash = 2_166_136_261;
  for (const symbol of grapheme) {
    hash ^= symbol.codePointAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return VARIED_FREQUENCIES_HZ[(hash >>> 0) % VARIED_FREQUENCIES_HZ.length];
}

function sampleTone(tone, frame, sampleRateHz) {
  const localFrame = frame - tone.startFrame;
  const totalFrames = tone.endFrame - tone.startFrame;
  const attackFrames = Math.max(1, millisecondsToFrames(6, sampleRateHz));
  const releaseFrames = Math.max(1, millisecondsToFrames(14, sampleRateHz));
  const envelope = Math.min(1, localFrame / attackFrames, (totalFrames - localFrame) / releaseFrames);
  const phase = 2 * Math.PI * tone.frequencyHz * localFrame / sampleRateHz;
  const softened = Math.sin(phase) * 0.82
    + Math.sin(phase * 2) * 0.14
    + Math.sin(phase * 3) * 0.04;
  return softened * tone.amplitude * Math.max(0, envelope);
}

function millisecondsToFrames(value, sampleRateHz) { return Math.round(value * sampleRateHz / 1_000); }
function framesToMilliseconds(value, sampleRateHz) { return value / sampleRateHz * 1_000; }
function clamp(value) { return Math.max(-1, Math.min(1, value)); }

function abortableDelay(delayMs, signal) {
  throwIfAborted(signal);
  if (!delayMs) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, delayMs);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
}

function positive(value, name) {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be positive and finite`);
  return value;
}

function nonNegative(value, name) {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be non-negative and finite`);
  return value;
}

function positiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
  return value;
}
