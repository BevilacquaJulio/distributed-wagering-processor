import { Migration } from '@mikro-orm/migrations';

export class Migration202610100001 extends Migration {
  override up(): void {
    this.addSql(`
      update schema_version set version = 3;

      -- Gravada no início da unidade financeira: entregas concorrentes da mesma mensagem esperam na chave primária.
      create table inbox_messages (
        consumer_name varchar(128) not null,
        message_id varchar(128) not null,
        payload_hash char(64) not null check (payload_hash ~ '^[0-9a-f]{64}$'),
        transaction_id uuid references wager_transactions(id),
        received_at timestamptz(3) not null,
        processed_at timestamptz(3),
        primary key (consumer_name, message_id),
        check ((transaction_id is null) = (processed_at is null))
      );

      create function guard_inbox_update() returns trigger language plpgsql as $$
      begin
        if old.processed_at is not null then
          raise exception 'processed inbox message is immutable' using errcode = '23514';
        end if;
        if (new.consumer_name, new.message_id, new.payload_hash, new.received_at)
          is distinct from (old.consumer_name, old.message_id, old.payload_hash, old.received_at) then
          raise exception 'inbox identity is immutable' using errcode = '23514';
        end if;
        return new;
      end; $$;
      create trigger inbox_processed_immutable before update on inbox_messages
        for each row execute function guard_inbox_update();
      create trigger inbox_no_delete before delete or truncate on inbox_messages
        for each statement execute function reject_immutable_mutation();

      grant select, insert on inbox_messages to jungle_runtime;
      grant update (transaction_id, processed_at) on inbox_messages to jungle_runtime;
    `);
  }

  // Downgrade descarta o registro de deduplicação das mensagens já consumidas.
  override down(): void {
    this.addSql(`
      drop table inbox_messages;
      drop function guard_inbox_update();
      update schema_version set version = 2;
    `);
  }
}
