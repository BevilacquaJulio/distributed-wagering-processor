import type { MikroORM } from '@mikro-orm/postgresql';
import type { Clock } from '../../src/application/ports';
import { WageringService } from '../../src/application/wagering-service';
import { Sha256PayloadHasher, UnauthenticatedProviderIdentity, UuidGenerator } from '../../src/infrastructure/identity';
import { Metrics } from '../../src/infrastructure/observability';
import { PostgresPendingReferenceStore } from '../../src/infrastructure/postgres/pending-references';
import { PostgresUnitOfWork } from '../../src/infrastructure/postgres/unit-of-work';
import { DEFAULT_REFERENCE_WORKER_SETTINGS, ReferenceWorker, type ReferenceWorkerHooks, type ResolutionReport }
  from '../../src/workers/reference-worker';
import { ShiftedClock } from './outbox';

export interface TestWorker {
  readonly worker: ReferenceWorker;
  readonly metrics: Metrics;
}

/** O mesmo relógio deslocado vale para o claim e para a decisão de expiração, como num worker real adiantado no tempo. */
export function testWorker(orm: MikroORM, options: {
  clock?: Clock; hooks?: ReferenceWorkerHooks; batchSize?: number; beforeCommit?: () => Promise<void>;
} = {}): TestWorker {
  const clock = options.clock ?? new ShiftedClock();
  const metrics = new Metrics();
  const wagering = new WageringService(new PostgresUnitOfWork(orm, options.beforeCommit), clock, new UuidGenerator(),
    new Sha256PayloadHasher(), new UnauthenticatedProviderIdentity());
  const worker = new ReferenceWorker(new PostgresPendingReferenceStore(orm), wagering, clock, new UuidGenerator(), {
    ...DEFAULT_REFERENCE_WORKER_SETTINGS, idleDelayMs: 50, ...(options.batchSize ? { batchSize: options.batchSize } : {}),
  }, metrics, options.hooks);
  return { worker, metrics };
}

type MutableReport = { -readonly [key in keyof ResolutionReport]: number };

/** Reavalia até não haver pendência vencida para este relógio. */
export async function drainReferences(worker: ReferenceWorker): Promise<ResolutionReport> {
  const total: MutableReport = { claimed: 0, processed: 0, rejected: 0, expired: 0, pending: 0, skipped: 0, failed: 0 };
  for (let report = await worker.runOnce(); report.claimed > 0; report = await worker.runOnce()) {
    for (const key of Object.keys(total) as (keyof MutableReport)[]) total[key] += report[key];
  }
  return total;
}

export interface ScheduleState {
  readonly attempts: number;
  readonly nextAttemptAt: string;
  readonly deadlineAt: string;
  readonly resolvedAt: string | null;
  readonly claimed: boolean;
  readonly status: string;
  readonly failureCode: string | null;
}

const iso = (column: string) => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

export async function schedule(orm: MikroORM, transactionId: string): Promise<ScheduleState> {
  const [row] = await orm.em.fork().execute<ScheduleState[]>(`
    select p.attempts, ${iso('p.next_attempt_at')} as "nextAttemptAt", ${iso('p.deadline_at')} as "deadlineAt",
      ${iso('p.resolved_at')} as "resolvedAt", p.claim_token is not null as claimed, t.status, t.failure_code as "failureCode"
    from pending_references p join wager_transactions t on t.id = p.transaction_id where p.transaction_id = ?`, [transactionId]);
  if (!row) throw new Error('Pending reference not found');
  return row;
}
