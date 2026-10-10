import { describe, expect, test } from 'bun:test';
import { readMetricsConfig } from '../../src/config';
import { Metrics } from '../../src/infrastructure/observability';

const line = (output: string, prefix: string) => output.split('\n').find((candidate) => candidate.startsWith(`${prefix} `));

describe('Metrics', () => {
  test('um nome interno alimenta todas as séries correspondentes, com labels fixos', () => {
    const metrics = new Metrics();
    metrics.increment('message_duplicate');
    metrics.increment('message_duplicate');
    metrics.increment('reference_expired');
    const output = metrics.render();
    expect(line(output, 'sqs_messages_total{outcome="duplicate"}')).toEndWith(' 2');
    expect(line(output, 'wagering_duplicates_total{source="queue"}')).toEndWith(' 2');
    expect(line(output, 'pending_references_resolved_total{outcome="expired"}')).toEndWith(' 1');
    expect(line(output, 'wagering_transactions_total{status="REJECTED"}')).toEndWith(' 1');
    // Séries conhecidas aparecem zeradas; cada família tem HELP e TYPE uma única vez.
    expect(line(output, 'wagering_lock_conflicts_total')).toEndWith(' 0');
    expect(output.split('\n').filter((entry) => entry === '# TYPE wagering_transactions_total counter')).toHaveLength(1);
    expect(metrics.value('message_duplicate')).toBe(2);
  });

  test('histograma acumula buckets, soma e contagem', () => {
    const metrics = new Metrics();
    for (const seconds of [0.004, 0.03, 0.03, 20]) metrics.observe('wagering_unit_duration_seconds', seconds);
    const output = metrics.render();
    expect(line(output, 'wagering_unit_duration_seconds_bucket{le="0.005"}')).toEndWith(' 1');
    expect(line(output, 'wagering_unit_duration_seconds_bucket{le="0.05"}')).toEndWith(' 3');
    expect(line(output, 'wagering_unit_duration_seconds_bucket{le="10"}')).toEndWith(' 3');
    expect(line(output, 'wagering_unit_duration_seconds_bucket{le="+Inf"}')).toEndWith(' 4');
    expect(line(output, 'wagering_unit_duration_seconds_count')).toEndWith(' 4');
    expect(Number(line(output, 'wagering_unit_duration_seconds_sum')?.split(' ')[1])).toBeCloseTo(20.064);
  });

  test('gauges lidos na coleta entram com HELP e TYPE', () => {
    const output = new Metrics().render([{ name: 'outbox_pending_events', help: 'Pending.', value: 7 }]);
    expect(output).toContain('# TYPE outbox_pending_events gauge\noutbox_pending_events 7\n');
  });
});

describe('configuração do endpoint de métricas', () => {
  test('loopback e porta padrão do processo, com sobrescrita validada', () => {
    expect(readMetricsConfig(9101, {})).toEqual({ host: '127.0.0.1', port: 9101 });
    expect(readMetricsConfig(9101, { METRICS_HOST: '0.0.0.0', METRICS_PORT: '0' })).toEqual({ host: '0.0.0.0', port: 0 });
    expect(() => readMetricsConfig(9101, { METRICS_PORT: '70000' })).toThrow('METRICS_PORT');
  });
});
