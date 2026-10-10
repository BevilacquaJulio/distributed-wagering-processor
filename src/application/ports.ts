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

export interface FinancialSession {
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
}

export interface ProviderIdentityPort {
  assertProvider(providerId: string): Promise<void>;
}
