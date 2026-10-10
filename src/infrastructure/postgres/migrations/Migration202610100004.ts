import { Migration } from '@mikro-orm/migrations';

/*
 * Reversão única por referência: uma BET recebe REFUND ou ROLLBACK, nunca os dois, porque ambos creditariam o mesmo valor.
 * Antes a unicidade era por referência e tipo, o que permitia dois créditos sobre a mesma BET.
 */
export class Migration202610100004 extends Migration {
  override up(): void {
    this.addSql(`
      update schema_version set version = 6;

      -- O histórico financeiro é imutável: com reversões duplicadas já gravadas, a migration para e pede análise manual.
      do $$
      declare duplicated integer;
      begin
        select count(*) into duplicated from (
          select reference_transaction_id from wager_references
          where kind in ('REFUND', 'ROLLBACK') group by reference_transaction_id having count(*) > 1) as twice;
        if duplicated > 0 then
          raise exception '% reference(s) already have both REFUND and ROLLBACK processed; review them before enforcing a single reversal', duplicated
            using errcode = '23505';
        end if;
      end $$;

      drop index wager_references_single_reversal;
      create unique index wager_references_single_reversal on wager_references(reference_transaction_id)
        where kind in ('REFUND', 'ROLLBACK');
    `);
  }

  // Volta à unicidade por referência e tipo, que é mais fraca; os dados gravados com a regra nova continuam válidos.
  override down(): void {
    this.addSql(`
      drop index wager_references_single_reversal;
      create unique index wager_references_single_reversal on wager_references(reference_transaction_id, kind)
        where kind in ('REFUND', 'ROLLBACK');

      update schema_version set version = 5;
    `);
  }
}
