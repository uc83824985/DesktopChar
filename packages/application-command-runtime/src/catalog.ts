import { ApplicationCommandRuntimeError } from './errors.ts';
import type {
  ApplicationCommandDefinition,
  ApplicationData,
  ApplicationQueryDefinition,
} from './types.ts';
import { nonEmpty } from './validation.ts';

type ErasedQueryDefinition = ApplicationQueryDefinition<ApplicationData, ApplicationData>;
type ErasedCommandDefinition = ApplicationCommandDefinition<ApplicationData, ApplicationData>;

export class ApplicationQueryCatalog {
  readonly #definitions = new Map<string, ErasedQueryDefinition>();

  register<TParameters extends ApplicationData, TResult extends ApplicationData>(
    definition: ApplicationQueryDefinition<TParameters, TResult>,
  ): () => void {
    validateQueryDefinition(definition);
    const type = definition.type.trim();
    if (this.#definitions.has(type)) {
      throw new ApplicationCommandRuntimeError(
        'duplicate-definition',
        `Application query definition "${type}" is already registered`,
      );
    }
    const erased = definition as unknown as ErasedQueryDefinition;
    this.#definitions.set(type, erased);
    return () => {
      if (this.#definitions.get(type) === erased) this.#definitions.delete(type);
    };
  }

  resolve(type: string): ErasedQueryDefinition {
    const normalizedType = nonEmpty(type, 'Application query type');
    const definition = this.#definitions.get(normalizedType);
    if (!definition) {
      throw new ApplicationCommandRuntimeError(
        'unknown-definition',
        `Application query definition "${normalizedType}" is not registered`,
      );
    }
    return definition;
  }

  list(): string[] {
    return [...this.#definitions.keys()].sort();
  }
}

export class ApplicationCommandCatalog {
  readonly #definitions = new Map<string, ErasedCommandDefinition>();

  register<TParameters extends ApplicationData, TResult extends ApplicationData>(
    definition: ApplicationCommandDefinition<TParameters, TResult>,
  ): () => void {
    validateCommandDefinition(definition);
    const type = definition.type.trim();
    if (this.#definitions.has(type)) {
      throw new ApplicationCommandRuntimeError(
        'duplicate-definition',
        `Application command definition "${type}" is already registered`,
      );
    }
    const erased = definition as unknown as ErasedCommandDefinition;
    this.#definitions.set(type, erased);
    return () => {
      if (this.#definitions.get(type) === erased) this.#definitions.delete(type);
    };
  }

  resolve(type: string): ErasedCommandDefinition {
    const normalizedType = nonEmpty(type, 'Application command type');
    const definition = this.#definitions.get(normalizedType);
    if (!definition) {
      throw new ApplicationCommandRuntimeError(
        'unknown-definition',
        `Application command definition "${normalizedType}" is not registered`,
      );
    }
    return definition;
  }

  list(): string[] {
    return [...this.#definitions.keys()].sort();
  }
}

function validateQueryDefinition(definition: ApplicationQueryDefinition): void {
  if (!definition || typeof definition !== 'object') {
    throw new TypeError('Application query definition must be an object');
  }
  nonEmpty(definition.type, 'Application query definition type');
  if (typeof definition.validateParameters !== 'function') {
    throw new TypeError(`Application query definition "${definition.type}" requires validateParameters`);
  }
  if (typeof definition.execute !== 'function') {
    throw new TypeError(`Application query definition "${definition.type}" requires execute`);
  }
  if (definition.access !== undefined && typeof definition.access !== 'function') {
    throw new TypeError(`Application query definition "${definition.type}" access must be a function`);
  }
}

function validateCommandDefinition(definition: ApplicationCommandDefinition): void {
  if (!definition || typeof definition !== 'object') {
    throw new TypeError('Application command definition must be an object');
  }
  nonEmpty(definition.type, 'Application command definition type');
  if (typeof definition.validateParameters !== 'function') {
    throw new TypeError(
      `Application command definition "${definition.type}" requires validateParameters`,
    );
  }
  if (typeof definition.execute !== 'function') {
    throw new TypeError(`Application command definition "${definition.type}" requires execute`);
  }
  if (definition.access !== undefined && typeof definition.access !== 'function') {
    throw new TypeError(`Application command definition "${definition.type}" access must be a function`);
  }
}
