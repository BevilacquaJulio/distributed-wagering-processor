import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { ApplicationError } from '../../src/application/errors';
import type { TransactionResult } from '../../src/application/ports';
import { WageringService } from '../../src/application/wagering-service';
import { Sha256PayloadHasher, SystemClock, UnauthenticatedProviderIdentity, UuidGenerator } from '../../src/infrastructure/identity';
import { Metrics } from '../../src/infrastructure/observability';
import { PostgresQueries } from '../../src/infrastructure/postgres/queries';
import { PostgresUnitOfWork } from '../../src/infrastructure/postgres/unit-of-work';
import { SqsConsumer } from '../../src/sqs/consumer';
import { financialState, openWallet, send, startTestApi, type TestApi, wager } from '../support/api';
import { createTestQueues, envelope, queueDepth, receive, receiveOne, sendBody, type TestQueues, testConsumer, testSqs } from '../support/sqs';

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

const wallet = (amount = '100.00') => openWallet(api.base, amount);

async function deliver(body: string, consumer = testConsumer(sqs, orm, queues)) {
  await sendBody(sqs, queues.url, body);
  return consumer.handle(await receiveOne(sqs, queues.url));
}

async function inbox(messageId: string) {
  return orm.em.fork().execute<{ transactionId: string | null; processed: boolean }[]>(`
    select transaction_id as "transactionId", processed_at is not null as processed
    from inbox_messages where consumer_name = 'test-consumer' and message_id = ?`, [messageId]);
}

async function expectEmpty(url: string): Promise<void> {
  expect(await queueDepth(sqs, url)).toEqual({ visible: 0, inFlight: 0 });
}

async function deadLetters() {
  const messages = await receive(sqs, queues.deadLetterUrl, 2);
  return messages.map((message) => message.MessageAttributes?.failureReason?.StringValue ?? 'broker-redrive');
}

describe('consumo da fila de comandos', () => {
  test('mensagem processada uma vez: commit, inbox e ack', async () => {
    const target = await wallet();
    const messageId = randomUUID();
    expect(await deliver(envelope(wager(target), randomUUID(), messageId))).toBe('processed');
    await expectEmpty(queues.url);
    const [record] = await inbox(messageId);
    expect(record?.processed).toBe(true);
    expect((await new PostgresQueries(orm).wallet(target.id)).balance.amount).toBe('75.00');
  });

  test('redelivery da mesma mensagem não repete o efeito', async () => {
    const target = await wallet();
    const body = envelope(wager(target), randomUUID());
    expect(await deliver(body)).toBe('processed');
    expect(await deliver(body)).toBe('duplicate');
    await expectEmpty(queues.url);
    expect((await financialState(orm, target.id)).ledger).toEqual({ CREDIT: 1, DEBIT: 1 });
  });

  test('operação já feita por HTTP é replay na fila, com a mesma identidade', async () => {
    const target = await wallet();
    const command = wager(target);
    const key = randomUUID();
    const response = await send(api.base, '/wagering/transactions', 'POST', command, key);
    const viaHttp = await response.json() as TransactionResult;
    const messageId = randomUUID();
    expect(await deliver(envelope(command, key, messageId))).toBe('duplicate');
    expect((await inbox(messageId))[0]?.transactionId).toBe(viaHttp.transactionId);
    expect((await financialState(orm, target.id)).ledger).toEqual({ CREDIT: 1, DEBIT: 1 });
  });

  test('rejeição de negócio é terminal: persistida e confirmada, sem DLQ', async () => {
    const target = await wallet('10.00');
    expect(await deliver(envelope(wager(target, 'BET', '50.00'), randomUUID()))).toBe('processed');
    await expectEmpty(queues.url);
    expect((await financialState(orm, target.id)).transactions).toEqual({ 'OPENING:PROCESSED': 1, 'BET:REJECTED': 1 });
  });

  test('mensagens sem identidade utilizável ou conflitantes vão para a DLQ com motivo', async () => {
    const target = await wallet();
    const messageId = randomUUID();
    const key = randomUUID();
    const command = wager(target);
    expect(await deliver(envelope(command, key, messageId))).toBe('processed');
    expect(await deliver(envelope({ ...command, money: { amount: '30.00', currency: 'BRL' } }, key, messageId))).toBe('dead_letter');
    expect(await deliver(envelope({ ...command, money: { amount: '30.00', currency: 'BRL' } }, key))).toBe('dead_letter');
    expect(await deliver('not json')).toBe('dead_letter');
    expect(await deliver(JSON.stringify({ messageId: randomUUID(), type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(),
      data: { ...command, kind: 'OPENING', idempotencyKey: randomUUID() } }))).toBe('dead_letter');

    expect(await deadLetters()).toEqual(['INBOX_CONFLICT', 'IDEMPOTENCY_CONFLICT', 'INVALID_ENVELOPE', 'INVALID_ENVELOPE']);
    await expectEmpty(queues.url);
    expect((await financialState(orm, target.id)).ledger).toEqual({ CREDIT: 1, DEBIT: 1 });
  });
});

describe('falhas transitórias e redrive', () => {
  function failingConsumer(target: TestQueues, failures: { remaining: number }): SqsConsumer {
    const unitOfWork = new PostgresUnitOfWork(orm, async () => {
      if (failures.remaining <= 0) return;
      failures.remaining -= 1;
      throw new ApplicationError('INFRASTRUCTURE_UNAVAILABLE');
    });
    const wagering = new WageringService(unitOfWork, new SystemClock(), new UuidGenerator(), new Sha256PayloadHasher(), new UnauthenticatedProviderIdentity());
    return new SqsConsumer(sqs, wagering, new Sha256PayloadHasher(), { consumerName: 'test-consumer', queueUrl: target.url,
      deadLetterQueueUrl: target.deadLetterUrl, waitTimeSeconds: 1, maxMessages: 10, retryBaseSeconds: 1, retryMaxSeconds: 1 }, new Metrics());
  }

  test('falha transitória não confirma; a reentrega processa uma única vez', async () => {
    const target = await wallet();
    const messageId = randomUUID();
    await sendBody(sqs, queues.url, envelope(wager(target), randomUUID(), messageId));
    expect(await failingConsumer(queues, { remaining: 1 }).handle(await receiveOne(sqs, queues.url))).toBe('retry');
    expect(await inbox(messageId)).toEqual([]);

    const redelivered = await receiveOne(sqs, queues.url, 6);
    expect(redelivered.Attributes?.ApproximateReceiveCount).toBe('2');
    expect(await testConsumer(sqs, orm, queues).handle(redelivered)).toBe('processed');
    expect((await financialState(orm, target.id)).ledger).toEqual({ CREDIT: 1, DEBIT: 1 });
    await expectEmpty(queues.url);
  });

  test('falha persistente esgota maxReceiveCount e o broker move para a DLQ', async () => {
    const isolated = await createTestQueues(sqs, 1, 2);
    try {
      const target = await wallet();
      await sendBody(sqs, isolated.url, envelope(wager(target), randomUUID()));
      const failing = failingConsumer(isolated, { remaining: 10 });
      expect(await failing.handle(await receiveOne(sqs, isolated.url))).toBe('retry');
      expect(await failing.handle(await receiveOne(sqs, isolated.url, 6))).toBe('retry');
      expect(await receive(sqs, isolated.url, 4)).toEqual([]);
      const dead = await receiveOne(sqs, isolated.deadLetterUrl, 4);
      expect(dead.MessageAttributes?.failureReason).toBeUndefined();
      expect((await new PostgresQueries(orm).wallet(target.id)).balance.amount).toBe('100.00');
    } finally {
      await isolated.remove();
    }
  });
});

describe('shutdown e crash', () => {
  test('stop interrompe o long polling e devolve a visibilidade do que não começou', async () => {
    const target = await wallet();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let proceed!: () => void;
    const gate = new Promise<void>((resolve) => { proceed = resolve; });
    let handled = 0;
    const consumer = testConsumer(sqs, orm, queues, { beforeHandle: async () => {
      handled += 1;
      if (handled === 1) { entered(); await gate; }
    } });
    for (let index = 0; index < 3; index++) await sendBody(sqs, queues.url, envelope(wager(target, 'BET', '10.00'), randomUUID()));

    const running = consumer.start();
    await started;
    const stopping = consumer.stop();
    proceed();
    await stopping;
    await running;

    expect(handled).toBe(1);
    expect((await new PostgresQueries(orm).wallet(target.id)).balance.amount).toBe('90.00');
    const returned = await receive(sqs, queues.url, 1);
    expect(returned).toHaveLength(2);
    for (const message of returned) expect(await testConsumer(sqs, orm, queues).handle(message)).toBe('processed');
    expect((await new PostgresQueries(orm).wallet(target.id)).balance.amount).toBe('70.00');

    const idle = testConsumer(sqs, orm, queues, {}, { waitTimeSeconds: 20 });
    const idleRun = idle.start();
    const before = Date.now();
    await idle.stop();
    await idleRun;
    expect(Date.now() - before).toBeLessThan(3000);
  });

  // Windows não entrega SIGTERM a handlers; a CI em Linux executa este caso com o processo real do consumidor.
  test.skipIf(process.platform === 'win32')('SIGTERM no processo real encerra com código 0 depois do stop', async () => {
    const child = Bun.spawn([process.execPath, '--no-env-file', 'src/consumer.ts'], { env: process.env, stdout: 'pipe', stderr: 'pipe' });
    const reader = child.stdout.getReader();
    let output = '';
    while (!output.includes('consumer_started')) {
      const chunk = await reader.read();
      if (chunk.done) break;
      output += new TextDecoder().decode(chunk.value);
    }
    child.kill('SIGTERM');
    expect(await child.exited).toBe(0);
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) output += new TextDecoder().decode(chunk.value);
    expect(output).toContain('consumer_stopping');
    expect(output).toContain('consumer_stopped');
  });

  test('processo morto depois do commit e antes do ack: a reentrega não reaplica', async () => {
    const target = await wallet();
    const messageId = randomUUID();
    await sendBody(sqs, queues.url, envelope(wager(target), randomUUID(), messageId));
    const child = Bun.spawn([process.execPath, '--no-env-file', 'tests/support/crash-consumer.ts'], {
      env: { ...process.env, CRASH_QUEUE_URL: queues.url, CRASH_DEAD_LETTER_URL: queues.deadLetterUrl }, stdout: 'pipe', stderr: 'pipe',
    });
    expect(await child.exited).not.toBe(0);
    expect(await new Response(child.stdout).text()).not.toContain('acked');
    expect((await inbox(messageId))[0]?.processed).toBe(true);
    expect((await queueDepth(sqs, queues.url)).visible + (await queueDepth(sqs, queues.url)).inFlight).toBe(1);

    const redelivered = await receiveOne(sqs, queues.url, 6);
    expect(await testConsumer(sqs, orm, queues).handle(redelivered)).toBe('duplicate');
    expect((await financialState(orm, target.id)).ledger).toEqual({ CREDIT: 1, DEBIT: 1 });
    expect((await new PostgresQueries(orm).wallet(target.id)).balance.amount).toBe('75.00');
    await expectEmpty(queues.url);
  });
});
