import { Money, type MoneyProps } from './money';

export interface LedgerState {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: 'DEBIT' | 'CREDIT';
  readonly money: MoneyProps;
  readonly balanceBefore: MoneyProps;
  readonly balanceAfter: MoneyProps;
  readonly createdAt: string;
}

export class LedgerEntry {
  private constructor(private readonly state: LedgerState) {}

  static create(state: LedgerState): LedgerEntry {
    const entry = new LedgerEntry(structuredClone(state));
    if (!Money.from(state.money).isPositive() || !entry.isBalanced()) {
      throw new Error('Invalid ledger arithmetic');
    }
    return entry;
  }

  static rehydrate(state: LedgerState): LedgerEntry {
    return new LedgerEntry(structuredClone(state));
  }

  isBalanced(): boolean {
    const before = Money.from(this.state.balanceBefore);
    const amount = Money.from(this.state.money);
    const after = this.state.direction === 'CREDIT' ? before.add(amount) : before.subtract(amount);
    return after.equals(Money.from(this.state.balanceAfter));
  }

  toState(): LedgerState { return structuredClone(this.state); }
}
