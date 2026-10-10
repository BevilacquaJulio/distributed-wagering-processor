import { describe, expect, test } from 'bun:test';
import type { PendingReferenceClaim, PendingReferenceStore } from '../../src/application/ports';
import { DEFAULT_PENDING_POLICY, referenceRetryDelayMs, type ResolutionOutcome, type WageringService }
  from '../../src/application/wagering-service';
import { Metrics } from '../../src/infrastructure/observability';
import { DEFAULT_REFERENCE_WORKER_SETTINGS, ReferenceWorker } from '../../src/workers/reference-worker';

const claim = (transactionId: string): PendingReferenceClaim => ({ transactionId, walletId: `wallet-${transactionId}` });

class FakeStore implements PendingReferenceStore {
  readonly calls: { token: string; now: string; leaseUntil: string; limit: number }[] = [];
  constructor(private readonly claims: PendingReferenceClaim[]) {}
  async claim(token: string, now: string, leaseUntil: string, limit: number): Promise<PendingReferenceClaim[]> {
    this.calls.push({ token, now, leaseUntil, limit });
    return this.claims.splice(0, limit);
  }
}

function worker(store: PendingReferenceStore, resolve: (claim: PendingReferenceClaim) => Promise<ResolutionOutcome>) {
  const wagering = { resolvePending: resolve } as unknown as WageringService;
  const metrics = new Metrics();
  const instance = new ReferenceWorker(store, wagering, { now: () => '2026-10-10T12:00:00.000Z' }, { next: () => 'token-1' },
    DEFAULT_REFERENCE_WORKER_SETTINGS, metrics);
  return { instance, metrics };
}

describe('backoff de referências pendentes', () => {
  test('dobra a partir de 1s e para em 5 minutos', () => {
    expect([1, 2, 3, 8, 9, 20].map((attempts) => referenceRetryDelayMs(attempts, DEFAULT_PENDING_POLICY)))
      .toEqual([2000, 4000, 8000, 256_000, 300_000, 300_000]);
  });
});

describe('ReferenceWorker', () => {
  test('reivindica com lease, contabiliza cada resultado e isola a falha de um item', async () => {
    const store = new FakeStore([claim('a'), claim('b'), claim('c'), claim('d')]);
    const outcomes: Record<string, () => Promise<ResolutionOutcome>> = {
      a: async () => 'processed', b: async () => { throw new Error('connection lost'); }, c: async () => 'expired', d: async () => 'skipped',
    };
    const { instance, metrics } = worker(store, (item) => outcomes[item.transactionId]?.() ?? Promise.resolve('pending'));
    expect(await instance.runOnce()).toEqual({ claimed: 4, processed: 1, rejected: 0, expired: 1, pending: 0, skipped: 1, failed: 1 });
    expect(store.calls).toEqual([{ token: 'token-1', now: '2026-10-10T12:00:00.000Z', leaseUntil: '2026-10-10T12:00:30.000Z', limit: 10 }]);
    expect([metrics.value('reference_processed'), metrics.value('reference_expired'), metrics.value('reference_failed')]).toEqual([1, 1, 1]);
  });

  test('stop interrompe a espera ociosa', async () => {
    const { instance } = worker(new FakeStore([]), async () => 'pending');
    const running = instance.start();
    await Bun.sleep(20);
    const before = Date.now();
    await instance.stop();
    await running;
    expect(Date.now() - before).toBeLessThan(DEFAULT_REFERENCE_WORKER_SETTINGS.idleDelayMs);
  });
});
