import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { TransactionResult, TransactionView } from '../../src/application/ports';
import type { FailureCode } from '../../src/domain/errors';
import type { SubmittedKind, WagerCommand } from '../../src/domain/wager-transaction';
import type { WalletState } from '../../src/domain/wallet';
import { PostgresQueries } from '../../src/infrastructure/postgres/queries';
import { financialState, openWallet, send, startTestApi, type TestApi, wager } from '../support/api';

let api: TestApi;
let orm: MikroORM;
let base: string;

beforeAll(async () => {
  api = await startTestApi();
  ({ orm, base } = api);
});

afterAll(async () => { await api?.close(); });

interface Reply { readonly status: number; readonly body: TransactionResult }

async function submit(command: WagerCommand, key = randomUUID()): Promise<Reply> {
  const response = await send(base, '/wagering/transactions', 'POST', command, key);
  return { status: response.status, body: await response.json() as TransactionResult };
}

const reverse = (wallet: WalletState, kind: SubmittedKind, amount: string, reference: WagerCommand, extra: Partial<WagerCommand> = {}) =>
  wager(wallet, kind, amount, { referenceExternalTransactionId: reference.externalTransactionId, ...extra });

async function processedBet(wallet: WalletState, amount: string): Promise<WagerCommand> {
  const command = wager(wallet, 'BET', amount);
  expect((await submit(command)).status).toBe(200);
  return command;
}

async function expectWallet(walletId: string, balance: string, version: number): Promise<void> {
  const queries = new PostgresQueries(orm);
  const current = await queries.wallet(walletId);
  expect(current.balance.amount).toBe(balance);
  expect(current.version).toBe(version);
  expect((await queries.reconcile(walletId)).consistent).toBe(true);
}

async function expectRejected(reply: Reply, code: FailureCode, balance: string): Promise<void> {
  expect(reply.status).toBe(422);
  expect(reply.body).toMatchObject({ status: 'REJECTED', failureCode: code, balance: { amount: balance } });
}

describe('WIN e LOSS', () => {
  test('WIN credita com ou sem referência; LOSS registra resultado sem mover saldo', async () => {
    const wallet = await openWallet(base);
    const bet = await processedBet(wallet, '25.00');
    const win = reverse(wallet, 'WIN', '40.00', bet);
    const credited = await submit(win);
    expect(credited).toMatchObject({ status: 200, body: { status: 'PROCESSED', balance: { amount: '115.00' } } });
    expect((await submit(wager(wallet, 'WIN', '5.00'))).body.balance.amount).toBe('120.00');

    const loss = wager(wallet, 'LOSS', '0.00');
    const key = randomUUID();
    const recorded = await submit(loss, key);
    expect(recorded).toMatchObject({ status: 200, body: { status: 'PROCESSED', balance: { amount: '120.00' } } });
    expect(await submit(loss, key)).toEqual({ status: 200, body: { ...recorded.body, idempotentReplay: true } });

    await expectWallet(wallet.id, '120.00', 4);
    expect(await financialState(orm, wallet.id)).toEqual({
      ledger: { CREDIT: 3, DEBIT: 1 },
      transactions: { 'OPENING:PROCESSED': 1, 'BET:PROCESSED': 1, 'WIN:PROCESSED': 2, 'LOSS:PROCESSED': 1 },
      events: { WagerTransactionProcessed: 5, WalletBalanceChanged: 4 },
    });
    const view = await (await send(base, `/wagering/transactions/${credited.body.transactionId}`)).json() as TransactionView;
    const betView = await (await send(base, `/providers/provider-a/wagering/transactions/${bet.externalTransactionId}`)).json() as TransactionView;
    expect(view.referenceTransactionId).toBe(betView.id);
    expect(view.result).toEqual({ ...credited.body, idempotentReplay: false });
  });

  test('LOSS com valor e WIN com zero são rejeitados sem ledger', async () => {
    const wallet = await openWallet(base);
    await expectRejected(await submit(wager(wallet, 'LOSS', '10.00')), 'AMOUNT_NOT_ALLOWED', '100.00');
    await expectRejected(await submit(wager(wallet, 'WIN', '0.00')), 'AMOUNT_NOT_ALLOWED', '100.00');
    await expectWallet(wallet.id, '100.00', 1);
  });
});

describe('REFUND e ROLLBACK', () => {
  test('REFUND credita a BET uma única vez; ROLLBACK da mesma BET é outro tipo (limitação D05)', async () => {
    const wallet = await openWallet(base);
    const bet = await processedBet(wallet, '25.00');
    expect((await submit(reverse(wallet, 'REFUND', '25.00', bet))).body).toMatchObject({ status: 'PROCESSED', balance: { amount: '100.00' } });
    await expectRejected(await submit(reverse(wallet, 'REFUND', '25.00', bet)), 'REFERENCE_ALREADY_REVERSED', '100.00');
    expect((await submit(reverse(wallet, 'ROLLBACK', '25.00', bet))).body).toMatchObject({ status: 'PROCESSED', balance: { amount: '125.00' } });
    await expectWallet(wallet.id, '125.00', 4);
    expect(await financialState(orm, wallet.id)).toEqual({
      ledger: { CREDIT: 3, DEBIT: 1 },
      transactions: { 'OPENING:PROCESSED': 1, 'BET:PROCESSED': 1, 'REFUND:PROCESSED': 1, 'REFUND:REJECTED': 1, 'ROLLBACK:PROCESSED': 1 },
      events: { WagerTransactionProcessed: 4, WalletBalanceChanged: 4, WagerTransactionRejected: 1 },
    });
  });

  test('ROLLBACK debita WIN e REFUND; sem saldo usa código de reversão', async () => {
    const wallet = await openWallet(base);
    const bet = await processedBet(wallet, '30.00');
    const refund = reverse(wallet, 'REFUND', '30.00', bet);
    expect((await submit(refund)).body.balance.amount).toBe('100.00');
    expect((await submit(reverse(wallet, 'ROLLBACK', '30.00', refund))).body).toMatchObject({ status: 'PROCESSED', balance: { amount: '70.00' } });

    const win = wager(wallet, 'WIN', '50.00');
    expect((await submit(win)).body.balance.amount).toBe('120.00');
    await processedBet(wallet, '110.00');
    await expectRejected(await submit(reverse(wallet, 'ROLLBACK', '50.00', win)), 'REVERSAL_INSUFFICIENT_FUNDS', '10.00');
    await expectWallet(wallet.id, '10.00', 6);
    expect((await financialState(orm, wallet.id)).ledger).toEqual({ CREDIT: 3, DEBIT: 3 });
  });

  test('referência incompatível é rejeitada com código estável e sem movimentação', async () => {
    const wallet = await openWallet(base);
    const other = await openWallet(base);
    const bet = await processedBet(wallet, '20.00');
    const rejectedBet = wager(wallet, 'BET', '500.00');
    await expectRejected(await submit(rejectedBet), 'INSUFFICIENT_FUNDS', '80.00');
    const win = wager(wallet, 'WIN', '20.00');
    await submit(win);
    const self = wager(wallet, 'REFUND', '20.00');

    const cases: [WagerCommand, FailureCode][] = [
      [reverse(wallet, 'REFUND', '10.00', bet), 'REFERENCE_AMOUNT_MISMATCH'],
      [reverse(wallet, 'REFUND', '20.00', bet, { roundId: 'round-2' }), 'REFERENCE_MISMATCH'],
      [reverse(wallet, 'REFUND', '20.00', win), 'REFERENCE_MISMATCH'],
      [reverse(wallet, 'REFUND', '500.00', rejectedBet), 'REFERENCE_NOT_PROCESSED'],
      [{ ...self, referenceExternalTransactionId: self.externalTransactionId }, 'INVALID_REFERENCE'],
      [reverse(other, 'REFUND', '20.00', bet), 'REFERENCE_MISMATCH'],
    ];
    for (const [command, code] of cases) {
      const reply = await submit(command);
      expect(reply.status).toBe(422);
      expect(reply.body.failureCode).toBe(code);
    }
    await expectWallet(wallet.id, '100.00', 3);
    await expectWallet(other.id, '100.00', 1);
  });
});

describe('referência fora de ordem', () => {
  test('REFUND antes da BET fica pendente com aceite, agenda e evento duráveis', async () => {
    const wallet = await openWallet(base);
    const bet = wager(wallet, 'BET', '25.00');
    const refund = reverse(wallet, 'REFUND', '25.00', bet);
    const key = randomUUID();

    const accepted = await submit(refund, key);
    expect(accepted).toEqual({ status: 202, body: { transactionId: accepted.body.transactionId, status: 'PENDING_REFERENCE',
      balance: { amount: '100.00', currency: 'BRL' }, idempotentReplay: false } });
    expect(await submit(refund, key)).toEqual({ status: 202, body: { ...accepted.body, idempotentReplay: true } });

    const view = await (await send(base, `/providers/provider-a/wagering/transactions/${refund.externalTransactionId}`)).json() as TransactionView;
    expect(view).toMatchObject({ status: 'PENDING_REFERENCE', failureCode: null, processedAt: null, referenceTransactionId: null,
      result: accepted.body });
    const schedule = await orm.em.fork().execute<{ attempts: number; waits: boolean; ttl: boolean }[]>(`
      select p.attempts, p.next_attempt_at > t.created_at as waits,
        p.deadline_at = t.created_at + interval '24 hours' as ttl
      from pending_references p join wager_transactions t on t.id = p.transaction_id where p.transaction_id = ?`, [accepted.body.transactionId]);
    expect(schedule).toEqual([{ attempts: 0, waits: true, ttl: true }]);

    expect((await submit(bet)).body.balance.amount).toBe('75.00');
    await expectWallet(wallet.id, '75.00', 2);
    expect(await financialState(orm, wallet.id)).toEqual({
      ledger: { CREDIT: 1, DEBIT: 1 },
      transactions: { 'OPENING:PROCESSED': 1, 'BET:PROCESSED': 1, 'REFUND:PENDING_REFERENCE': 1 },
      events: { WagerTransactionProcessed: 2, WalletBalanceChanged: 2, WagerTransactionPendingReference: 1 },
    });
  });
});

describe('contrato e schema', () => {
  test('referência só é aceita onde o tipo permite', async () => {
    const wallet = await openWallet(base);
    const bet = wager(wallet, 'BET', '10.00');
    for (const body of [
      { ...bet, referenceExternalTransactionId: 'other' },
      { ...wager(wallet, 'LOSS', '0.00'), referenceExternalTransactionId: 'other' },
      wager(wallet, 'REFUND', '10.00'),
      { ...wager(wallet, 'ROLLBACK', '10.00'), referenceExternalTransactionId: null },
    ]) expect((await send(base, '/wagering/transactions', 'POST', body, randomUUID())).status).toBe(400);
    await expectWallet(wallet.id, '100.00', 1);
  });

  test('papel runtime não altera vínculos, aceites, agenda nem reabre transação pendente', async () => {
    const wallet = await openWallet(base);
    const bet = await processedBet(wallet, '25.00');
    await submit(reverse(wallet, 'REFUND', '25.00', bet));
    const pending = await submit(reverse(wallet, 'ROLLBACK', '25.00', wager(wallet, 'WIN', '25.00')));
    expect(pending.status).toBe(202);
    const connection = orm.em.fork();
    for (const [sql, params] of [
      ['update wager_references set kind = kind', []],
      ['delete from wager_references', []],
      ['update transaction_acceptances set body = body', []],
      ['delete from pending_references', []],
      ["update wager_transactions set status = 'PENDING' where id = ?", [pending.body.transactionId]],
    ] as const) await expect(connection.execute(sql, [...params])).rejects.toThrow();
    const index = await connection.execute<{ unique: boolean }[]>(`
      select indisunique as unique from pg_index where indexrelid = 'wager_references_single_reversal'::regclass`);
    expect(index).toEqual([{ unique: true }]);
  });
});
