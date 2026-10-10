import { describe, expect, test } from 'bun:test';
import type { SendMessageBatchCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { ClaimedEvent, OutboxStore } from '../../src/application/ports';
import { Metrics } from '../../src/infrastructure/observability';
import { DEFAULT_PUBLISHER_SETTINGS, OutboxPublisher, retryDelaySeconds } from '../../src/sqs/publisher';

const NOW = '2026-10-10T12:00:00.000Z';

function claimed(eventId: string, attempts = 1): ClaimedEvent {
  return { attempts, envelope: { eventId, eventType: 'WalletBalanceChanged', version: 1, aggregateId: 'wallet-1',
    correlationId: 'correlation-1', occurredAt: NOW, data: {} } };
}

/** Store em memória: registra as chamadas para conferir o que foi confirmado e reagendado. */
class FakeStore implements OutboxStore {
  readonly published: string[] = [];
  readonly failed: { eventId: string; nextAttemptAt: string; error: string }[] = [];
  constructor(private readonly events: ClaimedEvent[], private readonly owned = true) {}
  async claim(): Promise<ClaimedEvent[]> { return this.events.splice(0); }
  async markPublished(_token: string, eventIds: readonly string[]): Promise<string[]> {
    if (!this.owned) return [];
    this.published.push(...eventIds);
    return [...eventIds];
  }
  async markFailed(_token: string, eventId: string, nextAttemptAt: string, error: string): Promise<boolean> {
    this.failed.push({ eventId, nextAttemptAt, error });
    return this.owned;
  }
}

function publisher(store: OutboxStore, respond: (command: SendMessageBatchCommand) => Promise<unknown>) {
  const sqs = { send: respond } as unknown as SQSClient;
  const metrics = new Metrics();
  const instance = new OutboxPublisher(sqs, store, { now: () => NOW }, { next: () => 'token-1' },
    { ...DEFAULT_PUBLISHER_SETTINGS, queueUrl: 'queue' }, metrics);
  return { instance, metrics };
}

describe('backoff da outbox', () => {
  test('cresce exponencialmente a partir da base e para no limite', () => {
    expect([1, 2, 3, 4, 9, 10, 30].map((attempts) => retryDelaySeconds(attempts, 1, 300))).toEqual([1, 2, 4, 8, 256, 300, 300]);
  });
});

describe('OutboxPublisher', () => {
  test('envia o lote com grupo por wallet e deduplicação pelo eventId', async () => {
    const store = new FakeStore([claimed('event-1'), claimed('event-2')]);
    let request: SendMessageBatchCommand['input'] | undefined;
    const { instance, metrics } = publisher(store, async (command) => {
      request = command.input;
      return { Successful: [{ Id: 'event-1' }, { Id: 'event-2' }] };
    });
    expect(await instance.publishOnce()).toEqual({ claimed: 2, published: 2, failed: 0, ownershipLost: 0 });
    expect(request?.Entries?.map((entry) => [entry.Id, entry.MessageGroupId, entry.MessageDeduplicationId]))
      .toEqual([['event-1', 'wallet-1', 'event-1'], ['event-2', 'wallet-1', 'event-2']]);
    expect(store.published).toEqual(['event-1', 'event-2']);
    expect(metrics.value('event_published')).toBe(2);
  });

  test('falha parcial do lote confirma só o que o broker aceitou e reagenda o resto', async () => {
    const store = new FakeStore([claimed('event-1'), claimed('event-2', 3), claimed('event-3')]);
    const { instance, metrics } = publisher(store, async () => ({
      Successful: [{ Id: 'event-1' }], Failed: [{ Id: 'event-2', Code: 'InternalError', SenderFault: false }],
    }));
    expect(await instance.publishOnce()).toEqual({ claimed: 3, published: 1, failed: 2, ownershipLost: 0 });
    expect(store.published).toEqual(['event-1']);
    expect(store.failed.map(({ eventId, error }) => [eventId, error])).toEqual([['event-2', 'InternalError'], ['event-3', 'MissingBatchResult']]);
    // Terceira tentativa: 4s de backoff mais jitter menor que 1s.
    const delay = Date.parse(store.failed[0]?.nextAttemptAt ?? '') - Date.parse(NOW);
    expect(delay).toBeGreaterThanOrEqual(4000);
    expect(delay).toBeLessThan(5000);
    expect(metrics.value('event_publish_failed')).toBe(2);
  });

  test('erro no envio reagenda todo o lote; sem posse, nada é confirmado', async () => {
    const store = new FakeStore([claimed('event-1'), claimed('event-2')], false);
    const { instance, metrics } = publisher(store, async () => { throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); });
    expect(await instance.publishOnce()).toEqual({ claimed: 2, published: 0, failed: 2, ownershipLost: 2 });
    expect(store.failed.map(({ error }) => error)).toEqual(['TimeoutError', 'TimeoutError']);
    expect(metrics.value('event_ownership_lost')).toBe(2);
  });

  test('stop interrompe a espera ociosa', async () => {
    const { instance } = publisher(new FakeStore([]), async () => ({}));
    const running = instance.start();
    await Bun.sleep(20);
    const before = Date.now();
    await instance.stop();
    await running;
    expect(Date.now() - before).toBeLessThan(DEFAULT_PUBLISHER_SETTINGS.idleDelayMs);
  });
});
