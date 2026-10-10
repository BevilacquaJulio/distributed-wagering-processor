import { IsolationLevel } from '@mikro-orm/core';
import type { MikroORM } from '@mikro-orm/postgresql';
import { ApplicationError } from '../../application/errors';
import type { FinancialSession, FinancialUnitOfWork } from '../../application/ports';
import type { Metrics } from '../observability';
import { PostgresFinancialSession } from './session';

export function sqlState(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const details = error as { code?: unknown; cause?: unknown };
  return typeof details.code === 'string' ? details.code : details.cause ? sqlState(details.cause) : undefined;
}

export function isUnavailable(error: unknown): boolean {
  if (error instanceof Error && ['KnexTimeoutError', 'TimeoutError'].includes(error.name)) return true;
  const code = sqlState(error);
  return code !== undefined && (code.startsWith('08') || ['57P01', '57P02', '57P03', '53300', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', '40001', '40P01', '55P03', '57014'].includes(code));
}

export class PostgresUnitOfWork implements FinancialUnitOfWork {
  constructor(private readonly orm: MikroORM, private readonly beforeCommit?: () => Promise<void>, private readonly metrics?: Metrics) {}

  async run<T>(work: (session: FinancialSession) => Promise<T>): Promise<T> {
    const started = performance.now();
    try {
      return await this.attempt(work);
    } finally {
      this.metrics?.observe('wagering_unit_duration_seconds', (performance.now() - started) / 1000);
    }
  }

  private async attempt<T>(work: (session: FinancialSession) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this.orm.em.fork().transactional(async (em) => {
          const result = await work(new PostgresFinancialSession(em));
          await em.flush();
          await this.beforeCommit?.();
          return result;
        }, { isolationLevel: IsolationLevel.READ_COMMITTED });
      } catch (error) {
        const code = sqlState(error);
        if (code === '23505' && typeof error === 'object' && error !== null && 'constraint' in error && error.constraint === 'wallets_player_currency_unique') {
          throw new ApplicationError('WALLET_ALREADY_EXISTS');
        }
        const lockConflict = code !== undefined && ['40001', '40P01', '55P03'].includes(code);
        if (lockConflict) this.metrics?.increment('lock_conflict');
        if (lockConflict && attempt < 2) {
          this.metrics?.increment('lock_retry');
          await Bun.sleep(20 * (attempt + 1) + Math.floor(Math.random() * 20));
          continue;
        }
        if (isUnavailable(error)) throw new ApplicationError('INFRASTRUCTURE_UNAVAILABLE');
        throw error;
      }
    }
    throw new ApplicationError('INFRASTRUCTURE_UNAVAILABLE');
  }
}
