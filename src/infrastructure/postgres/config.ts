import { Migrator } from '@mikro-orm/migrations';
import { defineConfig } from '@mikro-orm/postgresql';
import { entities } from './entities';
import { Migration202610090001 } from './migrations/Migration202610090001';

export const DATABASE_POOL_MAX = 10;

export function databaseConfig(clientUrl: string) {
  return defineConfig({
    clientUrl, entities, extensions: [Migrator], debug: false, logger: () => {},
    pool: { min: 0, max: DATABASE_POOL_MAX, acquireTimeoutMillis: 5000 },
    driverOptions: { connection: { connectionTimeoutMillis: 5000, options: '-c statement_timeout=10000 -c lock_timeout=3000' } },
    migrations: {
      migrationsList: [Migration202610090001], transactional: true, allOrNothing: true,
      snapshot: false, disableForeignKeys: false,
    },
  });
}
