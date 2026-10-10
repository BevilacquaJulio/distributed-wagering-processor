import type { MikroORM } from '@mikro-orm/postgresql';
import type { ClaimedEvent, OutboxStore } from '../../application/ports';
import type { EventEnvelope } from '../../domain/events';

const placeholders = (values: readonly unknown[]): string => values.map(() => '?').join(', ');

// Cada comando roda em autocommit: nenhum lock de linha sobrevive ao claim enquanto o envio acontece.
export class PostgresOutboxStore implements OutboxStore {
  constructor(private readonly orm: MikroORM) {}

  // SKIP LOCKED separa publishers simultâneos; em READ COMMITTED a linha travada é reavaliada,
  // então um claim recém-confirmado por outro publisher já não satisfaz o filtro de lease.
  async claim(token: string, now: string, leaseUntil: string, limit: number): Promise<ClaimedEvent[]> {
    const rows = await this.orm.em.fork().execute<{ payload: EventEnvelope; attempts: number; position: string }[]>(`
      with candidates as (
        select id from outbox_messages
        where published_at is null
          and (lease_until is null or lease_until <= ?)
          and (next_attempt_at is null or next_attempt_at <= ?)
        order by position
        limit ?
        for update skip locked
      )
      update outbox_messages o set claim_token = ?, lease_until = ?, attempts = o.attempts + 1
      from candidates c where o.id = c.id
      returning o.payload, o.attempts, o.position::text as position`, [now, now, limit, token, leaseUntil]);
    return rows.sort((left, right) => (BigInt(left.position) < BigInt(right.position) ? -1 : 1))
      .map((row) => ({ envelope: row.payload, attempts: row.attempts }));
  }

  async markPublished(token: string, eventIds: readonly string[], at: string): Promise<string[]> {
    if (eventIds.length === 0) return [];
    const rows = await this.orm.em.fork().execute<{ id: string }[]>(`
      update outbox_messages set published_at = ?, claim_token = null, lease_until = null, last_error = null
      where claim_token = ? and published_at is null and id in (${placeholders(eventIds)})
      returning id`, [at, token, ...eventIds]);
    return rows.map((row) => row.id);
  }

  async markFailed(token: string, eventId: string, nextAttemptAt: string, error: string): Promise<boolean> {
    const rows = await this.orm.em.fork().execute<{ id: string }[]>(`
      update outbox_messages set claim_token = null, lease_until = null, next_attempt_at = ?, last_error = ?
      where id = ? and claim_token = ? and published_at is null
      returning id`, [nextAttemptAt, error.slice(0, 64), eventId, token]);
    return rows.length === 1;
  }
}
