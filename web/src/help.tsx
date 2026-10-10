import type { ReactNode } from 'react';

export interface HelpEntry { title: string; summary: string; sections: { heading: string; body: ReactNode }[] }

const C = ({ children }: Readonly<{ children: ReactNode }>) => <code>{children}</code>;

/*
 * Explicações dos modais "i". O texto descreve as regras que o servidor aplica; o painel não decide nada sozinho.
 * Ao mudar uma regra no domínio, atualizar o tópico correspondente.
 */
export const help = {
  overview: {
    title: 'Como este painel funciona',
    summary: 'O painel faz o papel de um provedor de jogos: ele envia operações para o processador de apostas e mostra o que foi gravado.',
    sections: [
      { heading: 'O caminho de uma operação', body: <ol>
        <li><b>Wallet:</b> crie a carteira de um jogador, com saldo inicial, ou abra uma existente.</li>
        <li><b>Operar:</b> envie uma aposta (BET), um prêmio (WIN), uma perda (LOSS), um estorno (REFUND) ou uma reversão (ROLLBACK).</li>
        <li><b>Resultado:</b> o processador responde se a operação foi processada, rejeitada ou se aguarda outra operação.</li>
        <li><b>Consultar:</b> veja o estado gravado de qualquer operação, inclusive as que mudaram depois da resposta.</li>
        <li><b>Extrato:</b> confira cada movimentação no ledger e se o saldo bate com a soma do histórico.</li>
      </ol> },
      { heading: 'Nada é simulado', body: <p>Cada clique chama a API real, que grava no PostgreSQL. O navegador nunca calcula saldo: ele só mostra o que a
        API devolveu. A mesma regra financeira atende quem envia pela API HTTP e quem envia pela fila SQS.</p> },
      { heading: 'Os dois tipos de ID', body: <>
        <p><b>ID externo</b> é o identificador que o provedor dá à operação (por exemplo <C>bet-3f9a1c7e20</C>). É ele que você usa para
          referenciar e consultar.</p>
        <p><b>ID interno</b> é o UUID que o processador gera ao gravar. Ele aparece no resultado e no extrato, mas não serve como referência.</p>
      </> },
      { heading: 'Dica', body: <p>Todo campo e toda seção têm um botão "i" como este. Ele explica o que é, o valor padrão, se pode alterar e os
        erros mais comuns.</p> },
    ],
  },
  health: {
    title: 'Status da API',
    summary: 'Indica se a API consegue falar com o banco de dados e com a fila SQS neste momento.',
    sections: [
      { heading: 'O que é verificado', body: <p>O botão chama <C>GET /health/ready</C>. A resposta só é positiva se o PostgreSQL e a fila de
        comandos responderem. Clique para consultar de novo.</p> },
      { heading: 'Se aparecer indisponível', body: <ul>
        <li>As operações podem falhar com 503 <C>INFRASTRUCTURE_UNAVAILABLE</C>. Isso não é rejeição financeira.</li>
        <li>Nada fica pela metade: saldo, extrato e resultado são gravados juntos, ou nada é gravado.</li>
        <li>Quando voltar, use o <b>reenvio da mesma operação</b> (mesma chave). Se ela já tinha sido gravada, você recebe o resultado
          original, sem cobrar duas vezes.</li>
      </ul> },
      { heading: 'O que este status não cobre', body: <p>Consumidor da fila, publisher de eventos e worker de referências são processos
        separados, com health próprio. Se o worker de referências estiver parado, operações "aguardando referência" não são resolvidas
        até ele voltar.</p> },
    ],
  },
  player: {
    title: 'Jogador (playerId)',
    summary: 'O identificador do jogador dono da wallet, no formato UUID.',
    sections: [
      { heading: 'O que é um UUID', body: <p>Um código de 36 caracteres, como <C>7f3c2a10-5d4e-4b8f-9a61-2c3d4e5f6a7b</C>, gerado de forma
        aleatória. A chance de dois iguais é desprezível, então ninguém precisa de um cadastro central para criar um novo.</p> },
      { heading: 'De onde vem', body: <p>No mundo real, vem da plataforma do cassino. Aqui não existe cadastro de jogadores: o jogador passa a
        existir quando você cria a wallet dele. <b>Gerar ID de teste</b> cria um UUID aleatório no navegador.</p> },
      { heading: 'Posso alterar?', body: <p>Sim, desde que seja um UUID válido (8-4-4-4-12 caracteres hexadecimais). Reaproveitar um jogador
        só faz sentido se ele ainda não tiver wallet em BRL.</p> },
      { heading: 'Regras', body: <ul>
        <li>Uma wallet por jogador e moeda. Criar outra BRL para o mesmo jogador dá 409 <C>WALLET_ALREADY_EXISTS</C>.</li>
        <li>Toda operação informa o jogador; ele precisa ser o dono da wallet, senão <C>WALLET_PLAYER_MISMATCH</C>. O painel preenche isso
          sozinho a partir da wallet aberta.</li>
        <li>Não há login nesta versão: o processador confia no ID recebido. A autenticação de provedores é um ponto de extensão previsto.</li>
      </ul> },
    ],
  },
  initialBalance: {
    title: 'Saldo inicial',
    summary: 'Quanto a wallet já começa tendo, em reais (BRL).',
    sections: [
      { heading: 'Formato', body: <p>Texto com ponto e duas casas: <C>100.00</C>, <C>0.50</C>, <C>2500.00</C>. Vírgula, sinal ou mais de duas
        casas são recusados. Dinheiro nunca vira número com casas flutuantes, para evitar erros como 0.1 + 0.2 = 0.30000000000000004.</p> },
      { heading: 'O que acontece ao criar', body: <ul>
        <li>Com valor maior que zero, o sistema grava uma operação interna <b>OPENING</b> e um crédito no extrato. É o primeiro lançamento.</li>
        <li>Com <C>0.00</C>, a wallet nasce zerada e sem lançamento.</li>
        <li>A wallet começa na versão 1.</li>
      </ul> },
      { heading: 'Limites', body: <p>Só BRL está habilitado. O saldo não pode ser negativo nem passar do máximo técnico (18 dígitos antes do
        ponto). OPENING não pode ser enviado pelo formulário de operações: só nasce aqui.</p> },
    ],
  },
  walletId: {
    title: 'ID da wallet',
    summary: 'O identificador da carteira, gerado pelo servidor quando ela é criada.',
    sections: [
      { heading: 'Wallet e jogador são coisas diferentes', body: <p>O jogador é a pessoa (você escolhe o ID); a wallet é a carteira dele em uma
        moeda (o servidor escolhe o ID). Toda operação informa os dois, e o painel preenche a partir da wallet aberta.</p> },
      { heading: 'Como reabrir uma wallet', body: <ul>
        <li>Cole o <b>ID da wallet</b> em "Abrir wallet existente". O ID do jogador não funciona ali.</li>
        <li>As wallets abertas neste navegador ficam na lista de recentes. Ela guarda só os IDs, apenas neste navegador.</li>
        <li><C>WALLET_NOT_FOUND</C> indica um ID que não existe neste banco. O banco de testes automáticos é outro e não aparece aqui.</li>
      </ul> },
      { heading: 'Para que copiar', body: <p>Para usar a mesma wallet no Postman, no Swagger ou na fila SQS, que pedem <C>walletId</C> e{' '}
        <C>playerId</C> no corpo da requisição.</p> },
    ],
  },
  balance: {
    title: 'Saldo atual',
    summary: 'O saldo gravado agora no banco para esta wallet.',
    sections: [
      { heading: 'Quando muda', body: <p>Só depois que o servidor confirma uma operação processada que movimenta dinheiro: BET (débito), WIN e
        REFUND (crédito) e ROLLBACK (direção inversa da operação desfeita). O painel nunca adianta a mudança antes da confirmação.</p> },
      { heading: 'Saldo atual x saldo observado', body: <p>O resultado de cada operação mostra o <b>saldo observado</b>: o saldo logo depois
        dela. Num reenvio (replay), ele volta igual ao original, mesmo que o saldo atual já seja outro. Use "Atualizar" para ler o saldo de
        agora.</p> },
      { heading: 'Garantias', body: <ul>
        <li>Nunca fica negativo: há uma trava por wallet durante a operação e uma regra no próprio banco.</li>
        <li>É sempre igual à soma do extrato. A aba Extrato tem o botão para conferir.</li>
      </ul> },
    ],
  },
  version: {
    title: 'Versão da wallet',
    summary: 'Um contador que sobe 1 a cada mudança de saldo.',
    sections: [
      { heading: 'Como se comporta', body: <ul>
        <li>Começa em 1 ao criar a wallet, mesmo com saldo inicial.</li>
        <li>Sobe 1 a cada BET, WIN, REFUND ou ROLLBACK processado.</li>
        <li>Não muda com LOSS, rejeições, operações aguardando referência ou reenvios (replay).</li>
      </ul> },
      { heading: 'Para que serve', body: <p>Deixa visível quantas movimentações aconteceram e acompanha os eventos de saldo publicados pelo
        sistema. Se o saldo não mudou mas você esperava, compare a versão antes e depois: ela confirma se houve movimento.</p> },
    ],
  },
  kind: {
    title: 'Tipo de operação',
    summary: 'O que o provedor está pedindo para o processador fazer.',
    sections: [
      { heading: 'Os cinco tipos', body: <dl className="help-kinds">
        <dt>BET · aposta</dt><dd>Debita o valor. Sem saldo suficiente, é rejeitada com <C>INSUFFICIENT_FUNDS</C>. Não aceita referência.</dd>
        <dt>WIN · prêmio</dt><dd>Credita o valor. Pode, opcionalmente, apontar para a BET que gerou o prêmio; o valor é livre.</dd>
        <dt>LOSS · perda</dt><dd>Registra que o jogador perdeu. Valor <C>0.00</C>; não muda saldo, versão nem extrato. O dinheiro já saiu na BET.</dd>
        <dt>REFUND · estorno</dt><dd>Devolve uma BET inteira (crédito). Precisa apontar para a BET, com o mesmo valor e a mesma rodada.</dd>
        <dt>ROLLBACK · reversão</dt><dd>Desfaz uma BET (crédito), um WIN (débito) ou um REFUND (débito). Mesmo valor e mesma rodada da
          operação desfeita.</dd>
      </dl> },
      { heading: 'Ao trocar o tipo', body: <p>O painel gera um ID externo e uma chave novos, mantém provedor, rodada, jogo e referência, e
        ajusta o valor só quando LOSS exige <C>0.00</C>.</p> },
      { heading: 'Limites das reversões', body: <ul>
        <li>Cada operação aceita no máximo um REFUND e no máximo um ROLLBACK. O segundo do mesmo tipo dá <C>REFERENCE_ALREADY_REVERSED</C>.</li>
        <li>REFUND e ROLLBACK são tipos diferentes, então a mesma BET pode receber um de cada. É uma limitação conhecida e documentada.</li>
        <li>Desfazer um crédito (ROLLBACK de WIN ou REFUND) sem saldo dá <C>REVERSAL_INSUFFICIENT_FUNDS</C>.</li>
      </ul> },
    ],
  },
  amount: {
    title: 'Valor',
    summary: 'Quanto a operação movimenta, em reais (BRL), como texto com duas casas.',
    sections: [
      { heading: 'Formato', body: <p>Ponto e duas casas: <C>25.00</C>, <C>0.10</C>. Sem vírgula, sem sinal. A moeda é a da wallet e o painel
        a envia sozinho.</p> },
      { heading: 'Regras por tipo', body: <ul>
        <li>LOSS: sempre <C>0.00</C>.</li>
        <li>BET, WIN, REFUND e ROLLBACK: maior que zero.</li>
        <li>REFUND e ROLLBACK: igual ao da operação referenciada, senão <C>REFERENCE_AMOUNT_MISMATCH</C>. As sugestões de referência copiam o
          valor certo.</li>
      </ul> },
      { heading: 'Erros comuns', body: <ul>
        <li><C>AMOUNT_NOT_ALLOWED</C>: zero onde precisa ser positivo, ou valor em LOSS.</li>
        <li><C>INSUFFICIENT_FUNDS</C>: BET maior que o saldo atual. A rejeição fica gravada e o saldo não muda.</li>
      </ul> },
    ],
  },
  provider: {
    title: 'Provedor',
    summary: 'Quem está enviando a operação: o fornecedor do jogo.',
    sections: [
      { heading: 'Valor no painel', body: <p><C>provider-a</C>, mas pode ser qualquer nome com letras, números e <C>. _ : -</C>, até 128
        caracteres. Não existe cadastro de provedores nesta versão.</p> },
      { heading: 'Por que importa', body: <ul>
        <li>IDs externos e chaves de idempotência são únicos <b>por provedor</b>. <C>provider-a</C> e <C>provider-b</C> podem usar o mesmo
          ID externo sem conflito.</li>
        <li>A referência só é procurada no <b>mesmo provedor</b>. Uma BET de <C>provider-a</C> só é estornada por um REFUND de{' '}
          <C>provider-a</C>; de outro provedor, ela não é encontrada e o REFUND fica aguardando.</li>
        <li>A consulta por ID externo pede o provedor pelo mesmo motivo.</li>
      </ul> },
    ],
  },
  externalId: {
    title: 'ID externo',
    summary: 'O identificador que o provedor dá a esta operação.',
    sections: [
      { heading: 'Valor no painel', body: <p>Gerado a cada envio, no formato <C>tipo-código</C>, como <C>bet-3f9a1c7e20</C>. Depois de enviar,
        o painel troca por um novo, para que o próximo clique seja uma operação nova.</p> },
      { heading: 'Posso alterar?', body: <p>Sim. Nomes fáceis, como <C>bet-001</C>, ajudam a testar referências: depois é só digitar{' '}
        <C>bet-001</C> no campo de referência do REFUND. Use letras, números e <C>. _ : -</C>.</p> },
      { heading: 'Regras de unicidade', body: <ul>
        <li>Mesmo ID externo, mesma chave e mesmos dados: <b>replay</b>, devolve o resultado original sem nova movimentação.</li>
        <li>Mesmo ID externo com outra chave: 409 <C>EXTERNAL_ID_CONFLICT</C>.</li>
        <li>Os dois valem dentro do mesmo provedor.</li>
      </ul> },
      { heading: 'Não confunda', body: <p>O UUID que aparece no resultado como "ID interno" é gerado pelo processador. O ID externo é o seu, e
        é o único aceito como referência.</p> },
    ],
  },
  reference: {
    title: 'ID externo referenciado',
    summary: 'O ID externo da operação que esta operação estorna, desfaz ou premia.',
    sections: [
      { heading: 'Quando é usado', body: <ul>
        <li>REFUND e ROLLBACK: obrigatório.</li>
        <li>WIN: opcional, apontando para a BET premiada.</li>
        <li>BET e LOSS: o campo nem aparece.</li>
      </ul> },
      { heading: 'Onde conseguir', body: <ul>
        <li><b>Sugestões abaixo do campo:</b> operações desta sessão que combinam com o tipo escolhido. Um clique preenche a referência e,
          nas reversões, também o valor e a rodada.</li>
        <li><b>Resultado ou histórico:</b> mostram o ID externo de cada envio, com botão de copiar.</li>
        <li><b>Digitando:</b> se você escolheu o ID externo da BET (por exemplo <C>bet-001</C>), digite o mesmo aqui.</li>
      </ul> },
      { heading: 'O que o servidor confere', body: <ul>
        <li>Mesmo provedor, mesma wallet, mesmo jogador, mesma moeda e mesma rodada: senão <C>REFERENCE_MISMATCH</C>.</li>
        <li>Tipo compatível: REFUND só aponta para BET; ROLLBACK para BET, WIN ou REFUND; WIN para BET.</li>
        <li>A operação referenciada precisa ter sido processada, senão <C>REFERENCE_NOT_PROCESSED</C>.</li>
        <li>Nas reversões, mesmo valor e no máximo uma reversão de cada tipo.</li>
        <li>Apontar para si mesma: <C>INVALID_REFERENCE</C>.</li>
      </ul> },
      { heading: 'Se a referência ainda não existe', body: <p>A operação é aceita com HTTP 202 e fica <b>aguardando referência</b>, sem
        mexer no saldo. Isso cobre provedores que entregam fora de ordem. O worker tenta de novo (de 1 segundo até intervalos de 5 minutos) e
        processa assim que a referência chegar. Se não chegar em 24 horas, a operação é rejeitada com <C>REFERENCE_EXPIRED</C>.</p> },
      { heading: 'Erro mais comum', body: <p>Colar o <b>ID interno</b> (UUID do resultado ou do extrato). Nenhuma operação tem esse ID externo,
        então ela fica aguardando até expirar. O painel avisa quando reconhece um ID interno neste campo.</p> },
    ],
  },
  idempotencyKey: {
    title: 'Chave de idempotência',
    summary: 'Identifica a requisição para que reenvios não cobrem ou paguem duas vezes.',
    sections: [
      { heading: 'Por que existe', body: <p>Na rede, uma resposta pode se perder. O provedor não sabe se a aposta foi gravada e reenvia. Com a
        mesma chave, o processador reconhece o reenvio e devolve o resultado gravado, sem debitar de novo.</p> },
      { heading: 'De onde vem', body: <p>Vai no header HTTP <C>Idempotency-Key</C>. No mundo real, o provedor gera. O painel gera{' '}
        <C>key-</C> seguido do ID externo, como <C>key-bet-3f9a1c7e20</C>. É só uma convenção: qualquer texto com letras, números e{' '}
        <C>. _ : -</C> serve.</p> },
      { heading: 'Como o servidor decide', body: <ul>
        <li>Chave nova: operação nova.</li>
        <li>Mesma chave e mesmos dados: <b>replay</b>. Mesmo ID interno, mesmo saldo observado, <C>idempotentReplay: true</C>, nenhum
          lançamento novo.</li>
        <li>Mesma chave e dados diferentes: 409 <C>IDEMPOTENCY_CONFLICT</C>. "Dados" são todos os campos: tipo, valor, wallet, jogador,
          rodada, jogo, ID externo e referência.</li>
        <li>A chave é única por provedor e fica gravada no banco, então vale entre várias instâncias e depois de reinícios.</li>
      </ul> },
      { heading: 'Como testar', body: <ul>
        <li>Replay: depois de enviar, use <b>Reenviar a última</b>.</li>
        <li>Conflito: cole a chave e o ID externo do último envio nos campos, mude o valor e envie.</li>
      </ul> },
    ],
  },
  round: {
    title: 'Rodada (roundId)',
    summary: 'A rodada do jogo à qual a operação pertence. Liga a aposta ao seu resultado.',
    sections: [
      { heading: 'Valor no painel', body: <p><C>round-1</C>. Pode ser qualquer texto válido: <C>round-2</C>, <C>Round-81</C>, <C>r81</C>.</p> },
      { heading: 'Regra que importa', body: <p>Uma operação com referência precisa estar na <b>mesma rodada</b> da operação referenciada, senão{' '}
        <C>REFERENCE_MISMATCH</C>. A comparação diferencia maiúsculas: <C>Round-81</C> e <C>round-81</C> são rodadas diferentes.</p> },
      { heading: 'Atalho', body: <p>As sugestões de referência copiam a rodada da operação escolhida.</p> },
    ],
  },
  game: {
    title: 'Jogo (gameId)',
    summary: 'O jogo em que a operação aconteceu.',
    sections: [
      { heading: 'Valor no painel', body: <p><C>game-1</C>. Pode ser qualquer texto válido, como <C>roleta</C> ou <C>slot.777</C>.</p> },
      { heading: 'Regras', body: <p>Fica gravado com a operação e faz parte dos dados comparados no replay. Não é conferido nas referências:
        uma BET em <C>game-1</C> pode ser estornada por um REFUND em <C>game-2</C>.</p> },
    ],
  },
  result: {
    title: 'Resultado da operação',
    summary: 'A resposta do processador para o último envio.',
    sections: [
      { heading: 'Status possíveis', body: <dl className="help-kinds">
        <dt>Processada · HTTP 200</dt><dd>Gravada e aplicada. Se movimenta dinheiro, já está no saldo e no extrato.</dd>
        <dt>Aguardando referência · HTTP 202</dt><dd>Aceita, mas a operação referenciada ainda não chegou. Não é resultado final e o saldo
          não mudou.</dd>
        <dt>Rejeitada · HTTP 422</dt><dd>Recusada por uma regra de negócio. Fica gravada para auditoria, com o motivo, e o saldo não muda.</dd>
      </dl> },
      { heading: 'Outras respostas', body: <ul>
        <li>400: campo em formato inválido.</li>
        <li>404: wallet não encontrada.</li>
        <li>409: conflito de chave ou de ID externo.</li>
        <li>503: banco ou fila indisponível. Reenvie a mesma operação quando voltar.</li>
      </ul> },
      { heading: 'Campos', body: <ul>
        <li><b>ID externo:</b> o seu ID para esta operação. Use-o para referenciar e consultar.</li>
        <li><b>ID interno:</b> gerado pelo processador. Aparece no extrato.</li>
        <li><b>Saldo observado:</b> o saldo logo depois desta operação, gravado com ela.</li>
        <li><b>Replay:</b> indica que a resposta veio do resultado já gravado.</li>
      </ul> },
    ],
  },
  replay: {
    title: 'Reenviar a última',
    summary: 'Repete exatamente o último envio: mesmos dados e mesma chave de idempotência.',
    sections: [
      { heading: 'O que esperar', body: <p>Resultado marcado como <b>replay</b>, com o mesmo ID interno e o mesmo saldo observado do envio
        original. Nenhum lançamento novo no extrato e a versão da wallet não muda.</p> },
      { heading: 'Por que é um botão separado', body: <p>"Enviar operação" sempre usa um ID externo e uma chave novos, ou seja, uma operação de
        negócio nova. O reenvio é o teste deliberado de duplicidade, como faria um provedor depois de um timeout.</p> },
      { heading: 'Vale também para rejeições', body: <p>Reenviar uma BET rejeitada devolve a mesma rejeição gravada, mesmo que agora exista
        saldo. Para tentar de novo, envie uma operação nova.</p> },
    ],
  },
  history: {
    title: 'Enviadas nesta sessão',
    summary: 'As operações que você enviou desta aba, com o status recebido na resposta.',
    sections: [
      { heading: 'Para que serve', body: <ul>
        <li>Achar o ID externo de uma operação sem procurar: cada linha tem o botão de copiar.</li>
        <li>Abrir o estado atual com <b>Consultar</b>, que leva para a aba de consulta.</li>
        <li>Alimentar as sugestões do campo de referência.</li>
      </ul> },
      { heading: 'Limites', body: <ul>
        <li>Fica só na memória desta aba: recarregar a página apaga a lista, não as operações gravadas.</li>
        <li>O status é o da resposta. Uma operação "aguardando referência" pode já ter sido processada; a consulta mostra o estado atual.</li>
        <li>A API não tem listagem de operações por wallet. O histórico completo de dinheiro está no extrato.</li>
      </ul> },
    ],
  },
  lookup: {
    title: 'Consultar transação',
    summary: 'Lê o estado gravado no banco de uma operação, não o que a tela mostrou na hora do envio.',
    sections: [
      { heading: 'Duas formas de buscar', body: <ul>
        <li><b>Provedor e ID externo:</b> como o provedor procuraria. Os dois precisam ser os mesmos usados no envio.</li>
        <li><b>ID interno:</b> o UUID do resultado ou da coluna de transação do extrato.</li>
      </ul> },
      { heading: 'Como ler o resultado', body: <ul>
        <li><b>Status atual:</b> pode ser diferente do que o envio respondeu, por exemplo quando uma operação aguardando referência foi
          resolvida pelo worker.</li>
        <li><b>Referência informada:</b> o ID externo que foi digitado no envio.</li>
        <li><b>Referência vinculada:</b> o ID interno da operação que o servidor realmente encontrou. "Não vinculada" num REFUND significa que
          a referência ainda não foi achada ou que a operação foi rejeitada antes do vínculo.</li>
        <li><b>Saldo observado:</b> o saldo gravado com a resposta original.</li>
      </ul> },
      { heading: 'Status gravados', body: <ul>
        <li><C>PROCESSED</C>, <C>REJECTED</C> e <C>FAILED</C> são finais e nunca mudam.</li>
        <li><C>PENDING_REFERENCE</C> ainda pode virar processada ou rejeitada.</li>
        <li><C>OPENING</C> aparece como "abertura interna", sem ID externo.</li>
      </ul> },
      { heading: 'Não encontrou?', body: <p>Confira se o provedor é o mesmo do envio e se o ID está no modo certo: ID externo no primeiro modo,
        UUID interno no segundo.</p> },
    ],
  },
  ledger: {
    title: 'Ledger (extrato)',
    summary: 'O histórico de todas as movimentações de dinheiro da wallet, da mais antiga para a mais recente.',
    sections: [
      { heading: 'O que entra', body: <ul>
        <li>Um lançamento por operação processada que muda o saldo: o crédito de abertura, BETs, WINs, REFUNDs e ROLLBACKs.</li>
        <li>LOSS, rejeições, operações aguardando referência e reenvios não geram lançamento.</li>
      </ul> },
      { heading: 'Colunas', body: <ul>
        <li><b>Movimento:</b> crédito (entra) ou débito (sai), com data e hora.</li>
        <li><b>Saldo anterior e posterior:</b> mostram a conta de cada lançamento; o posterior de um é o anterior do seguinte.</li>
        <li><b>Transação:</b> o ID externo quando a operação foi enviada nesta sessão; senão, o ID interno (abertura incluída).</li>
      </ul> },
      { heading: 'Garantias', body: <p>O ledger só aceita inclusão: o banco bloqueia alteração e exclusão de lançamentos. Saldo e lançamento
        são gravados na mesma transação. Use "Carregar mais" para as páginas seguintes.</p> },
    ],
  },
  reconciliation: {
    title: 'Conferir saldo',
    summary: 'Recalcula o saldo a partir do ledger e compara com o saldo gravado na wallet.',
    sections: [
      { heading: 'Como calcula', body: <p>Soma os créditos, subtrai os débitos e compara com o saldo armazenado, numa leitura consistente do
        banco. A diferença esperada é sempre <C>0.00</C>.</p> },
      { heading: 'Se houver diferença', body: <p>O resultado aparece como divergência e é contado nas métricas do sistema. Nada é corrigido
        automaticamente: uma correção silenciosa esconderia o problema que a conferência existe para mostrar.</p> },
    ],
  },
  recentWallets: {
    title: 'Wallets recentes',
    summary: 'Atalho para reabrir wallets usadas neste navegador.',
    sections: [
      { heading: 'O que é guardado', body: <p>Só o ID da wallet e o ID do jogador das últimas wallets abertas, no armazenamento local deste
        navegador. Saldo e histórico sempre vêm da API.</p> },
      { heading: 'Limites', body: <p>Outro navegador não vê a lista. Se o banco for recriado, a wallet some e a abertura responde{' '}
        <C>WALLET_NOT_FOUND</C>.</p> },
    ],
  },
} satisfies Record<string, HelpEntry>;

export type HelpTopic = keyof typeof help;
