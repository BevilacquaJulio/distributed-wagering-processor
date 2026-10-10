import 'reflect-metadata';
import { MikroORM } from '@mikro-orm/postgresql';
import { assertRuntimeRole } from './bootstrap';
import { readConfig, readMessagingConfig, readMetricsConfig } from './config';
import { SystemClock, UuidGenerator } from './infrastructure/identity';
import { type MetricsServer, startMetricsServer } from './infrastructure/metrics-server';
import { logEvent, Metrics } from './infrastructure/observability';
import { databaseConfig } from './infrastructure/postgres/config';
import { PostgresOutboxStore } from './infrastructure/postgres/outbox';
import { createSqsClient, queueUrl } from './infrastructure/sqs/client';
import { DEFAULT_PUBLISHER_SETTINGS, OutboxPublisher } from './sqs/publisher';

// Processo independente: várias instâncias podem rodar juntas, coordenadas pelo claim com lease na outbox.
let orm: MikroORM | undefined;
let metricsServer: MetricsServer | undefined;
const messaging = readMessagingConfig();
const metricsConfig = readMetricsConfig(9102);
const metrics = new Metrics();
const sqs = createSqsClient(messaging);
try {
  orm = await MikroORM.init(databaseConfig(readConfig().DATABASE_URL));
  await assertRuntimeRole(orm);
  const publisher = new OutboxPublisher(sqs, new PostgresOutboxStore(orm), new SystemClock(), new UuidGenerator(), {
    ...DEFAULT_PUBLISHER_SETTINGS, queueUrl: await queueUrl(sqs, messaging.SQS_EVENT_QUEUE),
  }, metrics);
  metricsServer = startMetricsServer(metrics, metricsConfig.host, metricsConfig.port);
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      logEvent('publisher_stopping', { signal });
      void publisher.stop();
    });
  }
  logEvent('publisher_started', { queue: messaging.SQS_EVENT_QUEUE });
  await publisher.start();
  logEvent('publisher_stopped');
} catch {
  logEvent('startup_failed', { message: 'Check environment, database role, queues and connectivity.' });
  process.exitCode = 1;
} finally {
  await metricsServer?.stop();
  sqs.destroy();
  await orm?.close(true);
}
