import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { TransactionResult } from '../../src/application/ports';
import { readConfig } from '../../src/config';
import type { WagerCommand } from '../../src/domain/wager-transaction';
import type { WalletState } from '../../src/domain/wallet';
import { DATABASE_POOL_MAX } from '../../src/infrastructure/postgres/config';
import { PostgresQueries } from '../../src/infrastructure/postgres/queries';
import { financialState as stateOf } from '../support/api';
import { connectDisposableDatabase } from '../support/database';
import { type Barrier, type Instance, holdWalletIdentity, lockWallet, startInstances, stopInstances, waitForLockWaiters } from './harness';

const INSTANCES = 3;
// Requisições além da capacidade somada dos pools esperam conexão na aplicação, não lock no banco.
const IN_DATABASE_CAPACITY = INSTANCES * DATABASE_POOL_MAX;

let orm: MikroORM;
let instances: Instance[] = [];

beforeAll(async () => {
  const config = readConfig();
  orm = await connectDisposableDatabase(config.DATABASE_URL);
  instances = await startInstances(INSTANCES, config.DATABASE_URL);
});

afterAll(async () => {
  await stopInstances(instances);
  await orm?.close(true);
});

interface Reply<T> { readonly status: number; readonly body: T }

function instance(index: number): Instance {
  const selected = instances[index % instances.length];
  if (!selected) throw new Error('No API instance available');
  return selected;
}

async function post<T>(index: number, path: string, body: unknown, key?: string): Promise<Reply<T>> {
  const response = await fetch(`${instance(index).url}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  return { status: response.status, body: await response.json() as T };
}

async function openWallet(amount: string, playerId = randomUUID()): Promise<WalletState> {
  const reply = await post<WalletState>(0, '/wallets', { playerId, initialBalance: { amount, currency: 'BRL' } });
  expect(reply.status).toBe(201);
  return reply.body;
}

function bet(wallet: WalletState, amount: string): WagerCommand {
  return { providerId: 'provider-a', externalTransactionId: randomUUID(), playerId: wallet.playerId,
    walletId: wallet.id, roundId: 'round-1', gameId: 'game-1', kind: 'BET', money: { amount, currency: 'BRL' } };
}

function submit(index: number, command: WagerCommand, key: string): Promise<Reply<TransactionResult>> {
  return post<TransactionResult>(index, '/wagering/transactions', command, key);
}

// Dispara as requisições com o recurso bloqueado e só libera quando o banco mostra todas esperando.
async function contend<T>(barrier: Barrier, expectedWaiters: number, requests: () => Promise<T>[]): Promise<{ waiting: number; results: T[] }> {
  let pending: Promise<T>[] = [];
  let waiting = 0;
  try {
    pending = requests();
    waiting = await waitForLockWaiters(orm, expectedWaiters);
  } finally {
    await barrier.release();
  }
  return { waiting, results: await Promise.all(pending) };
}

const financialState = (walletId: string) => stateOf(orm, walletId);

async function expectConsistent(walletId: string, balance: string, version: number, entries: number): Promise<void> {
  const queries = new PostgresQueries(orm);
  const current = await queries.wallet(walletId);
  expect(current.balance.amount).toBe(balance);
  expect(current.version).toBe(version);
  const reconciliation = await queries.reconcile(walletId);
  expect(reconciliation.consistent).toBe(true);
  expect(reconciliation.calculatedBalance.amount).toBe(balance);
  expect(reconciliation.checkedEntries).toBe(entries);
}

describe(`concorrência entre ${INSTANCES} processos da API`, () => {
  test('a mesma BET enviada 50 vezes em paralelo gera um único débito', async () => {
    const wallet = await openWallet('100.00');
    const command = bet(wallet, '25.00');
    const key = randomUUID();
    const sends = 50;

    const { waiting, results } = await contend(await lockWallet(orm, wallet.id), Math.min(sends, IN_DATABASE_CAPACITY),
      () => Array.from({ length: sends }, (_, index) => submit(index, command, key)));

    expect(waiting).toBe(Math.min(sends, IN_DATABASE_CAPACITY));
    expect(results.every((reply) => reply.status === 200)).toBe(true);
    expect(new Set(results.map((reply) => reply.body.transactionId)).size).toBe(1);
    expect(results.filter((reply) => !reply.body.idempotentReplay)).toHaveLength(1);
    expect(results.filter((reply) => reply.body.idempotentReplay)).toHaveLength(sends - 1);
    expect(results.every((reply) => reply.body.status === 'PROCESSED' && reply.body.balance.amount === '75.00')).toBe(true);
    expect(await financialState(wallet.id)).toEqual({
      ledger: { CREDIT: 1, DEBIT: 1 },
      transactions: { 'OPENING:PROCESSED': 1, 'BET:PROCESSED': 1 },
      events: { WagerTransactionProcessed: 2, WalletBalanceChanged: 2 },
    });
    await expectConsistent(wallet.id, '75.00', 2, 2);
  });

  test('duas BETs de 80.00 contra saldo 100.00: uma processada, outra rejeitada', async () => {
    const wallet = await openWallet('100.00');
    const commands = [bet(wallet, '80.00'), bet(wallet, '80.00')];

    const { waiting, results } = await contend(await lockWallet(orm, wallet.id), 2,
      () => commands.map((command, index) => submit(index, command, randomUUID())));

    expect(waiting).toBe(2);
    const processed = results.filter((reply) => reply.status === 200);
    const rejected = results.filter((reply) => reply.status === 422);
    expect(processed).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(processed[0]?.body).toMatchObject({ status: 'PROCESSED', balance: { amount: '20.00' } });
    expect(rejected[0]?.body).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS', balance: { amount: '20.00' } });
    expect(await financialState(wallet.id)).toEqual({
      ledger: { CREDIT: 1, DEBIT: 1 },
      transactions: { 'OPENING:PROCESSED': 1, 'BET:PROCESSED': 1, 'BET:REJECTED': 1 },
      events: { WagerTransactionProcessed: 2, WalletBalanceChanged: 2, WagerTransactionRejected: 1 },
    });
    await expectConsistent(wallet.id, '20.00', 2, 2);
  });

  test('vinte BETs de 10.00 disputando saldo 100.00 serializam sem lost update', async () => {
    const wallet = await openWallet('100.00');
    const sends = 20;

    const { waiting, results } = await contend(await lockWallet(orm, wallet.id), sends,
      () => Array.from({ length: sends }, (_, index) => submit(index, bet(wallet, '10.00'), randomUUID())));

    expect(waiting).toBe(sends);
    const processed = results.filter((reply) => reply.status === 200);
    const rejected = results.filter((reply) => reply.status === 422);
    expect(processed).toHaveLength(10);
    expect(rejected).toHaveLength(10);
    // Cada débito observou um saldo distinto: nenhuma transação leu um saldo já consumido por outra.
    expect(processed.map((reply) => reply.body.balance.amount).sort((a, b) => a.localeCompare(b, 'en', { numeric: true })))
      .toEqual(['0.00', '10.00', '20.00', '30.00', '40.00', '50.00', '60.00', '70.00', '80.00', '90.00']);
    expect(rejected.every((reply) => reply.body.failureCode === 'INSUFFICIENT_FUNDS' && reply.body.balance.amount === '0.00')).toBe(true);
    expect(await financialState(wallet.id)).toEqual({
      ledger: { CREDIT: 1, DEBIT: 10 },
      transactions: { 'OPENING:PROCESSED': 1, 'BET:PROCESSED': 10, 'BET:REJECTED': 10 },
      events: { WagerTransactionProcessed: 11, WalletBalanceChanged: 11, WagerTransactionRejected: 10 },
    });
    await expectConsistent(wallet.id, '0.00', 11, 11);
  });

  test('wallet bloqueada não impede o processamento de outra wallet', async () => {
    const blocked = await openWallet('100.00');
    const free = await openWallet('100.00');
    const barrier = await lockWallet(orm, blocked.id);
    let blockedSettled = false;
    let blockedReply: Promise<Reply<TransactionResult>> | undefined;
    try {
      blockedReply = submit(0, bet(blocked, '25.00'), randomUUID());
      void blockedReply.then(() => { blockedSettled = true; });
      expect(await waitForLockWaiters(orm, 1)).toBe(1);

      const freeReply = await submit(1, bet(free, '25.00'), randomUUID());
      expect(freeReply.status).toBe(200);
      expect(freeReply.body.balance.amount).toBe('75.00');
      expect(blockedSettled).toBe(false);
    } finally {
      await barrier.release();
    }
    const released = await blockedReply;
    expect(released?.status).toBe(200);
    expect(released?.body.balance.amount).toBe('75.00');
    await expectConsistent(blocked.id, '75.00', 2, 2);
    await expectConsistent(free.id, '75.00', 2, 2);
  });

  test('dois REFUNDs simultâneos da mesma BET: um credita, outro é rejeitado como já revertido', async () => {
    const wallet = await openWallet('100.00');
    const original = bet(wallet, '25.00');
    expect((await submit(0, original, randomUUID())).status).toBe(200);
    const refunds = [0, 1].map(() => ({ ...bet(wallet, '25.00'), kind: 'REFUND' as const,
      referenceExternalTransactionId: original.externalTransactionId }));

    const { waiting, results } = await contend(await lockWallet(orm, wallet.id), 2,
      () => refunds.map((command, index) => submit(index + 1, command, randomUUID())));

    expect(waiting).toBe(2);
    const processed = results.filter((reply) => reply.status === 200);
    const rejected = results.filter((reply) => reply.status === 422);
    expect(processed).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(processed[0]?.body).toMatchObject({ status: 'PROCESSED', balance: { amount: '100.00' } });
    expect(rejected[0]?.body).toMatchObject({ failureCode: 'REFERENCE_ALREADY_REVERSED', balance: { amount: '100.00' } });
    expect(await financialState(wallet.id)).toEqual({
      ledger: { CREDIT: 2, DEBIT: 1 },
      transactions: { 'OPENING:PROCESSED': 1, 'BET:PROCESSED': 1, 'REFUND:PROCESSED': 1, 'REFUND:REJECTED': 1 },
      events: { WagerTransactionProcessed: 3, WalletBalanceChanged: 3, WagerTransactionRejected: 1 },
    });
    await expectConsistent(wallet.id, '100.00', 3, 3);
  });

  test('criações simultâneas da mesma wallet resultam em uma única wallet', async () => {
    const playerId = randomUUID();
    const sends = IN_DATABASE_CAPACITY;

    const { waiting, results } = await contend(await holdWalletIdentity(orm, playerId), sends,
      () => Array.from({ length: sends }, (_, index) => post<WalletState | { error: { code: string } }>(index, '/wallets',
        { playerId, initialBalance: { amount: '100.00', currency: 'BRL' } })));

    expect(waiting).toBe(sends);
    const created = results.filter((reply) => reply.status === 201);
    const conflicts = results.filter((reply) => reply.status === 409);
    expect(created).toHaveLength(1);
    expect(conflicts).toHaveLength(sends - 1);
    expect(conflicts.every((reply) => 'error' in reply.body && reply.body.error.code === 'WALLET_ALREADY_EXISTS')).toBe(true);
    const rows = await orm.em.fork().execute<{ id: string }[]>('select id from wallets where player_id = ?', [playerId]);
    expect(rows).toHaveLength(1);
    const winner = rows[0];
    if (!winner) throw new Error('Expected one wallet');
    expect(await financialState(winner.id)).toEqual({
      ledger: { CREDIT: 1 },
      transactions: { 'OPENING:PROCESSED': 1 },
      events: { WagerTransactionProcessed: 1, WalletBalanceChanged: 1 },
    });
    await expectConsistent(winner.id, '100.00', 1, 1);
  });
});
