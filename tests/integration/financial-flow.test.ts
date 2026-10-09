import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createApplication } from '../../src/bootstrap';
import { readConfig } from '../../src/config';
import { WageringService } from '../../src/application/wagering-service';
import { SystemClock, UuidGenerator, Sha256PayloadHasher, UnauthenticatedProviderIdentity } from '../../src/infrastructure/identity';
import { databaseConfig } from '../../src/infrastructure/postgres/config';
import { PostgresQueries } from '../../src/infrastructure/postgres/queries';
import { PostgresUnitOfWork } from '../../src/infrastructure/postgres/unit-of-work';
import type { TransactionResult } from '../../src/application/ports';
import type { BetCommand } from '../../src/domain/wager-transaction';
import type { WalletState } from '../../src/domain/wallet';
import type { LedgerState } from '../../src/domain/ledger-entry';
import { api as panelApi, getWallet as panelGetWallet, submitBet as panelSubmitBet } from '../../web/src/api';

let orm: MikroORM;
let app: NestExpressApplication;
let base: string;

beforeAll(async () => {
  const config = readConfig();
  const url = new URL(config.DATABASE_URL);
  if (process.env.TEST_DATABASE_DISPOSABLE !== 'yes' || url.pathname !== '/jungle_test'
    || !['127.0.0.1', 'localhost', 'postgres-test'].includes(url.hostname)) {
    throw new Error('Integration requires an explicitly disposable, local jungle_test database');
  }
  orm = await MikroORM.init(databaseConfig(config.DATABASE_URL));
  const version = await orm.em.fork().execute<{ version: number }[]>('select version from schema_version');
  if (version[0]?.version !== 1) throw new Error('Apply migrations manually before integration');
  app = await createApplication(config);
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
});

afterAll(async () => { await app?.close(); await orm?.close(true); });

async function request(path: string, method = 'GET', body?: unknown, key?: string) {
  return fetch(`${base}${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000),
  });
}

async function open(amount = '100.00'): Promise<WalletState> {
  const response = await request('/wallets', 'POST', { playerId: randomUUID(), initialBalance: { amount, currency: 'BRL' } });
  expect(response.status).toBe(201);
  return response.json() as Promise<WalletState>;
}

function command(wallet: WalletState, amount = '25.00'): BetCommand {
  return { providerId: 'provider-a', externalTransactionId: randomUUID(), playerId: wallet.playerId,
    walletId: wallet.id, roundId: 'round-1', gameId: 'game-1', kind: 'BET', money: { amount, currency: 'BRL' } };
}

async function counts(walletId: string) {
  const rows = await orm.em.fork().execute<{ ledger: string; events: string; transactions: string }[]>(`
    select (select count(*)::text from wallet_ledger where wallet_id = ?) as ledger,
      (select count(*)::text from outbox_messages where aggregate_id = ?) as events,
      (select count(*)::text from wager_transactions where wallet_id = ?) as transactions`, [walletId, walletId, walletId]);
  return rows[0];
}

describe('fluxo financeiro em PostgreSQL real', () => {
  test('wallet → BET → ledger/outbox → replay com saldo histórico', async () => {
    const wallet = await open();
    expect(wallet.version).toBe(1);
    const bet = command(wallet);
    const key = randomUUID();
    const response = await request('/wagering/transactions', 'POST', bet, key);
    expect(response.status).toBe(200);
    const original = await response.json() as TransactionResult;
    expect(original.balance.amount).toBe('75.00');
    expect(original.idempotentReplay).toBe(false);
    expect(await counts(wallet.id)).toEqual({ ledger: '2', events: '4', transactions: '2' });

    const next = await request('/wagering/transactions', 'POST', command(wallet, '5.00'), randomUUID());
    expect(next.status).toBe(200);
    const replay = await request('/wagering/transactions', 'POST', bet, key);
    expect(await replay.json()).toEqual({ ...original, idempotentReplay: true });
    const current = await new PostgresQueries(orm).wallet(wallet.id);
    expect(current.balance.amount).toBe('70.00');
    expect(current.version).toBe(3);
    expect(await counts(wallet.id)).toEqual({ ledger: '3', events: '6', transactions: '3' });
    expect((await new PostgresQueries(orm).reconcile(wallet.id)).consistent).toBe(true);
  });

  test('rejeição é auditável e replay não reavalia saldo', async () => {
    const wallet = await open('20.00');
    const bet = command(wallet, '80.00');
    const key = randomUUID();
    const response = await request('/wagering/transactions', 'POST', bet, key);
    expect(response.status).toBe(422);
    const result = await response.json() as TransactionResult;
    expect(result.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect((await new PostgresQueries(orm).wallet(wallet.id)).version).toBe(1);
    expect(await counts(wallet.id)).toEqual({ ledger: '1', events: '3', transactions: '2' });
    const replay = await request('/wagering/transactions', 'POST', bet, key);
    expect(replay.status).toBe(422);
    expect(await replay.json()).toEqual({ ...result, idempotentReplay: true });
  });

  test('conflitos de chave e ID externo não criam efeito adicional', async () => {
    const wallet = await open();
    const bet = command(wallet);
    const key = randomUUID();
    await request('/wagering/transactions', 'POST', bet, key);
    const changed = await request('/wagering/transactions', 'POST', { ...bet, money: { amount: '30.00', currency: 'BRL' } }, key);
    expect(changed.status).toBe(409);
    expect((await changed.json() as { error: { code: string } }).error.code).toBe('IDEMPOTENCY_CONFLICT');
    const alias = await request('/wagering/transactions', 'POST', bet, randomUUID());
    expect(alias.status).toBe(409);
    expect((await alias.json() as { error: { code: string } }).error.code).toBe('EXTERNAL_ID_CONFLICT');
    expect(await counts(wallet.id)).toEqual({ ledger: '2', events: '4', transactions: '2' });
  });

  test('falha depois dos writes e antes do commit desfaz saldo, identidade, ledger, resultado e eventos', async () => {
    const wallet = await open();
    const bet = command(wallet);
    const key = randomUUID();
    const service = new WageringService(new PostgresUnitOfWork(orm, async () => { throw new Error('falha injetada'); }),
      new SystemClock(), new UuidGenerator(), new Sha256PayloadHasher(), new UnauthenticatedProviderIdentity());
    await expect(service.bet(bet, key, randomUUID())).rejects.toThrow('falha injetada');
    expect(await counts(wallet.id)).toEqual({ ledger: '1', events: '2', transactions: '1' });
    expect((await new PostgresQueries(orm).wallet(wallet.id)).balance.amount).toBe('100.00');
    const identities = await orm.em.fork().execute<{ transaction_id: string }[]>('select transaction_id from wager_identities where idempotency_key = ?', [key]);
    expect(identities).toHaveLength(0);
    const retry = await request('/wagering/transactions', 'POST', bet, key);
    expect(retry.status).toBe(200);
    expect((await retry.json() as TransactionResult).idempotentReplay).toBe(false);
  });

  test('numeric máximo preserva centavos no banco e JSON', async () => {
    const wallet = await open('999999999999999999.99');
    const response = await request('/wagering/transactions', 'POST', command(wallet, '0.01'), randomUUID());
    expect((await response.json() as TransactionResult).balance.amount).toBe('999999999999999999.98');
    expect((await new PostgresQueries(orm).reconcile(wallet.id)).consistent).toBe(true);
  });

  test('wallet ausente desfaz reserva; jogador e moeda divergentes geram rejeição sem débito', async () => {
    const wallet = await open();
    const absent = command({ ...wallet, id: randomUUID() });
    const key = randomUUID();
    expect((await request('/wagering/transactions', 'POST', absent, key)).status).toBe(404);
    expect(await orm.em.fork().execute<{ transaction_id: string }[]>('select transaction_id from wager_identities where idempotency_key = ?', [key])).toHaveLength(0);
    for (const changed of [
      { ...command(wallet), playerId: randomUUID() },
      { ...command(wallet), money: { amount: '25.00', currency: 'USD' } },
    ]) expect((await request('/wagering/transactions', 'POST', changed, randomUUID())).status).toBe(422);
    expect((await new PostgresQueries(orm).wallet(wallet.id)).balance.amount).toBe('100.00');
    expect(await counts(wallet.id)).toEqual({ ledger: '1', events: '4', transactions: '3' });
  });

  test('abertura zero e rejeição de zero não geram ledger', async () => {
    const wallet = await open('0.00');
    expect(await counts(wallet.id)).toEqual({ ledger: '0', events: '0', transactions: '0' });
    const response = await request('/wagering/transactions', 'POST', command(wallet, '0.00'), randomUUID());
    expect(response.status).toBe(422);
    expect((await response.json() as TransactionResult).failureCode).toBe('AMOUNT_NOT_ALLOWED');
    expect((await new PostgresQueries(orm).reconcile(wallet.id)).consistent).toBe(true);
  });

  test('papel runtime não pode adulterar histórico nem saldo negativo', async () => {
    const wallet = await open();
    const connection = orm.em.fork();
    for (const sql of [
      "update wallet_ledger set amount = 1 where wallet_id = ?",
      'delete from wallet_ledger where wallet_id = ?',
      "update wallets set balance = -1 where id = ?",
      "update wallets set balance = 'NaN' where id = ?",
      "update wager_transactions set status = 'PENDING' where wallet_id = ?",
    ]) await expect(connection.execute(sql, [wallet.id])).rejects.toThrow();
    await expect(connection.execute('truncate wallet_ledger')).rejects.toThrow();
    await expect(connection.execute('update transaction_results set body = body')).rejects.toThrow();
    await expect(connection.execute(`insert into wallet_ledger select gen_random_uuid(), wallet_id, transaction_id,
      direction, amount, currency, balance_before, balance_after, created_at from wallet_ledger where wallet_id = ?`, [wallet.id])).rejects.toThrow();
    expect((await new PostgresQueries(orm).reconcile(wallet.id)).consistent).toBe(true);
  });

  test('contratos, consulta externa e paginação por cursor', async () => {
    const wallet = await open();
    const bet = command(wallet);
    expect((await request('/wagering/transactions', 'POST', bet)).status).toBe(400);
    expect((await request('/wagering/transactions', 'POST', { ...bet, kind: 'OPENING' }, randomUUID())).status).toBe(400);
    expect((await request('/wagering/transactions', 'POST', { ...bet, extra: true }, randomUUID())).status).toBe(400);
    expect((await request('/wallets', 'POST', { playerId: wallet.playerId, initialBalance: wallet.balance })).status).toBe(409);
    const response = await request('/wagering/transactions', 'POST', bet, randomUUID());
    const result = await response.json() as TransactionResult;
    expect((await request(`/providers/provider-a/wagering/transactions/${bet.externalTransactionId}`)).status).toBe(200);
    expect((await request(`/wagering/transactions/${result.transactionId}`)).status).toBe(200);
    const page = await (await request(`/wallets/${wallet.id}/ledger?limit=1`)).json() as { entries: LedgerState[]; nextCursor: string };
    expect(page.entries).toHaveLength(1);
    const second = await (await request(`/wallets/${wallet.id}/ledger?limit=1&cursor=${page.nextCursor}`)).json() as { entries: LedgerState[]; nextCursor: string | null };
    expect(second.entries).toHaveLength(1);
    expect(second.entries[0]?.id).not.toBe(page.entries[0]?.id);
    expect(second.nextCursor).toBeNull();
    expect((await request(`/wallets/${randomUUID()}/ledger?cursor=${page.nextCursor}`)).status).toBe(400);
    expect((await request('/health/live')).status).toBe(200);
    expect((await request('/health/ready')).status).toBe(200);
  });

  test('cliente do painel preserva strings, header e replay contra a API real', async () => {
    const originalBase = panelApi.defaults.baseURL;
    panelApi.defaults.baseURL = base;
    try {
      const wallet = await open();
      const id = randomUUID();
      const submission = { wallet, fields: { providerId: 'provider-a', externalTransactionId: id,
        idempotencyKey: `provider-a:${id}`, roundId: 'round-1', gameId: 'game-1', amount: '25.00' } };
      expect((await panelSubmitBet(submission)).balance?.amount).toBe('75.00');
      expect((await panelSubmitBet(submission)).idempotentReplay).toBe(true);
      expect((await panelGetWallet(wallet.id)).balance.amount).toBe('75.00');
      const rejected = await panelSubmitBet({ wallet, fields: { ...submission.fields, externalTransactionId: randomUUID(),
        idempotencyKey: randomUUID(), amount: '80.00' } });
      expect(rejected.status).toBe('REJECTED');
      expect(rejected.failureCode).toBe('INSUFFICIENT_FUNDS');
    } finally {
      if (originalBase === undefined) delete panelApi.defaults.baseURL;
      else panelApi.defaults.baseURL = originalBase;
    }
  });
});
