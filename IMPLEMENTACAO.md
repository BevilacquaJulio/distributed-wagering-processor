# Decisões da primeira implementação

## Escopo e evidência

Código e testes estão escritos, sem execução comprovada. O runtime proposto é Bun 1.4.2, com NestJS 11.2.6, MikroORM 6.6.16, TypeScript 5.9.3 e PostgreSQL 17.6. As versões foram identificadas em fontes oficiais/registro; a combinação precisa passar pela primeira instalação e suíte real. O lockfile ainda depende dessa instalação.

## Dinheiro, domínio e persistência

Money armazena centavos bigint e recebe/serializa strings com duas casas. O limite de entrada/saldo é 999999999999999999.99. O mapper PostgreSQL conserva numeric(20,2) como string e falha se receber number. Aritmética interna assinada permite diferenças de reconciliação; valores externos negativos são inválidos.

Domínio em `src/domain` não importa NestJS, ORM ou SQL. Factories encapsulam estado, rehydrate reconstrói sem executar transições e snapshots retornados são cópias. HTTP adapta dados para o serviço de aplicação. A entrada SQS futura usará o mesmo caso de uso.

EntitySchema define o mapeamento explicitamente. NestJS usa tokens de injeção, dispensando inferência por decorator metadata. Isso reduz dependência do modo de transpilação do runtime, mas não substitui o typecheck.

## Atomicidade e concorrência

Uma unidade `EntityManager.transactional()` com READ COMMITTED compartilha o manager entre reserva, wallet, transação, ledger, resposta e outbox. Cada tentativa começa com fork próprio. Repositories fazem flush dentro da unidade, sem commit isolado.

`wager_identities` reserva `(providerId,idempotencyKey)` e `(providerId,externalTransactionId)` com unicidade. O vínculo à transação é diferido até o commit. A reserva não referencia wallet, evitando um key-share lock prematuro antes do lock exclusivo. `INSERT ... ON CONFLICT DO NOTHING` permite consultar a operação vencedora sem continuar numa transação abortada.

Depois da reserva, a wallet é bloqueada e relida. Wallets distintas não compartilham lock global. Deadlock/serialization/lock timeout têm até três tentativas totais, com contexto novo. Conexão perdida em commit retorna indisponibilidade quando reconhecida; o cliente reenvia a mesma identidade para descobrir o resultado persistido. Não há troca automática de chave.

Antes do commit, falha desfaz toda a unidade. Depois do commit, replay lê o snapshot original e não recalcula saldo nem reemite eventos. `beforeCommit` é uma dependência de teste injetável no adaptador, sem rota/env pública de crash.

### Prova entre processos

`tests/concurrency` sobe três processos da API contra o mesmo PostgreSQL e sincroniza a disputa por uma barreira observada no banco: uma transação de teste segura a wallet (ou uma wallet provisória do mesmo jogador) e só é liberada quando todas as transações das instâncias aparecem esperando lock em `pg_stat_activity`. Os cenários cobrem 50 envios da mesma BET, 80/80 contra 100, vinte débitos de 10.00 contra 100, isolamento entre wallets e criação simultânea da mesma wallet. Sem o `PESSIMISTIC_WRITE` na leitura da wallet, os cenários 80/80 e vinte débitos falham com lost update, o que confirma que a suíte detecta a ausência do lock.

## Proteções no schema

Unicidade de wallet, identidades e ledger; numeric finito dentro dos bounds; equação local do lançamento; foreign keys entre ledger, operação e wallet/moeda; ledger compatível com operação processada; snapshot compatível com status/failureCode.

Papel runtime não é dono nem superusuário. Possui INSERT/SELECT necessários e UPDATE limitado às colunas mutáveis. Ledger, resultados e identidades têm triggers contra UPDATE/DELETE/TRUNCATE; transações terminais são imutáveis; envelope de outbox não pode ser alterado. Não há cascatas destrutivas.

Saldo total igual ao ledger é mantido pelo caso de uso transacional e verificado por reconciliação/testes. Não existe trigger que recalcule a soma completa do histórico em cada write: constraints locais não demonstram sozinhas a coerência de todo o agregado. Essa fronteira exige a prova de atomicidade e a próxima prova em três processos.

## Idempotência e resultados

SHA-256 de JSON com chaves ordenadas recursivamente, UTF-8, incluindo todos os campos de negócio validados; chave e metadados de transporte ficam fora. Mesmo provedor/chave/payload/ID é replay. Chave reaproveitada com outro payload é conflito; ID externo com outra chave também é conflito.

Resultados terminais ficam em tabela append-only, incluindo rejeições sem ledger. Movimentações posteriores não mudam o saldo dessa resposta. GET wallet retorna o saldo atual. Abertura positiva inclui OPENING/ledger e mantém version 1; débito posterior incrementa. Abertura zero e BET rejeitada não geram ledger.

## Eventos e diagnóstico

Processed, Rejected e BalanceChanged são classes concretas, com envelope versionado e MoneyProps serializável. Eventos são persistidos no mesmo commit. Nenhum publisher/SQS está implementado; eventos permanecem pendentes. Persistência de outbox não equivale a entrega comprovada.

Logs JSON contêm correlação e identidades do resultado, sem payload/valor financeiro, SQL ou credenciais. `/metrics` expõe contadores locais de resultados, replay, conflito, indisponibilidade e divergência. Contagem é observacional, não ledger auditável. Métricas de workers, retries, locks, lag e histogramas completos ainda serão implementadas.

Reconciliação usa REPEATABLE READ. Liveness verifica processo; readiness consulta schema/PostgreSQL e declara escopo parcial HTTP/BET. Timeouts de conexão/consulta/lock são finitos. A suite de shutdown/crash distribuído continua pendente.

## Painel e execução

React/Vite/Tailwind, TanStack Query, React Hook Form/Zod e cliente Axios centralizado. Dinheiro permanece string. Ações normais bloqueiam clique enquanto pendentes; reenvio deliberado conserva o último payload/chave. Novo negócio gera identidade nova somente por ação explícita. O resultado histórico aparece separado do saldo atual.

Proxy Vite remove `/api` e preserva os endpoints NestJS. Nenhum segredo de banco entra no bundle. A API roda em Docker; o painel é servido pelo Vite no host nesta primeira entrega. Build estático, avaliação visual/acessibilidade e eventual hospedagem do painel são passos distintos.

Não há migrations automáticas. `db:status` consulta catálogo/tabela existente sem criar schema; `db:provision` é administrativo e manual; `db:migrate` aplica a migration. `db:down` é destrutivo e restrito por guardas a banco de testes explicitamente descartável.

## Fontes verificadas

- [MikroORM 6.6: transações](https://mikro-orm.io/docs/6.6/transactions) e [EntitySchema](https://mikro-orm.io/docs/6.6/defining-entities).
- [MikroORM 6.6: migrations](https://mikro-orm.io/docs/6.6/migrations) e [implementação do migrator](https://github.com/mikro-orm/mikro-orm/blob/v6.6.16/packages/migrations/src/Migrator.ts).
- [Bun 1.4.2](https://bun.com/blog/bun-v1.4.2), [NestJS 11.2.6](https://github.com/nestjs/nest/releases/tag/v11.2.6) e [PostgreSQL 17.6](https://www.postgresql.org/docs/17/release-17-6.html).

O case completo ainda exige as demais operações, mensageria, recuperação, gates e evidências. A documentação final também deverá conciliar o nome público de arquitetura exigido pelo enunciado com a regra local que mantém `ARCHITECTURE.md` privado.
