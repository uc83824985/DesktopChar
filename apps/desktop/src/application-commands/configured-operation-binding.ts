import type { ApplicationData, ApplicationTarget } from '../../../../packages/application-command-runtime/src/index.ts';

export interface ConfiguredOperationFieldRule {
  source: string;
  required?: boolean;
}

export interface ConfiguredOperationBinding {
  operation: string;
  arguments: Record<string, ConfiguredOperationFieldRule>;
  result: Record<string, ConfiguredOperationFieldRule>;
}

export interface ConfiguredApplicationOperationGateway {
  invoke(
    operation: string,
    argumentsValue: Readonly<Record<string, ApplicationData>>,
    options: { signal: AbortSignal },
  ): ApplicationData | Promise<ApplicationData>;
}

export interface ApplicationOperationSource {
  target: ApplicationTarget;
  parameters: ApplicationData;
  contextRevision: number;
}

/**
 * Maps semantic application data to a transport-neutral operation call. The
 * gateway owns transport and discovery; bindings own operation/field names.
 */
export class ConfiguredApplicationOperationBindingRuntime {
  readonly #gateway: ConfiguredApplicationOperationGateway;
  #bindings: Readonly<Record<string, ConfiguredOperationBinding>> = {};

  constructor(
    gateway: ConfiguredApplicationOperationGateway,
    bindings: Readonly<Record<string, ConfiguredOperationBinding>> = {},
  ) {
    if (!gateway || typeof gateway.invoke !== 'function') {
      throw new TypeError('Configured application operation binding requires a gateway');
    }
    this.#gateway = gateway;
    this.replaceBindings(bindings);
  }

  replaceBindings(bindings: Readonly<Record<string, ConfiguredOperationBinding>>): void {
    this.#bindings = normalizeBindings(bindings);
  }

  async invoke(
    bindingId: string,
    source: ApplicationOperationSource,
    signal: AbortSignal,
  ): Promise<ApplicationData> {
    const binding = this.#bindings[bindingId];
    if (!binding) throw new Error(`Application operation binding is not configured: ${bindingId}`);
    const argumentsValue = projectFields(source as unknown as ApplicationData, binding.arguments, 'argument');
    const response = await this.#gateway.invoke(binding.operation, argumentsValue, { signal });
    return projectFields(response, binding.result, 'result');
  }
}

function normalizeBindings(
  value: Readonly<Record<string, ConfiguredOperationBinding>>,
): Readonly<Record<string, ConfiguredOperationBinding>> {
  if (!isRecord(value)) throw new TypeError('Application operation bindings must be an object');
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([bindingId, binding]) => {
    const id = nonEmpty(bindingId, 'Application operation binding id');
    if (!isRecord(binding)) throw new TypeError(`Application operation binding ${id} must be an object`);
    return [id, Object.freeze({
      operation: nonEmpty(binding.operation, `Application operation binding ${id} operation`),
      arguments: normalizeRules(binding.arguments, `${id}.arguments`),
      result: normalizeRules(binding.result, `${id}.result`),
    })];
  })));
}

function normalizeRules(
  value: Record<string, ConfiguredOperationFieldRule>,
  label: string,
): Readonly<Record<string, ConfiguredOperationFieldRule>> {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([destination, rule]) => {
    const normalizedDestination = fieldPath(destination, `${label} destination`);
    if (!isRecord(rule)) throw new TypeError(`${label}.${destination} must be an object`);
    const unknown = Object.keys(rule).filter(key => key !== 'source' && key !== 'required');
    if (unknown.length) throw new TypeError(`${label}.${destination} contains unknown field ${unknown[0]}`);
    if (rule.required !== undefined && typeof rule.required !== 'boolean') {
      throw new TypeError(`${label}.${destination}.required must be a boolean`);
    }
    return [normalizedDestination, Object.freeze({
      source: fieldPath(rule.source, `${label}.${destination}.source`),
      ...(rule.required !== undefined ? { required: rule.required } : {}),
    })];
  })));
}

function projectFields(
  source: ApplicationData,
  rules: Readonly<Record<string, ConfiguredOperationFieldRule>>,
  phase: string,
): Record<string, ApplicationData> {
  const result: Record<string, ApplicationData> = {};
  for (const [destination, rule] of Object.entries(rules)) {
    const resolved = readPath(source, rule.source);
    if (resolved === undefined) {
      if (rule.required !== false) {
        throw new Error(`Application operation ${phase} source is missing: ${rule.source}`);
      }
      continue;
    }
    writePath(result, destination, cloneData(resolved));
  }
  return result;
}

function readPath(value: ApplicationData, path: string): ApplicationData | undefined {
  let current: ApplicationData | undefined = value;
  for (const segment of path.split('.')) {
    if (!isRecord(current) || !Object.hasOwn(current, segment)) return undefined;
    current = current[segment];
  }
  return current;
}

function writePath(target: Record<string, ApplicationData>, path: string, value: ApplicationData): void {
  const segments = path.split('.');
  let current = target;
  for (let index = 0; index < segments.length - 1; index++) {
    const segment = segments[index]!;
    const existing = current[segment];
    if (existing !== undefined && !isRecord(existing)) {
      throw new Error(`Application operation destination overlaps a scalar field: ${path}`);
    }
    if (!existing) current[segment] = {};
    current = current[segment] as Record<string, ApplicationData>;
  }
  current[segments.at(-1)!] = value;
}

function cloneData<T extends ApplicationData>(value: T): T {
  return structuredClone(value);
}

function fieldPath(value: unknown, label: string): string {
  const result = nonEmpty(value, label);
  const segments = result.split('.');
  if (segments.some(segment => !/^[A-Za-z][A-Za-z0-9_-]*$/u.test(segment)
    || segment === '__proto__' || segment === 'prototype' || segment === 'constructor')) {
    throw new TypeError(`${label} must be a safe dotted field path`);
  }
  return result;
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be a non-empty string`);
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, ApplicationData> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
