# Distributed Wagering Processor

Primeira implementação do processador financeiro Jungle Gaming: abertura de wallet, BET, ledger, outbox persistida, replay e painel local de testes. Dinheiro é string decimal nos contratos e bigint em centavos no domínio.

**Estado:** dependências instaladas com Bun 1.4.2 e `bun.lock` versionado. Typecheck (API e painel), lint, testes de unidade, builds, integração com PostgreSQL real (provisionamento e migration em banco descartável) e conferência manual do painel executados com sucesso. Build Docker da API ainda sem registro.

A concorrência entre três processos da API está comprovada por testes reais. WIN, LOSS, REFUND, ROLLBACK, SQS/inbox, publicação da outbox e referências pendentes pertencem às próximas entregas. O painel oferece wallet, BET, ledger, replay e reconciliação. Não há autenticação externa nesta etapa; API/Vite/portas de banco usam loopback no host.

## Como executar o projeto

### Pré-requisitos

- Bun **1.4.2**, conforme `.bun-version` e `packageManager`; [instalação oficial](https://bun.com/docs/installation).
- Docker com Docker Compose v2 para PostgreSQL; PostgreSQL local usa a imagem `postgres:17.6-alpine`.
- Git para obter o código. Nenhum Node/npm separado é usado pelos comandos abaixo; a prova de compatibilidade das bibliotecas com Bun ainda deve ser executada.

As instruções abaixo estão em PowerShell e pressupõem a raiz do repositório. Os comandos alteram somente o ambiente local configurado; são passos manuais. Não há migration em bootstrap, healthcheck, setup de teste ou inicialização de container.

### Obter e preparar

```powershell
git clone https://github.com/BevilacquaJulio/distributed-wagering-processor.git
cd distributed-wagering-processor
```

O código desta entrega está integrado em `main`. Novas entregas passam primeiro pela branch `teste`.

```powershell
Copy-Item .env.example .env
Copy-Item .env.test.example .env.test
bun install
```

Executar as cópias apenas se os arquivos locais ainda não existirem. Ajustar senhas antes de uso e mantê-las consistentes entre `POSTGRES_PASSWORD`, `DATABASE_RUNTIME_PASSWORD` e as URLs; caracteres especiais em URLs precisam de percent-encoding. Os valores dos exemplos são credenciais fictícias de desenvolvimento. `VITE_*` é público e não pode conter segredo.

A primeira instalação gera o lockfile único `bun.lock`. Revisá-lo e versioná-lo junto do código. Nas instalações seguintes usar `bun install --frozen-lockfile`. Não substituir por lockfile npm/yarn nem editar o lockfile manualmente.

### Rodando localmente

```powershell
docker compose -f compose.yml config --quiet
docker compose -f compose.yml up -d postgres
docker compose -f compose.yml ps
bun run db:provision
bun run db:status
bun run db:migrate
bun run db:status
bun run dev
```

Esperar o serviço `postgres` ficar healthy antes do provisionamento. O alvo de desenvolvimento é `jungle` em `127.0.0.1:55432`. `db:provision` cria o papel restrito `jungle_runtime` uma única vez; se ele já existir, o comando falha sem rotacionar a senha. `DATABASE_ADMIN_URL` pertence ao papel administrativo, usado somente por provisionamento/migrations. `DATABASE_URL` pertence ao runtime, que não possui DDL nem privilégios de dono.

Em outro terminal, na mesma raiz:

```powershell
bun run dev:web
```

Painel: `http://127.0.0.1:5173`. API: `http://127.0.0.1:3000`. O Vite encaminha `/api/*` para a API e remove somente `/api`; os endpoints NestJS preservam os caminhos do case. `API_PROXY_TARGET` é configuração do servidor Vite. Nesta entrega `VITE_API_URL` fica vazio e o cliente usa `/api` na mesma origem.

```powershell
Invoke-RestMethod http://127.0.0.1:3000/health/live
Invoke-RestMethod http://127.0.0.1:3000/health/ready
```

Readiness desta entrega cobre PostgreSQL e versão do schema, com `scope: http-bet` e SQS explicitamente `not-implemented`. Isso não comprova a readiness final PostgreSQL/SQS exigida pelo case.

### Rodando a API em Docker

Depois de gerar `bun.lock`, subir PostgreSQL e aplicar manualmente as migrations acima:

```powershell
docker compose -f compose.yml up -d --build api
docker compose -f compose.yml ps
docker compose -f compose.yml logs -f --tail=100 api postgres
docker compose -f compose.yml down
```

Parar a API executada no host antes de iniciar o container na mesma porta. A API usa `DATABASE_URL_CONTAINER`, com host `postgres`; recebe somente configuração de runtime. O Dockerfile exige lockfile e instalação congelada, executa como usuário `bun` e não aplica migrations. O painel continua pelo Vite no host nesta entrega. `down` preserva o volume de desenvolvimento; o banco de testes tem armazenamento deliberadamente descartável.

## Validação

Após instalar as dependências:

```powershell
bun run typecheck
bun run typecheck:web
bun run lint
bun run test:unit
bun run build
bun run build:web
```

Unidade cobre Money, wallet, ledger, terminalidade, hash e contratos. `build` gera `dist/main.js`; `build:web` gera `dist/web`. O segundo build não é um deploy. O start compilado da API é `bun run start:built`.

### Integração com PostgreSQL real

Usar `.env.test` com URLs locais terminando em `/jungle_test`, porta `55433` e `TEST_DATABASE_DISPOSABLE=yes`. Preparar o banco separado:

```powershell
docker compose -f compose.yml --profile test up -d postgres-test
docker compose -f compose.yml --profile test ps
bun --env-file=.env.test run db:provision
bun --env-file=.env.test run db:status
bun --env-file=.env.test run db:migrate
bun run test:integration
bun run test:concurrency
docker compose -f compose.yml --profile test logs --tail=100 postgres-test
```

Esperar `postgres-test` healthy. Os testes recusam banco com outro nome/host e não aplicam migrations nem apagam histórico. Geram identidades próprias e incluem API HTTP real, round-trip monetário, replay histórico, conflitos, rejeições, rollback pré-commit, permissões/constraints, paginação e o cliente HTTP do painel contra a API real.

O PostgreSQL de testes usa tmpfs: parar/recriar o container pode perder os dados desse serviço, exigindo novo provisionamento e migrations. O volume de desenvolvimento é separado. Não usar `down -v` como atualização normal.

### Concorrência entre três processos

`bun run test:concurrency` usa o mesmo banco descartável e os mesmos pré-requisitos da integração. O teste sobe três processos independentes da API (`bun --no-env-file src/main.ts`), cada um com seu pool, e dispara as requisições distribuídas entre eles.

A disputa é sincronizada por uma barreira no próprio PostgreSQL, sem `sleep`: o teste abre uma transação que segura o recurso disputado (`SELECT ... FOR UPDATE` na wallet ou uma wallet provisória do mesmo jogador), envia as requisições e só libera quando `pg_stat_activity` mostra todas as transações esperando lock. A espera máxima da barreira (2s) fica abaixo do `lock_timeout` da aplicação (3s).

| Cenário | Resultado exigido |
| --- | --- |
| Mesma BET 50 vezes | Uma transação e um débito; 1 resposta original e 49 replays com o mesmo resultado. |
| Duas BETs de 80.00 contra 100.00 | Uma `PROCESSED`, uma `REJECTED` com `INSUFFICIENT_FUNDS`; saldo final 20.00. |
| Vinte BETs de 10.00 contra 100.00 | Dez processadas, cada uma com um saldo observado distinto (90.00 a 0.00), e dez rejeitadas. |
| Wallet bloqueada e outra wallet | A segunda wallet é processada enquanto a primeira continua bloqueada. |
| Trinta criações da mesma wallet | Uma 201 e 29 409 `WALLET_ALREADY_EXISTS`; uma única wallet no banco. |

Cada cenário confere saldo, version, reconciliação com o ledger e a contagem de lançamentos por direção, transações por status e eventos da outbox por tipo.

A reversão da migration apaga o histórico e não faz parte do procedimento normal; `db:down` recusa alvos diferentes de `jungle_test` e exige `ALLOW_DISPOSABLE_DOWN=yes`. A CI aplica, reverte e reaplica a migration no banco descartável dela.

### Conferência manual do painel

1. Gerar um jogador de teste e criar wallet com `100.00 BRL`.
2. Enviar BET de `25.00`; verificar saldo `75.00`, versão 2, crédito OPENING e débito BET no ledger.
3. Usar **Reenviar mesma operação**; confirmar replay e ausência de novo débito.
4. Usar **Nova operação**, enviar outra BET e verificar que o saldo atual mudou; o resultado de uma operação anterior continua histórico.
5. Enviar valor acima do saldo; confirmar rejeição auditável e ausência de débito.
6. Usar **Conferir saldo** e verificar diferença `0.00`.
7. Conferir navegação por teclado, foco, mensagens de validação, estados de erro/indisponibilidade e layout móvel. Essa inspeção visual ainda está pendente.

## Contrato implementado

| Método/caminho | Comportamento |
| --- | --- |
| POST `/wallets` | Cria wallet única por jogador/moeda; abertura positiva gera OPENING e ledger. |
| GET `/wallets/:walletId` | Saldo e versão atuais. |
| POST `/wagering/transactions` | BET com `Idempotency-Key` obrigatório. |
| GET `/wagering/transactions/:transactionId` | Estado da transação. |
| GET `/providers/:providerId/wagering/transactions/:externalTransactionId` | Consulta identidade externa. |
| GET `/wallets/:walletId/ledger?limit=50&cursor=...` | Ordem crescente, cursor opaco e limite de 1 a 100. |
| POST `/wallets/:walletId/reconciliation` | Compara saldo e ledger em snapshot consistente; não corrige divergência. |
| GET `/health/live`, `/health/ready`, `/metrics` | Diagnóstico da etapa HTTP/BET. |

Money: `{ "amount": "25.00", "currency": "BRL" }`, duas casas obrigatórias, sem sinais/expoentes/espaços/zeros à esquerda. UUIDs identificam jogador e recursos internos. Provedor, ID externo, chave, rodada e jogo aceitam de 1 a 128 caracteres de letras ASCII, números, `.`, `_`, `:`, `-`, começando por letra/número; não há trim ou mudança de caixa. Body JSON tem limite de 16 KiB e rejeita campos desconhecidos.

HTTP: 201 criação, 200 processamento/consulta, 400 formato/header, 404 recurso inexistente, 409 colisão, 422 rejeição financeira e 503 indisponibilidade transitória reconhecida. A rejeição financeira inclui ID, status, failureCode e saldo observado. Erros de transporte usam `{ error: { code, message, requestId } }`, sem SQL, stack ou secrets. Kinds ainda não implementados, inclusive OPENING externo, são recusados pelo contrato desta etapa.

## CI

O workflow `CI` (`.github/workflows/ci.yml`) roda na abertura e em cada atualização de PR para `teste` ou `main`, e também por **Actions → CI → Run workflow**.

| Job | O que executa |
| --- | --- |
| **Lint, tipos, unidade e build** | Instalação congelada, `typecheck`, `typecheck:web`, `lint`, `test:unit` com cobertura LCOV, `build`, `build:web`. |
| **Auditoria de dependências** | `bun audit --audit-level=high`; falha com vulnerabilidade alta ou crítica. |
| **Imagem Docker e Compose** | Valida o `compose.yml` e constrói a imagem da API. |
| **Integração com PostgreSQL real** | Sobe o `postgres-test` do Compose com credenciais geradas na execução, provisiona, aplica a migration, roda `test:integration` com cobertura LCOV e `test:concurrency`, reverte e reaplica a migration. Publica o log como artefato. |
| **SonarCloud Quality Gate** | Envia a cobertura de unidade e integração ao SonarCloud e aguarda o Quality Gate (inclui 80% de cobertura no código novo). |

O workflow `CodeQL` (`.github/workflows/codeql.yml`) analisa JavaScript/TypeScript em PRs e em pushes para `teste` e `main`; a análise das branches fixas é a base para identificar alertas novos.

Exceção da auditoria: `GHSA-vfj7-8cjw-p6xm` (`braces`) não tem versão corrigida publicada e é alcançada apenas por globs estáticos do MikroORM e da CLI de migrations. A cobertura exclui migrations, scripts administrativos e `web/vite.config.ts`, que rodam como processos separados ou configuração, fora da instrumentação do `bun test`.

Migrations só são aplicadas no PostgreSQL descartável criado pelo job; nenhum banco persistente é acessado. Não há deploy.

## Operação e atualização

- Dependências: atualizar manifesto somente com escopo definido, instalar/revisar `bun.lock` e reconstruir a imagem da API.
- Código backend: executar validações pertinentes e `docker compose -f compose.yml up -d --build api`.
- Código do painel: executar `typecheck:web`, `lint` e `build:web`; Vite acompanha edições em desenvolvimento.
- Schema: inspecionar a migration e o alvo, executar `db:status`, `db:migrate`, `db:status`, validar e depois atualizar a API. Nunca migrar no startup.
- Env de container: `docker compose -f compose.yml up -d --force-recreate api`; `restart` não recarrega env do Compose.
- Reiniciar o mesmo processo sem mudança de código/env: `docker compose -f compose.yml restart api`.

Não há deploy de produção ou CI/CD configurado. O ponto de extensão `ProviderIdentityPort` é deliberadamente permissivo nesta fase; completar autenticação e operação de produção requer escopo próprio. Decisões e limitações da implementação estão em [IMPLEMENTACAO.md](IMPLEMENTACAO.md).
