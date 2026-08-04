import { ApplicationCommandRuntime } from './command-runtime.ts';
import { ApplicationCommandRuntimeError } from './errors.ts';
import type {
  ApplicationCommand,
  ApplicationCommandBridgeErrorFact,
  ApplicationCommandProposal,
  ApplicationCommandReceipt,
  ApplicationCommandReceiptStatus,
  ApplicationData,
} from './types.ts';
import {
  boundedInteger,
  canonicalApplicationData,
  cloneApplicationData,
  errorMessage,
  isAbortError,
  nonEmpty,
  nonNegativeInteger,
  normalizeCommand,
} from './validation.ts';

export type ApplicationCommandBridgePhase = 'compile' | 'execute' | 'project-result';

export interface AgentApplicationCommandBridgeOptions {
  runtime: ApplicationCommandRuntime;
  compileProposal(
    proposal: Readonly<ApplicationCommandProposal>,
    signal: AbortSignal,
  ): ApplicationCommand | Promise<ApplicationCommand>;
  projectResult(
    command: Readonly<ApplicationCommand>,
    result: ApplicationData,
  ): ApplicationData;
  projectError?(
    error: unknown,
    phase: ApplicationCommandBridgePhase,
  ): ApplicationCommandBridgeErrorFact;
  now?: () => number;
  receiptIdFactory?: (proposalId: string, sequence: number) => string;
  maxRetainedReceipts?: number;
}

interface ProposalRecord {
  fingerprint: string;
  promise: Promise<ApplicationCommandReceipt>;
  receipt?: ApplicationCommandReceipt;
}

/** Optional bridge from untrusted agent proposals to authoritative commands and bounded receipts. */
export class AgentApplicationCommandBridge {
  readonly #options: AgentApplicationCommandBridgeOptions;
  readonly #now: () => number;
  readonly #receiptIdFactory: (proposalId: string, sequence: number) => string;
  readonly #maxRetainedReceipts: number;
  readonly #records = new Map<string, ProposalRecord>();
  #receiptSequence = 0;

  constructor(options: AgentApplicationCommandBridgeOptions) {
    if (!options?.runtime) throw new TypeError('Agent application command bridge requires a runtime');
    if (typeof options.compileProposal !== 'function') {
      throw new TypeError('Agent application command bridge requires compileProposal');
    }
    if (typeof options.projectResult !== 'function') {
      throw new TypeError('Agent application command bridge requires projectResult');
    }
    if (options.projectError !== undefined && typeof options.projectError !== 'function') {
      throw new TypeError('Agent application command bridge projectError must be a function');
    }
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#receiptIdFactory = options.receiptIdFactory
      ?? ((proposalId, sequence) => `command-receipt:${proposalId}:${sequence}`);
    this.#maxRetainedReceipts = boundedInteger(
      options.maxRetainedReceipts,
      500,
      10,
      10_000,
      'Agent application command bridge maxRetainedReceipts',
    );
  }

  executeProposal(
    value: ApplicationCommandProposal,
    options: { signal?: AbortSignal } = {},
  ): Promise<ApplicationCommandReceipt> {
    const proposal = normalizeProposal(value);
    const fingerprint = canonicalApplicationData(proposal as unknown as ApplicationData);
    const existing = this.#records.get(proposal.proposalId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new ApplicationCommandRuntimeError(
          'idempotency-conflict',
          `Application proposalId "${proposal.proposalId}" was reused with different content`,
        );
      }
      return existing.promise;
    }
    const signal = options.signal ?? new AbortController().signal;
    const record: ProposalRecord = {
      fingerprint,
      promise: Promise.resolve(undefined as never),
    };
    record.promise = this.#execute(proposal, signal).then(receipt => {
      record.receipt = receipt;
      this.#trimRecords();
      return cloneReceipt(receipt);
    });
    this.#records.set(proposal.proposalId, record);
    return record.promise;
  }

  getReceipts(): ApplicationCommandReceipt[] {
    return [...this.#records.values()]
      .flatMap(record => record.receipt ? [cloneReceipt(record.receipt)] : []);
  }

  async #execute(
    proposal: ApplicationCommandProposal,
    signal: AbortSignal,
  ): Promise<ApplicationCommandReceipt> {
    if (signal.aborted) {
      return this.#failureReceipt(
        proposal,
        undefined,
        signal.reason ?? new DOMException('Application command proposal was cancelled', 'AbortError'),
        'compile',
        true,
      );
    }
    let command: ApplicationCommand;
    try {
      command = normalizeCommand(await this.#options.compileProposal(proposal, signal));
    }
    catch (error) {
      return this.#failureReceipt(proposal, undefined, error, 'compile', signal.aborted);
    }

    let result: ApplicationData;
    try {
      result = await this.#options.runtime.execute(command, { signal });
    }
    catch (error) {
      return this.#failureReceipt(proposal, command, error, 'execute', signal.aborted);
    }

    try {
      const projected = cloneApplicationData(
        this.#options.projectResult(command, cloneApplicationData(result)),
        'Application command receipt result',
      );
      return {
        schemaVersion: 'desktop-char.application-command-receipt.v1',
        receiptId: this.#nextReceiptId(proposal.proposalId),
        proposalId: proposal.proposalId,
        commandId: command.commandId,
        type: proposal.type,
        status: 'succeeded',
        completedAtMs: this.#now(),
        result: projected,
      };
    }
    catch (error) {
      return this.#failureReceipt(proposal, command, error, 'project-result', signal.aborted);
    }
  }

  #failureReceipt(
    proposal: ApplicationCommandProposal,
    command: ApplicationCommand | undefined,
    error: unknown,
    phase: ApplicationCommandBridgePhase,
    signalAborted: boolean,
  ): ApplicationCommandReceipt {
    const status: ApplicationCommandReceiptStatus = signalAborted || isAbortError(error)
      ? 'cancelled'
      : phase === 'compile'
        ? 'rejected'
        : 'failed';
    const fact = normalizeErrorFact(
      this.#options.projectError?.(error, phase)
        ?? {
          code: signalAborted ? 'cancelled' : defaultErrorCode(error, phase),
          message: errorMessage(error),
        },
    );
    return {
      schemaVersion: 'desktop-char.application-command-receipt.v1',
      receiptId: this.#nextReceiptId(proposal.proposalId),
      proposalId: proposal.proposalId,
      ...(command ? { commandId: command.commandId } : {}),
      type: proposal.type,
      status,
      completedAtMs: this.#now(),
      error: fact,
    };
  }

  #nextReceiptId(proposalId: string): string {
    return nonEmpty(
      this.#receiptIdFactory(proposalId, ++this.#receiptSequence),
      'Application command receiptId',
    );
  }

  #trimRecords(): void {
    while (this.#records.size > this.#maxRetainedReceipts) {
      const oldest = this.#records.keys().next().value as string | undefined;
      if (oldest === undefined) return;
      const record = this.#records.get(oldest);
      if (!record?.receipt) return;
      this.#records.delete(oldest);
    }
  }
}

function normalizeProposal(value: ApplicationCommandProposal): ApplicationCommandProposal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApplicationCommandRuntimeError('invalid-input', 'Application proposal must be an object');
  }
  if (value.schemaVersion !== 'desktop-char.application-command-proposal.v1') {
    throw new ApplicationCommandRuntimeError(
      'invalid-input',
      'Application proposal schemaVersion is invalid',
    );
  }
  const confidence = value.confidence;
  if (confidence !== undefined && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)) {
    throw new ApplicationCommandRuntimeError(
      'invalid-input',
      'Application proposal confidence must be from 0 to 1',
    );
  }
  return {
    schemaVersion: value.schemaVersion,
    proposalId: nonEmpty(value.proposalId, 'Application proposal proposalId'),
    type: nonEmpty(value.type, 'Application proposal type'),
    parameters: cloneApplicationData(value.parameters, 'Application proposal parameters'),
    contextRevision: nonNegativeInteger(
      value.contextRevision,
      'Application proposal contextRevision',
    ),
    ...(confidence !== undefined ? { confidence } : {}),
    ...(value.targetReference
      ? {
          targetReference: {
            kind: nonEmpty(value.targetReference.kind, 'Application proposal target kind'),
            reference: nonEmpty(
              value.targetReference.reference,
              'Application proposal target reference',
            ),
          },
        }
      : {}),
  };
}

function normalizeErrorFact(value: ApplicationCommandBridgeErrorFact): ApplicationCommandBridgeErrorFact {
  if (!value || typeof value !== 'object') {
    throw new TypeError('Application command bridge error fact must be an object');
  }
  return {
    code: nonEmpty(value.code, 'Application command receipt error code').slice(0, 120),
    message: nonEmpty(value.message, 'Application command receipt error message').slice(-500),
  };
}

function defaultErrorCode(error: unknown, phase: ApplicationCommandBridgePhase): string {
  if (isAbortError(error)) return 'cancelled';
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return `${phase}-failed`;
}

function cloneReceipt(receipt: ApplicationCommandReceipt): ApplicationCommandReceipt {
  return {
    schemaVersion: receipt.schemaVersion,
    receiptId: receipt.receiptId,
    proposalId: receipt.proposalId,
    ...(receipt.commandId ? { commandId: receipt.commandId } : {}),
    type: receipt.type,
    status: receipt.status,
    completedAtMs: receipt.completedAtMs,
    ...(receipt.result !== undefined
      ? { result: cloneApplicationData(receipt.result) }
      : {}),
    ...(receipt.error ? { error: { ...receipt.error } } : {}),
  };
}
