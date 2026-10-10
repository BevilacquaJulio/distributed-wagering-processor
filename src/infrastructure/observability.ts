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

const METRIC_NAMES = ['processed', 'rejected', 'pending_reference', 'replay', 'conflict', 'reconciliation_divergence',
  'infrastructure_failure', 'message_processed', 'message_duplicate', 'message_retry', 'message_dead_letter',
  'event_published', 'event_publish_failed', 'event_ownership_lost'] as const;
export type MetricName = typeof METRIC_NAMES[number];

export class Metrics {
  private readonly counters = new Map<MetricName, number>();

  increment(name: MetricName): void {
    this.counters.set(name, this.value(name) + 1);
  }

  value(name: MetricName): number { return this.counters.get(name) ?? 0; }

  render(): string {
    return '# HELP wagering_results_total Observed results in this process.\n# TYPE wagering_results_total counter\n'
      + METRIC_NAMES.map((name) => `wagering_results_total{result="${name}"} ${this.value(name)}\n`).join('');
  }
}
