export type ApplicationData =
  | null
  | boolean
  | number
  | string
  | ApplicationData[]
  | { [key: string]: ApplicationData };

export type ApplicationAccessMode = 'read' | 'write';

export interface ApplicationAccessClaim {
  resource: string;
  mode: ApplicationAccessMode;
}

export interface ApplicationTarget {
  kind: string;
  id: string;
  expectedRevision?: string;
}

export interface ApplicationQuery {
  schemaVersion: 'desktop-char.application-query.v1';
  type: string;
  parameters: ApplicationData;
  contextRevision: number;
  target?: ApplicationTarget;
}

export interface ApplicationCommand {
  schemaVersion: 'desktop-char.application-command.v1';
  commandId: string;
  type: string;
  parameters: ApplicationData;
  contextRevision: number;
  target?: ApplicationTarget;
}

export interface ApplicationQueryExecutionContext<TParameters extends ApplicationData = ApplicationData> {
  query: Readonly<ApplicationQuery>;
  parameters: Readonly<TParameters>;
  signal: AbortSignal;
}

export interface ApplicationCommandExecutionContext<
  TParameters extends ApplicationData = ApplicationData,
> {
  command: Readonly<ApplicationCommand>;
  parameters: Readonly<TParameters>;
  signal: AbortSignal;
}

export interface ApplicationQueryDefinition<
  TParameters extends ApplicationData = ApplicationData,
  TResult extends ApplicationData = ApplicationData,
> {
  type: string;
  validateParameters(value: ApplicationData): TParameters;
  access?(query: Readonly<ApplicationQuery>, parameters: Readonly<TParameters>): readonly ApplicationAccessClaim[];
  execute(context: ApplicationQueryExecutionContext<TParameters>): TResult | Promise<TResult>;
}

export interface ApplicationCommandDefinition<
  TParameters extends ApplicationData = ApplicationData,
  TResult extends ApplicationData = ApplicationData,
> {
  type: string;
  validateParameters(value: ApplicationData): TParameters;
  access?(
    command: Readonly<ApplicationCommand>,
    parameters: Readonly<TParameters>,
  ): readonly ApplicationAccessClaim[];
  execute(context: ApplicationCommandExecutionContext<TParameters>): TResult | Promise<TResult>;
}

export type ApplicationExecutionState =
  | 'queued'
  | 'executing'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export interface ApplicationCommandExecutionSnapshot {
  commandId: string;
  type: string;
  state: ApplicationExecutionState;
  createdAtMs: number;
  startedAtMs?: number;
  completedAtMs?: number;
  error?: string;
}

export interface ApplicationCommandRuntimeSnapshot {
  queuedCount: number;
  executingCount: number;
  retainedCount: number;
  executions: ApplicationCommandExecutionSnapshot[];
}

export interface ApplicationQueryRuntimeSnapshot {
  queuedCount: number;
  executingCount: number;
}

export interface ApplicationAccessSchedulerSnapshot {
  queuedCount: number;
  activeCount: number;
  activeClaims: ApplicationAccessClaim[][];
}

export interface ApplicationCommandProposal {
  schemaVersion: 'desktop-char.application-command-proposal.v1';
  proposalId: string;
  type: string;
  parameters: ApplicationData;
  contextRevision: number;
  confidence?: number;
  targetReference?: {
    kind: string;
    reference: string;
  };
}

export type ApplicationCommandReceiptStatus =
  | 'succeeded'
  | 'rejected'
  | 'failed'
  | 'cancelled';

export interface ApplicationCommandReceipt {
  schemaVersion: 'desktop-char.application-command-receipt.v1';
  receiptId: string;
  proposalId: string;
  type: string;
  status: ApplicationCommandReceiptStatus;
  completedAtMs: number;
  commandId?: string;
  result?: ApplicationData;
  error?: {
    code: string;
    message: string;
  };
}

export interface ApplicationCommandBridgeErrorFact {
  code: string;
  message: string;
}
