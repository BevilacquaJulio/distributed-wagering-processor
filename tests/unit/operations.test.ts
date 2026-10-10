import { describe, expect, test } from 'bun:test';
import { wagerSchema } from '../../src/contracts/requests';
import type { FailureCode } from '../../src/domain/errors';
import { Money } from '../../src/domain/money';
import { type SubmittedKind, type WagerCommand, WagerTransaction } from '../../src/domain/wager-transaction';
import { Wallet } from '../../src/domain/wallet';
import { Sha256PayloadHasher } from '../../src/infrastructure/identity';

const at = '2026-10-09T12:00:00.000Z';
const money = (amount: string) => Money.from({ amount, currency: 'BRL' });

function command(kind: SubmittedKind, amount: string, overrides: Partial<WagerCommand> = {}): WagerCommand {
  return { providerId: 'provider-a', externalTransactionId: `${kind}-${amount}`, playerId: 'player', walletId: 'wallet',
    roundId: 'round-1', gameId: 'game-1', kind, money: { amount, currency: 'BRL' }, ...overrides };
}

function processed(kind: SubmittedKind, amount: string, overrides: Partial<WagerCommand> = {}): WagerTransaction {
  const transaction = WagerTransaction.submit(`${kind}-id`, command(kind, amount, overrides), at);
  transaction.markProcessed(at, null);
  return transaction;
}

const reversal = (kind: 'REFUND' | 'ROLLBACK', amount: string, reference: string, overrides: Partial<WagerCommand> = {}) =>
  WagerTransaction.submit(`${kind}-new`, command(kind, amount, { externalTransactionId: `${kind}-new`, referenceExternalTransactionId: reference, ...overrides }), at);

describe('valor por tipo de operação', () => {
  test('LOSS exige 0.00 e as demais operações exigem valor positivo', () => {
    expect(() => WagerTransaction.submit('loss', command('LOSS', '0.00'), at).assertAmountAllowed()).not.toThrow();
    expect(() => WagerTransaction.submit('loss', command('LOSS', '1.00'), at).assertAmountAllowed()).toThrow('AMOUNT_NOT_ALLOWED');
    for (const kind of ['BET', 'WIN'] as const) {
      expect(() => WagerTransaction.submit(kind, command(kind, '0.00'), at).assertAmountAllowed()).toThrow('AMOUNT_NOT_ALLOWED');
    }
    expect(WagerTransaction.submit('loss', command('LOSS', '0.00'), at).affectsBalance()).toBe(false);
  });

  test('crédito acima do limite é rejeitado sem alterar a wallet', () => {
    const wallet = Wallet.open('wallet', 'player', money('999999999999999999.99'), at);
    expect(() => wallet.credit(money('0.01'), 'entry', 'win', at)).toThrow('BALANCE_LIMIT_EXCEEDED');
    expect(wallet.version).toBe(1);
    expect(wallet.balance.toString()).toBe('999999999999999999.99');
  });

  test('saldo insuficiente de reversão tem código próprio', () => {
    const wallet = Wallet.open('wallet', 'player', money('10.00'), at);
    const rollback = reversal('ROLLBACK', '50.00', 'WIN-50.00');
    expect(() => wallet.debit(money('50.00'), 'entry', rollback.id, at, rollback.insufficientFundsCode())).toThrow('REVERSAL_INSUFFICIENT_FUNDS');
    expect(WagerTransaction.submit('bet', command('BET', '50.00'), at).insufficientFundsCode()).toBe('INSUFFICIENT_FUNDS');
  });
});

describe('resolução da referência', () => {
  test('WIN sem referência credita; com referência exige BET processada', () => {
    const win = WagerTransaction.submit('win', command('WIN', '40.00'), at);
    expect(win.evaluateReference(undefined, false)).toEqual({ outcome: 'apply', direction: 'CREDIT', referenceTransactionId: null });
    const linked = WagerTransaction.submit('win', command('WIN', '40.00', { referenceExternalTransactionId: 'BET-25.00' }), at);
    expect(linked.evaluateReference(processed('BET', '25.00'), false))
      .toEqual({ outcome: 'apply', direction: 'CREDIT', referenceTransactionId: 'BET-id' });
  });

  test('referência ausente ou ainda pendente mantém a operação em PENDING_REFERENCE', () => {
    const refund = reversal('REFUND', '25.00', 'BET-25.00');
    expect(refund.evaluateReference(undefined, false)).toEqual({ outcome: 'pending' });
    const waiting = WagerTransaction.submit('win-id', command('WIN', '30.00', { referenceExternalTransactionId: 'BET-30.00' }), at);
    waiting.markPendingReference();
    const rollback = reversal('ROLLBACK', '30.00', 'WIN-30.00');
    expect(rollback.evaluateReference(waiting, false)).toEqual({ outcome: 'pending' });
  });

  test('reversões invertem a direção efetivamente aplicada pela referência', () => {
    expect(reversal('REFUND', '25.00', 'BET-25.00').evaluateReference(processed('BET', '25.00'), false))
      .toMatchObject({ outcome: 'apply', direction: 'CREDIT' });
    expect(reversal('ROLLBACK', '25.00', 'BET-25.00').evaluateReference(processed('BET', '25.00'), false))
      .toMatchObject({ outcome: 'apply', direction: 'CREDIT' });
    expect(reversal('ROLLBACK', '40.00', 'WIN-40.00').evaluateReference(processed('WIN', '40.00'), false))
      .toMatchObject({ outcome: 'apply', direction: 'DEBIT' });
    expect(reversal('ROLLBACK', '25.00', 'REFUND-25.00').evaluateReference(processed('REFUND', '25.00', { referenceExternalTransactionId: 'x' }), false))
      .toMatchObject({ outcome: 'apply', direction: 'DEBIT' });
  });

  test('cada violação da referência tem código estável', () => {
    const bet = processed('BET', '25.00');
    const rejected = WagerTransaction.submit('BET-id', command('BET', '25.00'), at);
    rejected.reject('INSUFFICIENT_FUNDS', at);
    const cases: [WagerTransaction, WagerTransaction, boolean, FailureCode][] = [
      [reversal('REFUND', '25.00', 'REFUND-new'), bet, false, 'INVALID_REFERENCE'],
      [reversal('REFUND', '25.00', 'BET-25.00'), rejected, false, 'REFERENCE_NOT_PROCESSED'],
      [reversal('REFUND', '40.00', 'WIN-40.00'), processed('WIN', '40.00'), false, 'REFERENCE_MISMATCH'],
      [reversal('REFUND', '25.00', 'BET-25.00', { roundId: 'round-2' }), bet, false, 'REFERENCE_MISMATCH'],
      [reversal('REFUND', '25.00', 'BET-25.00', { playerId: 'other' }), bet, false, 'REFERENCE_MISMATCH'],
      [reversal('REFUND', '25.00', 'BET-25.00', { walletId: 'other' }), bet, false, 'REFERENCE_MISMATCH'],
      [reversal('REFUND', '20.00', 'BET-25.00'), bet, false, 'REFERENCE_AMOUNT_MISMATCH'],
      [reversal('REFUND', '25.00', 'BET-25.00'), bet, true, 'REFERENCE_ALREADY_REVERSED'],
    ];
    for (const [transaction, reference, alreadyReversed, code] of cases) {
      expect(transaction.evaluateReference(reference, alreadyReversed)).toEqual({ outcome: 'reject', code });
    }
  });

  test('gameId não é condição de compatibilidade', () => {
    expect(reversal('REFUND', '25.00', 'BET-25.00', { gameId: 'other-game' }).evaluateReference(processed('BET', '25.00'), false))
      .toMatchObject({ outcome: 'apply' });
  });
});

describe('transições', () => {
  test('pendência pode terminar, mas terminal não muda e não volta a esperar', () => {
    const refund = reversal('REFUND', '25.00', 'BET-25.00');
    refund.markPendingReference();
    expect(refund.isTerminal()).toBe(false);
    refund.markProcessed(at, 'BET-id');
    expect(refund.toState()).toMatchObject({ status: 'PROCESSED', referenceTransactionId: 'BET-id' });
    expect(() => refund.reject('REFERENCE_EXPIRED', at)).toThrow('Terminal transaction');
    expect(() => refund.markPendingReference()).toThrow();
  });

  test('referência é obrigatória em reversões e proibida em BET e LOSS', () => {
    expect(() => WagerTransaction.submit('r', command('REFUND', '25.00'), at)).toThrow('requires a reference');
    expect(() => WagerTransaction.submit('b', command('BET', '25.00', { referenceExternalTransactionId: 'x' }), at)).toThrow('does not accept');
  });
});

describe('contrato de entrada', () => {
  const base = { providerId: 'provider-a', externalTransactionId: 'tx-1', playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
    walletId: '0192f291-27dd-7d3f-8071-5f8685deef37', roundId: 'round-1', gameId: 'game-1', money: { amount: '25.00', currency: 'BRL' } };

  test('referência segue a regra de cada tipo e nunca aceita null ou vazio', () => {
    expect(wagerSchema.safeParse({ ...base, kind: 'REFUND' }).success).toBe(false);
    expect(wagerSchema.safeParse({ ...base, kind: 'REFUND', referenceExternalTransactionId: 'tx-0' }).success).toBe(true);
    expect(wagerSchema.safeParse({ ...base, kind: 'BET', referenceExternalTransactionId: 'tx-0' }).success).toBe(false);
    expect(wagerSchema.safeParse({ ...base, kind: 'LOSS', referenceExternalTransactionId: 'tx-0' }).success).toBe(false);
    expect(wagerSchema.safeParse({ ...base, kind: 'WIN' }).success).toBe(true);
    expect(wagerSchema.safeParse({ ...base, kind: 'WIN', referenceExternalTransactionId: null }).success).toBe(false);
    expect(wagerSchema.safeParse({ ...base, kind: 'ROLLBACK', referenceExternalTransactionId: '' }).success).toBe(false);
  });

  test('referência omitida não altera o hash, mas referência informada altera', () => {
    const hasher = new Sha256PayloadHasher();
    const win = { ...base, kind: 'WIN' };
    expect(hasher.hash({ ...win, referenceExternalTransactionId: undefined })).toBe(hasher.hash(win));
    expect(hasher.hash({ ...win, referenceExternalTransactionId: 'tx-0' })).not.toBe(hasher.hash(win));
  });
});
