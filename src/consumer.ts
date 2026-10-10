import 'reflect-metadata';
import { MikroORM } from '@mikro-orm/postgresql';
import { assertRuntimeRole, createWageringService } from './bootstrap';
import { readConfig, readMessagingConfig } from './config';
import { Sha256PayloadHasher } from './infrastructure/identity';
import { logEvent, Metrics } from './infrastructure/observability';
import { databaseConfig } from './infrastructure/postgres/config';
import { createSqsClient, queueUrl } from './infrastructure/sqs/client';
import { DEFAULT_CONSUMER_SETTINGS, SqsConsumer } from './sqs/consumer';

// Processo independente da API: pool, contexto ORM e lifecycle próprios, mesmo caso de uso financeiro.
let orm: MikroORM | undefined;
const messaging = readMessagingConfig();
const sqs = createSqsClient(messaging);
try {
  orm = await MikroORM.init(databaseConfig(readConfig().DATABASE_URL));
  await assertRuntimeRole(orm);
  const consumer = new SqsConsumer(sqs, createWageringService(orm), new Sha256PayloadHasher(), {
    ...DEFAULT_CONSUMER_SETTINGS, consumerName: messaging.SQS_CONSUMER_NAME,
    queueUrl: await queueUrl(sqs, messaging.SQS_COMMAND_QUEUE), deadLetterQueueUrl: await queueUrl(sqs, messaging.SQS_DEAD_LETTER_QUEUE),
  }, new Metrics());
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      logEvent('consumer_stopping', { signal });
      void consumer.stop();
    });
  }
  logEvent('consumer_started', { consumerName: messaging.SQS_CONSUMER_NAME, queue: messaging.SQS_COMMAND_QUEUE });
  await consumer.start();
  logEvent('consumer_stopped');
} catch {
  logEvent('startup_failed', { message: 'Check environment, database role, queues and connectivity.' });
  process.exitCode = 1;
} finally {
  sqs.destroy();
  await orm?.close(true);
}
