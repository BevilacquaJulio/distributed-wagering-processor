import { IsolationLevel } from '@mikro-orm/core';
import type { MikroORM } from '@mikro-orm/postgresql';
import { ApplicationError } from '../../application/errors';
import type { FinancialQueries, LedgerCursor, LedgerPage, Reconciliation } from '../../application/ports';
import { Money } from '../../domain/money';
import type { TransactionState } from '../../domain/wager-transaction';
import type { WalletState } from '../../domain/wallet';
import { LedgerSchema, TransactionSchema, WalletSchema } from './entities';
import { ledgerFromRow, transactionFromRow, walletFromRow } from './mappers';

export class PostgresQueries implements FinancialQueries {
  constructor(private readonly orm: MikroORM) {}

  async wallet(id: string): Promise<WalletState> {
    const row = await this.orm.em.fork().findOne(WalletSchema, { id });
    if (!row) throw new ApplicationError('WALLET_NOT_FOUND');
    return walletFromRow(row).toState();
  }

  async transaction(id: string): Promise<TransactionState> {
    const row = await this.orm.em.fork().findOne(TransactionSchema, { id });
    if (!row) throw new ApplicationError('TRANSACTION_NOT_FOUND');
    return transactionFromRow(row).toState();
  }

  async transactionByExternal(providerId: string, externalTransactionId: string): Promise<TransactionState> {
    const rows = await this.orm.em.fork().execute<{ id: string }[]>(
      'select transaction_id as id from wager_identities where provider_id = ? and external_transaction_id = ?', [providerId, externalTransactionId]);
    if (!rows[0]) throw new ApplicationError('TRANSACTION_NOT_FOUND');
    return this.transaction(rows[0].id);
  }

  async ledger(walletId: string, limit: number, cursor?: LedgerCursor): Promise<LedgerPage> {
    await this.wallet(walletId);
    const rows = await this.orm.em.fork().find(LedgerSchema, {
      walletId,
      ...(cursor ? { $or: [{ createdAt: { $gt: new Date(cursor.at) } }, { createdAt: new Date(cursor.at), id: { $gt: cursor.id } }] } : {}),
    }, { orderBy: { createdAt: 'asc', id: 'asc' }, limit: limit + 1 });
    const selected = rows.slice(0, limit);
    const last = selected.at(-1);
    return { entries: selected.map((row) => ledgerFromRow(row).toState()),
      next: rows.length > limit && last ? { at: last.createdAt.toISOString(), id: last.id } : null };
  }

  async reconcile(walletId: string): Promise<Reconciliation> {
    return this.orm.em.fork().transactional(async (em) => {
      const row = await em.findOne(WalletSchema, { id: walletId });
      if (!row) throw new ApplicationError('WALLET_NOT_FOUND');
      const totals = await em.execute<{ balance: string; entries: string }[]>(`
        select coalesce(sum(case direction when 'CREDIT' then amount else -amount end), 0)::numeric::text as balance,
          count(*)::text as entries from wallet_ledger where wallet_id = ?`, [walletId]);
      const total = totals[0];
      if (!total) throw new Error('Missing aggregate result');
      const amount = total.balance.includes('.') ? total.balance : `${total.balance}.00`;
      const calculated = Money.fromSignedDecimal(amount, row.currency);
      const stored = Money.from({ amount: row.balance, currency: row.currency });
      const difference = stored.subtract(calculated);
      return { walletId, storedBalance: stored.toJSON(), calculatedBalance: calculated.toJSON(), difference: difference.toJSON(),
        consistent: difference.isZero(), checkedEntries: Number(total.entries) };
    }, { isolationLevel: IsolationLevel.REPEATABLE_READ });
  }
}
