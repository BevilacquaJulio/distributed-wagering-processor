import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { createApplication } from '../../src/bootstrap';
import { readConfig, readMessagingConfig } from '../../src/config';
import { openWalletSchema, wagerSchema } from '../../src/contracts/requests';
import { FinancialController, HealthController } from '../../src/http/controller';
import { OPENAPI_SCHEMAS } from '../../src/http/openapi';
import { openWallet, send, startTestApi, type TestApi, wager } from '../support/api';

interface OpenApi {
  openapi: string;
  paths: Record<string, Record<string, { requestBody?: { content: Record<string, { example?: unknown }> } }>>;
  components: { schemas: Record<string, unknown> };
}

let api: TestApi;
let document: OpenApi;

beforeAll(async () => {
  api = await startTestApi();
  const response = await send(api.base, '/docs/openapi.json');
  expect(response.status).toBe(200);
  document = await response.json() as OpenApi;
});

afterAll(async () => { await api?.close(); });

// Rotas declaradas nos controllers, lidas dos metadados do Nest: rota nova sem documentação quebra o teste.
function declaredRoutes(): string[] {
  const routes: string[] = [];
  for (const controller of [FinancialController, HealthController]) {
    for (const name of Object.getOwnPropertyNames(controller.prototype).filter((key) => key !== 'constructor')) {
      const handler = controller.prototype[name as keyof typeof controller.prototype] as unknown;
      if (typeof handler !== 'function' || !Reflect.hasMetadata(PATH_METADATA, handler)) continue;
      const path = `/${Reflect.getMetadata(PATH_METADATA, handler) as string}`.replace(/:(\w+)/g, '{$1}');
      routes.push(`${RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as number]?.toLowerCase()} ${path}`);
    }
  }
  return routes.sort();
}

describe('documentação OpenAPI', () => {
  test('cobre exatamente as rotas dos controllers', () => {
    expect(document.openapi).toBe('3.1.0');
    const documented = Object.entries(document.paths).flatMap(([path, methods]) => Object.keys(methods).map((method) => `${method} ${path}`));
    expect(documented.sort()).toEqual(declaredRoutes());
  });

  test('exemplos de requisição passam pela mesma validação da API', () => {
    const example = (path: string) => document.paths[path]?.post?.requestBody?.content['application/json']?.example;
    expect(openWalletSchema.safeParse(example('/wallets')).success).toBe(true);
    expect(wagerSchema.safeParse(example('/wagering/transactions')).success).toBe(true);
  });

  test('respostas reais da API correspondem aos schemas documentados', async () => {
    const created = await openWallet(api.base);
    expect(OPENAPI_SCHEMAS.Wallet.parse(created)).toEqual(created);

    const command = wager(created);
    const submitted = await (await send(api.base, '/wagering/transactions', 'POST', command, randomUUID())).json();
    OPENAPI_SCHEMAS.TransactionResult.parse(submitted);
    const rejected = await (await send(api.base, '/wagering/transactions', 'POST', wager(created, 'BET', '500.00'), randomUUID())).json();
    OPENAPI_SCHEMAS.TransactionResult.parse(rejected);
    const pending = await send(api.base, '/wagering/transactions', 'POST',
      wager(created, 'REFUND', '10.00', { referenceExternalTransactionId: `missing-${randomUUID()}` }), randomUUID());
    expect(pending.status).toBe(202);
    OPENAPI_SCHEMAS.TransactionResult.parse(await pending.json());

    const transactionId = (submitted as { transactionId: string }).transactionId;
    OPENAPI_SCHEMAS.Transaction.parse(await (await send(api.base, `/wagering/transactions/${transactionId}`)).json());
    OPENAPI_SCHEMAS.Transaction.parse(await (await send(api.base,
      `/providers/${command.providerId}/wagering/transactions/${command.externalTransactionId}`)).json());
    OPENAPI_SCHEMAS.LedgerPage.parse(await (await send(api.base, `/wallets/${created.id}/ledger?limit=1`)).json());
    OPENAPI_SCHEMAS.Reconciliation.parse(await (await send(api.base, `/wallets/${created.id}/reconciliation`, 'POST')).json());
    OPENAPI_SCHEMAS.Readiness.parse(await (await send(api.base, '/health/ready')).json());
    OPENAPI_SCHEMAS.Error.parse(await (await send(api.base, `/wallets/${randomUUID()}`)).json());
  });

  test('interface Swagger e YAML respondem em /docs', async () => {
    const page = await send(api.base, '/docs');
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(await page.text()).toContain('swagger');
    expect((await send(api.base, '/docs/openapi.yaml')).status).toBe(200);
  });

  test('API_DOCS_ENABLED=false remove a documentação', async () => {
    const app = await createApplication({ ...readConfig(), API_DOCS_ENABLED: false }, readMessagingConfig());
    try {
      await app.listen(0, '127.0.0.1');
      const base = await app.getUrl();
      expect((await send(base, '/docs/openapi.json')).status).toBe(404);
      expect((await send(base, '/health/live')).status).toBe(200);
    } finally {
      await app.close();
    }
  });
});
