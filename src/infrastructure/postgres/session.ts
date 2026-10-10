import { LockMode } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import { ApplicationError } from '../../application/errors';
import type { FinancialSession, Identity, InboxDelivery, InboxRecord, PendingSchedule, TransactionResult } from '../../application/ports';
import type { EventEnvelope } from '../../domain/events';
import type { LedgerEntry } from '../../domain/ledger-entry';
import type { SubmittedKind, WagerTransaction } from '../../domain/wager-transaction';
import type { Wallet } from '../../domain/wallet';
import { LedgerSchema, OutboxSchema, ResultSchema, TransactionSchema, WalletSchema } from './entities';
import { ledgerToRow, transactionFromRow, transactionToRow, walletFromRow, walletToRow } from './mappers';

export class PostgresFinancialSession implements FinancialSession {
  constructor(private readonly em: EntityManager) {}

  async receiveInbox(delivery: InboxDelivery, at: string): Promise<InboxRecord | null> {
    const inserted = await this.em.execute<{ message_id: string }[]>(`
      insert into inbox_messages (consumer_name, message_id, payload_hash, received_at) values (?, ?, ?, ?)
      on conflict do nothing returning message_id`, [delivery.consumerName, delivery.messageId, delivery.payloadHash, at]);
    if (inserted.length > 0) return null;
    const rows = await this.em.execute<InboxRecord[]>(`
      select payload_hash as "payloadHash", transaction_id as "transactionId"
      from inbox_messages where consumer_name = ? and message_id = ?`, [delivery.consumerName, delivery.messageId]);
    const existing = rows[0];
    if (!existing) throw new Error('Conflicting inbox message was not visible');
    return existing;
  }

  async completeInbox(delivery: InboxDelivery, transactionId: string, at: string): Promise<void> {
    await this.em.execute('update inbox_messages set transaction_id = ?, processed_at = ? where consumer_name = ? and message_id = ?',
      [transactionId, at, delivery.consumerName, delivery.messageId]);
  }

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

  async lockPendingReference(transactionId: string, claimToken: string): Promise<PendingSchedule | null> {
    const rows = await this.em.execute<{ attempts: number; deadlineAt: Date }[]>(`
      select attempts, deadline_at as "deadlineAt" from pending_references
      where transaction_id = ? and claim_token = ? and resolved_at is null for update`, [transactionId, claimToken]);
    const row = rows[0];
    return row ? { attempts: row.attempts, deadlineAt: new Date(row.deadlineAt).toISOString() } : null;
  }

  async pendingTransaction(transactionId: string): Promise<WagerTransaction> {
    const row = await this.em.findOneOrFail(TransactionSchema, { id: transactionId }, { refresh: true });
    return transactionFromRow(row);
  }

  async saveTransaction(transaction: WagerTransaction): Promise<void> {
    const state = transaction.toState();
    const rows = await this.em.execute<{ id: string }[]>(`
      update wager_transactions set status = ?, failure_code = ?, processed_at = ?
      where id = ? and status = 'PENDING_REFERENCE' returning id`, [state.status, state.failureCode, state.processedAt, state.id]);
    if (rows.length !== 1) throw new Error('Pending transaction changed outside the wallet lock');
  }

  async reschedulePendingReference(transactionId: string, attempts: number, nextAttemptAt: string): Promise<void> {
    await this.em.execute(`
      update pending_references set attempts = ?, next_attempt_at = ?, claim_token = null, lease_until = null
      where transaction_id = ?`, [attempts, nextAttemptAt, transactionId]);
  }

  async resolvePendingReference(transactionId: string, attempts: number, at: string): Promise<void> {
    await this.em.execute(`
      update pending_references set attempts = ?, resolved_at = ?, claim_token = null, lease_until = null
      where transaction_id = ?`, [attempts, at, transactionId]);
  }

  async wakeDependents(providerId: string, externalTransactionId: string, at: string): Promise<void> {
    await this.em.execute(`
      update pending_references p set next_attempt_at = ?
      from wager_transactions t
      where t.id = p.transaction_id and t.status = 'PENDING_REFERENCE'
        and (t.command->>'providerId') = ? and (t.command->>'referenceExternalTransactionId') = ?
        and p.resolved_at is null and p.next_attempt_at > ?`, [at, providerId, externalTransactionId, at]);
  }

  async enqueue(payload: EventEnvelope): Promise<void> {
    this.em.persist(this.em.create(OutboxSchema, { id: payload.eventId, aggregateId: payload.aggregateId,
      eventType: payload.eventType, occurredAt: new Date(payload.occurredAt), payload: structuredClone(payload) }));
    await this.em.flush();
  }
}
