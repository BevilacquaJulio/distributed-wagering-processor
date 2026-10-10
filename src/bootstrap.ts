import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Module, type DynamicModule, type OnApplicationShutdown, Inject, Injectable } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { MikroORM } from '@mikro-orm/postgresql';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { WageringService } from './application/wagering-service';
import type { MessagingConfig, RuntimeConfig } from './config';
import { FinancialController, HealthController, MESSAGING, ORM, QUERIES, SQS } from './http/controller';
import { HttpErrorFilter } from './http/error-filter';
import { Sha256PayloadHasher, SystemClock, UnauthenticatedProviderIdentity, UuidGenerator } from './infrastructure/identity';
import { JsonLogger, Metrics, requestContext } from './infrastructure/observability';
import { databaseConfig } from './infrastructure/postgres/config';
import { PostgresQueries } from './infrastructure/postgres/queries';
import { PostgresUnitOfWork } from './infrastructure/postgres/unit-of-work';
import { createSqsClient } from './infrastructure/sqs/client';

@Injectable()
class InfrastructureLifecycle implements OnApplicationShutdown {
  constructor(@Inject(ORM) private readonly orm: MikroORM, @Inject(SQS) private readonly sqs: SQSClient) {}
  async onApplicationShutdown(): Promise<void> {
    this.sqs.destroy();
    await this.orm.close(true);
  }
}

/** Composição única do caso de uso financeiro, compartilhada pela API e pelo consumidor da fila. */
export function createWageringService(orm: MikroORM, metrics?: Metrics): WageringService {
  return new WageringService(new PostgresUnitOfWork(orm, undefined, metrics), new SystemClock(), new UuidGenerator(),
    new Sha256PayloadHasher(), new UnauthenticatedProviderIdentity());
}

// Todo processo recusa iniciar com papel de banco que possa alterar schema ou contornar as proteções.
export async function assertRuntimeRole(orm: MikroORM): Promise<void> {
  const roles = await orm.em.fork().execute<{ safe: boolean }[]>(`
    select current_user = 'jungle_runtime' and not rolsuper and not rolcreatedb and not rolcreaterole and not rolbypassrls
      and not pg_has_role(current_user, (select datdba from pg_database where datname = current_database()), 'MEMBER') as safe
    from pg_roles where rolname = current_user`);
  if (!roles[0]?.safe) throw new Error('Unsafe runtime database role');
}

@Module({})
class AppModule {
  static register(orm: MikroORM, sqs: SQSClient, messaging: MessagingConfig): DynamicModule {
    return {
      module: AppModule, controllers: [FinancialController, HealthController], providers: [
        { provide: ORM, useValue: orm }, { provide: SQS, useValue: sqs }, { provide: MESSAGING, useValue: messaging },
        InfrastructureLifecycle, Metrics,
        { provide: QUERIES, useFactory: () => new PostgresQueries(orm) },
        { provide: WageringService, useFactory: (metrics: Metrics) => createWageringService(orm, metrics), inject: [Metrics] },
      ],
    };
  }
}

export async function createApplication(config: RuntimeConfig, messaging: MessagingConfig): Promise<NestExpressApplication> {
  const orm = await MikroORM.init(databaseConfig(config.DATABASE_URL));
  const sqs = createSqsClient(messaging);
  try {
    await assertRuntimeRole(orm);
    const app = await NestFactory.create<NestExpressApplication>(AppModule.register(orm, sqs, messaging), { logger: new JsonLogger(), abortOnError: false });
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
    sqs.destroy();
    await orm.close(true);
    throw error;
  }
}
