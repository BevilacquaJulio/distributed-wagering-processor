import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { WageringService } from '../../src/application/wagering-service';
import { Sha256PayloadHasher, SystemClock, UnauthenticatedProviderIdentity, UuidGenerator } from '../../src/infrastructure/identity';
import { startMetricsServer } from '../../src/infrastructure/metrics-server';
import { Metrics } from '../../src/infrastructure/observability';
import { PostgresUnitOfWork } from '../../src/infrastructure/postgres/unit-of-work';
import { queueDepth } from '../../src/infrastructure/sqs/client';
import { openWallet, send, startTestApi, type TestApi, wager } from '../support/api';
import { createTestQueues, sendBody, receiveOne, type TestQueues, testConsumer, testSqs } from '../support/sqs';

let api: TestApi;
let orm: MikroORM;
let sqs: SQSClient;
let queues: TestQueues;

beforeAll(async () => {
  api = await startTestApi();
  orm = api.orm;
  sqs = testSqs();
  queues = await createTestQueues(sqs);
});

afterAll(async () => {
  await queues?.remove();
  sqs?.destroy();
  await api?.close();
});

const sample = (output: string, series: string): number => {
  const found = output.split('\n').find((line) => line.startsWith(`${series} `));
  if (!found) throw new Error(`Series ${series} not exposed`);
  return Number(found.slice(series.length + 1));
};

async function readUntil(stream: ReadableStream<Uint8Array>, marker: string): Promise<string> {
  const reader = stream.getReader();
  let output = '';
  while (!output.includes(marker)) {
    const chunk = await reader.read();
    if (chunk.done) break;
    output += new TextDecoder().decode(chunk.value);
  }
  reader.releaseLock();
  return output;
}

describe('métricas da API', () => {
  test('resultados, duplicatas, latência e backlog lido do banco', async () => {
    const before = await (await send(api.base, '/metrics')).text();
    const target = await openWallet(api.base);
    const command = wager(target);
    const key = randomUUID();
    expect((await send(api.base, '/wagering/transactions', 'POST', command, key)).status).toBe(200);
    expect((await send(api.base, '/wagering/transactions', 'POST', command, key)).status).toBe(200);

    const response = await send(api.base, '/metrics');
    expect(response.headers.get('content-type')).toContain('text/plain');
    const after = await response.text();
    expect(sample(after, 'wagering_transactions_total{status="PROCESSED"}') - sample(before, 'wagering_transactions_total{status="PROCESSED"}')).toBe(1);
    expect(sample(after, 'wagering_duplicates_total{source="http"}') - sample(before, 'wagering_duplicates_total{source="http"}')).toBe(1);
    expect(sample(after, 'wagering_unit_duration_seconds_count')).toBeGreaterThan(sample(before, 'wagering_unit_duration_seconds_count'));
    expect(sample(after, 'wagering_backlog_scrape_success')).toBe(1);
    // A BET acabou de gravar eventos e nenhum publisher roda nesta suíte: a outbox tem pendência com idade observável.
    expect(sample(after, 'outbox_pending_events')).toBeGreaterThanOrEqual(2);
    expect(sample(after, 'outbox_oldest_pending_age_seconds')).toBeGreaterThanOrEqual(0);
    for (const gauge of ['pending_references_open', 'pending_references_oldest_age_seconds', 'pending_references_overdue']) {
      expect(sample(after, gauge)).toBeGreaterThanOrEqual(0);
    }
    expect(after).not.toContain(target.id);
  });

  test('divergência entre saldo e ledger é sinalizada, contada e não corrigida', async () => {
    const target = await openWallet(api.base);
    const before = sample(await (await send(api.base, '/metrics')).text(), 'wagering_reconciliation_divergences_total');
    // Escrita fora do caso de uso: o saldo é coluna mutável do runtime, mas o ledger não acompanha.
    await orm.em.fork().execute('update wallets set balance = balance + 1 where id = ?', [target.id]);

    const response = await send(api.base, `/wallets/${target.id}/reconciliation`, 'POST');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ consistent: false, storedBalance: { amount: '101.00' },
      calculatedBalance: { amount: '100.00' }, difference: { amount: '1.00' } });
    expect(sample(await (await send(api.base, '/metrics')).text(), 'wagering_reconciliation_divergences_total')).toBe(before + 1);
    expect((await (await send(api.base, `/wallets/${target.id}`)).json() as { balance: { amount: string } }).balance.amount).toBe('101.00');
  });

  test('conflito de lock é contado e a unidade é repetida', async () => {
    const metrics = new Metrics();
    let failures = 1;
    const unitOfWork = new PostgresUnitOfWork(orm, async () => {
      if (failures-- > 0) throw Object.assign(new Error('could not serialize access'), { code: '40001' });
    }, metrics);
    const wagering = new WageringService(unitOfWork, new SystemClock(), new UuidGenerator(), new Sha256PayloadHasher(),
      new UnauthenticatedProviderIdentity());
    const wallet = await wagering.openWallet(randomUUID(), { amount: '10.00', currency: 'BRL' }, 'lock-test');
    expect(wallet.balance.amount).toBe('10.00');
    expect([metrics.value('lock_conflict'), metrics.value('lock_retry')]).toEqual([1, 1]);
    expect(sample(metrics.render(), 'wagering_retries_total{origin="lock"}')).toBe(1);
    expect(sample(metrics.render(), 'wagering_unit_duration_seconds_count')).toBe(1);
  });
});

describe('métricas dos processos sem API', () => {
  test('servidor de métricas expõe /metrics e /health/live e não derruba a coleta quando um gauge falha', async () => {
    const metrics = new Metrics();
    metrics.increment('event_published');
    let fail = false;
    const server = startMetricsServer(metrics, '127.0.0.1', 0, async () => {
      if (fail) throw new Error('broker down');
      return [{ name: 'sqs_dead_letter_queue_messages', help: 'DLQ depth.', value: 3 }];
    });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const body = await (await fetch(`${base}/metrics`)).text();
      expect(sample(body, 'outbox_events_published_total')).toBe(1);
      expect(sample(body, 'sqs_dead_letter_queue_messages')).toBe(3);
      fail = true;
      const degraded = await fetch(`${base}/metrics`);
      expect(degraded.status).toBe(200);
      expect(await degraded.text()).not.toContain('sqs_dead_letter_queue_messages');
      expect(await (await fetch(`${base}/health/live`)).json()).toEqual({ status: 'up' });
      expect((await fetch(`${base}/other`)).status).toBe(404);
      expect((await fetch(`${base}/metrics`, { method: 'POST' })).status).toBe(405);
    } finally {
      await server.stop();
    }
  });

  test('profundidade da DLQ consultada no broker acompanha o envio do consumidor', async () => {
    const consumer = testConsumer(sqs, orm, queues);
    await sendBody(sqs, queues.url, 'not json');
    expect(await consumer.handle(await receiveOne(sqs, queues.url))).toBe('dead_letter');
    expect(await queueDepth(sqs, queues.deadLetterUrl)).toBe(1);
  });

  test('processo real do worker publica /metrics na porta própria', async () => {
    const child = Bun.spawn([process.execPath, '--no-env-file', 'src/reference-worker.ts'], {
      env: { ...process.env, METRICS_PORT: '0' }, stdout: 'pipe', stderr: 'pipe',
    });
    try {
      const output = await readUntil(child.stdout, 'reference_worker_started');
      const started = output.split('\n').find((line) => line.includes('"metrics_server_started"'));
      const port = (JSON.parse(started ?? '{}') as { port?: number }).port;
      expect(port).toBeGreaterThan(0);
      const body = await (await fetch(`http://127.0.0.1:${port}/metrics`)).text();
      expect(body).toContain('# TYPE pending_references_resolved_total counter');
      expect(body).toContain('# TYPE wagering_unit_duration_seconds histogram');
    } finally {
      child.kill();
      await child.exited;
    }
  });
});
