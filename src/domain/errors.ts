export type FailureCode =
  | 'INSUFFICIENT_FUNDS'
  | 'CURRENCY_MISMATCH'
  | 'CURRENCY_NOT_SUPPORTED'
  | 'WALLET_PLAYER_MISMATCH'
  | 'AMOUNT_NOT_ALLOWED'
  | 'BALANCE_LIMIT_EXCEEDED';

export class DomainError extends Error {
  constructor(public readonly code: FailureCode) {
    super(code);
    this.name = 'DomainError';
  }
}

export class InvalidMoneyError extends Error {
  constructor() {
    super('Invalid canonical monetary value');
    this.name = 'InvalidMoneyError';
  }
}
