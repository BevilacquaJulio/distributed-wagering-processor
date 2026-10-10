import type { Clock, IdGenerator, PendingReferenceClaim, PendingReferenceStore } from '../application/ports';
import type { ResolutionOutcome, WageringService } from '../application/wagering-service';
import { logEvent, type MetricName, type Metrics } from '../infrastructure/observability';

export interface ReferenceWorkerSettings {
  readonly batchSize: number;
  /** Folga ampla: cada resolução é uma unidade curta no banco, sem I/O externo. */
  readonly leaseSeconds: number;
  readonly idleDelayMs: number;
}

export const DEFAULT_REFERENCE_WORKER_SETTINGS: ReferenceWorkerSettings = { batchSize: 10, leaseSeconds: 30, idleDelayMs: 500 };

/** Pontos de observação para os testes; a aplicação não registra hooks. */
export interface ReferenceWorkerHooks {
  beforeResolve?(claim: PendingReferenceClaim): Promise<void>;
}

export type ResolutionReport = Readonly<Record<ResolutionOutcome | 'failed', number>> & { readonly claimed: number };

const OUTCOME_METRIC: Record<ResolutionOutcome | 'failed', MetricName | undefined> = {
  processed: 'reference_processed', rejected: 'reference_rejected', expired: 'reference_expired', pending: 'reference_retry',
  skipped: undefined, failed: 'reference_failed',
};

const addSeconds = (iso: string, seconds: number): string => new Date(Date.parse(iso) + seconds * 1000).toISOString();

export class ReferenceWorker {
  private stopping = false;
  private running: Promise<void> | undefined;
  private wake: (() => void) | undefined;

  constructor(
    private readonly store: PendingReferenceStore,
    private readonly wagering: WageringService,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly settings: ReferenceWorkerSettings,
    private readonly metrics: Metrics,
    private readonly hooks: ReferenceWorkerHooks = {},
  ) {}

  start(): Promise<void> {
    this.running ??= this.loop();
    return this.running;
  }

  /** Conclui a resolução em andamento; claims ainda não processados voltam quando a lease vencer. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.wake?.();
    await this.running;
  }

  async runOnce(): Promise<ResolutionReport> {
    const token = this.ids.next();
    const now = this.clock.now();
    const claims = await this.store.claim(token, now, addSeconds(now, this.settings.leaseSeconds), this.settings.batchSize);
    const report = { claimed: claims.length, processed: 0, rejected: 0, expired: 0, pending: 0, skipped: 0, failed: 0 };
    for (const claim of claims) {
      if (this.stopping) break;
      const outcome = await this.resolve(claim, token);
      report[outcome] += 1;
      const metric = OUTCOME_METRIC[outcome];
      if (metric) this.metrics.increment(metric);
    }
    return report;
  }

  private async resolve(claim: PendingReferenceClaim, token: string): Promise<ResolutionOutcome | 'failed'> {
    try {
      await this.hooks.beforeResolve?.(claim);
      const outcome = await this.wagering.resolvePending(claim, token);
      logEvent('pending_reference_evaluated', { transactionId: claim.transactionId, walletId: claim.walletId, outcome });
      return outcome;
    } catch (error) {
      // A unidade foi desfeita; o claim permanece até a lease vencer e outro ciclo tenta de novo. Nunca vira FAILED.
      logEvent('pending_reference_failed', { transactionId: claim.transactionId, error: error instanceof Error ? error.name : 'unknown' });
      return 'failed';
    }
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      let claimed = 0;
      try {
        claimed = (await this.runOnce()).claimed;
      } catch (error) {
        logEvent('reference_cycle_failed', { error: error instanceof Error ? error.name : 'unknown' });
      }
      if (claimed < this.settings.batchSize) await this.pause();
    }
  }

  private pause(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(done, this.settings.idleDelayMs);
      function done() { clearTimeout(timer); resolve(); }
      this.wake = done;
    });
  }
}
