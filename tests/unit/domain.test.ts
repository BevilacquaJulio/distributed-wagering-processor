import { expect, test } from 'bun:test';
import { Wallet } from '../../src/domain/wallet';
import { Money } from '../../src/domain/money';
import { WagerTransaction } from '../../src/domain/wager-transaction';
import { Sha256PayloadHasher } from '../../src/infrastructure/identity';
import { betSchema, ledgerQuerySchema } from '../../src/contracts/requests';

const at = '2026-10-09T12:00:00.000Z';
const money = (amount: string) => Money.from({ amount, currency: 'BRL' });

test('abertura e débito mantêm versões e lançamentos coerentes', () => {
  const wallet = Wallet.open('wallet', 'player', money('100.00'), at);
  expect(wallet.version).toBe(1);
  expect(wallet.openingEntry('entry', 'opening')?.isBalanced()).toBe(true);
  const ledger = wallet.debit(money('25.00'), 'debit', 'bet', at);
  expect(ledger.toState().balanceAfter.amount).toBe('75.00');
  expect(wallet.version).toBe(2);
  expect(() => wallet.debit(money('80.00'), 'entry', 'bet2', at)).toThrow('INSUFFICIENT_FUNDS');
  expect(wallet.balance.toString()).toBe('75.00');
  expect(wallet.version).toBe(2);
});

test('abertura zero não gera lançamento; estado retornado não altera domínio', () => {
  const wallet = Wallet.open('wallet', 'player', money('0.00'), at);
  expect(wallet.openingEntry('entry', 'opening')).toBeUndefined();
  expect(wallet.version).toBe(1);
  const state = wallet.toState();
  Object.assign(state.balance, { amount: '999.00' });
  expect(wallet.balance.toString()).toBe('0.00');
  expect(() => wallet.debit(money('0.00'), 'entry', 'bet', at)).toThrow('AMOUNT_NOT_ALLOWED');
});

test('reidratação conserva versão e não permite reabrir terminal', () => {
  const transaction = WagerTransaction.opening('transaction', 'wallet', 'player', money('100.00').toJSON(), at);
  const restored = WagerTransaction.rehydrate(transaction.toState());
  expect(() => restored.reject('INSUFFICIENT_FUNDS', at)).toThrow('Terminal transaction');
  expect(restored.toState().status).toBe('PROCESSED');
});

test('hash é independente da ordem de chaves e diferencia campos de negócio', () => {
  const hasher = new Sha256PayloadHasher();
  expect(hasher.hash({ b: { y: 2, x: 1 }, a: '1.00' })).toBe(hasher.hash({ a: '1.00', b: { x: 1, y: 2 } }));
  expect(hasher.hash({ amount: '1.00' })).not.toBe(hasher.hash({ amount: '2.00' }));
});

test('contrato rejeita OPENING e limita paginação', () => {
  expect(betSchema.safeParse({ kind: 'OPENING' }).success).toBe(false);
  expect(ledgerQuerySchema.parse({}).limit).toBe(50);
  expect(ledgerQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
  expect(ledgerQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
});
