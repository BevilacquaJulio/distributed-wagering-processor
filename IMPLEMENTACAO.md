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

## Operações e referências

`WagerTransaction` concentra a tabela de transições e a decisão sobre a referência; o serviço aplica uma única transição sob o lock da wallet. A referência é procurada por provedor e ID externo depois do lock, porque pertence à mesma wallet. Ausente ou ainda pendente, a operação fica `PENDING_REFERENCE`; rejeitada ou com falha, `REFERENCE_NOT_PROCESSED`; incompatível, `REFERENCE_MISMATCH`; com outro valor, `REFERENCE_AMOUNT_MISMATCH`. ROLLBACK aplica a direção inversa da efetivamente lançada pela referência.

A migration `Migration202610090002` acrescenta:

- `wager_references`: vínculo gravado só para operações processadas, com índice único parcial `(reference_transaction_id, kind)` para REFUND e ROLLBACK e trigger que confere tipo, wallet, jogador, moeda, rodada e valor. Sem a checagem do serviço, o segundo REFUND da mesma BET bate nesse índice e a unidade inteira é desfeita.
- `transaction_acceptances`: aceite pendente imutável, separado do resultado terminal.
- `pending_references`: agenda com tentativas, próxima tentativa (1s após o aceite) e prazo (24h), que o worker da próxima entrega consumirá.
- Constraints de kind, status, LOSS com 0.00, coerência do `command` com wallet/jogador e presença da referência por tipo; o trigger do ledger passa a exigir a direção de cada kind, inclusive a inversa no ROLLBACK.

O downgrade descarta vínculos, aceites e agenda e restaura as constraints anteriores como `NOT VALID`, para não falhar com linhas já gravadas pelos novos kinds.

## Fila de comandos e inbox

Emulador SQS: MiniStack 1.5.15. O LocalStack, escolhido inicialmente, passou a exigir token de autenticação na versão 2026.03.0, o que impediria reproduzir o ambiente só com o repositório; o case aceita MiniStack. Antes de adotar, foram verificados no emulador: FIFO com deduplicação, visibilidade, `ChangeMessageVisibility`, `ApproximateReceiveCount`, redrive para DLQ por `maxReceiveCount` e cancelamento de long polling. Divergência encontrada: num envio deduplicado com corpo diferente, o emulador devolve o MD5 da mensagem original e o SDK rejeita a resposta; a aplicação nunca reenvia corpo diferente com a mesma deduplicação.

`src/consumer.ts` é um processo próprio (pool, ORM e lifecycle independentes) que chama o mesmo `WageringService.submit` da API. A migration `Migration202610100001` cria `inbox_messages` com chave `(consumer_name, message_id)`, hash do envelope e vínculo com a transação. A linha é gravada no início da unidade financeira: duas entregas simultâneas da mesma mensagem esperam na chave primária e a segunda encontra o registro confirmado. Depois de processada, a linha é imutável.

A classificação de falhas e o tratamento de cada caso estão no README. Retry usa visibilidade com backoff exponencial e o redrive do broker; mensagens sem identidade utilizável ou conflitantes vão explicitamente para a DLQ com o motivo, e o original só é apagado depois da confirmação da DLQ.

## Eventos e diagnóstico

Processed, Rejected, PendingReference e BalanceChanged são classes concretas, com envelope versionado e MoneyProps serializável. Eventos são persistidos no mesmo commit.

## Publisher da outbox

`src/publisher.ts` é um processo próprio que entrega a outbox à fila `wager-events.fifo`, separada da fila de comandos para que um evento nunca seja consumido como comando. Não foi acrescentado SNS: o case não nomeia o destino e uma fila FIFO por ambiente atende ao contrato com a infraestrutura que já existe.

Estratégia escolhida: claim durável com lease. Um único comando em autocommit seleciona até 10 eventos pendentes por `position` com `FOR UPDATE SKIP LOCKED` e grava `claim_token`, `lease_until` e `attempts + 1`. Nenhum lock de linha fica aberto durante o envio. A confirmação grava `published_at` somente `where claim_token = token`; um publisher que perdeu a posse não consegue concluir o claim de outro. A alternativa de manter a transação aberta com o lock durante o envio foi descartada: prenderia conexões do pool pelo tempo de rede do SQS e não sobrevive a um crash melhor do que a lease.

A migration `Migration202610100002` acrescenta `position` (identidade gerada na inserção; como os eventos de uma wallet são gravados sob o lock dela, a posição segue a ordem de commit por wallet), `last_error`, a coerência entre token e lease, o índice parcial dos pendentes por posição, o trigger que torna definitivo o evento publicado e impede `attempts` de diminuir, e o `UPDATE` do papel runtime restrito às colunas do publisher.

O envio usa `SendMessageBatch` com `MessageGroupId` igual à wallet e `MessageDeduplicationId` igual ao `eventId`. O timeout do envio (10s) é menor que a lease (30s), então em operação normal nenhum outro publisher assume um evento ainda em envio. Falha libera o claim, registra o código do erro e agenda a próxima tentativa com backoff exponencial de 1s a 5min mais jitter; não há limite que descarte o evento. Lease e backoff usam o relógio do processo: os hosts precisam de relógio sincronizado, com folga ampla frente aos 30s da lease.

Limites: entrega ao menos uma vez, não exactly-once. Um crash depois do envio e antes de `published_at`, ou um timeout com resultado desconhecido, reenvia o mesmo `eventId`; o FIFO descarta a cópia dentro da janela de deduplicação de 5 minutos e o consumidor deduplica depois dela. A ordem por wallet é de melhor esforço: um evento reagendado pode chegar depois de eventos mais novos.

Logs JSON contêm correlação e identidades do resultado, sem payload/valor financeiro, SQL ou credenciais. `/metrics` expõe contadores locais de resultados, replay, conflito, indisponibilidade e divergência. Contagem é observacional, não ledger auditável. O publisher registra `event_published`, `event_publish_failed` e `event_ownership_lost` e loga o atraso de cada evento entre `occurredAt` e a confirmação; o processo dele não expõe HTTP. Métricas de locks, histogramas e a exposição das métricas dos workers ainda serão implementadas.

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
