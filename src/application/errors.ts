export type ApplicationErrorCode =
  | 'WALLET_NOT_FOUND' | 'TRANSACTION_NOT_FOUND' | 'WALLET_ALREADY_EXISTS'
  | 'IDEMPOTENCY_CONFLICT' | 'EXTERNAL_ID_CONFLICT' | 'INBOX_CONFLICT' | 'INFRASTRUCTURE_UNAVAILABLE';

export class ApplicationError extends Error {
  constructor(public readonly code: ApplicationErrorCode) {
    super(code);
    this.name = 'ApplicationError';
  }
}
