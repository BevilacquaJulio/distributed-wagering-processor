import 'reflect-metadata';
import { MikroORM } from '@mikro-orm/postgresql';
import { assertRuntimeRole, createWageringService } from './bootstrap';
import { readConfig, readMessagingConfig, readMetricsConfig } from './config';
import { Sha256PayloadHasher } from './infrastructure/identity';
import { type MetricsServer, startMetricsServer } from './infrastructure/metrics-server';
import { logEvent, Metrics } from './infrastructure/observability';
import { databaseConfig } from './infrastructure/postgres/config';
import { createSqsClient, queueDepth, queueUrl } from './infrastructure/sqs/client';
import { DEFAULT_CONSUMER_SETTINGS, SqsConsumer } from './sqs/consumer';

// Processo independente da API: pool, contexto ORM e lifecycle próprios, mesmo caso de uso financeiro.
let orm: MikroORM | undefined;
let metricsServer: MetricsServer | undefined;
const messaging = readMessagingConfig();
const metricsConfig = readMetricsConfig(9101);
const metrics = new Metrics();
const sqs = createSqsClient(messaging);
try {
  orm = await MikroORM.init(databaseConfig(readConfig().DATABASE_URL));
  await assertRuntimeRole(orm);
  const deadLetterQueueUrl = await queueUrl(sqs, messaging.SQS_DEAD_LETTER_QUEUE);
  const consumer = new SqsConsumer(sqs, createWageringService(orm, metrics), new Sha256PayloadHasher(), {
    ...DEFAULT_CONSUMER_SETTINGS, consumerName: messaging.SQS_CONSUMER_NAME,
    queueUrl: await queueUrl(sqs, messaging.SQS_COMMAND_QUEUE), deadLetterQueueUrl,
  }, metrics);
  // Profundidade consultada no broker: inclui o redrive automático, que o contador local não enxerga.
  metricsServer = startMetricsServer(metrics, metricsConfig.host, metricsConfig.port, async () => [{
    name: 'sqs_dead_letter_queue_messages', help: 'Messages currently in the dead-letter queue (broker value).',
    value: await queueDepth(sqs, deadLetterQueueUrl, AbortSignal.timeout(2000)),
  }]);
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
  await metricsServer?.stop();
  sqs.destroy();
  await orm?.close(true);
}
