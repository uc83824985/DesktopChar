import type {
  SpeechBubbleConfig,
  SpeechBubbleMode,
  SpeechBubbleState,
} from '../../contracts/src/index.ts';

export interface SpeechBubbleProjection {
  visible: boolean;
  mode: SpeechBubbleMode;
  fullText: string;
  visibleText: string;
  leadingText: string;
  activeText: string;
  trailingText: string;
}

const DEFAULT_CHARACTERS_PER_SECOND = 8;
export const DEFAULT_SPEECH_BUBBLE_DISMISS_DELAY_MS = 800;

export function projectSpeechBubble(
  state: Readonly<SpeechBubbleState>,
): SpeechBubbleProjection {
  const mode = state.config?.mode ?? 'complete';
  const text = state.displayText;
  if (state.phase === 'hidden' || !state.segmentId || !text) return hiddenBubble(mode);
  if (mode === 'complete') return completeBubble(text);
  if (state.phase === 'holding') return completeBubble(text, mode);
  if (mode === 'stream') return streamBubble(text, state.config, state.positionMs, state.durationMs);
  return karaokeBubble(text, state.config, state.positionMs, state.durationMs);
}

function streamBubble(
  text: string,
  config: SpeechBubbleConfig | undefined,
  positionMs: number,
  durationMs: number | undefined,
): SpeechBubbleProjection {
  const cues = config?.cues;
  const visibleText = cues?.length
    ? cues.filter(cue => cue.atMs <= positionMs).map(cue => cue.text).join('')
    : takeCharacters(text, revealedCharacterCount(text, positionMs, durationMs, config));
  return { visible: true, mode: 'stream', fullText: text, visibleText, leadingText: visibleText, activeText: '', trailingText: '' };
}

function karaokeBubble(
  text: string,
  config: SpeechBubbleConfig | undefined,
  positionMs: number,
  durationMs: number | undefined,
): SpeechBubbleProjection {
  const cues = config?.cues;
  if (cues?.length) {
    let offset = 0;
    for (let index = 0; index < cues.length; index++) {
      const cue = cues[index]!;
      const end = cue.durationMs === undefined ? (cues[index + 1]?.atMs ?? Number.POSITIVE_INFINITY) : cue.atMs + cue.durationMs;
      if (positionMs < cue.atMs) break;
      if (positionMs < end) return karaokeParts(text, offset, cue.text.length);
      offset += cue.text.length;
    }
    return karaokeParts(text, Math.min(offset, text.length), 0);
  }
  const characters = Array.from(text);
  const index = Math.min(activeCharacterIndex(characters.length, positionMs, durationMs, config), characters.length);
  const leadingText = characters.slice(0, index).join('');
  const activeText = characters[index] ?? '';
  return {
    visible: true, mode: 'karaoke', fullText: text, visibleText: text,
    leadingText, activeText, trailingText: characters.slice(index + (activeText ? 1 : 0)).join(''),
  };
}

function completeBubble(text: string, mode: SpeechBubbleMode = 'complete'): SpeechBubbleProjection {
  return { visible: true, mode, fullText: text, visibleText: text, leadingText: text, activeText: '', trailingText: '' };
}

function karaokeParts(text: string, start: number, length: number): SpeechBubbleProjection {
  return {
    visible: true, mode: 'karaoke', fullText: text, visibleText: text,
    leadingText: text.slice(0, start), activeText: text.slice(start, start + length), trailingText: text.slice(start + length),
  };
}

function hiddenBubble(mode: SpeechBubbleMode): SpeechBubbleProjection {
  return { visible: false, mode, fullText: '', visibleText: '', leadingText: '', activeText: '', trailingText: '' };
}

function charactersPerMs(config: SpeechBubbleConfig | undefined): number {
  return (config?.charactersPerSecond ?? DEFAULT_CHARACTERS_PER_SECOND) / 1_000;
}

function revealedCharacterCount(
  text: string,
  positionMs: number,
  durationMs: number | undefined,
  config: SpeechBubbleConfig | undefined,
): number {
  if (durationMs !== undefined && durationMs > 0) {
    return Math.ceil(Array.from(text).length * Math.max(0, Math.min(1, positionMs / durationMs)));
  }
  return Math.ceil(positionMs * charactersPerMs(config));
}

function activeCharacterIndex(
  characterCount: number,
  positionMs: number,
  durationMs: number | undefined,
  config: SpeechBubbleConfig | undefined,
): number {
  if (durationMs !== undefined && durationMs > 0) {
    return Math.floor(characterCount * Math.max(0, Math.min(1, positionMs / durationMs)));
  }
  return Math.floor(positionMs * charactersPerMs(config));
}

function takeCharacters(text: string, count: number): string {
  return Array.from(text).slice(0, Math.max(0, count)).join('');
}
