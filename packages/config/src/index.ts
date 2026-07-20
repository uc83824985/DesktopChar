import type { AvatarAction, Emotion } from '../../contracts/src/index.ts';

export interface CharacterConfig {
  id: string;
  modelJsonUrl: string;
  defaultEmotion: Emotion;
  allowedEmotions: Emotion[];
  allowedActions: AvatarAction[];
  expressionCooldownMs: number;
  idleReturnDelayMs: number;
}

export interface TtsConfig {
  mode: 'mock' | 'mcp';
  mock: {
    delayMs: number;
    durationPerCharacterMs: number;
    minimumDurationMs: number;
    amplitudeIntervalMs: number;
  };
  mcp: {
    toolName: string;
    timeoutMs: number;
    textArgument: string;
    voice?: string;
    format: 'wav' | 'mp3' | 'ogg' | 'pcm';
  };
}

export const DEFAULT_TTS_CONFIG: TtsConfig = {
  mode: 'mock',
  mock: { delayMs: 15, durationPerCharacterMs: 90, minimumDurationMs: 500, amplitudeIntervalMs: 50 },
  mcp: { toolName: 'tts.synthesize', timeoutMs: 30_000, textArgument: 'text', format: 'wav' },
};

export function loadTtsConfig(values: Record<string, string | undefined>): TtsConfig {
  const mode = values.DESKTOP_CHAR_TTS_MODE ?? DEFAULT_TTS_CONFIG.mode;
  if (mode !== 'mock' && mode !== 'mcp') throw new Error('DESKTOP_CHAR_TTS_MODE must be mock or mcp');
  const mcp: TtsConfig['mcp'] = {
    toolName: values.DESKTOP_CHAR_TTS_MCP_TOOL ?? DEFAULT_TTS_CONFIG.mcp.toolName,
    timeoutMs: environmentNumber(values.DESKTOP_CHAR_TTS_TIMEOUT_MS, DEFAULT_TTS_CONFIG.mcp.timeoutMs, 'DESKTOP_CHAR_TTS_TIMEOUT_MS'),
    textArgument: values.DESKTOP_CHAR_TTS_TEXT_ARGUMENT ?? DEFAULT_TTS_CONFIG.mcp.textArgument,
    format: audioFormat(values.DESKTOP_CHAR_TTS_FORMAT),
  };
  if (values.DESKTOP_CHAR_TTS_VOICE) mcp.voice = values.DESKTOP_CHAR_TTS_VOICE;
  return {
    mode,
    mock: {
      delayMs: environmentNumber(values.DESKTOP_CHAR_TTS_MOCK_DELAY_MS, DEFAULT_TTS_CONFIG.mock.delayMs, 'DESKTOP_CHAR_TTS_MOCK_DELAY_MS', true),
      durationPerCharacterMs: environmentNumber(values.DESKTOP_CHAR_TTS_MOCK_CHAR_MS, DEFAULT_TTS_CONFIG.mock.durationPerCharacterMs, 'DESKTOP_CHAR_TTS_MOCK_CHAR_MS'),
      minimumDurationMs: environmentNumber(values.DESKTOP_CHAR_TTS_MOCK_MIN_MS, DEFAULT_TTS_CONFIG.mock.minimumDurationMs, 'DESKTOP_CHAR_TTS_MOCK_MIN_MS'),
      amplitudeIntervalMs: environmentNumber(values.DESKTOP_CHAR_TTS_MOCK_AMPLITUDE_MS, DEFAULT_TTS_CONFIG.mock.amplitudeIntervalMs, 'DESKTOP_CHAR_TTS_MOCK_AMPLITUDE_MS'),
    },
    mcp,
  };
}

function environmentNumber(value: string | undefined, fallback: number, name: string, allowZero = false): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || (allowZero ? parsed < 0 : parsed <= 0)) throw new Error(`${name} must be ${allowZero ? 'non-negative' : 'positive'}`);
  return parsed;
}

function audioFormat(value: string | undefined): TtsConfig['mcp']['format'] {
  const format = value ?? DEFAULT_TTS_CONFIG.mcp.format;
  if (format === 'wav' || format === 'mp3' || format === 'ogg' || format === 'pcm') return format;
  throw new Error('DESKTOP_CHAR_TTS_FORMAT must be wav, mp3, ogg, or pcm');
}
