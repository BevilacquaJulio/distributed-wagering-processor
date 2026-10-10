# Distributed Wagering Processor

Processador financeiro Jungle Gaming: abertura de wallet, BET, WIN, LOSS, REFUND e ROLLBACK, ledger, outbox persistida, replay, referências fora de ordem persistidas e painel local de testes. Dinheiro é string decimal nos contratos e bigint em centavos no domínio.

**Estado:** dependências instaladas com Bun 1.4.2 e `bun.lock` versionado. Typecheck (API e painel), lint, testes de unidade, builds, integração com PostgreSQL real (provisionamento e migration em banco descartável) e conferência manual do painel executados com sucesso. Build Docker da API ainda sem registro.

A concorrência entre três processos da API está comprovada por testes reais. Comandos também chegam pela fila SQS `wager-transactions.fifo`, consumida com inbox persistente e ack depois do commit pelo mesmo caso de uso da API. Uma operação que chega antes da referência fica `PENDING_REFERENCE` com aceite, agenda e evento duráveis; o publisher da outbox e o worker que reavalia pendências pertencem às próximas partes da entrega. O painel oferece wallet, todas as operações, consulta de transação, ledger, replay e reconciliação. Não há autenticação externa nesta etapa; API/Vite/portas de banco usam loopback no host.

## Como executar o projeto

### Pré-requisitos

- Bun **1.4.2**, conforme `.bun-version` e `packageManager`; [instalação oficial](https://bun.com/docs/installation).
- Docker com Docker Compose v2 para PostgreSQL (`postgres:17.6-alpine`) e o emulador SQS [MiniStack](https://ministack.org/) (`ministackorg/ministack:1.5.15`). O MiniStack não exige conta nem token; o LocalStack passou a exigir token a partir da versão 2026.03.0.
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
docker compose -f compose.yml up -d postgres sqs
docker compose -f compose.yml ps
bun run db:provision
bun run db:status
bun run db:migrate
bun run db:status
bun run sqs:provision
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

Readiness responde 200 somente com o schema na versão esperada e a fila de comandos alcançável; caso contrário, 503. Ela não cria filas nem aplica migrations.

`sqs:provision` cria manualmente `wager-transactions.fifo` (visibilidade de 30s, redrive para a DLQ após 5 recebimentos) e `wager-transactions-dlq.fifo` (retenção de 14 dias); `sqs:status` mostra os atributos. O comando é idempotente para os mesmos atributos.

Consumidor da fila, em outro terminal:

```powershell
bun run consumer
```

### Rodando a API em Docker

Depois de gerar `bun.lock`, subir PostgreSQL e aplicar manualmente as migrations acima:

```powershell
docker compose -f compose.yml up -d --build api consumer
docker compose -f compose.yml ps
docker compose -f compose.yml logs -f --tail=100 api consumer postgres sqs
docker compose -f compose.yml down
```

Parar a API e o consumidor executados no host antes de iniciar os containers. O serviço `consumer` usa a mesma imagem com `bun dist/consumer.js` e `stop_grace_period` de 30s para o SIGTERM concluir a mensagem em andamento. Os containers usam `DATABASE_URL_CONTAINER`, com host `postgres`, e `SQS_ENDPOINT_CONTAINER`, com host `sqs`; recebe somente configuração de runtime. O Dockerfile exige lockfile e instalação congelada, executa como usuário `bun` e não aplica migrations. O painel continua pelo Vite no host nesta entrega. `down` preserva o volume de desenvolvimento; o banco de testes tem armazenamento deliberadamente descartável.

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
docker compose -f compose.yml --profile test up -d postgres-test sqs
docker compose -f compose.yml --profile test ps
bun --env-file=.env.test run sqs:provision
bun --env-file=.env.test run db:provision
bun --env-file=.env.test run db:status
bun --env-file=.env.test run db:migrate
bun run test:integration
bun run test:concurrency
docker compose -f compose.yml --profile test logs --tail=100 postgres-test
```

Esperar `postgres-test` e `sqs` healthy. As filas de teste (`wager-transactions-test*.fifo`) são separadas das de desenvolvimento; os testes do consumidor criam e removem filas próprias com visibilidade curta. Os testes recusam banco com outro nome/host e não aplicam migrations nem apagam histórico. Geram identidades próprias e incluem API HTTP real, round-trip monetário, replay histórico, conflitos, rejeições, rollback pré-commit, permissões/constraints, paginação e o cliente HTTP do painel contra a API real.

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
| Dois REFUNDs da mesma BET | Um processado e outro `REFERENCE_ALREADY_REVERSED`; um único crédito. |

Cada cenário confere saldo, version, reconciliação com o ledger e a contagem de lançamentos por direção, transações por status e eventos da outbox por tipo.

A reversão da migration apaga o histórico e não faz parte do procedimento normal; `db:down` recusa alvos diferentes de `jungle_test` e exige `ALLOW_DISPOSABLE_DOWN=yes`. A CI aplica, reverte e reaplica a migration no banco descartável dela.

### Conferência manual do painel

1. Gerar um jogador de teste e criar wallet com `100.00 BRL`.
2. Enviar BET de `25.00`; verificar saldo `75.00`, versão 2, crédito OPENING e débito BET no ledger.
3. Usar **Reenviar mesma operação**; confirmar replay e ausência de novo débito.
4. Usar **Nova operação**, enviar outra BET e verificar que o saldo atual mudou; o resultado de uma operação anterior continua histórico.
5. Enviar valor acima do saldo; confirmar rejeição auditável e ausência de débito.
6. Usar **Conferir saldo** e verificar diferença `0.00`.
7. Trocar o tipo para **REFUND**, usar **Referenciar o último envio** e confirmar o crédito integral; repetir com nova operação e ver `REFERENCE_ALREADY_REVERSED`.
8. Enviar um **ROLLBACK** com um ID externo que ainda não existe; confirmar a resposta 202 `PENDING_REFERENCE` e consultar a transação em **Consultar transação**.
9. Enviar **LOSS** com `0.00` e confirmar que saldo e versão não mudam.
10. Conferir navegação por teclado, foco, mensagens de validação, estados de erro/indisponibilidade e layout móvel. Essa inspeção visual ainda está pendente.

## Contrato implementado

| Método/caminho | Comportamento |
| --- | --- |
| POST `/wallets` | Cria wallet única por jogador/moeda; abertura positiva gera OPENING e ledger. |
| GET `/wallets/:walletId` | Saldo e versão atuais. |
| POST `/wagering/transactions` | BET, WIN, LOSS, REFUND e ROLLBACK com `Idempotency-Key` obrigatório. |
| GET `/wagering/transactions/:transactionId` | Estado atual, vínculo com a referência e resposta persistida (terminal ou aceite pendente). |
| GET `/providers/:providerId/wagering/transactions/:externalTransactionId` | Consulta identidade externa. |
| GET `/wallets/:walletId/ledger?limit=50&cursor=...` | Ordem crescente, cursor opaco e limite de 1 a 100. |
| POST `/wallets/:walletId/reconciliation` | Compara saldo e ledger em snapshot consistente; não corrige divergência. |
| GET `/health/live`, `/health/ready`, `/metrics` | Diagnóstico da etapa HTTP/BET. |

Money: `{ "amount": "25.00", "currency": "BRL" }`, duas casas obrigatórias, sem sinais/expoentes/espaços/zeros à esquerda. UUIDs identificam jogador e recursos internos. Provedor, ID externo, chave, rodada e jogo aceitam de 1 a 128 caracteres de letras ASCII, números, `.`, `_`, `:`, `-`, começando por letra/número; não há trim ou mudança de caixa. Body JSON tem limite de 16 KiB e rejeita campos desconhecidos.

`referenceExternalTransactionId` é o ID externo da operação referenciada no mesmo provedor: obrigatório em REFUND e ROLLBACK, opcional em WIN e recusado em BET e LOSS; `null` ou vazio são inválidos. LOSS usa `0.00`; as demais operações exigem valor positivo. REFUND reverte BET; ROLLBACK reverte BET, WIN ou REFUND no sentido inverso; ambos exigem valor integral e mesma wallet, jogador, moeda e rodada. A unicidade de reversão é por referência e tipo, conforme o case: uma BET pode receber um REFUND e um ROLLBACK.

HTTP: 201 criação, 200 processamento/consulta, 202 aceite com referência ainda ausente (`PENDING_REFERENCE`), 400 formato/header, 404 recurso inexistente, 409 colisão, 422 rejeição financeira e 503 indisponibilidade transitória reconhecida. 202 não é resultado financeiro final; o replay devolve o aceite enquanto a operação estiver pendente. A rejeição financeira inclui ID, status, failureCode e saldo observado. Erros de transporte usam `{ error: { code, message, requestId } }`, sem SQL, stack ou secrets. OPENING é interno e recusado pelo contrato.

| `failureCode` | Situação | O que o provedor pode fazer |
| --- | --- | --- |
| `INSUFFICIENT_FUNDS` | BET maior que o saldo. | Não reenviar igual; nova aposta exige nova identidade. |
| `REVERSAL_INSUFFICIENT_FUNDS` | ROLLBACK de WIN/REFUND sem saldo para desfazer o crédito. | Tratamento operacional; não é falta de saldo de aposta. |
| `AMOUNT_NOT_ALLOWED` | LOSS diferente de 0.00 ou demais operações com 0.00. | Corrigir o payload com nova identidade. |
| `BALANCE_LIMIT_EXCEEDED` | Crédito ultrapassaria 999999999999999999.99. | Corrigir o valor com nova identidade. |
| `CURRENCY_MISMATCH` / `CURRENCY_NOT_SUPPORTED` | Moeda diferente da wallet ou não habilitada. | Corrigir a moeda. |
| `WALLET_PLAYER_MISMATCH` | Jogador não é dono da wallet. | Corrigir jogador ou wallet. |
| `INVALID_REFERENCE` | Operação referencia o próprio ID externo. | Corrigir a referência. |
| `REFERENCE_NOT_PROCESSED` | Referência existe, mas foi rejeitada ou falhou. | Desistir da reversão. |
| `REFERENCE_MISMATCH` | Tipo, jogador, wallet, moeda ou rodada incompatíveis. | Corrigir a referência. |
| `REFERENCE_AMOUNT_MISMATCH` | Valor da reversão diferente do original. | Enviar o valor integral. |
| `REFERENCE_ALREADY_REVERSED` | Já existe reversão processada do mesmo tipo para a referência. | Nada a fazer; o efeito já foi aplicado. |
| `REFERENCE_EXPIRED` | Referência não chegou dentro do prazo (aplicado pelo worker da próxima entrega). | Reenviar a operação original, se ainda for devida. |

## Fila de comandos

Envelope (§10 do case): `messageId`, `type: "WagerTransactionRequested"`, `occurredAt` ISO-8601 e `data` com os mesmos campos do POST de transação mais `idempotencyKey`. O consumidor usa o mesmo caso de uso da API, com a inbox `(consumerName, messageId)` na mesma transação SQL. Recomenda-se `MessageGroupId` por wallet; deduplicação do broker é otimização, não garantia.

| Situação | Tratamento |
| --- | --- |
| Processada, rejeitada por regra de negócio ou `PENDING_REFERENCE` | Commit e depois ack (`DeleteMessage`). |
| Mesmo `messageId` com o mesmo conteúdo, ou operação já feita por HTTP | Replay do resultado persistido e ack, sem novo efeito. |
| JSON inválido, envelope fora do contrato, OPENING ou kind desconhecido | DLQ com `failureReason = INVALID_ENVELOPE`. |
| Mesmo `messageId` com outro conteúdo | DLQ com `INBOX_CONFLICT`; o primeiro efeito é preservado. |
| Conflito de chave ou ID externo; wallet inexistente | DLQ com `IDEMPOTENCY_CONFLICT`, `EXTERNAL_ID_CONFLICT` ou `WALLET_NOT_FOUND`. |
| Falha transitória (banco indisponível, deadlock esgotado, erro inesperado) | Sem ack; visibilidade com backoff exponencial (2s a 60s). Ao exceder 5 recebimentos, o redrive do broker move para a DLQ. |

A mensagem permanente só é apagada depois que a DLQ confirma o envio. Um crash depois do commit e antes do ack é resolvido pela inbox na reentrega. No SIGTERM, o consumidor interrompe o long polling, conclui a mensagem em andamento e devolve a visibilidade das que ainda não começaram.

## CI

O workflow `CI` (`.github/workflows/ci.yml`) roda na abertura e em cada atualização de PR para `teste` ou `main`, e também por **Actions → CI → Run workflow**.

| Job | O que executa |
| --- | --- |
| **Lint, tipos, unidade e build** | Instalação congelada, `typecheck`, `typecheck:web`, `lint`, `test:unit` com cobertura LCOV, `build`, `build:web`. |
| **Auditoria de dependências** | `bun audit --audit-level=high`; falha com vulnerabilidade alta ou crítica. |
| **Imagem Docker e Compose** | Valida o `compose.yml` e constrói a imagem da API. |
| **Integração com PostgreSQL real** | Sobe `postgres-test` e o emulador SQS do Compose com credenciais geradas na execução, cria as filas de teste, provisiona, aplica as migrations, roda `test:integration` (inclui o consumidor e o SIGTERM do processo real) com cobertura LCOV e `test:concurrency`, reverte e reaplica a última migration. Publica o log como artefato. |
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
