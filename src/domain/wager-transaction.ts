import type { FailureCode } from './errors';
import type { MoneyProps } from './money';

export interface BetCommand {
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: 'BET';
  readonly money: MoneyProps;
}

export interface TransactionState {
  readonly id: string;
  readonly kind: 'OPENING' | 'BET';
  readonly walletId: string;
  readonly playerId: string;
  readonly money: MoneyProps;
  readonly status: 'PENDING' | 'PROCESSED' | 'REJECTED' | 'FAILED';
  readonly failureCode: FailureCode | null;
  readonly createdAt: string;
  readonly processedAt: string | null;
  readonly command: BetCommand | null;
}

export class WagerTransaction {
  private constructor(private state: TransactionState) {}

  static bet(id: string, command: BetCommand, at: string): WagerTransaction {
    return new WagerTransaction({
      id, kind: 'BET', walletId: command.walletId, playerId: command.playerId,
      money: structuredClone(command.money), status: 'PENDING', failureCode: null,
      createdAt: at, processedAt: null, command: structuredClone(command),
    });
  }

  static opening(id: string, walletId: string, playerId: string, money: MoneyProps, at: string): WagerTransaction {
    const transaction = new WagerTransaction({
      id, kind: 'OPENING', walletId, playerId, money: structuredClone(money),
      status: 'PENDING', failureCode: null, createdAt: at, processedAt: null, command: null,
    });
    transaction.markProcessed(at);
    return transaction;
  }

  static rehydrate(state: TransactionState): WagerTransaction {
    return new WagerTransaction(structuredClone(state));
  }

  markProcessed(at: string): void {
    this.assertPending();
    this.state = { ...this.state, status: 'PROCESSED', processedAt: at };
  }

  reject(code: FailureCode, at: string): void {
    this.assertPending();
    this.state = { ...this.state, status: 'REJECTED', failureCode: code, processedAt: at };
  }

  toState(): TransactionState { return structuredClone(this.state); }

  private assertPending(): void {
    if (this.state.status !== 'PENDING') throw new Error('Terminal transaction is immutable');
  }
}
