import { DomainError, type FailureCode } from './errors';
import type { LedgerDirection } from './ledger-entry';
import { Money, type MoneyProps } from './money';

export type SubmittedKind = 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';
export type TransactionKind = 'OPENING' | SubmittedKind;
export type TransactionStatus = 'PENDING' | 'PENDING_REFERENCE' | 'PROCESSED' | 'REJECTED' | 'FAILED';

export interface WagerCommand {
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: SubmittedKind;
  readonly money: MoneyProps;
  /** ID no provedor da transação referenciada, nunca o ID interno. */
  readonly referenceExternalTransactionId?: string | undefined;
}

export interface TransactionState {
  readonly id: string;
  readonly kind: TransactionKind;
  readonly walletId: string;
  readonly playerId: string;
  readonly money: MoneyProps;
  readonly status: TransactionStatus;
  readonly failureCode: FailureCode | null;
  readonly createdAt: string;
  readonly processedAt: string | null;
  readonly command: WagerCommand | null;
  readonly referenceTransactionId: string | null;
}

export type ReferenceDecision =
  | { readonly outcome: 'apply'; readonly direction: LedgerDirection | null; readonly referenceTransactionId: string | null }
  | { readonly outcome: 'pending' }
  | { readonly outcome: 'reject'; readonly code: FailureCode };

const TERMINAL: readonly TransactionStatus[] = ['PROCESSED', 'REJECTED', 'FAILED'];
const REFERENCEABLE: Record<SubmittedKind, readonly TransactionKind[]> = {
  BET: [], LOSS: [], WIN: ['BET'], REFUND: ['BET'], ROLLBACK: ['BET', 'WIN', 'REFUND'],
};
const OWN_DIRECTION: Record<TransactionKind, LedgerDirection | null> = {
  OPENING: 'CREDIT', BET: 'DEBIT', WIN: 'CREDIT', REFUND: 'CREDIT', LOSS: null, ROLLBACK: null,
};

/*
 * Transições: PENDING → PROCESSED | REJECTED | PENDING_REFERENCE; PENDING_REFERENCE → PROCESSED | REJECTED.
 * PROCESSED, REJECTED e FAILED são terminais.
 */
export class WagerTransaction {
  private constructor(private state: TransactionState) {}

  static submit(id: string, command: WagerCommand, at: string): WagerTransaction {
    const reference = command.referenceExternalTransactionId;
    if (REFERENCEABLE[command.kind].length === 0 && reference !== undefined) throw new Error(`${command.kind} does not accept a reference`);
    if ((command.kind === 'REFUND' || command.kind === 'ROLLBACK') && reference === undefined) throw new Error(`${command.kind} requires a reference`);
    return new WagerTransaction({
      id, kind: command.kind, walletId: command.walletId, playerId: command.playerId,
      money: structuredClone(command.money), status: 'PENDING', failureCode: null,
      createdAt: at, processedAt: null, command: structuredClone(command), referenceTransactionId: null,
    });
  }

  static opening(id: string, walletId: string, playerId: string, money: MoneyProps, at: string): WagerTransaction {
    const transaction = new WagerTransaction({
      id, kind: 'OPENING', walletId, playerId, money: structuredClone(money),
      status: 'PENDING', failureCode: null, createdAt: at, processedAt: null, command: null, referenceTransactionId: null,
    });
    transaction.markProcessed(at, null);
    return transaction;
  }

  static rehydrate(state: TransactionState): WagerTransaction {
    return new WagerTransaction(structuredClone(state));
  }

  get id(): string { return this.state.id; }
  get kind(): TransactionKind { return this.state.kind; }
  get status(): TransactionStatus { return this.state.status; }
  get money(): Money { return Money.from(this.state.money); }

  isTerminal(): boolean { return TERMINAL.includes(this.state.status); }
  isReversal(): boolean { return this.state.kind === 'REFUND' || this.state.kind === 'ROLLBACK'; }
  affectsBalance(): boolean { return this.state.kind !== 'LOSS'; }

  /** Reversão sem saldo é situação operacional distinta da aposta sem saldo. */
  insufficientFundsCode(): FailureCode {
    return this.isReversal() ? 'REVERSAL_INSUFFICIENT_FUNDS' : 'INSUFFICIENT_FUNDS';
  }

  /** LOSS só registra resultado e exige 0.00; demais operações exigem valor positivo. */
  assertAmountAllowed(): void {
    const money = this.money;
    if (this.affectsBalance() ? !money.isPositive() : !money.isZero()) throw new DomainError('AMOUNT_NOT_ALLOWED');
  }

  /** Referência a ser procurada no provedor; a autorreferência é decidida sem consulta. */
  referenceToResolve(): string | undefined {
    const reference = this.state.command?.referenceExternalTransactionId;
    return reference === this.state.command?.externalTransactionId ? undefined : reference;
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection | null {
    if (this.state.kind !== 'ROLLBACK') return OWN_DIRECTION[this.state.kind];
    if (!reference) throw new Error('ROLLBACK direction depends on its reference');
    return reference.ledgerDirectionFor() === 'DEBIT' ? 'CREDIT' : 'DEBIT';
  }

  evaluateReference(reference: WagerTransaction | undefined, alreadyReversed: boolean): ReferenceDecision {
    const command = this.state.command;
    if (!command) throw new Error('Only submitted transactions resolve references');
    if (command.referenceExternalTransactionId === undefined) {
      return { outcome: 'apply', direction: this.ledgerDirectionFor(), referenceTransactionId: null };
    }
    if (command.referenceExternalTransactionId === command.externalTransactionId) return { outcome: 'reject', code: 'INVALID_REFERENCE' };
    if (!reference || !reference.isTerminal()) return { outcome: 'pending' };
    if (reference.status !== 'PROCESSED') return { outcome: 'reject', code: 'REFERENCE_NOT_PROCESSED' };
    const target = reference.state;
    if (!REFERENCEABLE[command.kind].includes(target.kind) || target.playerId !== this.state.playerId
      || target.walletId !== this.state.walletId || target.money.currency !== this.state.money.currency
      || target.command?.roundId !== command.roundId) {
      return { outcome: 'reject', code: 'REFERENCE_MISMATCH' };
    }
    if (this.isReversal() && !reference.money.equals(this.money)) return { outcome: 'reject', code: 'REFERENCE_AMOUNT_MISMATCH' };
    if (this.isReversal() && alreadyReversed) return { outcome: 'reject', code: 'REFERENCE_ALREADY_REVERSED' };
    return { outcome: 'apply', direction: this.ledgerDirectionFor(reference), referenceTransactionId: target.id };
  }

  markProcessed(at: string, referenceTransactionId: string | null): void {
    this.assertOpen();
    this.state = { ...this.state, status: 'PROCESSED', processedAt: at, referenceTransactionId };
  }

  markPendingReference(): void {
    if (this.state.status !== 'PENDING') throw new Error('Only a new transaction can wait for its reference');
    this.state = { ...this.state, status: 'PENDING_REFERENCE' };
  }

  reject(code: FailureCode, at: string): void {
    this.assertOpen();
    this.state = { ...this.state, status: 'REJECTED', failureCode: code, processedAt: at };
  }

  toState(): TransactionState { return structuredClone(this.state); }

  private assertOpen(): void {
    if (this.isTerminal()) throw new Error('Terminal transaction is immutable');
  }
}
