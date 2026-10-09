import { LockMode } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import { ApplicationError } from '../../application/errors';
import type { FinancialSession, Identity, TransactionResult } from '../../application/ports';
import type { EventEnvelope } from '../../domain/events';
import type { LedgerEntry } from '../../domain/ledger-entry';
import type { WagerTransaction } from '../../domain/wager-transaction';
import type { Wallet } from '../../domain/wallet';
import { LedgerSchema, OutboxSchema, ResultSchema, TransactionSchema, WalletSchema } from './entities';
import { ledgerToRow, transactionToRow, walletFromRow, walletToRow } from './mappers';

export class PostgresFinancialSession implements FinancialSession {
  constructor(private readonly em: EntityManager) {}

  async reserve(identity: Identity): Promise<Identity | null> {
    const inserted = await this.em.execute<{ transaction_id: string }[]>(`
      insert into wager_identities (transaction_id, provider_id, external_transaction_id, idempotency_key, payload_hash)
      values (?, ?, ?, ?, ?) on conflict do nothing returning transaction_id`,
    [identity.transactionId, identity.providerId, identity.externalTransactionId, identity.idempotencyKey, identity.payloadHash]);
    if (inserted.length > 0) return null;
    const matches = await this.em.execute<Identity[]>(`
      select transaction_id as "transactionId", provider_id as "providerId", external_transaction_id as "externalTransactionId",
        idempotency_key as "idempotencyKey", payload_hash as "payloadHash"
      from wager_identities where provider_id = ? and (idempotency_key = ? or external_transaction_id = ?)
      order by (idempotency_key = ?) desc`,
    [identity.providerId, identity.idempotencyKey, identity.externalTransactionId, identity.idempotencyKey]);
    const existing = matches[0];
    if (!existing) throw new Error('Conflicting identity was not visible');
    return existing;
  }

  async result(transactionId: string): Promise<TransactionResult> {
    const row = await this.em.findOne(ResultSchema, { transactionId });
    if (!row) throw new Error('Committed identity has no terminal snapshot');
    return structuredClone(row.body);
  }

  async walletForUpdate(walletId: string): Promise<Wallet> {
    const row = await this.em.findOne(WalletSchema, { id: walletId }, { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true });
    if (!row) throw new ApplicationError('WALLET_NOT_FOUND');
    return walletFromRow(row);
  }

  async insertWallet(wallet: Wallet): Promise<void> {
    this.em.persist(this.em.create(WalletSchema, walletToRow(wallet)));
    await this.em.flush();
  }

  async saveWallet(wallet: Wallet): Promise<void> {
    const row = await this.em.findOneOrFail(WalletSchema, { id: wallet.id });
    const state = wallet.toState();
    row.balance = state.balance.amount;
    row.version = state.version;
    row.updatedAt = new Date(state.updatedAt);
    await this.em.flush();
  }

  async insertTransaction(transaction: WagerTransaction): Promise<void> {
    this.em.persist(this.em.create(TransactionSchema, transactionToRow(transaction)));
    await this.em.flush();
  }

  async appendLedger(entry: LedgerEntry): Promise<void> {
    this.em.persist(this.em.create(LedgerSchema, ledgerToRow(entry)));
    await this.em.flush();
  }

  async saveResult(body: TransactionResult): Promise<void> {
    this.em.persist(this.em.create(ResultSchema, { transactionId: body.transactionId, body: structuredClone(body) }));
    await this.em.flush();
  }

  async enqueue(payload: EventEnvelope): Promise<void> {
    this.em.persist(this.em.create(OutboxSchema, { id: payload.eventId, aggregateId: payload.aggregateId,
      eventType: payload.eventType, occurredAt: new Date(payload.occurredAt), payload: structuredClone(payload) }));
    await this.em.flush();
  }
}
