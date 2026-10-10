import type { FailureCode } from '../domain/errors';
import type { EventEnvelope } from '../domain/events';
import type { LedgerEntry, LedgerState } from '../domain/ledger-entry';
import type { MoneyProps } from '../domain/money';
import type { SubmittedKind, WagerTransaction, TransactionState } from '../domain/wager-transaction';
import type { Wallet, WalletState } from '../domain/wallet';

export interface TransactionResult {
  readonly transactionId: string;
  readonly status: 'PROCESSED' | 'REJECTED' | 'PENDING_REFERENCE';
  readonly balance: MoneyProps;
  readonly failureCode?: FailureCode;
  readonly idempotentReplay: boolean;
}

export interface Identity {
  readonly transactionId: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
}

/** Identidade da entrega na fila; a deduplicação é por consumidor e messageId do envelope. */
export interface InboxDelivery {
  readonly consumerName: string;
  readonly messageId: string;
  readonly payloadHash: string;
}

export interface InboxRecord {
  readonly payloadHash: string;
  readonly transactionId: string | null;
}

export interface FinancialSession {
  /** Grava a entrega; devolve o registro anterior quando a mensagem já foi recebida. */
  receiveInbox(delivery: InboxDelivery, at: string): Promise<InboxRecord | null>;
  completeInbox(delivery: InboxDelivery, transactionId: string, at: string): Promise<void>;
  reserve(identity: Identity): Promise<Identity | null>;
  result(transactionId: string): Promise<TransactionResult>;
  walletForUpdate(walletId: string): Promise<Wallet>;
  insertWallet(wallet: Wallet): Promise<void>;
  saveWallet(wallet: Wallet): Promise<void>;
  insertTransaction(transaction: WagerTransaction): Promise<void>;
  appendLedger(entry: LedgerEntry): Promise<void>;
  saveResult(result: TransactionResult): Promise<void>;
  /** Snapshot do aceite pendente; o resultado terminal é gravado separadamente quando a referência for resolvida. */
  saveAcceptance(result: TransactionResult): Promise<void>;
  enqueue(event: EventEnvelope): Promise<void>;
  findReference(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
  hasProcessedReversal(referenceTransactionId: string, kind: SubmittedKind): Promise<boolean>;
  linkReference(transactionId: string, referenceTransactionId: string, kind: SubmittedKind): Promise<void>;
  schedulePendingReference(transactionId: string, nextAttemptAt: string, deadlineAt: string): Promise<void>;
  /** Trava a agenda sob o lock da wallet; null quando o claim deixou de ser deste worker ou já foi resolvida. */
  lockPendingReference(transactionId: string, claimToken: string): Promise<PendingSchedule | null>;
  pendingTransaction(transactionId: string): Promise<WagerTransaction>;
  /** Grava a transição de uma transação já persistida (PENDING_REFERENCE para terminal). */
  saveTransaction(transaction: WagerTransaction): Promise<void>;
  reschedulePendingReference(transactionId: string, attempts: number, nextAttemptAt: string): Promise<void>;
  resolvePendingReference(transactionId: string, attempts: number, at: string): Promise<void>;
  /** Antecipa as operações que esperam por esta identidade, para o worker reavaliá-las sem aguardar o backoff. */
  wakeDependents(providerId: string, externalTransactionId: string, at: string): Promise<void>;
}

export interface PendingSchedule {
  readonly attempts: number;
  readonly deadlineAt: string;
}

export interface PendingReferenceClaim {
  readonly transactionId: string;
  readonly walletId: string;
}

/** Claim durável da agenda de referências, no mesmo padrão da outbox: token e lease, sem transação aberta. */
export interface PendingReferenceStore {
  claim(token: string, now: string, leaseUntil: string, limit: number): Promise<PendingReferenceClaim[]>;
}

export interface ClaimedEvent {
  readonly envelope: EventEnvelope;
  /** Inclui a tentativa atual. */
  readonly attempts: number;
}

/** Claim durável da outbox: o token comprova a posse até o fim da lease, fora de qualquer transação aberta. */
export interface OutboxStore {
  claim(token: string, now: string, leaseUntil: string, limit: number): Promise<ClaimedEvent[]>;
  /** Devolve os eventos confirmados; os ausentes foram reivindicados por outro publisher depois da lease. */
  markPublished(token: string, eventIds: readonly string[], at: string): Promise<string[]>;
  markFailed(token: string, eventId: string, nextAttemptAt: string, error: string): Promise<boolean>;
}

export interface FinancialUnitOfWork {
  run<T>(work: (session: FinancialSession) => Promise<T>): Promise<T>;
}

export interface Clock { now(): string; }
export interface IdGenerator { next(): string; }
export interface PayloadHasher { hash(value: unknown): string; }

export interface LedgerCursor { readonly at: string; readonly id: string; }
export interface LedgerPage { readonly entries: readonly LedgerState[]; readonly next: LedgerCursor | null; }

export interface Reconciliation {
  readonly walletId: string;
  readonly storedBalance: MoneyProps;
  readonly calculatedBalance: MoneyProps;
  readonly difference: MoneyProps;
  readonly consistent: boolean;
  readonly checkedEntries: number;
}

export interface TransactionView extends TransactionState {
  /** Resposta persistida: terminal quando existir, senão o aceite pendente. */
  readonly result: TransactionResult | null;
}

export interface FinancialQueries {
  wallet(id: string): Promise<WalletState>;
  transaction(id: string): Promise<TransactionView>;
  transactionByExternal(providerId: string, externalTransactionId: string): Promise<TransactionView>;
  ledger(walletId: string, limit: number, cursor?: LedgerCursor): Promise<LedgerPage>;
  reconcile(walletId: string): Promise<Reconciliation>;
  backlog(): Promise<Backlog>;
}

/** Pendências operacionais lidas do banco no momento da coleta de métricas. */
export interface Backlog {
  readonly outboxPending: number;
  readonly outboxOldestPendingSeconds: number;
  readonly pendingReferencesOpen: number;
  readonly pendingReferencesOldestSeconds: number;
  /** Abertas com prazo vencido: o worker está parado ou atrasado. */
  readonly pendingReferencesOverdue: number;
}

export interface ProviderIdentityPort {
  assertProvider(providerId: string): Promise<void>;
}
