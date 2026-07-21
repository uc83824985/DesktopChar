import type { AvatarAction, Emotion, GazeProfile, LipSyncProfile } from '../../contracts/src/index.ts';

export interface CharacterConfig {
  id: string;
  modelJsonUrl: string;
  defaultEmotion: Emotion;
  allowedEmotions: Emotion[];
  allowedActions: AvatarAction[];
  expressionCooldownMs: number;
  idleReturnDelayMs: number;
  gazeProfile: GazeProfile;
  lipSyncProfile: LipSyncProfile;
}

export const MAO_CHARACTER_CONFIG: CharacterConfig = {
  id: 'mao',
  modelJsonUrl: 'models/Mao/Mao.model3.json',
  defaultEmotion: 'neutral',
  allowedEmotions: ['neutral', 'happy'],
  allowedActions: ['nod'],
  expressionCooldownMs: 500,
  idleReturnDelayMs: 800,
  gazeProfile: {
    headX: { negative: { limit: -30, exponent: 1 }, positive: { limit: 30, exponent: 1 }, deadZone: 0.02 },
    headY: { negative: { limit: -20, exponent: 1 }, positive: { limit: 30, exponent: 0.9 }, deadZone: 0.02 },
    eyeX: { negative: { limit: -1, exponent: 0.9 }, positive: { limit: 1, exponent: 0.9 }, deadZone: 0.01 },
    eyeY: { negative: { limit: -1, exponent: 0.9 }, positive: { limit: 1, exponent: 0.85 }, deadZone: 0.01 },
  },
  lipSyncProfile: { gain: 2.5 },
};

export interface TtsConfig {
  mode: 'local' | 'mcp';
  local: {
    host: '127.0.0.1' | 'localhost' | '::1';
    port: number;
    delayMs: number;
    defaultRate: number;
    durationPerCharacterMs: number;
    minimumDurationMs: number;
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
  mode: 'local',
  local: { host: '127.0.0.1', port: 8766, delayMs: 15, defaultRate: 1, durationPerCharacterMs: 232, minimumDurationMs: 500, sampleRateHz: 24_000, channels: 1 },
  mcp: { toolName: 'tts_open_stream', cancelToolName: 'tts_cancel_synthesis', timeoutMs: 30_000, requestIdArgument: 'request_id', textArgument: 'text', format: 'pcm_s16le' },
};

export function loadTtsConfig(values: Record<string, string | undefined>): TtsConfig {
  const mode = values.DESKTOP_CHAR_TTS_MODE ?? DEFAULT_TTS_CONFIG.mode;
  if (mode !== 'local' && mode !== 'mcp') throw new Error('DESKTOP_CHAR_TTS_MODE must be local or mcp');
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
    local: {
      host: loopbackHost(values.DESKTOP_CHAR_TTS_LOCAL_MCP_HOST),
      port: environmentPort(values.DESKTOP_CHAR_TTS_LOCAL_MCP_PORT, DEFAULT_TTS_CONFIG.local.port),
      delayMs: environmentNumber(values.DESKTOP_CHAR_TTS_LOCAL_DELAY_MS, DEFAULT_TTS_CONFIG.local.delayMs, 'DESKTOP_CHAR_TTS_LOCAL_DELAY_MS', true),
      defaultRate: environmentRate(values.DESKTOP_CHAR_TTS_LOCAL_RATE, DEFAULT_TTS_CONFIG.local.defaultRate),
      durationPerCharacterMs: environmentNumber(values.DESKTOP_CHAR_TTS_LOCAL_CHAR_MS, DEFAULT_TTS_CONFIG.local.durationPerCharacterMs, 'DESKTOP_CHAR_TTS_LOCAL_CHAR_MS'),
      minimumDurationMs: environmentNumber(values.DESKTOP_CHAR_TTS_LOCAL_MIN_MS, DEFAULT_TTS_CONFIG.local.minimumDurationMs, 'DESKTOP_CHAR_TTS_LOCAL_MIN_MS'),
      sampleRateHz: environmentNumber(values.DESKTOP_CHAR_TTS_SAMPLE_RATE_HZ, DEFAULT_TTS_CONFIG.local.sampleRateHz, 'DESKTOP_CHAR_TTS_SAMPLE_RATE_HZ'),
      channels: environmentNumber(values.DESKTOP_CHAR_TTS_CHANNELS, DEFAULT_TTS_CONFIG.local.channels, 'DESKTOP_CHAR_TTS_CHANNELS'),
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

function loopbackHost(value: string | undefined): TtsConfig['local']['host'] {
  const host = value ?? DEFAULT_TTS_CONFIG.local.host;
  if (host === '127.0.0.1' || host === 'localhost' || host === '::1') return host;
  throw new Error('DESKTOP_CHAR_TTS_LOCAL_MCP_HOST must be a loopback host');
}

function environmentPort(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new Error('DESKTOP_CHAR_TTS_LOCAL_MCP_PORT must be an integer from 0 to 65535');
  }
  return parsed;
}

function environmentRate(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0.5 || parsed > 2) throw new Error('DESKTOP_CHAR_TTS_LOCAL_RATE must be from 0.5 to 2');
  return parsed;
}
