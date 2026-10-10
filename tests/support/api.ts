import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { MikroORM } from '@mikro-orm/postgresql';
import { createApplication } from '../../src/bootstrap';
import { readConfig } from '../../src/config';
import type { SubmittedKind, WagerCommand } from '../../src/domain/wager-transaction';
import type { WalletState } from '../../src/domain/wallet';
import { connectDisposableDatabase } from './database';

export interface TestApi {
  readonly orm: MikroORM;
  readonly base: string;
  close(): Promise<void>;
}

// Aplicação Nest real no mesmo processo do teste, contra o banco descartável já migrado.
export async function startTestApi(): Promise<TestApi> {
  const config = readConfig();
  const orm = await connectDisposableDatabase(config.DATABASE_URL);
  const app = await createApplication(config);
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  return { orm, base, close: async () => { await app.close(); await orm.close(true); } };
}

export function send(base: string, path: string, method = 'GET', body?: unknown, key?: string): Promise<Response> {
  return fetch(`${base}${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000),
  });
}

export async function openWallet(base: string, amount = '100.00', playerId = randomUUID()): Promise<WalletState> {
  const response = await send(base, '/wallets', 'POST', { playerId, initialBalance: { amount, currency: 'BRL' } });
  expect(response.status).toBe(201);
  return response.json() as Promise<WalletState>;
}

export function wager(wallet: WalletState, kind: SubmittedKind = 'BET', amount = '25.00', extra: Partial<WagerCommand> = {}): WagerCommand {
  return { providerId: 'provider-a', externalTransactionId: randomUUID(), playerId: wallet.playerId,
    walletId: wallet.id, roundId: 'round-1', gameId: 'game-1', kind, money: { amount, currency: 'BRL' }, ...extra };
}

/** Contagens por direção, kind:status e tipo de evento: reconciliação sozinha esconde efeitos que se compensam. */
export async function financialState(orm: MikroORM, walletId: string) {
  const em = orm.em.fork();
  const group = async (sql: string) => Object.fromEntries(
    (await em.execute<{ key: string; count: number }[]>(sql, [walletId])).map((row) => [row.key, row.count]));
  return {
    ledger: await group('select direction as key, count(*)::int as count from wallet_ledger where wallet_id = ? group by direction'),
    transactions: await group(`select kind || ':' || status as key, count(*)::int as count
      from wager_transactions where wallet_id = ? group by kind, status`),
    events: await group('select event_type as key, count(*)::int as count from outbox_messages where aggregate_id = ? group by event_type'),
  };
}
