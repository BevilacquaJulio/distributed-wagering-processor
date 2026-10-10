import { MikroORM } from '@mikro-orm/postgresql';
import { databaseConfig, SCHEMA_VERSION } from '../../src/infrastructure/postgres/config';

const DISPOSABLE_HOSTS = ['127.0.0.1', 'localhost', 'postgres-test'];

// Integração e concorrência só rodam contra o banco descartável e já migrado; nunca preparam schema.
export async function connectDisposableDatabase(databaseUrl: string): Promise<MikroORM> {
  const url = new URL(databaseUrl);
  if (process.env.TEST_DATABASE_DISPOSABLE !== 'yes' || url.pathname !== '/jungle_test' || !DISPOSABLE_HOSTS.includes(url.hostname)) {
    throw new Error('Integration requires an explicitly disposable, local jungle_test database');
  }
  const orm = await MikroORM.init(databaseConfig(databaseUrl));
  const version = await orm.em.fork().execute<{ version: number }[]>('select version from schema_version');
  if (version[0]?.version !== SCHEMA_VERSION) {
    await orm.close(true);
    throw new Error('Apply migrations manually before integration');
  }
  return orm;
}
