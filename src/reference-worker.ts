import 'reflect-metadata';
import { MikroORM } from '@mikro-orm/postgresql';
import { assertRuntimeRole, createWageringService } from './bootstrap';
import { readConfig } from './config';
import { SystemClock, UuidGenerator } from './infrastructure/identity';
import { logEvent, Metrics } from './infrastructure/observability';
import { databaseConfig } from './infrastructure/postgres/config';
import { PostgresPendingReferenceStore } from './infrastructure/postgres/pending-references';
import { DEFAULT_REFERENCE_WORKER_SETTINGS, ReferenceWorker } from './workers/reference-worker';

// Processo independente: só PostgreSQL, mesmo caso de uso financeiro da API; várias instâncias podem rodar juntas.
let orm: MikroORM | undefined;
try {
  orm = await MikroORM.init(databaseConfig(readConfig().DATABASE_URL));
  await assertRuntimeRole(orm);
  const worker = new ReferenceWorker(new PostgresPendingReferenceStore(orm), createWageringService(orm), new SystemClock(),
    new UuidGenerator(), DEFAULT_REFERENCE_WORKER_SETTINGS, new Metrics());
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
  await orm?.close(true);
}
