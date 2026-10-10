import type { LedgerState } from './ledger-entry';
import type { TransactionState } from './wager-transaction';

export interface EventContext {
  readonly eventId: string;
  readonly correlationId: string;
  readonly occurredAt: string;
}

export interface EventEnvelope {
  readonly eventId: string;
  readonly eventType: string;
  readonly version: number;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly occurredAt: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export abstract class IntegrationEvent {
  abstract readonly eventType: string;
  readonly version = 1;
  protected constructor(
    private readonly context: EventContext,
    private readonly aggregateId: string,
    private readonly data: Readonly<Record<string, unknown>>,
  ) {
    this.context = structuredClone(context);
    this.data = structuredClone(data);
  }

  toJSON(): EventEnvelope {
    return structuredClone({ ...this.context, aggregateId: this.aggregateId, eventType: this.eventType, version: this.version, data: this.data });
  }
}

export class WagerTransactionProcessed extends IntegrationEvent {
  readonly eventType = 'WagerTransactionProcessed';
  static from(transaction: TransactionState, context: EventContext): WagerTransactionProcessed {
    return new WagerTransactionProcessed(context, transaction.walletId, { transaction: structuredClone(transaction) });
  }
}

export class WagerTransactionRejected extends IntegrationEvent {
  readonly eventType = 'WagerTransactionRejected';
  static from(transaction: TransactionState, context: EventContext): WagerTransactionRejected {
    return new WagerTransactionRejected(context, transaction.walletId, { transaction: structuredClone(transaction) });
  }
}

export class WagerTransactionPendingReference extends IntegrationEvent {
  readonly eventType = 'WagerTransactionPendingReference';
  static from(transaction: TransactionState, context: EventContext): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference(context, transaction.walletId, { transaction: structuredClone(transaction) });
  }
}

export class WalletBalanceChanged extends IntegrationEvent {
  readonly eventType = 'WalletBalanceChanged';
  static from(entry: LedgerState, walletVersion: number, context: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged(context, entry.walletId, { ...structuredClone(entry), walletVersion });
  }
}
