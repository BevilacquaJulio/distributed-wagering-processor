import { AsyncLocalStorage } from 'node:async_hooks';
import type { LoggerService } from '@nestjs/common';

export const requestContext = new AsyncLocalStorage<{ correlationId: string }>();

export function logEvent(event: string, fields: Record<string, string | number | boolean | null> = {}): void {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), event, ...requestContext.getStore(), ...fields })}\n`);
}

export class JsonLogger implements LoggerService {
  log(message: unknown): void { logEvent('framework', { message: typeof message === 'string' ? message : 'message' }); }
  error(_message: unknown): void { logEvent('framework_error'); }
  warn(_message: unknown): void { logEvent('framework_warning'); }
}

const COUNTER_HELP = {
  wagering_transactions_total: 'New financial results by status; replays are not counted.',
  wagering_duplicates_total: 'Duplicate submissions answered from persisted state, by source.',
  wagering_conflicts_total: 'Requests rejected with 409 (idempotency key, external id or wallet conflicts).',
  wagering_retries_total: 'Retries scheduled, by origin.',
  wagering_dead_letters_total: 'Messages this consumer moved to the dead-letter queue.',
  wagering_lock_conflicts_total: 'Deadlocks, serialization failures and lock timeouts in financial units.',
  wagering_infrastructure_failures_total: 'Requests answered with 503.',
  wagering_reconciliation_divergences_total: 'Reconciliations whose stored balance differs from the ledger.',
  sqs_messages_total: 'Command messages handled, by outcome.',
  outbox_events_published_total: 'Outbox events confirmed as published by this process.',
  outbox_ownership_lost_total: 'Sent events whose claim had been taken over after the lease.',
  pending_references_resolved_total: 'Pending references resolved, by outcome.',
  pending_references_failures_total: 'Resolutions undone by an unexpected error; retried after the lease.',
} as const;
type CounterFamily = keyof typeof COUNTER_HELP;
type Series = readonly [CounterFamily, Readonly<Record<string, string>>?];

// Nome interno → séries Prometheus. Labels só têm valores fixos: IDs ficam nos logs.
const SERIES = {
  processed: [['wagering_transactions_total', { status: 'PROCESSED' }]],
  rejected: [['wagering_transactions_total', { status: 'REJECTED' }]],
  pending_reference: [['wagering_transactions_total', { status: 'PENDING_REFERENCE' }]],
  replay: [['wagering_duplicates_total', { source: 'http' }]],
  conflict: [['wagering_conflicts_total']],
  reconciliation_divergence: [['wagering_reconciliation_divergences_total']],
  infrastructure_failure: [['wagering_infrastructure_failures_total']],
  lock_conflict: [['wagering_lock_conflicts_total']],
  lock_retry: [['wagering_retries_total', { origin: 'lock' }]],
  message_processed: [['sqs_messages_total', { outcome: 'processed' }]],
  message_duplicate: [['sqs_messages_total', { outcome: 'duplicate' }], ['wagering_duplicates_total', { source: 'queue' }]],
  message_retry: [['sqs_messages_total', { outcome: 'retry' }], ['wagering_retries_total', { origin: 'queue' }]],
  message_dead_letter: [['sqs_messages_total', { outcome: 'dead_letter' }], ['wagering_dead_letters_total']],
  event_published: [['outbox_events_published_total']],
  event_publish_failed: [['wagering_retries_total', { origin: 'publisher' }]],
  event_ownership_lost: [['outbox_ownership_lost_total']],
  reference_processed: [['pending_references_resolved_total', { outcome: 'processed' }], ['wagering_transactions_total', { status: 'PROCESSED' }]],
  reference_rejected: [['pending_references_resolved_total', { outcome: 'rejected' }], ['wagering_transactions_total', { status: 'REJECTED' }]],
  reference_expired: [['pending_references_resolved_total', { outcome: 'expired' }], ['wagering_transactions_total', { status: 'REJECTED' }]],
  reference_retry: [['wagering_retries_total', { origin: 'reference' }]],
  reference_failed: [['pending_references_failures_total']],
} as const satisfies Record<string, readonly Series[]>;
export type MetricName = keyof typeof SERIES;

const HISTOGRAMS = {
  wagering_unit_duration_seconds: {
    help: 'Duration of a financial unit of work, including lock waits and retries.',
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  },
  outbox_publish_lag_seconds: {
    help: 'Time from event occurrence to confirmed publication.',
    buckets: [0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 300, 900],
  },
} as const;
export type HistogramName = keyof typeof HISTOGRAMS;

/** Valor lido no momento da coleta (profundidade de fila, backlog no banco). */
export interface Gauge {
  readonly name: string;
  readonly help: string;
  readonly value: number;
}

const seriesKey = (family: string, labels: Readonly<Record<string, string>> = {}): string => {
  const pairs = Object.entries(labels).map(([key, value]) => `${key}="${value}"`);
  return pairs.length > 0 ? `${family}{${pairs.join(',')}}` : family;
};

export class Metrics {
  private readonly names = new Map<MetricName, number>();
  private readonly series = new Map<string, number>();
  private readonly histograms = new Map<HistogramName, { counts: number[]; sum: number; count: number }>();

  increment(name: MetricName): void {
    this.names.set(name, this.value(name) + 1);
    for (const [family, labels] of SERIES[name] as readonly Series[]) {
      const key = seriesKey(family, labels);
      this.series.set(key, (this.series.get(key) ?? 0) + 1);
    }
  }

  value(name: MetricName): number { return this.names.get(name) ?? 0; }

  observe(name: HistogramName, seconds: number): void {
    const { buckets } = HISTOGRAMS[name];
    const state = this.histograms.get(name) ?? { counts: buckets.map(() => 0), sum: 0, count: 0 };
    buckets.forEach((bound, index) => { if (seconds <= bound) state.counts[index] = (state.counts[index] ?? 0) + 1; });
    state.sum += seconds;
    state.count += 1;
    this.histograms.set(name, state);
  }

  /** Formato de exposição do Prometheus; séries conhecidas aparecem zeradas para manter o conjunto estável. */
  render(gauges: readonly Gauge[] = []): string {
    const lines: string[] = [];
    for (const [family, help] of Object.entries(COUNTER_HELP)) {
      lines.push(`# HELP ${family} ${help}`, `# TYPE ${family} counter`);
      const keys = new Set<string>();
      for (const all of Object.values(SERIES) as readonly (readonly Series[])[]) {
        for (const [owner, labels] of all) if (owner === family) keys.add(seriesKey(owner, labels));
      }
      for (const key of keys) lines.push(`${key} ${this.series.get(key) ?? 0}`);
    }
    for (const [name, { help, buckets }] of Object.entries(HISTOGRAMS) as [HistogramName, typeof HISTOGRAMS[HistogramName]][]) {
      const state = this.histograms.get(name) ?? { counts: buckets.map(() => 0), sum: 0, count: 0 };
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} histogram`);
      for (const [index, bound] of buckets.entries()) lines.push(`${name}_bucket{le="${bound}"} ${state.counts[index] ?? 0}`);
      lines.push(`${name}_bucket{le="+Inf"} ${state.count}`, `${name}_sum ${state.sum}`, `${name}_count ${state.count}`);
    }
    for (const gauge of gauges) lines.push(`# HELP ${gauge.name} ${gauge.help}`, `# TYPE ${gauge.name} gauge`, `${gauge.name} ${gauge.value}`);
    return `${lines.join('\n')}\n`;
  }
}
