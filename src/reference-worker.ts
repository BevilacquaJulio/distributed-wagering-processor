import 'reflect-metadata';
import { MikroORM } from '@mikro-orm/postgresql';
import { assertRuntimeRole, createWageringService } from './bootstrap';
import { readConfig, readMetricsConfig } from './config';
import { SystemClock, UuidGenerator } from './infrastructure/identity';
import { type MetricsServer, startMetricsServer } from './infrastructure/metrics-server';
import { logEvent, Metrics } from './infrastructure/observability';
import { databaseConfig } from './infrastructure/postgres/config';
import { PostgresPendingReferenceStore } from './infrastructure/postgres/pending-references';
import { DEFAULT_REFERENCE_WORKER_SETTINGS, ReferenceWorker } from './workers/reference-worker';

// Processo independente: só PostgreSQL, mesmo caso de uso financeiro da API; várias instâncias podem rodar juntas.
let orm: MikroORM | undefined;
let metricsServer: MetricsServer | undefined;
const metricsConfig = readMetricsConfig(9103);
const metrics = new Metrics();
try {
  orm = await MikroORM.init(databaseConfig(readConfig().DATABASE_URL));
  await assertRuntimeRole(orm);
  const worker = new ReferenceWorker(new PostgresPendingReferenceStore(orm), createWageringService(orm, metrics), new SystemClock(),
    new UuidGenerator(), DEFAULT_REFERENCE_WORKER_SETTINGS, metrics);
  metricsServer = startMetricsServer(metrics, metricsConfig.host, metricsConfig.port);
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      logEvent('reference_worker_stopping', { signal });
      void worker.stop();
    });
  }
  logEvent('reference_worker_started');
  await worker.start();
  logEvent('reference_worker_stopped');
} catch {
  logEvent('startup_failed', { message: 'Check environment, database role and connectivity.' });
  process.exitCode = 1;
} finally {
  await metricsServer?.stop();
  await orm?.close(true);
}
