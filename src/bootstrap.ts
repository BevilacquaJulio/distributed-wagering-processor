import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Module, type DynamicModule, type OnApplicationShutdown, Inject, Injectable } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { MikroORM } from '@mikro-orm/postgresql';
import { WageringService } from './application/wagering-service';
import type { RuntimeConfig } from './config';
import { FinancialController, HealthController, ORM, QUERIES } from './http/controller';
import { HttpErrorFilter } from './http/error-filter';
import { Sha256PayloadHasher, SystemClock, UnauthenticatedProviderIdentity, UuidGenerator } from './infrastructure/identity';
import { JsonLogger, Metrics, requestContext } from './infrastructure/observability';
import { databaseConfig } from './infrastructure/postgres/config';
import { PostgresQueries } from './infrastructure/postgres/queries';
import { PostgresUnitOfWork } from './infrastructure/postgres/unit-of-work';

@Injectable()
class DatabaseLifecycle implements OnApplicationShutdown {
  constructor(@Inject(ORM) private readonly orm: MikroORM) {}
  async onApplicationShutdown(): Promise<void> { await this.orm.close(true); }
}

@Module({})
class AppModule {
  static register(orm: MikroORM): DynamicModule {
    return {
      module: AppModule, controllers: [FinancialController, HealthController], providers: [
        { provide: ORM, useValue: orm }, DatabaseLifecycle, Metrics,
        { provide: QUERIES, useFactory: () => new PostgresQueries(orm) },
        { provide: WageringService, useFactory: () => new WageringService(new PostgresUnitOfWork(orm),
          new SystemClock(), new UuidGenerator(), new Sha256PayloadHasher(), new UnauthenticatedProviderIdentity()) },
      ],
    };
  }
}

export async function createApplication(config: RuntimeConfig): Promise<NestExpressApplication> {
  const orm = await MikroORM.init(databaseConfig(config.DATABASE_URL));
  try {
    const roles = await orm.em.fork().execute<{ safe: boolean }[]>(`
      select current_user = 'jungle_runtime' and not rolsuper and not rolcreatedb and not rolcreaterole and not rolbypassrls
        and not pg_has_role(current_user, (select datdba from pg_database where datname = current_database()), 'MEMBER') as safe
      from pg_roles where rolname = current_user`);
    if (!roles[0]?.safe) throw new Error('Unsafe runtime database role');
    const app = await NestFactory.create<NestExpressApplication>(AppModule.register(orm), { logger: new JsonLogger(), abortOnError: false });
    app.use((request: IncomingMessage, response: ServerResponse, next: () => void) => {
      const supplied = request.headers['x-correlation-id'];
      const correlationId = typeof supplied === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(supplied) ? supplied : randomUUID();
      response.setHeader('X-Request-Id', correlationId);
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Cache-Control', 'no-store');
      requestContext.run({ correlationId }, next);
    });
    app.useBodyParser('json', { limit: '16kb' });
    app.useGlobalFilters(new HttpErrorFilter(app.get(Metrics)));
    app.enableShutdownHooks();
    await app.init();
    return app;
  } catch (error) {
    await orm.close(true);
    throw error;
  }
}
