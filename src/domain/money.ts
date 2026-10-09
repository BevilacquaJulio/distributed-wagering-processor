import { DomainError, InvalidMoneyError } from './errors';

export interface MoneyProps {
  readonly amount: string;
  readonly currency: string;
}

export const MAX_CENTS = 99999999999999999999n;
export const AMOUNT_PATTERN = /^(0|[1-9]\d{0,17})\.\d{2}$/;

export class Money {
  private constructor(private readonly cents: bigint, public readonly currency: string) {
    Object.freeze(this);
  }

  static from(props: MoneyProps): Money {
    if (!AMOUNT_PATTERN.test(props.amount) || !/^[A-Z]{3}$/.test(props.currency)) {
      throw new InvalidMoneyError();
    }
    return new Money(BigInt(props.amount.replace('.', '')), props.currency);
  }

  static fromSignedDecimal(amount: string, currency: string): Money {
    if (!/^-?(0|[1-9]\d*)\.\d{2}$/.test(amount) || !/^[A-Z]{3}$/.test(currency)) {
      throw new InvalidMoneyError();
    }
    return new Money(BigInt(amount.replace('.', '')), currency);
  }

  static zero(currency: string): Money {
    return Money.from({ amount: '0.00', currency });
  }

  add(other: Money): Money {
    this.assertCurrency(other);
    return new Money(this.cents + other.cents, this.currency);
  }

  subtract(other: Money): Money {
    return this.add(other.negate());
  }

  negate(): Money {
    return new Money(-this.cents, this.currency);
  }

  equals(other: Money): boolean {
    this.assertCurrency(other);
    return this.cents === other.cents;
  }

  isLessThan(other: Money): boolean {
    this.assertCurrency(other);
    return this.cents < other.cents;
  }

  isZero(): boolean { return this.cents === 0n; }
  isPositive(): boolean { return this.cents > 0n; }
  isNegative(): boolean { return this.cents < 0n; }
  exceedsLimit(): boolean { return this.cents > MAX_CENTS; }

  toString(): string {
    const absolute = this.cents < 0n ? -this.cents : this.cents;
    return `${this.cents < 0n ? '-' : ''}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, '0')}`;
  }

  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }

  private assertCurrency(other: Money): void {
    if (this.currency !== other.currency) throw new DomainError('CURRENCY_MISMATCH');
  }
}
