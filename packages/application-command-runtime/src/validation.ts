import { ApplicationCommandRuntimeError } from './errors.ts';
import type {
  ApplicationAccessClaim,
  ApplicationCommand,
  ApplicationData,
  ApplicationQuery,
  ApplicationTarget,
} from './types.ts';

const MAX_DATA_DEPTH = 32;

export function cloneApplicationData(value: ApplicationData, label = 'Application data'): ApplicationData {
  return cloneData(value, label, 0, new Set<object>());
}

export function normalizeCommand(value: ApplicationCommand): ApplicationCommand {
  if (!record(value)) invalid('Application command must be an object');
  if (value.schemaVersion !== 'desktop-char.application-command.v1') {
    invalid('Application command schemaVersion is invalid');
  }
  return {
    schemaVersion: value.schemaVersion,
    commandId: nonEmpty(value.commandId, 'Application command commandId'),
    type: nonEmpty(value.type, 'Application command type'),
    parameters: cloneApplicationData(value.parameters, 'Application command parameters'),
    contextRevision: nonNegativeInteger(
      value.contextRevision,
      'Application command contextRevision',
    ),
    ...(value.target ? { target: normalizeTarget(value.target) } : {}),
  };
}

export function normalizeQuery(value: ApplicationQuery): ApplicationQuery {
  if (!record(value)) invalid('Application query must be an object');
  if (value.schemaVersion !== 'desktop-char.application-query.v1') {
    invalid('Application query schemaVersion is invalid');
  }
  return {
    schemaVersion: value.schemaVersion,
    type: nonEmpty(value.type, 'Application query type'),
    parameters: cloneApplicationData(value.parameters, 'Application query parameters'),
    contextRevision: nonNegativeInteger(value.contextRevision, 'Application query contextRevision'),
    ...(value.target ? { target: normalizeTarget(value.target) } : {}),
  };
}

export function normalizeAccessClaims(
  values: readonly ApplicationAccessClaim[],
): ApplicationAccessClaim[] {
  if (!Array.isArray(values) || values.length === 0) {
    invalid('Application access claims must contain at least one resource');
  }
  const claims = new Map<string, ApplicationAccessClaim['mode']>();
  for (const value of values) {
    if (!record(value)) invalid('Application access claim must be an object');
    const resource = nonEmpty(value.resource, 'Application access resource');
    if (value.mode !== 'read' && value.mode !== 'write') {
      invalid(`Application access mode for ${resource} is invalid`);
    }
    const existing = claims.get(resource);
    claims.set(resource, existing === 'write' || value.mode === 'write' ? 'write' : 'read');
  }
  return [...claims]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([resource, mode]) => ({ resource, mode }));
}

export function canonicalApplicationData(value: ApplicationData): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(item => canonicalApplicationData(item)).join(',')}]`;
  }
  return `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${canonicalApplicationData(value[key]!)}`).join(',')}}`;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Application operation was cancelled', 'AbortError');
}

export function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) invalid(`${label} must be a non-empty string`);
  return value.trim();
}

export function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    invalid(`${label} must be a non-negative integer`);
  }
  return value as number;
}

export function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const candidate = value ?? fallback;
  if (!Number.isInteger(candidate) || (candidate as number) < minimum || (candidate as number) > maximum) {
    invalid(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return candidate as number;
}

function normalizeTarget(value: ApplicationTarget): ApplicationTarget {
  if (!record(value)) invalid('Application target must be an object');
  return {
    kind: nonEmpty(value.kind, 'Application target kind'),
    id: nonEmpty(value.id, 'Application target id'),
    ...(value.expectedRevision !== undefined
      ? { expectedRevision: nonEmpty(value.expectedRevision, 'Application target expectedRevision') }
      : {}),
  };
}

function cloneData(
  value: ApplicationData,
  label: string,
  depth: number,
  ancestors: Set<object>,
): ApplicationData {
  if (depth > MAX_DATA_DEPTH) invalid(`${label} exceeds the maximum nesting depth`);
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid(`${label} contains a non-finite number`);
    return value;
  }
  if (typeof value !== 'object') invalid(`${label} must contain only JSON-compatible values`);
  if (ancestors.has(value)) invalid(`${label} contains a cycle`);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item, index) => cloneData(item, `${label}[${index}]`, depth + 1, ancestors));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      invalid(`${label} contains a non-plain object`);
    }
    const cloned: Record<string, ApplicationData> = {};
    for (const [key, item] of Object.entries(value)) {
      cloned[key] = cloneData(item, `${label}.${key}`, depth + 1, ancestors);
    }
    return cloned;
  }
  finally {
    ancestors.delete(value);
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(message: string): never {
  throw new ApplicationCommandRuntimeError('invalid-input', message);
}
