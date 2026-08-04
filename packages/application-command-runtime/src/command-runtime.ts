import { ApplicationAccessScheduler } from './access-scheduler.ts';
import { ApplicationCommandCatalog } from './catalog.ts';
import { ApplicationCommandRuntimeError } from './errors.ts';
import type {
  ApplicationAccessClaim,
  ApplicationCommand,
  ApplicationCommandExecutionSnapshot,
  ApplicationCommandRuntimeSnapshot,
  ApplicationData,
  ApplicationExecutionState,
} from './types.ts';
import {
  boundedInteger,
  canonicalApplicationData,
  cloneApplicationData,
  errorMessage,
  isAbortError,
  normalizeAccessClaims,
  normalizeCommand,
} from './validation.ts';

const DEFAULT_COMMAND_ACCESS: readonly ApplicationAccessClaim[] = [{
  resource: 'application',
  mode: 'write',
}];

interface CommandExecutionRecord {
  commandId: string;
  type: string;
  fingerprint: string;
  state: ApplicationExecutionState;
  createdAtMs: number;
  startedAtMs?: number;
  completedAtMs?: number;
  error?: string;
  promise: Promise<ApplicationData>;
}

export interface ApplicationCommandRuntimeOptions {
  catalog?: ApplicationCommandCatalog;
  scheduler?: ApplicationAccessScheduler;
  maxRetainedExecutions?: number;
  now?: () => number;
}

/**
 * Executes already-authoritative application commands. Proposal compilation,
 * user confirmation and agent-facing receipts intentionally live outside it.
 */
export class ApplicationCommandRuntime {
  readonly catalog: ApplicationCommandCatalog;
  readonly scheduler: ApplicationAccessScheduler;
  readonly #maxRetainedExecutions: number;
  readonly #now: () => number;
  readonly #records = new Map<string, CommandExecutionRecord>();

  constructor(options: ApplicationCommandRuntimeOptions = {}) {
    this.catalog = options.catalog ?? new ApplicationCommandCatalog();
    this.scheduler = options.scheduler ?? new ApplicationAccessScheduler();
    this.#maxRetainedExecutions = boundedInteger(
      options.maxRetainedExecutions,
      500,
      10,
      10_000,
      'Application command maxRetainedExecutions',
    );
    this.#now = options.now ?? Date.now;
  }

  execute<TResult extends ApplicationData = ApplicationData>(
    value: ApplicationCommand,
    options: { signal?: AbortSignal } = {},
  ): Promise<TResult> {
    const command = normalizeCommand(value);
    const fingerprint = canonicalApplicationData(command as unknown as ApplicationData);
    const existing = this.#records.get(command.commandId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new ApplicationCommandRuntimeError(
          'idempotency-conflict',
          `Application commandId "${command.commandId}" was reused with different content`,
        );
      }
      return existing.promise as Promise<TResult>;
    }

    const definition = this.catalog.resolve(command.type);
    const parameters = cloneApplicationData(
      definition.validateParameters(cloneApplicationData(command.parameters)),
      `Application command "${command.type}" normalized parameters`,
    );
    const normalizedCommand: ApplicationCommand = {
      ...command,
      parameters,
    };
    const claims = normalizeAccessClaims(
      definition.access?.(normalizedCommand, parameters) ?? DEFAULT_COMMAND_ACCESS,
    );
    const record: CommandExecutionRecord = {
      commandId: normalizedCommand.commandId,
      type: normalizedCommand.type,
      fingerprint,
      state: 'queued',
      createdAtMs: this.#now(),
      promise: Promise.resolve(null),
    };
    this.#records.set(record.commandId, record);
    const scheduled = this.scheduler.schedule(
      claims,
      async signal => {
        record.state = 'executing';
        record.startedAtMs = this.#now();
        try {
          const result = cloneApplicationData(await definition.execute({
            command: normalizedCommand,
            parameters,
            signal,
          }), `Application command "${command.type}" result`);
          record.state = 'succeeded';
          record.completedAtMs = this.#now();
          return result;
        }
        catch (error) {
          record.state = isAbortError(error) || signal.aborted ? 'cancelled' : 'failed';
          record.completedAtMs = this.#now();
          record.error = errorMessage(error);
          throw error;
        }
      },
      options,
    );
    record.promise = scheduled.catch(error => {
      if (record.state === 'queued') {
        record.state = isAbortError(error) || options.signal?.aborted ? 'cancelled' : 'failed';
        record.completedAtMs = this.#now();
        record.error = errorMessage(error);
      }
      throw error;
    }).finally(() => this.#trimRecords());
    return record.promise as Promise<TResult>;
  }

  getSnapshot(): ApplicationCommandRuntimeSnapshot {
    const executions = [...this.#records.values()].map(cloneExecutionSnapshot);
    return {
      queuedCount: executions.filter(item => item.state === 'queued').length,
      executingCount: executions.filter(item => item.state === 'executing').length,
      retainedCount: executions.length,
      executions,
    };
  }

  #trimRecords(): void {
    if (this.#records.size <= this.#maxRetainedExecutions) return;
    for (const [commandId, record] of this.#records) {
      if (record.state === 'queued' || record.state === 'executing') continue;
      this.#records.delete(commandId);
      if (this.#records.size <= this.#maxRetainedExecutions) return;
    }
  }
}

function cloneExecutionSnapshot(record: CommandExecutionRecord): ApplicationCommandExecutionSnapshot {
  return {
    commandId: record.commandId,
    type: record.type,
    state: record.state,
    createdAtMs: record.createdAtMs,
    ...(record.startedAtMs !== undefined ? { startedAtMs: record.startedAtMs } : {}),
    ...(record.completedAtMs !== undefined ? { completedAtMs: record.completedAtMs } : {}),
    ...(record.error ? { error: record.error } : {}),
  };
}
