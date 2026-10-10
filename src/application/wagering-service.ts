import { randomInt } from 'node:crypto';
import { DomainError } from '../domain/errors';
import { WalletBalanceChanged, WagerTransactionPendingReference, WagerTransactionProcessed, WagerTransactionRejected } from '../domain/events';
import { Money, type MoneyProps } from '../domain/money';
import type { LedgerEntry } from '../domain/ledger-entry';
import { type WagerCommand, WagerTransaction } from '../domain/wager-transaction';
import { Wallet, type WalletState } from '../domain/wallet';
import { ApplicationError } from './errors';
import type { Clock, FinancialSession, FinancialUnitOfWork, IdGenerator, InboxDelivery, PayloadHasher, PendingReferenceClaim,
  ProviderIdentityPort, TransactionResult } from './ports';

/** Política de espera por referência (D07): primeira reavaliação em 1s, backoff até 5min e expiração em 24h a partir do aceite. */
export interface PendingReferencePolicy {
  readonly firstRetryDelayMs: number;
  readonly maxRetryDelayMs: number;
  readonly ttlMs: number;
}

export const DEFAULT_PENDING_POLICY: PendingReferencePolicy = { firstRetryDelayMs: 1000, maxRetryDelayMs: 5 * 60 * 1000, ttlMs: 24 * 60 * 60 * 1000 };

/** skipped: outro worker assumiu o claim ou a agenda já foi resolvida; nada foi alterado. */
export type ResolutionOutcome = 'processed' | 'rejected' | 'expired' | 'pending' | 'skipped';

/** Espera após a n-ésima reavaliação sem referência: dobra a partir da primeira espera, sem passar do máximo. */
export function referenceRetryDelayMs(attempts: number, policy: PendingReferencePolicy): number {
  return Math.min(policy.maxRetryDelayMs, policy.firstRetryDelayMs * 2 ** attempts);
}

function later(at: string, milliseconds: number): string {
  return new Date(Date.parse(at) + milliseconds).toISOString();
}

export class WageringService {
  constructor(
    private readonly unitOfWork: FinancialUnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly hasher: PayloadHasher,
    private readonly identity: ProviderIdentityPort,
    private readonly pendingPolicy: PendingReferencePolicy = DEFAULT_PENDING_POLICY,
  ) {}

  async openWallet(playerId: string, initialBalance: MoneyProps, correlationId: string): Promise<WalletState> {
    const balance = Money.from(initialBalance);
    const walletId = this.ids.next();
    return this.unitOfWork.run(async (session) => {
      const at = this.clock.now();
      const wallet = Wallet.open(walletId, playerId, balance, at);
      await session.insertWallet(wallet);
      if (balance.isPositive()) {
        const transactionId = this.ids.next();
        const transaction = WagerTransaction.opening(transactionId, walletId, playerId, balance.toJSON(), at);
        const entry = wallet.openingEntry(this.ids.next(), transactionId);
        if (!entry) throw new Error('Positive opening requires a ledger entry');
        await session.insertTransaction(transaction);
        await session.appendLedger(entry);
        await session.saveResult({ transactionId, status: 'PROCESSED', balance: balance.toJSON(), idempotentReplay: false });
        await session.enqueue(WagerTransactionProcessed.from(transaction.toState(), this.eventContext(correlationId, at)).toJSON());
        await session.enqueue(WalletBalanceChanged.from(entry.toState(), wallet.version, this.eventContext(correlationId, at)).toJSON());
      }
      return wallet.toState();
    });
  }

  /** HTTP e fila usam este mesmo caso de uso; a fila acrescenta a inbox à mesma transação SQL. */
  async submit(input: WagerCommand, idempotencyKey: string, correlationId: string, inbox?: InboxDelivery): Promise<TransactionResult> {
    const command = structuredClone(input);
    await this.identity.assertProvider(command.providerId);
    Money.from(command.money);
    const transactionId = this.ids.next();
    const payloadHash = this.hasher.hash(command);

    return this.unitOfWork.run(async (session) => {
      if (!inbox) return this.process(session, command, idempotencyKey, transactionId, payloadHash, correlationId);
      const received = await session.receiveInbox(inbox, this.clock.now());
      if (received) {
        if (received.payloadHash !== inbox.payloadHash) throw new ApplicationError('INBOX_CONFLICT');
        if (!received.transactionId) throw new Error('Confirmed inbox message without transaction');
        return { ...await session.result(received.transactionId), idempotentReplay: true };
      }
      const result = await this.process(session, command, idempotencyKey, transactionId, payloadHash, correlationId);
      await session.completeInbox(inbox, result.transactionId, this.clock.now());
      return result;
    });
  }

  private async process(session: FinancialSession, command: WagerCommand, idempotencyKey: string, transactionId: string,
    payloadHash: string, correlationId: string): Promise<TransactionResult> {
    const existing = await session.reserve({ transactionId, providerId: command.providerId,
      externalTransactionId: command.externalTransactionId, idempotencyKey, payloadHash });
    if (existing) {
      if (existing.idempotencyKey !== idempotencyKey) throw new ApplicationError('EXTERNAL_ID_CONFLICT');
      if (existing.payloadHash !== payloadHash || existing.externalTransactionId !== command.externalTransactionId) {
        throw new ApplicationError('IDEMPOTENCY_CONFLICT');
      }
      return { ...await session.result(existing.transactionId), idempotentReplay: true };
    }

    // A referência pertence à mesma wallet; o lock da wallet também protege a leitura dela.
    const wallet = await session.walletForUpdate(command.walletId);
    const at = this.clock.now();
    const transaction = WagerTransaction.submit(transactionId, command, at);
    const entry = await this.decide(session, transaction, wallet, at);
    await session.insertTransaction(transaction);

    if (transaction.status === 'PENDING_REFERENCE') return this.persistPending(session, transaction, wallet, correlationId, at);
    return this.finish(session, transaction, wallet, entry, correlationId, at);
  }

  /**
   * Reavalia uma operação PENDING_REFERENCE com a mesma decisão do envio original, sob o lock da wallet.
   * Ainda sem referência: reagenda sem novo evento. Prazo vencido: REJECTED com REFERENCE_EXPIRED.
   */
  async resolvePending(claim: PendingReferenceClaim, claimToken: string): Promise<ResolutionOutcome> {
    return this.unitOfWork.run(async (session) => {
      const wallet = await session.walletForUpdate(claim.walletId);
      const schedule = await session.lockPendingReference(claim.transactionId, claimToken);
      if (!schedule) return 'skipped';
      const transaction = await session.pendingTransaction(claim.transactionId);
      if (transaction.status !== 'PENDING_REFERENCE') throw new Error('Unresolved schedule without a pending transaction');
      const at = this.clock.now();
      const attempts = schedule.attempts + 1;
      const entry = await this.decide(session, transaction, wallet, at);
      if (transaction.status === 'PENDING_REFERENCE') {
        if (Date.parse(at) < Date.parse(schedule.deadlineAt)) {
          await session.reschedulePendingReference(transaction.id, attempts, this.nextAttempt(at, attempts, schedule.deadlineAt));
          return 'pending';
        }
        transaction.reject('REFERENCE_EXPIRED', at);
      }
      await session.saveTransaction(transaction);
      // Sem a requisição original, os eventos da resolução são correlacionados pelo ID da própria transação.
      const result = await this.finish(session, transaction, wallet, entry, transaction.id, at);
      await session.resolvePendingReference(transaction.id, attempts, at);
      if (result.status === 'PROCESSED') return 'processed';
      return result.failureCode === 'REFERENCE_EXPIRED' ? 'expired' : 'rejected';
    });
  }

  // Trecho comum ao envio e à resolução: vínculo, saldo, ledger, resultado terminal e eventos na mesma unidade.
  private async finish(session: FinancialSession, transaction: WagerTransaction, wallet: Wallet, entry: LedgerEntry | undefined,
    correlationId: string, at: string): Promise<TransactionResult> {
    const state = transaction.toState();
    const command = state.command;
    if (!command) throw new Error('Submitted transaction without command');
    if (state.referenceTransactionId) await session.linkReference(state.id, state.referenceTransactionId, command.kind);
    if (entry) {
      await session.saveWallet(wallet);
      await session.appendLedger(entry);
      await session.enqueue(WalletBalanceChanged.from(entry.toState(), wallet.version, this.eventContext(correlationId, at)).toJSON());
    }
    const result = await this.persistTerminal(session, transaction, wallet, correlationId, at);
    await session.wakeDependents(command.providerId, command.externalTransactionId, at);
    return result;
  }

  private nextAttempt(at: string, attempts: number, deadlineAt: string): string {
    const delay = referenceRetryDelayMs(attempts, this.pendingPolicy) + randomInt(0, this.pendingPolicy.firstRetryDelayMs);
    return new Date(Math.min(Date.parse(at) + delay, Date.parse(deadlineAt))).toISOString();
  }

  // Aplica uma única transição sob o lock da wallet; regras violadas viram rejeição persistida, não exceção.
  private async decide(session: FinancialSession, transaction: WagerTransaction, wallet: Wallet, at: string): Promise<LedgerEntry | undefined> {
    const state = transaction.toState();
    const command = state.command;
    if (!command) throw new Error('Submitted transaction without command');
    try {
      if (command.playerId !== wallet.playerId) throw new DomainError('WALLET_PLAYER_MISMATCH');
      wallet.assertAccepts(transaction.money);
      transaction.assertAmountAllowed();
      const referenceId = transaction.referenceToResolve();
      const reference = referenceId ? await session.findReference(command.providerId, referenceId) : undefined;
      const alreadyReversed = reference && transaction.isReversal()
        ? await session.hasProcessedReversal(reference.id) : false;
      const decision = transaction.evaluateReference(reference, alreadyReversed);
      if (decision.outcome === 'pending') {
        if (transaction.status === 'PENDING') transaction.markPendingReference();
        return undefined;
      }
      if (decision.outcome === 'reject') throw new DomainError(decision.code);
      const entry = decision.direction
        ? wallet.apply(decision.direction, transaction.money, this.ids.next(), state.id, at, transaction.insufficientFundsCode())
        : undefined;
      transaction.markProcessed(at, decision.referenceTransactionId);
      return entry;
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      transaction.reject(error.code, at);
      return undefined;
    }
  }

  private async persistPending(session: FinancialSession, transaction: WagerTransaction, wallet: Wallet, correlationId: string, at: string): Promise<TransactionResult> {
    const result: TransactionResult = { transactionId: transaction.id, status: 'PENDING_REFERENCE', balance: wallet.balance.toJSON(), idempotentReplay: false };
    await session.schedulePendingReference(transaction.id, later(at, this.pendingPolicy.firstRetryDelayMs), later(at, this.pendingPolicy.ttlMs));
    await session.saveAcceptance(result);
    await session.enqueue(WagerTransactionPendingReference.from(transaction.toState(), this.eventContext(correlationId, at)).toJSON());
    return result;
  }

  private async persistTerminal(session: FinancialSession, transaction: WagerTransaction, wallet: Wallet, correlationId: string, at: string): Promise<TransactionResult> {
    const state = transaction.toState();
    if (state.status !== 'PROCESSED' && state.status !== 'REJECTED') throw new Error('Expected a terminal financial result');
    const result: TransactionResult = {
      transactionId: state.id, status: state.status, balance: wallet.balance.toJSON(), idempotentReplay: false,
      ...(state.failureCode ? { failureCode: state.failureCode } : {}),
    };
    await session.saveResult(result);
    const context = this.eventContext(correlationId, at);
    const event = state.status === 'PROCESSED'
      ? WagerTransactionProcessed.from(state, context)
      : WagerTransactionRejected.from(state, context);
    await session.enqueue(event.toJSON());
    return result;
  }

  private eventContext(correlationId: string, occurredAt: string) {
    return { eventId: this.ids.next(), correlationId, occurredAt };
  }
}
