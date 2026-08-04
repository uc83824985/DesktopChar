import { ApplicationAccessScheduler } from './access-scheduler.ts';
import { ApplicationQueryCatalog } from './catalog.ts';
import type {
  ApplicationAccessClaim,
  ApplicationData,
  ApplicationQuery,
  ApplicationQueryRuntimeSnapshot,
} from './types.ts';
import {
  cloneApplicationData,
  normalizeAccessClaims,
  normalizeQuery,
} from './validation.ts';

const DEFAULT_QUERY_ACCESS: readonly ApplicationAccessClaim[] = [{
  resource: 'application',
  mode: 'read',
}];

export interface ApplicationQueryRuntimeOptions {
  catalog?: ApplicationQueryCatalog;
  scheduler?: ApplicationAccessScheduler;
}

/** Executes registered read-only application queries through shared access scheduling. */
export class ApplicationQueryRuntime {
  readonly catalog: ApplicationQueryCatalog;
  readonly scheduler: ApplicationAccessScheduler;
  #queuedCount = 0;
  #executingCount = 0;

  constructor(options: ApplicationQueryRuntimeOptions = {}) {
    this.catalog = options.catalog ?? new ApplicationQueryCatalog();
    this.scheduler = options.scheduler ?? new ApplicationAccessScheduler();
  }

  execute<TResult extends ApplicationData = ApplicationData>(
    value: ApplicationQuery,
    options: { signal?: AbortSignal } = {},
  ): Promise<TResult> {
    const query = normalizeQuery(value);
    const definition = this.catalog.resolve(query.type);
    const parameters = cloneApplicationData(
      definition.validateParameters(cloneApplicationData(query.parameters)),
      `Application query "${query.type}" normalized parameters`,
    );
    const claims = normalizeAccessClaims(
      definition.access?.(query, parameters) ?? DEFAULT_QUERY_ACCESS,
    );
    let started = false;
    this.#queuedCount++;
    const scheduled = this.scheduler.schedule(
      claims,
      async signal => {
        started = true;
        this.#queuedCount--;
        this.#executingCount++;
        try {
          return cloneApplicationData(await definition.execute({
            query,
            parameters,
            signal,
          }), `Application query "${query.type}" result`);
        }
        finally {
          this.#executingCount--;
        }
      },
      options,
    );
    return scheduled
      .finally(() => {
        if (!started) this.#queuedCount--;
      }) as Promise<TResult>;
  }

  getSnapshot(): ApplicationQueryRuntimeSnapshot {
    return {
      queuedCount: this.#queuedCount,
      executingCount: this.#executingCount,
    };
  }
}
