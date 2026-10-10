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

export class Metrics {
  private readonly counters = new Map<string, number>();

  increment(name: 'processed' | 'rejected' | 'pending_reference' | 'replay' | 'conflict' | 'reconciliation_divergence' | 'infrastructure_failure'): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + 1);
  }

  render(): string {
    return '# HELP wagering_results_total Observed results in this process.\n# TYPE wagering_results_total counter\n'
      + ['processed', 'rejected', 'pending_reference', 'replay', 'conflict', 'reconciliation_divergence', 'infrastructure_failure']
        .map((name) => `wagering_results_total{result="${name}"} ${this.counters.get(name) ?? 0}\n`).join('');
  }
}
