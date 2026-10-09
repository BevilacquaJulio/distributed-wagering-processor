import { DomainError } from './errors';
import { LedgerEntry } from './ledger-entry';
import { Money, type MoneyProps } from './money';

export interface WalletState {
  readonly id: string;
  readonly playerId: string;
  readonly balance: MoneyProps;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export class Wallet {
  private constructor(private state: WalletState) {}

  static open(id: string, playerId: string, balance: Money, at: string): Wallet {
    if (balance.currency !== 'BRL') throw new DomainError('CURRENCY_NOT_SUPPORTED');
    if (balance.isNegative() || balance.exceedsLimit()) throw new DomainError('BALANCE_LIMIT_EXCEEDED');
    return new Wallet({ id, playerId, balance: balance.toJSON(), version: 1, createdAt: at, updatedAt: at });
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(structuredClone(state));
  }

  get id(): string { return this.state.id; }
  get playerId(): string { return this.state.playerId; }
  get balance(): Money { return Money.from(this.state.balance); }
  get version(): number { return this.state.version; }

  openingEntry(id: string, transactionId: string): LedgerEntry | undefined {
    if (this.balance.isZero()) return undefined;
    return LedgerEntry.create({
      id, transactionId, walletId: this.id, direction: 'CREDIT', money: this.balance.toJSON(),
      balanceBefore: Money.zero(this.balance.currency).toJSON(), balanceAfter: this.balance.toJSON(),
      createdAt: this.state.createdAt,
    });
  }

  debit(money: Money, id: string, transactionId: string, at: string): LedgerEntry {
    if (money.currency !== 'BRL') throw new DomainError('CURRENCY_NOT_SUPPORTED');
    if (money.currency !== this.balance.currency) throw new DomainError('CURRENCY_MISMATCH');
    if (!money.isPositive()) throw new DomainError('AMOUNT_NOT_ALLOWED');
    if (this.balance.isLessThan(money)) throw new DomainError('INSUFFICIENT_FUNDS');
    if (this.version >= 2147483647) throw new Error('Wallet version exhausted');
    const after = this.balance.subtract(money);
    const entry = LedgerEntry.create({
      id, transactionId, walletId: this.id, direction: 'DEBIT', money: money.toJSON(),
      balanceBefore: this.balance.toJSON(), balanceAfter: after.toJSON(), createdAt: at,
    });
    this.state = { ...this.state, balance: after.toJSON(), version: this.version + 1, updatedAt: at };
    return entry;
  }

  toState(): WalletState { return structuredClone(this.state); }
}
