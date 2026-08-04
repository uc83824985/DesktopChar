export type ApplicationCommandRuntimeErrorCode =
  | 'invalid-input'
  | 'unknown-definition'
  | 'duplicate-definition'
  | 'idempotency-conflict';

export class ApplicationCommandRuntimeError extends Error {
  readonly code: ApplicationCommandRuntimeErrorCode;

  constructor(
    code: ApplicationCommandRuntimeErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ApplicationCommandRuntimeError';
    this.code = code;
  }
}
