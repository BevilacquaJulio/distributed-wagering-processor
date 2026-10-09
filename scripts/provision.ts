import { MikroORM } from '@mikro-orm/postgresql';
import { adminUrl } from '../src/config';
import { databaseConfig } from '../src/infrastructure/postgres/config';

let orm: MikroORM | undefined;
try {
  const url = adminUrl();
  const password = process.env.DATABASE_RUNTIME_PASSWORD;
  if (!password || password.length < 16) throw new Error('Runtime password must contain at least 16 characters');
  orm = await MikroORM.init(databaseConfig(url));
  const em = orm.em.fork();
  const exists = await em.execute<{ present: boolean }[]>("select exists(select 1 from pg_roles where rolname = 'jungle_runtime') as present");
  if (exists[0]?.present) throw new Error('Runtime role already exists; provision does not rotate passwords');
  const statements = await em.execute<{ sql: string }[]>(
    "select format('create role jungle_runtime login nosuperuser nocreatedb nocreaterole noinherit nobypassrls password %L', ?) as sql", [password]);
  const statement = statements[0]?.sql;
  if (!statement) throw new Error('Role statement unavailable');
  await em.transactional(async (session) => {
    await session.execute(statement);
    await session.execute('revoke create on schema public from public');
    await session.execute('grant usage on schema public to jungle_runtime');
  });
  process.stdout.write('Papel jungle_runtime criado. Execute as migrations separadamente.\n');
} catch {
  process.stderr.write('Provisionamento não concluído. Confira URL administrativa, senha e existência do papel; nenhuma senha é alterada automaticamente.\n');
  process.exitCode = 1;
} finally { await orm?.close(true); }
