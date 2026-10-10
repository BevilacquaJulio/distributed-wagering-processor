import { MikroORM } from '@mikro-orm/postgresql';
import { adminUrl } from '../src/config';
import { databaseConfig, MIGRATIONS } from '../src/infrastructure/postgres/config';

let orm: MikroORM | undefined;
try {
  const action = process.argv[2];
  if (!['status', 'up', 'down'].includes(action ?? '')) throw new Error('Expected status, up or down');
  const url = adminUrl();
  if (action === 'down' && (process.env.ALLOW_DISPOSABLE_DOWN !== 'yes' || new URL(url).pathname !== '/jungle_test')) {
    throw new Error('Downgrade is restricted to explicitly disposable jungle_test');
  }
  orm = await MikroORM.init(databaseConfig(url));
  if (action === 'status') {
    const em = orm.em.fork();
    const tables = await em.execute<{ present: boolean }[]>("select to_regclass('public.mikro_orm_migrations') is not null as present");
    const executed = tables[0]?.present
      ? await em.execute<{ name: string; executed_at: Date }[]>('select name, executed_at from mikro_orm_migrations order by id') : [];
    const pending = MIGRATIONS.map((migration) => migration.name).filter((name) => !executed.some((row) => row.name === name));
    process.stdout.write(`${JSON.stringify({ executed, pending }, null, 2)}\n`);
  } else if (action === 'up') {
    await orm.getMigrator().up();
    process.stdout.write('Migrations aplicadas.\n');
  } else {
    await orm.getMigrator().down();
    process.stdout.write('Migration revertida no banco descartável; histórico financeiro removido.\n');
  }
} catch {
  process.stderr.write('Operação de migrations não concluída. Confira alvo, papel provisionado e schema; detalhes SQL foram omitidos.\n');
  process.exitCode = 1;
} finally { await orm?.close(true); }
