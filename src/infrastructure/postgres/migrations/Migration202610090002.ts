import { Migration } from '@mikro-orm/migrations';

const LEDGER_V1 = `
  create or replace function validate_ledger_transaction() returns trigger language plpgsql as $$
  declare t wager_transactions;
  begin
    select * into strict t from wager_transactions where id = new.transaction_id;
    if t.status <> 'PROCESSED' or t.amount <> new.amount or t.currency <> new.currency
      or (t.kind = 'OPENING' and new.direction <> 'CREDIT')
      or (t.kind = 'BET' and new.direction <> 'DEBIT') then
      raise exception 'ledger does not match processed transaction' using errcode = '23514';
    end if;
    return new;
  end; $$;`;

const GUARD_V1 = `
  create or replace function guard_transaction_update() returns trigger language plpgsql as $$
  begin
    if old.status in ('PROCESSED', 'REJECTED', 'FAILED') then
      raise exception 'terminal transaction is immutable' using errcode = '23514';
    end if;
    if (to_jsonb(new) - array['status','failure_code','processed_at']) is distinct from
       (to_jsonb(old) - array['status','failure_code','processed_at']) then
      raise exception 'transaction identity is immutable' using errcode = '23514';
    end if;
    return new;
  end; $$;`;

export class Migration202610090002 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      update schema_version set version = 2;

      alter table wager_transactions
        drop constraint wager_transactions_kind_check,
        add constraint wager_transactions_kind_check check (kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        drop constraint wager_transactions_status_check,
        add constraint wager_transactions_status_check
          check (status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        drop constraint wager_transactions_check,
        add constraint wager_transactions_check check (
          (status in ('PENDING', 'PENDING_REFERENCE') and processed_at is null and failure_code is null)
          or (status = 'PROCESSED' and processed_at is not null and failure_code is null
            and ((kind = 'LOSS' and amount = 0) or (kind <> 'LOSS' and amount > 0)))
          or (status in ('REJECTED', 'FAILED') and processed_at is not null and failure_code is not null)),
        drop constraint wager_transactions_check1,
        add constraint wager_transactions_check1 check (
          (kind = 'OPENING' and command is null and status = 'PROCESSED')
          or (kind <> 'OPENING' and command is not null and (command->>'kind') = kind
            and (command->>'walletId') = wallet_id::text and (command->>'playerId') = player_id::text)),
        add constraint wager_transactions_reference_check check (
          (kind in ('REFUND', 'ROLLBACK') and (command->>'referenceExternalTransactionId') is not null)
          or (kind in ('OPENING', 'BET', 'LOSS') and (command->>'referenceExternalTransactionId') is null)
          or kind = 'WIN');

      -- Vínculo gravado somente para operações processadas; a unicidade parcial impede a segunda reversão do mesmo tipo.
      create table wager_references (
        transaction_id uuid primary key references wager_transactions(id),
        reference_transaction_id uuid not null references wager_transactions(id),
        kind text not null check (kind in ('WIN', 'REFUND', 'ROLLBACK')),
        check (transaction_id <> reference_transaction_id)
      );
      create unique index wager_references_single_reversal on wager_references(reference_transaction_id, kind)
        where kind in ('REFUND', 'ROLLBACK');

      create table transaction_acceptances (
        transaction_id uuid primary key references wager_transactions(id), body jsonb not null,
        check ((body->>'transactionId') is not distinct from transaction_id::text),
        check ((body->>'status') is not distinct from 'PENDING_REFERENCE'),
        check ((body->>'idempotentReplay') is not distinct from 'false')
      );

      create table pending_references (
        transaction_id uuid primary key references wager_transactions(id),
        attempts integer not null default 0 check (attempts >= 0),
        next_attempt_at timestamptz(3) not null,
        deadline_at timestamptz(3) not null
      );
      create index pending_references_due on pending_references(next_attempt_at);
    `);
    this.addSql(`
      create or replace function validate_ledger_transaction() returns trigger language plpgsql as $$
      declare t wager_transactions; expected text;
      begin
        select * into strict t from wager_transactions where id = new.transaction_id;
        if t.status <> 'PROCESSED' or t.amount <> new.amount or t.currency <> new.currency then
          raise exception 'ledger does not match processed transaction' using errcode = '23514';
        end if;
        expected := case t.kind
          when 'OPENING' then 'CREDIT' when 'WIN' then 'CREDIT' when 'REFUND' then 'CREDIT' when 'BET' then 'DEBIT'
          when 'ROLLBACK' then (
            select case l.direction when 'CREDIT' then 'DEBIT' else 'CREDIT' end
            from wager_references r join wallet_ledger l on l.transaction_id = r.reference_transaction_id
            where r.transaction_id = t.id)
        end;
        if expected is distinct from new.direction then
          raise exception 'ledger direction does not match transaction kind' using errcode = '23514';
        end if;
        return new;
      end; $$;

      create or replace function guard_transaction_update() returns trigger language plpgsql as $$
      begin
        if old.status in ('PROCESSED', 'REJECTED', 'FAILED') then
          raise exception 'terminal transaction is immutable' using errcode = '23514';
        end if;
        if new.status = 'PENDING' and old.status <> 'PENDING' then
          raise exception 'transaction cannot return to PENDING' using errcode = '23514';
        end if;
        if (to_jsonb(new) - array['status','failure_code','processed_at']) is distinct from
           (to_jsonb(old) - array['status','failure_code','processed_at']) then
          raise exception 'transaction identity is immutable' using errcode = '23514';
        end if;
        return new;
      end; $$;

      create function validate_reference_link() returns trigger language plpgsql as $$
      declare t wager_transactions; r wager_transactions;
      begin
        select * into strict t from wager_transactions where id = new.transaction_id;
        select * into strict r from wager_transactions where id = new.reference_transaction_id;
        if t.status <> 'PROCESSED' or r.status <> 'PROCESSED' or t.kind <> new.kind
          or r.wallet_id <> t.wallet_id or r.player_id <> t.player_id or r.currency <> t.currency
          or (t.command->>'roundId') is distinct from (r.command->>'roundId')
          or (new.kind in ('WIN', 'REFUND') and r.kind <> 'BET')
          or (new.kind = 'ROLLBACK' and r.kind not in ('BET', 'WIN', 'REFUND'))
          or (new.kind in ('REFUND', 'ROLLBACK') and r.amount <> t.amount) then
          raise exception 'reference does not match transaction' using errcode = '23514';
        end if;
        return new;
      end; $$;
      create trigger reference_link_matches before insert on wager_references
        for each row execute function validate_reference_link();
      create trigger reference_link_immutable before update or delete or truncate on wager_references
        for each statement execute function reject_immutable_mutation();

      create function validate_pending_snapshot() returns trigger language plpgsql as $$
      declare t wager_transactions;
      begin
        select * into strict t from wager_transactions where id = new.transaction_id;
        if t.status <> 'PENDING_REFERENCE' then
          raise exception 'pending record requires a PENDING_REFERENCE transaction' using errcode = '23514';
        end if;
        return new;
      end; $$;
      create trigger acceptance_matches_transaction before insert on transaction_acceptances
        for each row execute function validate_pending_snapshot();
      create trigger acceptance_immutable before update or delete or truncate on transaction_acceptances
        for each statement execute function reject_immutable_mutation();
      create trigger pending_reference_matches_transaction before insert on pending_references
        for each row execute function validate_pending_snapshot();
      create trigger pending_reference_no_delete before delete or truncate on pending_references
        for each statement execute function reject_immutable_mutation();

      grant select, insert on wager_references, transaction_acceptances, pending_references to jungle_runtime;
      grant update (attempts, next_attempt_at) on pending_references to jungle_runtime;
    `);
  }

  // Downgrade descarta vínculos de referência, aceites pendentes e agenda de reprocessamento.
  // As constraints anteriores voltam como NOT VALID para não falhar com linhas já gravadas pelos novos kinds.
  override async down(): Promise<void> {
    this.addSql(`
      drop table pending_references, transaction_acceptances, wager_references;
      drop function validate_reference_link(), validate_pending_snapshot();

      alter table wager_transactions
        drop constraint wager_transactions_reference_check,
        drop constraint wager_transactions_kind_check,
        add constraint wager_transactions_kind_check check (kind in ('OPENING', 'BET')) not valid,
        drop constraint wager_transactions_status_check,
        add constraint wager_transactions_status_check check (status in ('PENDING', 'PROCESSED', 'REJECTED', 'FAILED')) not valid,
        drop constraint wager_transactions_check,
        add constraint wager_transactions_check check (
          (status = 'PENDING' and processed_at is null and failure_code is null)
          or (status = 'PROCESSED' and processed_at is not null and failure_code is null and amount > 0)
          or (status in ('REJECTED', 'FAILED') and processed_at is not null and failure_code is not null)) not valid,
        drop constraint wager_transactions_check1,
        add constraint wager_transactions_check1 check (
          (kind = 'OPENING' and command is null and status = 'PROCESSED') or (kind = 'BET' and command is not null)) not valid;

      update schema_version set version = 1;
    `);
    this.addSql(LEDGER_V1);
    this.addSql(GUARD_V1);
  }
}
