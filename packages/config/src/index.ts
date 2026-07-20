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
    delivery: 'stream' | 'artifact';
    sampleRateHz: number;
    channels: number;
  };
  mcp: {
    toolName: string;
    cancelToolName: string;
    timeoutMs: number;
    requestIdArgument: string;
    textArgument: string;
    voice?: string;
    format: 'wav' | 'mp3' | 'ogg' | 'opus' | 'pcm_s16le' | 'pcm_f32le';
  };
}

export const DEFAULT_TTS_CONFIG: TtsConfig = {
  mode: 'mock',
  mock: { delayMs: 15, durationPerCharacterMs: 90, minimumDurationMs: 500, amplitudeIntervalMs: 50, delivery: 'stream', sampleRateHz: 24_000, channels: 1 },
  mcp: { toolName: 'tts_open_stream', cancelToolName: 'tts_cancel_synthesis', timeoutMs: 30_000, requestIdArgument: 'request_id', textArgument: 'text', format: 'pcm_s16le' },
};

export function loadTtsConfig(values: Record<string, string | undefined>): TtsConfig {
  const mode = values.DESKTOP_CHAR_TTS_MODE ?? DEFAULT_TTS_CONFIG.mode;
  if (mode !== 'mock' && mode !== 'mcp') throw new Error('DESKTOP_CHAR_TTS_MODE must be mock or mcp');
  const mcp: TtsConfig['mcp'] = {
    toolName: values.DESKTOP_CHAR_TTS_MCP_TOOL ?? DEFAULT_TTS_CONFIG.mcp.toolName,
    cancelToolName: values.DESKTOP_CHAR_TTS_MCP_CANCEL_TOOL ?? DEFAULT_TTS_CONFIG.mcp.cancelToolName,
    timeoutMs: environmentNumber(values.DESKTOP_CHAR_TTS_TIMEOUT_MS, DEFAULT_TTS_CONFIG.mcp.timeoutMs, 'DESKTOP_CHAR_TTS_TIMEOUT_MS'),
    requestIdArgument: values.DESKTOP_CHAR_TTS_REQUEST_ID_ARGUMENT ?? DEFAULT_TTS_CONFIG.mcp.requestIdArgument,
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
      delivery: mockDelivery(values.DESKTOP_CHAR_TTS_MOCK_DELIVERY),
      sampleRateHz: environmentNumber(values.DESKTOP_CHAR_TTS_SAMPLE_RATE_HZ, DEFAULT_TTS_CONFIG.mock.sampleRateHz, 'DESKTOP_CHAR_TTS_SAMPLE_RATE_HZ'),
      channels: environmentNumber(values.DESKTOP_CHAR_TTS_CHANNELS, DEFAULT_TTS_CONFIG.mock.channels, 'DESKTOP_CHAR_TTS_CHANNELS'),
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
  if (format === 'wav' || format === 'mp3' || format === 'ogg' || format === 'opus' || format === 'pcm_s16le' || format === 'pcm_f32le') return format;
  throw new Error('DESKTOP_CHAR_TTS_FORMAT must be wav, mp3, ogg, opus, pcm_s16le, or pcm_f32le');
}

function mockDelivery(value: string | undefined): TtsConfig['mock']['delivery'] {
  const delivery = value ?? DEFAULT_TTS_CONFIG.mock.delivery;
  if (delivery === 'stream' || delivery === 'artifact') return delivery;
  throw new Error('DESKTOP_CHAR_TTS_MOCK_DELIVERY must be stream or artifact');
}
