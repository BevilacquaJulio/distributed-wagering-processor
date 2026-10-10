import { Migration } from '@mikro-orm/migrations';

const GUARD_V1 = `
  create or replace function guard_outbox_update() returns trigger language plpgsql as $$
  begin
    if (new.id, new.aggregate_id, new.event_type, new.payload, new.occurred_at)
      is distinct from (old.id, old.aggregate_id, old.event_type, old.payload, old.occurred_at) then
      raise exception 'outbox event is immutable' using errcode = '23514';
    end if;
    return new;
  end; $$;`;

// Publicação confirmada é definitiva; tentativas só crescem para manter o histórico auditável.
const GUARD_V2 = `
  create or replace function guard_outbox_update() returns trigger language plpgsql as $$
  begin
    if (new.id, new.aggregate_id, new.event_type, new.payload, new.occurred_at)
      is distinct from (old.id, old.aggregate_id, old.event_type, old.payload, old.occurred_at) then
      raise exception 'outbox event is immutable' using errcode = '23514';
    end if;
    if old.published_at is not null then
      raise exception 'published outbox event is immutable' using errcode = '23514';
    end if;
    if new.attempts < old.attempts then
      raise exception 'outbox attempts cannot decrease' using errcode = '23514';
    end if;
    return new;
  end; $$;`;

const PUBLISHER_COLUMNS = 'attempts, next_attempt_at, published_at, claim_token, lease_until, last_error';

export class Migration202610100002 extends Migration {
  override up(): void {
    this.addSql(`
      update schema_version set version = 4;

      -- Ordem de inserção: eventos de uma wallet são gravados sob o lock dela, então a posição segue a ordem de commit.
      alter table outbox_messages
        add column position bigint generated always as identity,
        add column last_error varchar(64),
        add constraint outbox_claim_pair check ((claim_token is null) = (lease_until is null)),
        add constraint outbox_published_released check (published_at is null or claim_token is null);

      drop index outbox_pending;
      create index outbox_pending on outbox_messages(position) where published_at is null;
      ${GUARD_V2}

      grant update (${PUBLISHER_COLUMNS}) on outbox_messages to jungle_runtime;
    `);
  }

  // Downgrade descarta a ordem e o último erro de envio; eventos e publishedAt permanecem.
  override down(): void {
    this.addSql(`
      revoke update (${PUBLISHER_COLUMNS}) on outbox_messages from jungle_runtime;
      ${GUARD_V1}
      drop index outbox_pending;
      create index outbox_pending on outbox_messages(occurred_at, id) where published_at is null;
      alter table outbox_messages
        drop constraint outbox_published_released,
        drop constraint outbox_claim_pair,
        drop column last_error,
        drop column position;
      update schema_version set version = 3;
    `);
  }
}
