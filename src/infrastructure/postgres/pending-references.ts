import type { MikroORM } from '@mikro-orm/postgresql';
import type { PendingReferenceClaim, PendingReferenceStore } from '../../application/ports';

// Claim em autocommit: a unidade financeira depois trava wallet e agenda nessa ordem, a mesma do envio que acorda
// dependentes. Travar a agenda primeiro e a wallet depois inverteria a ordem e abriria espaço para deadlock.
export class PostgresPendingReferenceStore implements PendingReferenceStore {
  constructor(private readonly orm: MikroORM) {}

  async claim(token: string, now: string, leaseUntil: string, limit: number): Promise<PendingReferenceClaim[]> {
    return this.orm.em.fork().execute<PendingReferenceClaim[]>(`
      with candidates as (
        select transaction_id from pending_references
        where resolved_at is null and next_attempt_at <= ? and (lease_until is null or lease_until <= ?)
        order by next_attempt_at
        limit ?
        for update skip locked
      )
      update pending_references p set claim_token = ?, lease_until = ?
      from candidates c, wager_transactions t
      where p.transaction_id = c.transaction_id and t.id = p.transaction_id
      returning p.transaction_id as "transactionId", t.wallet_id as "walletId"`, [now, now, limit, token, leaseUntil]);
  }
}
