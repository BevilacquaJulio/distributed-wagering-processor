import { Migration } from '@mikro-orm/migrations';

const WORKER_COLUMNS = 'claim_token, lease_until, resolved_at';

export class Migration202610100003 extends Migration {
  override up(): void {
    this.addSql(`
      update schema_version set version = 5;

      alter table pending_references
        add column claim_token uuid,
        add column lease_until timestamptz(3),
        add column resolved_at timestamptz(3),
        add constraint pending_claim_pair check ((claim_token is null) = (lease_until is null)),
        add constraint pending_resolved_released check (resolved_at is null or claim_token is null);

      drop index pending_references_due;
      create index pending_references_due on pending_references(next_attempt_at) where resolved_at is null;

      -- Quando uma referência fica terminal, as dependentes que esperam por ela são antecipadas na mesma transação.
      create index wager_transactions_waiting_reference
        on wager_transactions ((command->>'providerId'), (command->>'referenceExternalTransactionId'))
        where status = 'PENDING_REFERENCE';

      -- Agenda resolvida é definitiva e só pode ser resolvida junto da transação terminal; tentativas só crescem.
      create function guard_pending_update() returns trigger language plpgsql as $$
      begin
        if old.resolved_at is not null then
          raise exception 'resolved pending reference is immutable' using errcode = '23514';
        end if;
        if (new.transaction_id, new.deadline_at) is distinct from (old.transaction_id, old.deadline_at) then
          raise exception 'pending reference identity is immutable' using errcode = '23514';
        end if;
        if new.attempts < old.attempts then
          raise exception 'pending reference attempts cannot decrease' using errcode = '23514';
        end if;
        if new.resolved_at is not null and not exists (
          select 1 from wager_transactions where id = new.transaction_id and status in ('PROCESSED', 'REJECTED')) then
          raise exception 'pending reference resolves only with a terminal transaction' using errcode = '23514';
        end if;
        return new;
      end; $$;
      create trigger pending_reference_guard before update on pending_references
        for each row execute function guard_pending_update();

      grant update (${WORKER_COLUMNS}) on pending_references to jungle_runtime;
    `);
  }

  // Downgrade descarta claims e marcas de resolução; transações e resultados terminais permanecem.
  override down(): void {
    this.addSql(`
      revoke update (${WORKER_COLUMNS}) on pending_references from jungle_runtime;
      drop trigger pending_reference_guard on pending_references;
      drop function guard_pending_update();
      drop index wager_transactions_waiting_reference;
      drop index pending_references_due;
      create index pending_references_due on pending_references(next_attempt_at);
      alter table pending_references
        drop constraint pending_resolved_released,
        drop constraint pending_claim_pair,
        drop column resolved_at,
        drop column lease_until,
        drop column claim_token;
      update schema_version set version = 4;
    `);
  }
}
