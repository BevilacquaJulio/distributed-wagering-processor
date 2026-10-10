import { EntitySchema, Type } from '@mikro-orm/core';
import type { TransactionResult } from '../../application/ports';
import type { FailureCode } from '../../domain/errors';
import type { EventEnvelope } from '../../domain/events';
import type { TransactionKind, TransactionStatus, WagerCommand } from '../../domain/wager-transaction';

export class ExactDecimalType extends Type<string, string> {
  override convertToDatabaseValue(value: string): string {
    if (typeof value !== 'string' || !/^(0|[1-9]\d{0,17})\.\d{2}$/.test(value)) throw new Error('Expected exact decimal string');
    return value;
  }
  override convertToJSValue(value: string): string {
    if (typeof value !== 'string') throw new Error('PostgreSQL numeric must remain a string');
    return value;
  }
  override getColumnType(): string { return 'numeric(20,2)'; }
  override compareAsType(): string { return 'string'; }
}

export interface WalletRow {
  id: string; playerId: string; currency: string; balance: string; version: number; createdAt: Date; updatedAt: Date;
}
export interface TransactionRow {
  id: string; walletId: string; playerId: string; kind: TransactionKind; amount: string; currency: string;
  status: TransactionStatus; failureCode: FailureCode | null; command: WagerCommand | null; createdAt: Date; processedAt: Date | null;
}
export interface LedgerRow {
  id: string; walletId: string; transactionId: string; direction: 'CREDIT' | 'DEBIT'; amount: string; currency: string;
  balanceBefore: string; balanceAfter: string; createdAt: Date;
}
export interface ResultRow { transactionId: string; body: TransactionResult; }
export interface OutboxRow {
  id: string; aggregateId: string; eventType: string; payload: EventEnvelope; occurredAt: Date;
}

const uuid = { type: 'uuid' } as const;
const timestamp = { type: Date, columnType: 'timestamptz(3)' } as const;
const decimal = { type: ExactDecimalType } as const;

export const WalletSchema = new EntitySchema<WalletRow>({
  name: 'WalletRow', tableName: 'wallets', properties: {
    id: { ...uuid, primary: true }, playerId: uuid, currency: { type: 'string', length: 3 }, balance: decimal,
    version: { type: 'integer' }, createdAt: timestamp, updatedAt: timestamp,
  },
});
export const TransactionSchema = new EntitySchema<TransactionRow>({
  name: 'TransactionRow', tableName: 'wager_transactions', properties: {
    id: { ...uuid, primary: true }, walletId: uuid, playerId: uuid, kind: { type: 'string' }, amount: decimal,
    currency: { type: 'string', length: 3 }, status: { type: 'string' }, failureCode: { type: 'string', nullable: true },
    command: { type: 'json', nullable: true }, createdAt: timestamp, processedAt: { ...timestamp, nullable: true },
  },
});
export const LedgerSchema = new EntitySchema<LedgerRow>({
  name: 'LedgerRow', tableName: 'wallet_ledger', properties: {
    id: { ...uuid, primary: true }, walletId: uuid, transactionId: uuid, direction: { type: 'string' },
    amount: decimal, currency: { type: 'string', length: 3 }, balanceBefore: decimal, balanceAfter: decimal, createdAt: timestamp,
  },
});
export const ResultSchema = new EntitySchema<ResultRow>({
  name: 'ResultRow', tableName: 'transaction_results', properties: {
    transactionId: { ...uuid, primary: true }, body: { type: 'json' },
  },
});
export const OutboxSchema = new EntitySchema<OutboxRow>({
  name: 'OutboxRow', tableName: 'outbox_messages', properties: {
    id: { ...uuid, primary: true }, aggregateId: uuid, eventType: { type: 'string' },
    payload: { type: 'json' }, occurredAt: timestamp,
  },
});

export const entities = [WalletSchema, TransactionSchema, LedgerSchema, ResultSchema, OutboxSchema];
