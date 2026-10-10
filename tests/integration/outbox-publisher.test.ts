import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { readConfig } from '../../src/config';
import type { WalletState } from '../../src/domain/wallet';
import { DEFAULT_PUBLISHER_SETTINGS } from '../../src/sqs/publisher';
import { openWallet, send, startTestApi, type TestApi, wager } from '../support/api';
import { connectDisposableDatabase } from '../support/database';
import { collect, createEventQueue, drain, type EventQueue, outboxState, ShiftedClock, testPublisher } from '../support/outbox';
import { testSqs } from '../support/sqs';

const AFTER_LEASE = new ShiftedClock(DEFAULT_PUBLISHER_SETTINGS.leaseSeconds + 1);

let api: TestApi;
let orm: MikroORM;
let sqs: SQSClient;
let queue: EventQueue;

beforeAll(async () => {
  api = await startTestApi();
  orm = api.orm;
  sqs = testSqs();
  queue = await createEventQueue(sqs);
  // O banco descartável acumula eventos de outras suítes: publicá-los de verdade numa fila à parte isola os cenários.
  const backlog = await createEventQueue(sqs);
  try {
    await drain(testPublisher(sqs, orm, backlog.url, { clock: new ShiftedClock(86_400) }).publisher);
  } finally {
    await backlog.remove();
  }
});

afterAll(async () => {
  await queue?.remove();
  sqs?.destroy();
  await api?.close();
});

/** Wallet aberta e uma BET processada: quatro eventos (Processed e BalanceChanged de cada operação). */
async function walletWithBet(): Promise<WalletState> {
  const target = await openWallet(api.base);
  expect((await send(api.base, '/wagering/transactions', 'POST', wager(target), randomUUID())).status).toBe(200);
  return target;
}

const ids = (events: readonly { envelope: { eventId: string } }[]) => events.map((event) => event.envelope.eventId);

function spawnCrashPublisher(point: 'before-send' | 'after-send') {
  return Bun.spawn([process.execPath, '--no-env-file', 'tests/support/crash-publisher.ts'], {
    env: { ...process.env, CRASH_EVENT_QUEUE_URL: queue.url, CRASH_POINT: point }, stdout: 'pipe', stderr: 'pipe',
  });
}

describe('publicação da outbox', () => {
  test('publica após o commit, em ordem por wallet, com eventId, tipo e grupo, e marca publishedAt', async () => {
    const target = await walletWithBet();
    const { publisher } = testPublisher(sqs, orm, queue.url);
    expect(await drain(publisher)).toEqual({ claimed: 4, published: 4, failed: 0, ownershipLost: 0 });

    const stored = await outboxState(orm, [target.id]);
    const received = await collect(sqs, queue.url);
    expect(ids(received)).toEqual(stored.map((event) => event.id));
    for (const { envelope, message } of received) {
      expect(envelope.aggregateId).toBe(target.id);
      expect(message.Attributes?.MessageGroupId).toBe(target.id);
      expect(message.Attributes?.MessageDeduplicationId).toBe(envelope.eventId);
      expect(message.MessageAttributes?.eventType?.StringValue).toBe(envelope.eventType);
    }
    // Abertura grava Processed antes do saldo; a BET grava o saldo antes do resultado terminal.
    expect(received.map(({ envelope }) => envelope.eventType)).toEqual(
      ['WagerTransactionProcessed', 'WalletBalanceChanged', 'WalletBalanceChanged', 'WagerTransactionProcessed']);
    for (const event of stored) expect(event).toMatchObject({ attempts: 1, claimed: false, lastError: null, publishedAt: expect.any(String) });
    expect(await drain(publisher)).toEqual({ claimed: 0, published: 0, failed: 0, ownershipLost: 0 });
  });

  test('dois publishers simultâneos dividem os eventos sem enviar nenhum duas vezes', async () => {
    const wallets = await Promise.all(Array.from({ length: 8 }, walletWithBet));
    const second = await connectDisposableDatabase(readConfig().DATABASE_URL);
    try {
      let otherClaimed!: () => void;
      const overlap = new Promise<void>((resolve) => { otherClaimed = resolve; });
      const sent: string[] = [];
      const record = async (events: readonly { envelope: { eventId: string } }[]) => { sent.push(...ids(events)); };
      let firstBatch = true;
      // O primeiro lote de A só é enviado depois que B reivindicou o seu: os dois claims coexistem antes da confirmação.
      const a = testPublisher(sqs, orm, queue.url, { settings: { batchSize: 5 }, hooks: { afterSend: record, beforeSend: async () => {
        if (!firstBatch) return;
        firstBatch = false;
        await Promise.race([overlap, Bun.sleep(5000)]);
      } } });
      const b = testPublisher(sqs, second, queue.url, { settings: { batchSize: 5 }, hooks: { afterSend: record,
        beforeSend: async () => { otherClaimed(); } } });

      const [fromA, fromB] = await Promise.all([drain(a.publisher), drain(b.publisher)]);
      expect(fromA.published).toBeGreaterThan(0);
      expect(fromB.published).toBeGreaterThan(0);
      expect(fromA.published + fromB.published).toBe(32);
      expect(fromA.ownershipLost + fromB.ownershipLost + fromA.failed + fromB.failed).toBe(0);
      expect(sent).toHaveLength(32);
      expect(new Set(sent).size).toBe(32);

      const stored = await outboxState(orm, wallets.map((target) => target.id));
      expect(new Set(sent)).toEqual(new Set(stored.map((event) => event.id)));
      for (const event of stored) expect(event).toMatchObject({ attempts: 1, claimed: false, publishedAt: expect.any(String) });
      const received = await collect(sqs, queue.url);
      expect(received).toHaveLength(32);
      expect(new Set(ids(received))).toEqual(new Set(sent));
    } finally {
      await second.close(true);
    }
  });
});

describe('falhas e recuperação', () => {
  test('crash depois do claim e antes do envio: a lease vence e outro publisher entrega', async () => {
    const target = await walletWithBet();
    const child = spawnCrashPublisher('before-send');
    expect(await child.exited).not.toBe(0);
    expect(await new Response(child.stdout).text()).not.toContain('confirmed');
    expect((await outboxState(orm, [target.id])).every((event) => event.claimed && event.publishedAt === null)).toBe(true);
    expect(await collect(sqs, queue.url)).toEqual([]);

    // Dentro da lease ninguém mais assume o evento.
    expect((await drain(testPublisher(sqs, orm, queue.url).publisher)).claimed).toBe(0);
    expect(await drain(testPublisher(sqs, orm, queue.url, { clock: AFTER_LEASE }).publisher))
      .toEqual({ claimed: 4, published: 4, failed: 0, ownershipLost: 0 });
    const stored = await outboxState(orm, [target.id]);
    for (const event of stored) expect(event).toMatchObject({ attempts: 2, claimed: false, publishedAt: expect.any(String) });
    expect(ids(await collect(sqs, queue.url))).toEqual(stored.map((event) => event.id));
  });

  test('crash depois do envio e antes de publishedAt: o reenvio mantém o mesmo eventId', async () => {
    const target = await walletWithBet();
    const child = spawnCrashPublisher('after-send');
    expect(await child.exited).not.toBe(0);
    expect(await new Response(child.stdout).text()).not.toContain('confirmed');
    expect((await outboxState(orm, [target.id])).every((event) => event.claimed && event.publishedAt === null)).toBe(true);

    expect(await drain(testPublisher(sqs, orm, queue.url, { clock: AFTER_LEASE }).publisher))
      .toEqual({ claimed: 4, published: 4, failed: 0, ownershipLost: 0 });
    const stored = await outboxState(orm, [target.id]);
    for (const event of stored) expect(event).toMatchObject({ attempts: 2, publishedAt: expect.any(String) });
    // O segundo envio usa a mesma deduplicação; se o broker não o descartar, a cópia tem identidade idêntica.
    const received = await collect(sqs, queue.url);
    expect(received.length).toBeGreaterThanOrEqual(4);
    expect(new Set(ids(received))).toEqual(new Set(stored.map((event) => event.id)));
  });

  test('publisher antigo depois da lease não confirma o claim que outro assumiu', async () => {
    const target = await walletWithBet();
    let paused!: () => void;
    const claimedByStale = new Promise<void>((resolve) => { paused = resolve; });
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    const stale = testPublisher(sqs, orm, queue.url, { hooks: { beforeSend: async () => { paused(); await gate; } } });

    const staleRun = stale.publisher.publishOnce();
    await claimedByStale;
    expect(await drain(testPublisher(sqs, orm, queue.url, { clock: AFTER_LEASE }).publisher))
      .toEqual({ claimed: 4, published: 4, failed: 0, ownershipLost: 0 });
    const confirmed = await outboxState(orm, [target.id]);

    resume();
    expect(await staleRun).toEqual({ claimed: 4, published: 0, failed: 0, ownershipLost: 4 });
    expect(stale.metrics.value('event_ownership_lost')).toBe(4);
    expect(await outboxState(orm, [target.id])).toEqual(confirmed);
    expect(new Set(ids(await collect(sqs, queue.url)))).toEqual(new Set(confirmed.map((event) => event.id)));
  });

  test('falha de envio reagenda com backoff crescente e nunca descarta o evento', async () => {
    const target = await walletWithBet();
    const missing = queue.url.replace(/[^/]+$/, `missing-${randomUUID().slice(0, 8)}.fifo`);
    const failing = testPublisher(sqs, orm, missing);
    expect(await drain(failing.publisher)).toEqual({ claimed: 4, published: 0, failed: 4, ownershipLost: 0 });
    expect(failing.metrics.value('event_publish_failed')).toBe(4);
    const first = await outboxState(orm, [target.id]);
    for (const event of first) {
      expect(event).toMatchObject({ attempts: 1, claimed: false, publishedAt: null, lastError: expect.any(String) });
      expect(Date.parse(event.nextAttemptAt ?? '')).toBeGreaterThan(Date.now());
    }
    // O backoff vale para todos os publishers, não só para quem falhou.
    expect((await drain(testPublisher(sqs, orm, queue.url).publisher)).claimed).toBe(0);

    for (const offset of [600, 1200]) await drain(testPublisher(sqs, orm, missing, { clock: new ShiftedClock(offset) }).publisher);
    const third = await outboxState(orm, [target.id]);
    for (const event of third) {
      expect(event).toMatchObject({ attempts: 3, publishedAt: null });
      // Terceira falha: 4s de backoff a partir do relógio deslocado em 1200s.
      expect(Date.parse(event.nextAttemptAt ?? '') - Date.now()).toBeGreaterThan(1200_000 + 3000);
    }

    expect(await drain(testPublisher(sqs, orm, queue.url, { clock: new ShiftedClock(3600) }).publisher))
      .toEqual({ claimed: 4, published: 4, failed: 0, ownershipLost: 0 });
    for (const event of await outboxState(orm, [target.id])) {
      expect(event).toMatchObject({ attempts: 4, publishedAt: expect.any(String), lastError: null });
    }
    expect(ids(await collect(sqs, queue.url))).toEqual(third.map((event) => event.id));
  });

  test('evento publicado não pode ser reaberto pelo papel runtime', async () => {
    const target = await walletWithBet();
    await drain(testPublisher(sqs, orm, queue.url).publisher);
    await collect(sqs, queue.url);
    const [event] = await outboxState(orm, [target.id]);
    const em = orm.em.fork();
    await expect(em.execute('update outbox_messages set published_at = null where id = ?', [event?.id])).rejects.toThrow();
    await expect(em.execute('update outbox_messages set payload = payload where id = ?', [event?.id])).rejects.toThrow();
    await expect(em.execute('delete from outbox_messages where id = ?', [event?.id])).rejects.toThrow();
    expect((await outboxState(orm, [target.id]))[0]).toEqual(event);
  });
});

describe('processo do publisher', () => {
  // Windows não entrega SIGTERM a handlers; a CI em Linux executa este caso com o processo real.
  test.skipIf(process.platform === 'win32')('SIGTERM encerra com código 0 depois do lote em andamento', async () => {
    const child = Bun.spawn([process.execPath, '--no-env-file', 'src/publisher.ts'], { env: process.env, stdout: 'pipe', stderr: 'pipe' });
    const reader = child.stdout.getReader();
    let output = '';
    while (!output.includes('publisher_started')) {
      const chunk = await reader.read();
      if (chunk.done) break;
      output += new TextDecoder().decode(chunk.value);
    }
    child.kill('SIGTERM');
    expect(await child.exited).toBe(0);
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) output += new TextDecoder().decode(chunk.value);
    expect(output).toContain('publisher_stopping');
    expect(output).toContain('publisher_stopped');
  });
});
