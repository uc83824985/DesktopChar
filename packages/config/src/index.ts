import {
  DEFAULT_GAZE_SMOOTHING_PROFILE,
  DEFAULT_LIP_SYNC_PROFILE,
  type AvatarAction,
  type AvatarState,
  type CharacterExpressionCatalog,
  type Emotion,
  type EmotionBindings,
  type ExpressionDescriptor,
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
  expressionCatalog?: CharacterExpressionCatalog;
  expressionCooldownMs: number;
  idleReturnDelayMs: number;
  gazeProfile: GazeProfile;
  lipSyncProfile: LipSyncProfile;
}

export const DEFAULT_CHARACTER_PROFILE_URL = 'models/Mao/DesktopChar.character.json';

const EMOTIONS = new Set<Emotion>(['neutral', 'happy', 'sad', 'angry', 'surprised', 'thinking']);
const ACTIONS = new Set<AvatarAction>(['nod', 'shake', 'tap', 'greet']);
const AVATAR_STATES = new Set<AvatarState>(['idle', 'listening', 'thinking', 'speaking', 'presenting']);
const AFFECT_DIMENSIONS = new Set(['valence', 'arousal', 'approval', 'engagement', 'certainty']);

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
    'emotionBindings', 'expressionCatalog', 'expressionCooldownMs', 'idleReturnDelayMs', 'gazeProfile',
    'lipSyncProfile',
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
  const catalog = expressionCatalog(profile.expressionCatalog);
  return {
    id,
    modelJsonUrl: resolveProfileAsset(profileUrl, model),
    defaultEmotion,
    allowedEmotions,
    allowedActions,
    emotionBindings: bindings,
    ...(catalog ? { expressionCatalog: catalog } : {}),
    expressionCooldownMs: nonNegativeNumber(profile.expressionCooldownMs, 'Character profile expressionCooldownMs'),
    idleReturnDelayMs: nonNegativeNumber(profile.idleReturnDelayMs, 'Character profile idleReturnDelayMs'),
    gazeProfile: gazeProfile(profile.gazeProfile),
    lipSyncProfile: lipSyncProfile(profile.lipSyncProfile),
  };
}

export function validateCharacterExpressionResources(
  catalog: CharacterExpressionCatalog,
  availableExpressionIds: Iterable<string>,
): void {
  const available = new Set(availableExpressionIds);
  const boundResources = new Set<string>();
  for (const descriptor of catalog.descriptors) {
    const binding = catalog.bindings[descriptor.expressionKey];
    if (!binding) {
      throw new TypeError(`Expression catalog has no binding for ${descriptor.expressionKey}`);
    }
    if (binding.expression === null) continue;
    if (!available.has(binding.expression)) {
      throw new TypeError(
        `Expression catalog binding ${descriptor.expressionKey} references unavailable resource ${binding.expression}`,
      );
    }
    if (boundResources.has(binding.expression)) {
      throw new TypeError(`Expression resource is bound more than once: ${binding.expression}`);
    }
    boundResources.add(binding.expression);
  }
}

function expressionCatalog(value: unknown): CharacterExpressionCatalog | undefined {
  if (value === undefined) return undefined;
  const catalog = record(value, 'Character profile expressionCatalog');
  assertKnownKeys(
    catalog,
    ['revision', 'defaultExpressionKey', 'descriptors', 'bindings'],
    'Character profile expressionCatalog',
  );
  const revision = nonNegativeInteger(catalog.revision, 'Character profile expressionCatalog.revision');
  const defaultExpressionKey = expressionKey(
    catalog.defaultExpressionKey,
    'Character profile expressionCatalog.defaultExpressionKey',
  );
  if (!Array.isArray(catalog.descriptors) || !catalog.descriptors.length) {
    throw new TypeError('Character profile expressionCatalog.descriptors must be a non-empty array');
  }
  const keys = new Set<string>();
  const descriptors = catalog.descriptors.map((item, index): ExpressionDescriptor => {
    const label = `Character profile expressionCatalog.descriptors[${index}]`;
    const descriptor = record(item, label);
    assertKnownKeys(descriptor, [
      'expressionKey', 'label', 'semanticTags', 'prototypeTexts', 'affectPrototype',
      'baseWeight', 'cooldownMs', 'holdMs', 'compatibleAvatarStates',
    ], label);
    const key = expressionKey(descriptor.expressionKey, `${label}.expressionKey`);
    if (keys.has(key)) throw new TypeError(`${label}.expressionKey must be unique`);
    keys.add(key);
    const hold = record(descriptor.holdMs, `${label}.holdMs`);
    assertKnownKeys(hold, ['minMs', 'maxMs'], `${label}.holdMs`);
    const minMs = nonNegativeNumber(hold.minMs, `${label}.holdMs.minMs`);
    const maxMs = nonNegativeNumber(hold.maxMs, `${label}.holdMs.maxMs`);
    if (maxMs < minMs) throw new TypeError(`${label}.holdMs.maxMs must be at least minMs`);
    const affect = affectPrototype(descriptor.affectPrototype, `${label}.affectPrototype`);
    return {
      expressionKey: key,
      label: nonEmptyText(descriptor.label, `${label}.label`),
      semanticTags: uniqueTextArray(descriptor.semanticTags, `${label}.semanticTags`),
      prototypeTexts: uniqueTextArray(descriptor.prototypeTexts, `${label}.prototypeTexts`),
      ...(affect ? { affectPrototype: affect } : {}),
      baseWeight: positiveNumber(descriptor.baseWeight, `${label}.baseWeight`),
      cooldownMs: nonNegativeNumber(descriptor.cooldownMs, `${label}.cooldownMs`),
      holdMs: { minMs, maxMs },
      compatibleAvatarStates: enumArray(
        descriptor.compatibleAvatarStates,
        AVATAR_STATES,
        `${label}.compatibleAvatarStates`,
      ),
    };
  });
  if (!keys.has(defaultExpressionKey)) {
    throw new TypeError('Character profile expressionCatalog.defaultExpressionKey must reference a descriptor');
  }

  const configuredBindings = record(
    catalog.bindings,
    'Character profile expressionCatalog.bindings',
  );
  const bindingKeys = Object.keys(configuredBindings);
  const unknownBindings = bindingKeys.filter(key => !keys.has(key));
  const missingBindings = [...keys].filter(key => !(key in configuredBindings));
  if (unknownBindings.length || missingBindings.length) {
    throw new TypeError(
      'Character profile expressionCatalog.bindings must exactly match descriptor keys'
      + `${unknownBindings.length ? `; unknown: ${unknownBindings.join(', ')}` : ''}`
      + `${missingBindings.length ? `; missing: ${missingBindings.join(', ')}` : ''}`,
    );
  }
  const bindings = Object.fromEntries(bindingKeys.map(key => {
    const label = `Character profile expressionCatalog.bindings.${key}`;
    const binding = record(configuredBindings[key], label);
    assertKnownKeys(binding, ['expression'], label);
    const expression = binding.expression === null
      ? null
      : nonEmptyText(binding.expression, `${label}.expression`);
    return [key, { expression }];
  }));
  return { revision, defaultExpressionKey, descriptors, bindings };
}

function affectPrototype(
  value: unknown,
  label: string,
): ExpressionDescriptor['affectPrototype'] | undefined {
  if (value === undefined) return undefined;
  const prototype = record(value, label);
  assertKnownKeys(prototype, [...AFFECT_DIMENSIONS], label);
  if (!Object.keys(prototype).length) throw new TypeError(`${label} must not be empty`);
  const result: NonNullable<ExpressionDescriptor['affectPrototype']> = {};
  for (const [key, dimension] of Object.entries(prototype)) {
    const minimum = key === 'valence' || key === 'approval' ? -1 : 0;
    const number = finiteNumber(dimension, `${label}.${key}`);
    if (number < minimum || number > 1) {
      throw new TypeError(`${label}.${key} must be from ${minimum} to 1`);
    }
    result[key as keyof typeof result] = number;
  }
  return result;
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
  assertKnownKeys(profile, ['headX', 'headY', 'eyeX', 'eyeY', 'smoothing'], 'Character profile gazeProfile');
  return {
    headX: gazeAxis(profile.headX, 'gazeProfile.headX'),
    headY: gazeAxis(profile.headY, 'gazeProfile.headY'),
    eyeX: gazeAxis(profile.eyeX, 'gazeProfile.eyeX'),
    eyeY: gazeAxis(profile.eyeY, 'gazeProfile.eyeY'),
    smoothing: gazeSmoothing(profile.smoothing),
  };
}

function gazeSmoothing(value: unknown): GazeProfile['smoothing'] {
  if (value === undefined) return { ...DEFAULT_GAZE_SMOOTHING_PROFILE };
  const smoothing = record(value, 'gazeProfile.smoothing');
  assertKnownKeys(smoothing, ['headResponseMs', 'eyeResponseMs'], 'gazeProfile.smoothing');
  return {
    headResponseMs: nonNegativeNumber(smoothing.headResponseMs, 'gazeProfile.smoothing.headResponseMs'),
    eyeResponseMs: nonNegativeNumber(smoothing.eyeResponseMs, 'gazeProfile.smoothing.eyeResponseMs'),
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

function uniqueTextArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.length) throw new TypeError(`${label} must be a non-empty array`);
  const result = value.map((item, index) => nonEmptyText(item, `${label}[${index}]`));
  if (new Set(result).size !== result.length) throw new TypeError(`${label} must not contain duplicates`);
  return result;
}

function expressionKey(value: unknown, label: string): string {
  const key = nonEmptyText(value, label);
  if (!/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u.test(key)) {
    throw new TypeError(`${label} must be a stable lowercase logical ID`);
  }
  return key;
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

function nonNegativeInteger(value: unknown, label: string): number {
  const result = nonNegativeNumber(value, label);
  if (!Number.isInteger(result)) throw new TypeError(`${label} must be an integer`);
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
