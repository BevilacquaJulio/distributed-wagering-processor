import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { TransactionResult, TransactionView } from '../../src/application/ports';
import { readConfig } from '../../src/config';
import type { SubmittedKind, WagerCommand } from '../../src/domain/wager-transaction';
import type { WalletState } from '../../src/domain/wallet';
import { PostgresQueries } from '../../src/infrastructure/postgres/queries';
import { DEFAULT_REFERENCE_WORKER_SETTINGS } from '../../src/workers/reference-worker';
import { financialState, openWallet, send, startTestApi, type TestApi, wager } from '../support/api';
import { connectDisposableDatabase } from '../support/database';
import { ShiftedClock } from '../support/outbox';
import { drainReferences, schedule, testWorker } from '../support/references';

const DAY_SECONDS = 24 * 60 * 60;
const AFTER_LEASE = new ShiftedClock(DEFAULT_REFERENCE_WORKER_SETTINGS.leaseSeconds + 1);

let api: TestApi;
let orm: MikroORM;

beforeAll(async () => {
  api = await startTestApi();
  orm = api.orm;
  // Pendências deixadas por outras suítes vencem neste relógio: cada cenário passa a observar só as próprias.
  await drainReferences(testWorker(orm, { clock: new ShiftedClock(DAY_SECONDS + 3600) }).worker);
});

afterAll(async () => { await api?.close(); });

interface Reply { readonly status: number; readonly body: TransactionResult }

async function submit(command: WagerCommand, key = randomUUID()): Promise<Reply> {
  const response = await send(api.base, '/wagering/transactions', 'POST', command, key);
  return { status: response.status, body: await response.json() as TransactionResult };
}

const reverse = (wallet: WalletState, kind: SubmittedKind, amount: string, reference: WagerCommand) =>
  wager(wallet, kind, amount, { referenceExternalTransactionId: reference.externalTransactionId });

async function pending(command: WagerCommand, key = randomUUID()): Promise<string> {
  const reply = await submit(command, key);
  expect(reply).toMatchObject({ status: 202, body: { status: 'PENDING_REFERENCE' } });
  return reply.body.transactionId;
}

async function expectWallet(walletId: string, balance: string, version: number): Promise<void> {
  const queries = new PostgresQueries(orm);
  expect(await queries.wallet(walletId)).toMatchObject({ balance: { amount: balance }, version });
  expect((await queries.reconcile(walletId)).consistent).toBe(true);
}

describe('resolução de referências pendentes', () => {
  test('a referência que chega depois acorda a dependente e o worker a processa uma única vez', async () => {
    const wallet = await openWallet(api.base);
    const bet = wager(wallet, 'BET', '25.00');
    const refund = reverse(wallet, 'REFUND', '25.00', bet);
    const key = randomUUID();
    const refundId = await pending(refund, key);
    const accepted = await schedule(orm, refundId);

    const betReply = await submit(bet);
    expect(betReply.status).toBe(200);
    const woken = await schedule(orm, refundId);
    expect(Date.parse(woken.nextAttemptAt)).toBeLessThan(Date.parse(accepted.nextAttemptAt));

    const { worker, metrics } = testWorker(orm);
    expect(await drainReferences(worker)).toMatchObject({ claimed: 1, processed: 1 });
    expect(metrics.value('reference_processed')).toBe(1);
    expect(await schedule(orm, refundId)).toMatchObject({ attempts: 1, claimed: false, resolvedAt: expect.any(String), status: 'PROCESSED' });

    // Replay passa do aceite 202 ao resultado terminal persistido na resolução.
    expect(await submit(refund, key)).toEqual({ status: 200, body: { transactionId: refundId, status: 'PROCESSED',
      balance: { amount: '100.00', currency: 'BRL' }, idempotentReplay: true } });
    const view = await (await send(api.base, `/wagering/transactions/${refundId}`)).json() as TransactionView;
    expect(view).toMatchObject({ status: 'PROCESSED', referenceTransactionId: betReply.body.transactionId });
    await expectWallet(wallet.id, '100.00', 3);
    expect(await financialState(orm, wallet.id)).toEqual({
      ledger: { CREDIT: 2, DEBIT: 1 },
      transactions: { 'OPENING:PROCESSED': 1, 'BET:PROCESSED': 1, 'REFUND:PROCESSED': 1 },
      events: { WagerTransactionProcessed: 3, WalletBalanceChanged: 3, WagerTransactionPendingReference: 1 },
    });
    expect((await drainReferences(testWorker(orm).worker)).claimed).toBe(0);
  });

  test('sem referência, reagenda com backoff crescente e sem novo evento', async () => {
    const wallet = await openWallet(api.base);
    const id = await pending(reverse(wallet, 'ROLLBACK', '10.00', wager(wallet, 'WIN', '10.00')));

    expect(await drainReferences(testWorker(orm, { clock: new ShiftedClock(5) }).worker)).toMatchObject({ pending: 1, processed: 0 });
    const first = await schedule(orm, id);
    expect(first).toMatchObject({ attempts: 1, claimed: false, resolvedAt: null, status: 'PENDING_REFERENCE' });
    // Primeira reavaliação: 2s mais jitter abaixo de 1s, a partir do relógio adiantado em 5s.
    const firstDelay = Date.parse(first.nextAttemptAt) - Date.now() - 5000;
    expect(firstDelay).toBeGreaterThan(1500);
    expect(firstDelay).toBeLessThan(3500);

    await drainReferences(testWorker(orm, { clock: new ShiftedClock(60) }).worker);
    const second = await schedule(orm, id);
    expect(second.attempts).toBe(2);
    expect(Date.parse(second.nextAttemptAt) - Date.now() - 60_000).toBeGreaterThan(3500);
    await expectWallet(wallet.id, '100.00', 1);
    expect((await financialState(orm, wallet.id)).events).toEqual({ WagerTransactionProcessed: 1, WalletBalanceChanged: 1,
      WagerTransactionPendingReference: 1 });
  });

  test('prazo vencido rejeita com REFERENCE_EXPIRED, evento e replay terminal', async () => {
    const wallet = await openWallet(api.base);
    const bet = wager(wallet, 'BET', '25.00');
    const refund = reverse(wallet, 'REFUND', '25.00', bet);
    const key = randomUUID();
    const id = await pending(refund, key);

    const { worker, metrics } = testWorker(orm, { clock: new ShiftedClock(DAY_SECONDS + 1) });
    await drainReferences(worker);
    expect(metrics.value('reference_expired')).toBeGreaterThanOrEqual(1);
    expect(await schedule(orm, id)).toMatchObject({ status: 'REJECTED', failureCode: 'REFERENCE_EXPIRED', resolvedAt: expect.any(String) });
    expect(await submit(refund, key)).toMatchObject({ status: 422, body: { transactionId: id, status: 'REJECTED',
      failureCode: 'REFERENCE_EXPIRED', balance: { amount: '100.00' }, idempotentReplay: true } });

    // A BET tardia é processada normalmente; a reversão expirada continua terminal.
    expect((await submit(bet)).status).toBe(200);
    expect((await drainReferences(testWorker(orm).worker)).claimed).toBe(0);
    await expectWallet(wallet.id, '75.00', 2);
    expect(await financialState(orm, wallet.id)).toEqual({
      ledger: { CREDIT: 1, DEBIT: 1 },
      transactions: { 'OPENING:PROCESSED': 1, 'BET:PROCESSED': 1, 'REFUND:REJECTED': 1 },
      events: { WagerTransactionProcessed: 2, WalletBalanceChanged: 2, WagerTransactionPendingReference: 1, WagerTransactionRejected: 1 },
    });
  });

  test('referência rejeitada rejeita a dependente com REFERENCE_NOT_PROCESSED', async () => {
    const wallet = await openWallet(api.base);
    const bet = wager(wallet, 'BET', '500.00');
    const id = await pending(reverse(wallet, 'REFUND', '500.00', bet));
    expect((await submit(bet)).body.failureCode).toBe('INSUFFICIENT_FUNDS');

    expect(await drainReferences(testWorker(orm).worker)).toMatchObject({ rejected: 1 });
    expect(await schedule(orm, id)).toMatchObject({ status: 'REJECTED', failureCode: 'REFERENCE_NOT_PROCESSED' });
    await expectWallet(wallet.id, '100.00', 1);
  });

  test('cadeia: o ROLLBACK de um REFUND pendente é resolvido depois do REFUND', async () => {
    const wallet = await openWallet(api.base);
    const bet = wager(wallet, 'BET', '25.00');
    const refund = reverse(wallet, 'REFUND', '25.00', bet);
    const refundId = await pending(refund);
    const rollbackId = await pending(reverse(wallet, 'ROLLBACK', '25.00', refund));
    expect((await submit(bet)).status).toBe(200);

    // O REFUND resolvido acorda o ROLLBACK na mesma transação; o próximo ciclo do mesmo worker o processa.
    expect(await drainReferences(testWorker(orm).worker)).toMatchObject({ processed: 2, pending: 0 });
    expect((await schedule(orm, refundId)).status).toBe('PROCESSED');
    expect((await schedule(orm, rollbackId)).status).toBe('PROCESSED');
    await expectWallet(wallet.id, '75.00', 4);
    expect((await financialState(orm, wallet.id)).ledger).toEqual({ CREDIT: 2, DEBIT: 2 });
  });
});

describe('workers concorrentes e falhas', () => {
  test('dois workers simultâneos resolvem cada pendência uma única vez', async () => {
    const wallets = await Promise.all(Array.from({ length: 12 }, () => openWallet(api.base)));
    for (const wallet of wallets) {
      const bet = wager(wallet, 'BET', '25.00');
      await pending(reverse(wallet, 'REFUND', '25.00', bet));
      expect((await submit(bet)).status).toBe(200);
    }
    const second = await connectDisposableDatabase(readConfig().DATABASE_URL);
    try {
      let otherClaimed!: () => void;
      const overlap = new Promise<void>((resolve) => { otherClaimed = resolve; });
      let firstClaim = true;
      // A só resolve o primeiro claim depois que B reivindicou o seu: os dois lotes coexistem.
      const a = testWorker(orm, { batchSize: 3, hooks: { beforeResolve: async () => {
        if (!firstClaim) return;
        firstClaim = false;
        await Promise.race([overlap, Bun.sleep(5000)]);
      } } });
      const b = testWorker(second, { batchSize: 3, hooks: { beforeResolve: async () => { otherClaimed(); } } });

      const [fromA, fromB] = await Promise.all([drainReferences(a.worker), drainReferences(b.worker)]);
      expect(fromA.processed).toBeGreaterThan(0);
      expect(fromB.processed).toBeGreaterThan(0);
      expect(fromA.processed + fromB.processed).toBe(12);
      expect(fromA.skipped + fromB.skipped + fromA.failed + fromB.failed).toBe(0);
      for (const wallet of wallets) {
        await expectWallet(wallet.id, '100.00', 3);
        expect((await financialState(orm, wallet.id)).ledger).toEqual({ CREDIT: 2, DEBIT: 1 });
      }
    } finally {
      await second.close(true);
    }
  });

  test('worker antigo depois da lease não aplica a resolução que outro assumiu', async () => {
    const wallet = await openWallet(api.base);
    const bet = wager(wallet, 'BET', '25.00');
    const id = await pending(reverse(wallet, 'REFUND', '25.00', bet));
    expect((await submit(bet)).status).toBe(200);

    let paused!: () => void;
    const claimedByStale = new Promise<void>((resolve) => { paused = resolve; });
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    const stale = testWorker(orm, { hooks: { beforeResolve: async () => { paused(); await gate; } } });
    const staleRun = stale.worker.runOnce();
    await claimedByStale;

    expect(await drainReferences(testWorker(orm, { clock: AFTER_LEASE }).worker)).toMatchObject({ claimed: 1, processed: 1 });
    resume();
    expect(await staleRun).toMatchObject({ claimed: 1, skipped: 1, processed: 0 });
    expect(await schedule(orm, id)).toMatchObject({ status: 'PROCESSED', attempts: 1 });
    await expectWallet(wallet.id, '100.00', 3);
    expect((await financialState(orm, wallet.id)).ledger).toEqual({ CREDIT: 2, DEBIT: 1 });
  });

  test('processo morto antes do commit: nada é aplicado e outro worker conclui depois da lease', async () => {
    const wallet = await openWallet(api.base);
    const bet = wager(wallet, 'BET', '25.00');
    const id = await pending(reverse(wallet, 'REFUND', '25.00', bet));
    expect((await submit(bet)).status).toBe(200);

    const child = Bun.spawn([process.execPath, '--no-env-file', 'tests/support/crash-reference-worker.ts'], {
      env: process.env, stdout: 'pipe', stderr: 'pipe',
    });
    expect(await child.exited).not.toBe(0);
    expect(await new Response(child.stdout).text()).not.toContain('committed');
    expect(await schedule(orm, id)).toMatchObject({ status: 'PENDING_REFERENCE', attempts: 0, claimed: true, resolvedAt: null });
    await expectWallet(wallet.id, '75.00', 2);

    expect((await drainReferences(testWorker(orm).worker)).claimed).toBe(0);
    expect(await drainReferences(testWorker(orm, { clock: AFTER_LEASE }).worker)).toMatchObject({ claimed: 1, processed: 1 });
    await expectWallet(wallet.id, '100.00', 3);
    expect((await financialState(orm, wallet.id)).ledger).toEqual({ CREDIT: 2, DEBIT: 1 });
  });

  test('agenda resolvida é definitiva e só se resolve com a transação terminal', async () => {
    const wallet = await openWallet(api.base);
    const bet = wager(wallet, 'BET', '25.00');
    const resolved = await pending(reverse(wallet, 'REFUND', '25.00', bet));
    const open = await pending(reverse(wallet, 'ROLLBACK', '10.00', wager(wallet, 'WIN', '10.00')));
    expect((await submit(bet)).status).toBe(200);
    await drainReferences(testWorker(orm).worker);
    await drainReferences(testWorker(orm, { clock: new ShiftedClock(5) }).worker);
    expect((await schedule(orm, open)).attempts).toBe(1);

    const em = orm.em.fork();
    for (const [sql, params] of [
      ['update pending_references set next_attempt_at = now() where transaction_id = ?', [resolved]],
      ['update pending_references set resolved_at = now() where transaction_id = ?', [open]],
      ['update pending_references set attempts = 0 where transaction_id = ?', [open]],
      ['update pending_references set deadline_at = now() where transaction_id = ?', [open]],
    ] as const) await expect(em.execute(sql, [...params])).rejects.toThrow();
    expect((await schedule(orm, open)).status).toBe('PENDING_REFERENCE');
  });
});

describe('processo do worker', () => {
  // Windows não entrega SIGTERM a handlers; a CI em Linux executa este caso com o processo real.
  test.skipIf(process.platform === 'win32')('SIGTERM encerra com código 0 depois da resolução em andamento', async () => {
    const child = Bun.spawn([process.execPath, '--no-env-file', 'src/reference-worker.ts'], { env: { ...process.env, METRICS_PORT: '0' }, stdout: 'pipe', stderr: 'pipe' });
    const reader = child.stdout.getReader();
    let output = '';
    while (!output.includes('reference_worker_started')) {
      const chunk = await reader.read();
      if (chunk.done) break;
      output += new TextDecoder().decode(chunk.value);
    }
    child.kill('SIGTERM');
    expect(await child.exited).toBe(0);
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) output += new TextDecoder().decode(chunk.value);
    expect(output).toContain('reference_worker_stopping');
    expect(output).toContain('reference_worker_stopped');
  });
});
