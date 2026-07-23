import {
  DEFAULT_LIP_SYNC_PROFILE,
  type AvatarAction,
  type Emotion,
  type EmotionBindings,
  type GazeProfile,
  type LipSyncProfile,
} from '../../contracts/src/index.ts';

export interface CharacterConfig {
  id: string;
  modelJsonUrl: string;
  defaultEmotion: Emotion;
  allowedEmotions: Emotion[];
  allowedActions: AvatarAction[];
  emotionBindings: EmotionBindings;
  expressionCooldownMs: number;
  idleReturnDelayMs: number;
  gazeProfile: GazeProfile;
  lipSyncProfile: LipSyncProfile;
}

export const DEFAULT_CHARACTER_PROFILE_URL = 'models/Mao/DesktopChar.character.json';

const EMOTIONS = new Set<Emotion>(['neutral', 'happy', 'sad', 'angry', 'surprised', 'thinking']);
const ACTIONS = new Set<AvatarAction>(['nod', 'shake', 'tap', 'greet']);

export async function loadCharacterConfig(
  profileUrl = DEFAULT_CHARACTER_PROFILE_URL,
  fetcher: typeof fetch = fetch,
): Promise<CharacterConfig> {
  const response = await fetcher(profileUrl, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Character profile request failed (${response.status}): ${profileUrl}`);
  return parseCharacterConfig(await response.json(), profileUrl);
}

export function parseCharacterConfig(value: unknown, profileUrl = DEFAULT_CHARACTER_PROFILE_URL): CharacterConfig {
  const profile = record(value, 'Character profile');
  assertKnownKeys(profile, [
    '$schema', 'version', 'id', 'model', 'defaultEmotion', 'allowedEmotions', 'allowedActions',
    'emotionBindings', 'expressionCooldownMs', 'idleReturnDelayMs', 'gazeProfile', 'lipSyncProfile',
  ], 'Character profile');
  if (profile.$schema !== undefined) nonEmptyText(profile.$schema, 'Character profile $schema');
  if ((profile.version ?? 1) !== 1) throw new TypeError('Character profile version must be 1');
  const id = nonEmptyText(profile.id, 'Character profile id');
  const model = relativeAssetPath(profile.model, 'Character profile model');
  const defaultEmotion = enumValue(profile.defaultEmotion, EMOTIONS, 'Character profile defaultEmotion');
  const allowedEmotions = enumArray(profile.allowedEmotions, EMOTIONS, 'Character profile allowedEmotions');
  if (!allowedEmotions.includes(defaultEmotion)) {
    throw new TypeError('Character profile allowedEmotions must contain defaultEmotion');
  }
  const allowedActions = enumArray(profile.allowedActions, ACTIONS, 'Character profile allowedActions');
  const bindings = emotionBindings(profile.emotionBindings, allowedEmotions);
  return {
    id,
    modelJsonUrl: resolveProfileAsset(profileUrl, model),
    defaultEmotion,
    allowedEmotions,
    allowedActions,
    emotionBindings: bindings,
    expressionCooldownMs: nonNegativeNumber(profile.expressionCooldownMs, 'Character profile expressionCooldownMs'),
    idleReturnDelayMs: nonNegativeNumber(profile.idleReturnDelayMs, 'Character profile idleReturnDelayMs'),
    gazeProfile: gazeProfile(profile.gazeProfile),
    lipSyncProfile: lipSyncProfile(profile.lipSyncProfile),
  };
}

function emotionBindings(value: unknown, allowedEmotions: Emotion[]): EmotionBindings {
  if (value === undefined) return {};
  const configured = record(value, 'Character profile emotionBindings');
  return Object.fromEntries(Object.entries(configured).map(([emotion, bindingValue]) => {
    const semanticEmotion = enumValue(emotion, EMOTIONS, `Character profile emotionBindings.${emotion}`);
    if (!allowedEmotions.includes(semanticEmotion)) {
      throw new TypeError(`Character profile emotionBindings.${emotion} is not listed in allowedEmotions`);
    }
    const binding = record(bindingValue, `Character profile emotionBindings.${emotion}`);
    assertKnownKeys(binding, ['expression'], `Character profile emotionBindings.${emotion}`);
    const expression = binding.expression === null
      ? null
      : nonEmptyText(binding.expression, `Character profile emotionBindings.${emotion}.expression`);
    return [semanticEmotion, { expression }];
  })) as EmotionBindings;
}

function gazeProfile(value: unknown): GazeProfile {
  const profile = record(value, 'Character profile gazeProfile');
  assertKnownKeys(profile, ['headX', 'headY', 'eyeX', 'eyeY'], 'Character profile gazeProfile');
  return {
    headX: gazeAxis(profile.headX, 'gazeProfile.headX'),
    headY: gazeAxis(profile.headY, 'gazeProfile.headY'),
    eyeX: gazeAxis(profile.eyeX, 'gazeProfile.eyeX'),
    eyeY: gazeAxis(profile.eyeY, 'gazeProfile.eyeY'),
  };
}

function gazeAxis(value: unknown, label: string): GazeProfile['headX'] {
  const axis = record(value, label);
  assertKnownKeys(axis, ['negative', 'positive', 'deadZone'], label);
  const negative = gazeDirection(axis.negative, `${label}.negative`);
  const positive = gazeDirection(axis.positive, `${label}.positive`);
  if (negative.limit > 0 || positive.limit < 0) {
    throw new TypeError(`${label} negative/positive limits must preserve their direction`);
  }
  const deadZone = nonNegativeNumber(axis.deadZone, `${label}.deadZone`);
  if (deadZone >= 1) throw new TypeError(`${label}.deadZone must be below 1`);
  return { negative, positive, deadZone };
}

function gazeDirection(value: unknown, label: string): GazeProfile['headX']['negative'] {
  const direction = record(value, label);
  assertKnownKeys(direction, ['limit', 'exponent'], label);
  return {
    limit: finiteNumber(direction.limit, `${label}.limit`),
    exponent: positiveNumber(direction.exponent, `${label}.exponent`),
  };
}

function lipSyncProfile(value: unknown): LipSyncProfile {
  const profile = record(value, 'Character profile lipSyncProfile');
  assertKnownKeys(profile, ['gain', 'attackMs', 'releaseMs', 'peakHoldMs'], 'Character profile lipSyncProfile');
  return {
    gain: positiveNumber(profile.gain, 'lipSyncProfile.gain'),
    attackMs: optionalNonNegativeNumber(profile.attackMs, DEFAULT_LIP_SYNC_PROFILE.attackMs, 'lipSyncProfile.attackMs'),
    releaseMs: optionalNonNegativeNumber(profile.releaseMs, DEFAULT_LIP_SYNC_PROFILE.releaseMs, 'lipSyncProfile.releaseMs'),
    peakHoldMs: optionalNonNegativeNumber(profile.peakHoldMs, DEFAULT_LIP_SYNC_PROFILE.peakHoldMs, 'lipSyncProfile.peakHoldMs'),
  };
}

function resolveProfileAsset(profileUrl: string, reference: string): string {
  const slash = profileUrl.lastIndexOf('/');
  return `${slash >= 0 ? profileUrl.slice(0, slash + 1) : ''}${reference}`;
}

function relativeAssetPath(value: unknown, label: string): string {
  const result = nonEmptyText(value, label).replaceAll('\\', '/');
  if (result.startsWith('/') || /^[a-z][a-z\d+.-]*:/iu.test(result) || result.split('/').includes('..')) {
    throw new TypeError(`${label} must be relative to the character profile`);
  }
  return result;
}

function enumArray<T extends string>(value: unknown, allowed: ReadonlySet<T>, label: string): T[] {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError(`${label} must be a non-empty array`);
  const result = value.map((item, index) => enumValue(item, allowed, `${label}[${index}]`));
  if (new Set(result).size !== result.length) throw new TypeError(`${label} must not contain duplicates`);
  return result;
}

function enumValue<T extends string>(value: unknown, allowed: ReadonlySet<T>, label: string): T {
  if (typeof value !== 'string' || !allowed.has(value as T)) throw new TypeError(`${label} is unsupported`);
  return value as T;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function nonEmptyText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be a non-empty string`);
  return value.trim();
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${label} must be finite`);
  return value;
}

function positiveNumber(value: unknown, label: string): number {
  const result = finiteNumber(value, label);
  if (result <= 0) throw new TypeError(`${label} must be positive`);
  return result;
}

function nonNegativeNumber(value: unknown, label: string): number {
  const result = finiteNumber(value, label);
  if (result < 0) throw new TypeError(`${label} must be non-negative`);
  return result;
}

function optionalNonNegativeNumber(value: unknown, fallback: number, label: string): number {
  return value === undefined ? fallback : nonNegativeNumber(value, label);
}

function assertKnownKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const known = new Set(allowed);
  const unknown = Object.keys(value).filter(key => !known.has(key));
  if (unknown.length) throw new TypeError(`${label} contains unknown field(s): ${unknown.join(', ')}`);
}

export interface TtsConfig {
  lifecycle: 'external' | 'managed';
  mcp: {
    timeoutMs: number;
    voice?: string;
    rate?: number;
    format: 'wav' | 'mp3' | 'ogg' | 'opus' | 'pcm_s16le' | 'pcm_f32le';
  };
}

export const DEFAULT_TTS_CONFIG: TtsConfig = {
  lifecycle: 'external',
  mcp: { timeoutMs: 30_000, format: 'pcm_s16le' },
};

export function loadTtsConfig(values: Record<string, string | undefined>): TtsConfig {
  const requestedLifecycle = values.DESKTOP_CHAR_TTS_LIFECYCLE ?? values.DESKTOP_CHAR_TTS_MODE ?? DEFAULT_TTS_CONFIG.lifecycle;
  const lifecycle = requestedLifecycle === 'local' ? 'managed' : requestedLifecycle === 'mcp' ? 'external' : requestedLifecycle;
  if (lifecycle !== 'managed' && lifecycle !== 'external') throw new Error('DESKTOP_CHAR_TTS_LIFECYCLE must be managed or external');
  const mcp: TtsConfig['mcp'] = {
    timeoutMs: environmentNumber(values.DESKTOP_CHAR_TTS_TIMEOUT_MS, DEFAULT_TTS_CONFIG.mcp.timeoutMs, 'DESKTOP_CHAR_TTS_TIMEOUT_MS'),
    format: audioFormat(values.DESKTOP_CHAR_TTS_FORMAT),
  };
  if (values.DESKTOP_CHAR_TTS_VOICE) mcp.voice = values.DESKTOP_CHAR_TTS_VOICE;
  if (values.DESKTOP_CHAR_TTS_RATE !== undefined) mcp.rate = speechRate(values.DESKTOP_CHAR_TTS_RATE, 'DESKTOP_CHAR_TTS_RATE');
  return { lifecycle, mcp };
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

function speechRate(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0.5 || parsed > 2) throw new Error(`${name} must be from 0.5 to 2`);
  return parsed;
}
