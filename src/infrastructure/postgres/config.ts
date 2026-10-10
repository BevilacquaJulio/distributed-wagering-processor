import { Migrator } from '@mikro-orm/migrations';
import { defineConfig } from '@mikro-orm/postgresql';
import { entities } from './entities';
import { Migration202610090001 } from './migrations/Migration202610090001';
import { Migration202610090002 } from './migrations/Migration202610090002';
import { Migration202610100001 } from './migrations/Migration202610100001';

export const DATABASE_POOL_MAX = 10;
/** Versão gravada em schema_version pela última migration; readiness e testes recusam schema diferente. */
export const SCHEMA_VERSION = 3;
export const MIGRATIONS = [Migration202610090001, Migration202610090002, Migration202610100001];

export function databaseConfig(clientUrl: string) {
  return defineConfig({
    clientUrl, entities, extensions: [Migrator], debug: false, logger: () => {},
    pool: { min: 0, max: DATABASE_POOL_MAX, acquireTimeoutMillis: 5000 },
    driverOptions: { connection: { connectionTimeoutMillis: 5000, options: '-c statement_timeout=10000 -c lock_timeout=3000' } },
    migrations: {
      migrationsList: MIGRATIONS, transactional: true, allOrNothing: true,
      snapshot: false, disableForeignKeys: false,
    },
  });
}
