import { LockMode } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import { ApplicationError } from '../../application/errors';
import type { FinancialSession, Identity, TransactionResult } from '../../application/ports';
import type { EventEnvelope } from '../../domain/events';
import type { LedgerEntry } from '../../domain/ledger-entry';
import type { SubmittedKind, WagerTransaction } from '../../domain/wager-transaction';
import type { Wallet } from '../../domain/wallet';
import { LedgerSchema, OutboxSchema, ResultSchema, TransactionSchema, WalletSchema } from './entities';
import { ledgerToRow, transactionFromRow, transactionToRow, walletFromRow, walletToRow } from './mappers';

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

  // Replay devolve o resultado terminal quando existir; enquanto pendente, o aceite persistido.
  async result(transactionId: string): Promise<TransactionResult> {
    const row = await this.em.findOne(ResultSchema, { transactionId });
    if (row) return structuredClone(row.body);
    const accepted = await this.em.execute<{ body: TransactionResult }[]>(
      'select body from transaction_acceptances where transaction_id = ?', [transactionId]);
    const acceptance = accepted[0];
    if (!acceptance) throw new Error('Committed identity has no persisted result');
    return structuredClone(acceptance.body);
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

  async saveAcceptance(body: TransactionResult): Promise<void> {
    await this.em.execute('insert into transaction_acceptances (transaction_id, body) values (?, ?)',
      [body.transactionId, JSON.stringify(body)]);
  }

  async findReference(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined> {
    const rows = await this.em.execute<{ id: string }[]>(
      'select transaction_id as id from wager_identities where provider_id = ? and external_transaction_id = ?',
      [providerId, externalTransactionId]);
    const id = rows[0]?.id;
    if (!id) return undefined;
    const row = await this.em.findOne(TransactionSchema, { id }, { refresh: true });
    return row ? transactionFromRow(row) : undefined;
  }

  async hasProcessedReversal(referenceTransactionId: string, kind: SubmittedKind): Promise<boolean> {
    const rows = await this.em.execute<{ found: number }[]>(
      'select 1 as found from wager_references where reference_transaction_id = ? and kind = ?', [referenceTransactionId, kind]);
    return rows.length > 0;
  }

  async linkReference(transactionId: string, referenceTransactionId: string, kind: SubmittedKind): Promise<void> {
    await this.em.execute('insert into wager_references (transaction_id, reference_transaction_id, kind) values (?, ?, ?)',
      [transactionId, referenceTransactionId, kind]);
  }

  async schedulePendingReference(transactionId: string, nextAttemptAt: string, deadlineAt: string): Promise<void> {
    await this.em.execute('insert into pending_references (transaction_id, next_attempt_at, deadline_at) values (?, ?, ?)',
      [transactionId, nextAttemptAt, deadlineAt]);
  }

  async enqueue(payload: EventEnvelope): Promise<void> {
    this.em.persist(this.em.create(OutboxSchema, { id: payload.eventId, aggregateId: payload.aggregateId,
      eventType: payload.eventType, occurredAt: new Date(payload.occurredAt), payload: structuredClone(payload) }));
    await this.em.flush();
  }
}
