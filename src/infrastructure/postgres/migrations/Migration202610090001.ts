import { Migration } from '@mikro-orm/migrations';

export class Migration202610090001 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table schema_version (version integer primary key);
      insert into schema_version values (1);
      create table wallets (
        id uuid primary key, player_id uuid not null, currency varchar(3) not null check (currency = 'BRL'),
        balance numeric(20,2) not null check (balance >= 0 and balance <= 999999999999999999.99),
        version integer not null check (version >= 1), created_at timestamptz(3) not null, updated_at timestamptz(3) not null,
        constraint wallets_player_currency_unique unique (player_id, currency), unique (id, currency)
      );
      create table wager_transactions (
        id uuid primary key, wallet_id uuid not null references wallets(id), player_id uuid not null,
        kind text not null check (kind in ('OPENING', 'BET')),
        amount numeric(20,2) not null check (amount >= 0 and amount <= 999999999999999999.99),
        currency varchar(3) not null check (currency ~ '^[A-Z]{3}$'),
        status text not null check (status in ('PENDING', 'PROCESSED', 'REJECTED', 'FAILED')),
        failure_code text, command jsonb, created_at timestamptz(3) not null, processed_at timestamptz(3),
        unique (id, wallet_id),
        check ((status = 'PENDING' and processed_at is null and failure_code is null)
          or (status = 'PROCESSED' and processed_at is not null and failure_code is null and amount > 0)
          or (status in ('REJECTED', 'FAILED') and processed_at is not null and failure_code is not null)),
        check ((kind = 'OPENING' and command is null and status = 'PROCESSED') or (kind = 'BET' and command is not null))
      );
      create table wager_identities (
        transaction_id uuid primary key references wager_transactions(id) deferrable initially deferred,
        provider_id varchar(128) not null, external_transaction_id varchar(128) not null,
        idempotency_key varchar(128) not null, payload_hash char(64) not null check (payload_hash ~ '^[0-9a-f]{64}$'),
        unique (provider_id, idempotency_key), unique (provider_id, external_transaction_id)
      );
      create table wallet_ledger (
        id uuid primary key, wallet_id uuid not null, transaction_id uuid not null,
        direction text not null check (direction in ('DEBIT', 'CREDIT')),
        amount numeric(20,2) not null check (amount > 0 and amount <= 999999999999999999.99),
        currency varchar(3) not null,
        balance_before numeric(20,2) not null check (balance_before >= 0 and balance_before <= 999999999999999999.99),
        balance_after numeric(20,2) not null check (balance_after >= 0 and balance_after <= 999999999999999999.99),
        created_at timestamptz(3) not null,
        unique (transaction_id, wallet_id),
        foreign key (transaction_id, wallet_id) references wager_transactions(id, wallet_id),
        foreign key (wallet_id, currency) references wallets(id, currency),
        check (balance_after = balance_before + case direction when 'CREDIT' then amount else -amount end)
      );
      create index wallet_ledger_cursor on wallet_ledger(wallet_id, created_at, id);
      create table transaction_results (
        transaction_id uuid primary key references wager_transactions(id), body jsonb not null,
        check ((body->>'transactionId') is not distinct from transaction_id::text),
        check (coalesce(body->>'status' in ('PROCESSED', 'REJECTED'), false)),
        check ((body->>'idempotentReplay') is not distinct from 'false')
      );
      create table outbox_messages (
        id uuid primary key, aggregate_id uuid not null references wallets(id), event_type text not null,
        payload jsonb not null, occurred_at timestamptz(3) not null,
        attempts integer not null default 0 check (attempts >= 0), next_attempt_at timestamptz(3),
        published_at timestamptz(3), claim_token uuid, lease_until timestamptz(3),
        check ((payload->>'eventId') is not distinct from id::text),
        check ((payload->>'eventType') is not distinct from event_type),
        check ((payload->>'aggregateId') is not distinct from aggregate_id::text)
      );
      create index outbox_pending on outbox_messages(occurred_at, id) where published_at is null;
    `);
    this.addSql(`
      create function reject_immutable_mutation() returns trigger language plpgsql as $$
      begin raise exception 'immutable financial record' using errcode = '23514'; end; $$;
      create trigger ledger_immutable before update or delete or truncate on wallet_ledger
        for each statement execute function reject_immutable_mutation();
      create trigger result_immutable before update or delete or truncate on transaction_results
        for each statement execute function reject_immutable_mutation();
      create trigger identity_immutable before update or delete or truncate on wager_identities
        for each statement execute function reject_immutable_mutation();
      create trigger transaction_no_delete before delete or truncate on wager_transactions
        for each statement execute function reject_immutable_mutation();

      create function guard_transaction_update() returns trigger language plpgsql as $$
      begin
        if old.status in ('PROCESSED', 'REJECTED', 'FAILED') then
          raise exception 'terminal transaction is immutable' using errcode = '23514';
        end if;
        if (to_jsonb(new) - array['status','failure_code','processed_at']) is distinct from
           (to_jsonb(old) - array['status','failure_code','processed_at']) then
          raise exception 'transaction identity is immutable' using errcode = '23514';
        end if;
        return new;
      end; $$;
      create trigger transaction_terminal before update on wager_transactions
        for each row execute function guard_transaction_update();

      create function validate_ledger_transaction() returns trigger language plpgsql as $$
      declare t wager_transactions;
      begin
        select * into strict t from wager_transactions where id = new.transaction_id;
        if t.status <> 'PROCESSED' or t.amount <> new.amount or t.currency <> new.currency
          or (t.kind = 'OPENING' and new.direction <> 'CREDIT')
          or (t.kind = 'BET' and new.direction <> 'DEBIT') then
          raise exception 'ledger does not match processed transaction' using errcode = '23514';
        end if;
        return new;
      end; $$;
      create trigger ledger_matches_transaction before insert on wallet_ledger
        for each row execute function validate_ledger_transaction();
      create function validate_terminal_result() returns trigger language plpgsql as $$
      declare t wager_transactions;
      begin
        select * into strict t from wager_transactions where id = new.transaction_id;
        if (new.body->>'status') is distinct from t.status
          or (new.body->>'failureCode') is distinct from t.failure_code then
          raise exception 'snapshot does not match transaction' using errcode = '23514';
        end if;
        return new;
      end; $$;
      create trigger result_matches_transaction before insert on transaction_results
        for each row execute function validate_terminal_result();
      create function guard_outbox_update() returns trigger language plpgsql as $$
      begin
        if (new.id, new.aggregate_id, new.event_type, new.payload, new.occurred_at)
          is distinct from (old.id, old.aggregate_id, old.event_type, old.payload, old.occurred_at) then
          raise exception 'outbox event is immutable' using errcode = '23514';
        end if;
        return new;
      end; $$;
      create trigger outbox_envelope_immutable before update on outbox_messages
        for each row execute function guard_outbox_update();
      create trigger outbox_no_delete before delete or truncate on outbox_messages
        for each statement execute function reject_immutable_mutation();
      revoke all on all tables in schema public from public;
      grant usage on schema public to jungle_runtime;
      grant select on schema_version to jungle_runtime;
      grant select, insert on wallets, wager_transactions, wager_identities, wallet_ledger, transaction_results, outbox_messages to jungle_runtime;
      grant update (balance, version, updated_at) on wallets to jungle_runtime;
      grant update (status, failure_code, processed_at) on wager_transactions to jungle_runtime;
    `);
  }

  // A downgrade removes the financial history; it is only exposed with an explicit disposable-database guard.
  override async down(): Promise<void> {
    this.addSql(`
      drop table outbox_messages, transaction_results, wallet_ledger, wager_identities, wager_transactions, wallets, schema_version;
      drop function validate_ledger_transaction(), validate_terminal_result(), guard_outbox_update(), guard_transaction_update(), reject_immutable_mutation();
    `);
  }
}
