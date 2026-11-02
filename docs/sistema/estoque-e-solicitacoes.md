# Estoque, materiais, solicitações, entregas e relatórios

Regras técnicas consolidadas. Datas e execução ficam na fonte histórica por ID.
Não se revoga obrigação por idade. Toda restrição, campo, estado, erro, migration,
ordem de trava e exceção conservada abaixo deve ser aplicada no escopo pertinente.
Conflitos não resolvidos exigem decisão, não suposição de prevalência do código.

## Reconciliações aplicáveis

- **R10:** MASTER nunca aprova, reprova nem encerra: o serviço revalida autoridade.
  Descrições anteriores de ausência de concessão não substituem essa proteção.
- **R11:** Classificação V2 substitui listas antigas apenas para novos cadastros;
  compatibilidade legada e dados históricos permanecem.
- **R05:** pré-condição mínima por funcionalidade não é inventário atual nem
  prova de aplicação no banco. Fonte técnica: main local de estado-atual.md.

## S63-003

- Fluxo: a solicitação é decidida pela **Segurança do Trabalho**, nunca pelo supervisor.
- Quem decide não pode ser quem solicitou (`AUTODECISAO_PROIBIDA`).
- A entrega direta do Bloco 10 (`origem = DIRETA`) não pode ser quebrada.

[Proveniência e custódia da fonte](../../historico/governanca/rastreabilidade.md#s63-003).

## S63-004

- Reserva lógica, derivada:

[Proveniência e custódia da fonte](../../historico/governanca/rastreabilidade.md#s63-004).

## S63-005

- não persistir reserva, alocação, contador de saldo, `quantidade_entregue` nem tabela de alocação;
- a cobertura de cada par (empresa, material, tamanho) é calculada a partir dos lotes e da demanda aprovada pendente;
- o físico utilizável desconsidera lotes de material inativo e de CA ausente ou vencido na data operacional;
- a cobertura segue a ordem de fila `decidida_em`, solicitação, item;
- a aprovação sem estoque é permitida, e a situação exibida da solicitação é derivada (inclusive `SUSPENSA`, quando o trabalhador ou o material do item está inativo);
- o status gravado não muda por derivação.

[Proveniência e custódia da fonte](../../historico/governanca/rastreabilidade.md#s63-005).

## S63-006

- Entrega por solicitação (12C): o vínculo fica no item da entrega (`entregas_epi_itens.solicitacao_item_id`, migration 066);
- a quantidade entregue de um item da solicitação é a soma das entregas ligadas a ele e o pendente é a aprovada menos essa soma, nunca gravados em coluna.
- A solicitação só passa a `ENTREGUE` quando toda a quantidade aprovada dos itens aprovados foi entregue (itens reprovados não contam), na mesma transação da última entrega, e o banco confere isso no COMMIT nos dois sentidos.
- Uma entrega atende uma solicitação só, e entrega `DIRETA` e `SOLICITACAO` não se misturam.
- O gatilho do item da entrega trava a solicitação (`FOR NO KEY UPDATE`) depois dos lotes: nenhum caminho pode segurar a solicitação e esperar um lote.

[Proveniência e custódia da fonte](../../historico/governanca/rastreabilidade.md#s63-006).

## S63-007

- Serviço da entrega por solicitação (`entrega-solicitacao.service.js`): o chamador informa só solicitação, chave, itens (item da solicitação, lote, quantidade) e confirmação;
- tudo o que o servidor deriva (trabalhador, material, tamanho, motivo, justificativas, GHE) vem da solicitação e do cadastro, e o item que o traz é recusado.
- A quantidade do ato é somada por item da solicitação e tem de caber no pendente e na cobertura FIFO, recalculada depois das travas na ordem aprovada;
- a cobertura é conferida antes do saldo do lote.
- A justificativa técnica da SST fora do GHE é reutilizada, nunca pedida de novo.
- Trabalhador ou material inativo torna a solicitação não entregável sem mudar o status histórico.
- O hash de conteúdo da entrega `DIRETA` não pode mudar byte a byte;
- o vínculo entra no hash só na entrega `SOLICITACAO`.

[Proveniência e custódia da fonte](../../historico/governanca/rastreabilidade.md#s63-007).

## S63-008

- Encerramento (D6, 12E-2, migration `068`): a solicitação `APROVADA` ou `APROVADA_PARCIAL` que não será mais entregue é encerrada com justificativa obrigatória (1 a 500, sem só espaços nem controle), e `ENCERRADA` é final.
- Nada é apagado nem desfeito: entregas, ficha, lotes e operações ficam, a entregue continua derivada, e só a aprovada ainda não entregue sai de D, porque a posição só conta `APROVADA` e `APROVADA_PARCIAL` (sem contador, reserva ou alocação). `ENTREGUE`, `PENDENTE`, `REPROVADA` e `CANCELADA` não são encerradas (409 `SOLICITACAO_NAO_ENCERRAVEL`), e a `ENCERRADA` não recebe entrega (409 `SOLICITACAO_NAO_ENTREGAVEL`).
- A autoridade é a ação `ENCERRAR_SOLICITACAO` (`exige_sst = true`, OBRIGATORIA), sem concessão automática a ninguém.
- O autoencerramento é permitido com autoridade válida;
- `AUTODECISAO_PROIBIDA` vale só para aprovar e reprovar.
- Travas: solicitação, depois os pares com pendente.
- A justificativa aparece só no detalhe, para quem pode vê-lo;
- nunca em lista nem na auditoria.
- Inativar trabalhador ou material continua só suspendendo, sem encerrar.

[Proveniência e custódia da fonte](../../historico/governanca/rastreabilidade.md#s63-008).

## S63-009

- Consultas e HTTP (12E-1, 12F): "minhas" (recurso `request`, visualizar;
- só as do próprio), fila (ação `APROVAR_SOLICITACAO`), entregáveis (ação `REALIZAR_ENTREGA`) e detalhe (quem tem `APROVAR_SOLICITACAO`, `REPROVAR_SOLICITACAO`, `ENCERRAR_SOLICITACAO` ou `REALIZAR_ENTREGA` vê qualquer uma da empresa, com cobertura e posição;
- quem só tem `request.visualizar` vê só as próprias, sem os números de estoque).
- Escrita: criar com `request.criar`;
- cancelar com `request.editar` (nunca `excluir`;
- o cancelamento não apaga o registro;
- não existe ação `CANCELAR_SOLICITACAO`);
- decidir exige `APROVAR_SOLICITACAO` se aprova algum item e `REPROVAR_SOLICITACAO` se reprova algum (a mista exige as duas, compostas a partir da fábrica central, nunca autorização manual);
- encerrar com `ENCERRAR_SOLICITACAO`;
- entregar por solicitação com `REALIZAR_ENTREGA`;
- conceder e remover vínculo SST só pelo MASTER ativo, no serviço.
- Empresa e ator vêm só da sessão;
- schemas estritos recusam empresa, solicitante, decisor, encerrador, responsável, status, instantes e hashes vindos do cliente;
- quem só pede não vê cobertura nem posição.
- Desde (decisão que supera a do 12E/12F: o MASTER tem autoridade máxima na empresa) o recurso `request` (visualizar, criar, editar) entra em `ESCOPO_PROVISIONAMENTO_MASTER` e chega ao MASTER pelo provisionamento normal (cadastro da empresa no Painel Privado e `db:provisionar:master`);
- as ações `APROVAR_SOLICITACAO`, `REPROVAR_SOLICITACAO` e `ENCERRAR_SOLICITACAO` continuam fora do escopo (exigem vínculo SST, que não se aplica ao MASTER).
- Para ADMINISTRADOR, SUPERVISOR e USUARIO, `request.*` continua concedido explicitamente por grupo ou exceção individual, nunca pelo nome do perfil.
- Qualquer banco persistente que sirva essas rotas precisa estar migrado até a `068`.

[Proveniência e custódia da fonte](../../historico/governanca/rastreabilidade.md#s63-009).

## S63-013

- Aprovação da SST da 12G-3 (`js/aprovacao-sst.js`, sem migration, sem rota nova, sem mudança no backend): fila e detalhe da 12F e uma decisão de TODOS os itens num POST só (`{decisoes: [{itemId, decisao, quantidadeAprovada?, justificativa}]}` na ordem dos itens;
- o índice do 400 `body.decisoes[i].campo` aponta o item). `rascunho.validar` e `rascunho.resultadoPrevisto` repetem as regras do servidor, sem divergir: aprovar de 1 até a quantidade solicitada;
- justificativa só quando ele a exige (reprovação, redução, aprovação fora do GHE) e nunca escondida no envio;
- resultado APROVADA, APROVADA_PARCIAL ou REPROVADA como `resultadoDaDecisao`;
- se o servidor exigir uma justificativa que a tela não previa, o campo aparece. `rascunho.criadaPor` é a mesma condição de `AUTODECISAO_PROIBIDA` (origem `USUARIO_INTERNO` e solicitante igual ao usuário da sessão): a tela avisa e bloqueia antes, e trata o 403 do servidor;
- nunca exceção para MASTER.
- Aprovar exige `APROVAR_SOLICITACAO` e reprovar `REPROVAR_SOLICITACAO`, pelas permissões efetivas (opção sem autorização indisponível).
- Nenhum número de estoque na tela (o detalhe da SST traz cobertura e posição, que não são exibidas).
- Os textos dos códigos da decisão ficam em `EpiAprovacaoSst.TEXTOS` (o `SOLICITACAO_NAO_PENDENTE` do Pedido fala de cancelamento). 409 de concorrência fecha a análise e relê a fila;
- botão desabilitado em cinza pela regra `#conteudoProtegido button:disabled` da página. `AUTODECISAO_PROIBIDA` é absoluta (decisão registrada na fonte): nenhuma exceção para SUPERVISOR, ADMINISTRADOR ou MASTER, nenhum desvio para teste ou validação e nenhuma permissão de autodecisão;
- só a 12J pode reavaliar.

[Proveniência e custódia da fonte](../../historico/governanca/rastreabilidade.md#s63-013).

## S63-014

- Entregas por solicitação da 12G-4 (`js/entregas-solicitacao.js`, sem migration, sem rota nova, sem mudança no backend): a lista vem de `/entregaveis` para quem tem `REALIZAR_ENTREGA` e de `/encerraveis` para quem só tem `ENCERRAR_SOLICITACAO`, nunca das duas por uma ação só.
- O "disponível agora" de um item é `min(pendente, cobertura.coberta)` do servidor (`rascunho.disponivelAgora`), nunca recalculado do estoque;
- sem cobertura (suspensa ou reprovada) é zero.
- Os lotes vêm de `GET /entregas-epi/contexto/:funcionarioId/materiais/:materialId/lotes` só para os itens com algo disponível, filtrados pelo tamanho do item, saldo e `EpiFicha.SITUACOES_CA[...].permitido`, na ordem do servidor (validade do CA);
- a sugestão FIFO para no disponível agora.
- O corpo é `{itens: [{solicitacaoItemId, loteId, quantidade}], confirmacao, chaveIdempotencia}`, com a confirmação e a declaração da Ficha;
- a chave vem de `EpiFicha.idempotencia.chavePara` sobre itens e confirmação.
- Mudar a entrega ou o modo descarta a confirmação.
- Falha de rede trava a entrega como incerta (nada se altera, nem se troca de pedido) até "Tentar novamente" (mesmo corpo e chave) ou "Descartar" (relê do servidor). 409 de cobertura, pendente, saldo, lote ou CA relê o detalhe e os lotes e descarta a confirmação.
- O encerramento repete a validação do servidor (aparar, NFC, 1 a 500 por ponto de código, sem `\p{Cc}`).
- Nenhuma solicitação é decidida nesta tela;
- alerta, SMS e compra vinculada seguem "Em integração", com a regra futura em comentário da página.

[Proveniência e custódia da fonte](../../historico/governanca/rastreabilidade.md#s63-014).

## S63-017

- Avisos e alertas da 12G-6 (migration `069`, sem ação nova de RBAC):

[Proveniência e custódia da fonte](../../historico/governanca/rastreabilidade.md#s63-017).

## S63-018

- **Disponibilidade derivada:** "Disponível para entrega" continua calculado do estado real a cada leitura.
- Proibido gravar flag `DISPONIVEL_PARA_ENTREGA`, cobertura, situação, reserva ou qualquer registro item a item (candidato, "já comunicado", COMUNICADO/IGNORADO por item).
- A `069` cria só `alertas_estoque_agendamentos` (scheduler/outbox), nunca a verdade operacional;
- não criar tabela de candidatos com outro nome.
- **Agendamento:** debounce por empresa + tipo (`DISPONIBILIDADE_ESTOQUE_ENTREGA`);
- o índice único parcial cobre SÓ o `PENDENTE`, para `ENVIANDO`, `AGUARDANDO_RETRY` e `FALHA` conviverem com um `PENDENTE` novo (nunca pôr esses estados na restrição única).
- A entrada relevante estende o `PENDENTE` (preserva a primeira entrada, atualiza a última e `enviar_apos` ≈ última + `ALERTA_ESTOQUE_JANELA_MINUTOS`, padrão 10);
- o que já foi reivindicado nunca muda de janela.
- Estados finais imutáveis;
- erro só como código técnico.
- **Entrada relevante:** só a ENTRADA de estoque dispara.
- A entrada é relevante quando algum item do par passa de cobertura 0 para > 0, medida antes e depois numa leitura só (antes = físico menos a quantidade da entrada);
- aí abre ou estende o `PENDENTE`, sem gravar o item.
- Entrada não relevante não cria nem estende lote.
- **Travas:** a entrada continua sem trava de par: chave, material (`FOR UPDATE`) e, por último, a linha do agendamento `PENDENTE`.
- O processador usa `FOR UPDATE SKIP LOCKED` sob uma advisory lock curta só da reivindicação (espaço próprio), um lote por empresa + tipo de cada vez, e conclui só com a marca `reivindicado_em`.
- Nada disso muda a ordem global de travas.
- **Processamento:** script para cron externo (`npm run alertas:processar`), nunca timer no processo da API.
- No envio, medir de novo a situação ATUAL da empresa (`resumirCoberturaPorPar`) e resolver os destinatários de novo a cada tentativa.
- Sem nada disponível: `DESCARTADO` `SEM_DISPONIBILIDADE`;
- sem destinatário: `DESCARTADO` `SEM_DESTINATARIO`, sem retry;
- e-mail desativado: `DESCARTADO` `EMAIL_DESATIVADO`.
- **At-least-once:** `ENVIADO` só quando TODOS os destinatários da tentativa receberam;
- qualquer falha, inclusive parcial, vai a `AGUARDANDO_RETRY` (2, 5, 15 e 30 minutos) e a `FALHA` na 5ª tentativa, e reenviar a quem já recebeu é aceito (sem tabela por destinatário);
- `ENVIANDO` abandonado (15 minutos) é retomado.
- Nunca exatamente uma vez.
- **Destinatários:** automático = ativo + empresa ativa + e-mail de conta utilizável + vínculo SST + `REALIZAR_ENTREGA` efetiva;
- manual ("Gerar alerta") = ativo + empresa ativa + e-mail + `MOVIMENTAR_ESTOQUE` efetiva, sem vínculo SST.
- Sempre pela avaliação efetiva das rotas, nunca pelo nome do perfil.
- **Conteúdo:** automático = resumo operacional consolidado por empresa e janela, uma linha por EPI + tamanho com a quantidade disponível agora e quantos pedidos;
- NUNCA trabalhador, matrícula, CPF, dado médico ou número de pedido (o template recusa campos fora do contrato;
- o detalhe é da tela Entregas por solicitação).
- O que segue disponível pode reaparecer no resumo de uma janela seguinte: aceito, porque o aviso é a situação atual e não um histórico por item;
- não reintroduzir persistência item a item para evitar isso.
- Manual = pedido, EPI, tamanho, pendente e sem cobertura, sem trabalhador.
- Texto escapado;
- link só da URL pública configurada.
- **"Gerar alerta":** rota própria `POST /api/alertas-estoque/falta` `{ solicitacaoId }` (`REALIZAR_ENTREGA`), fora das rotas da solicitação para `js/solicitacoes-epi.js` continuar a fonte única dos caminhos delas;
- supressão de 30 minutos por ator e pedido pela auditoria `ALERTA_FALTA_ESTOQUE` (só ids e números) sob advisory lock próprio, gravada só quando alguém recebeu.
- Na tela, `js/alerta-falta-estoque.js` acompanha o detalhe aberto pelo `aoMudarDetalhe` de `js/entregas-solicitacao.js`;
- o botão só aparece com `REALIZAR_ENTREGA`, só habilita com item aguardando estoque e, desabilitado, fica cinza.
- **Dashboard:** `solicitacoesAguardandoSst` (PENDENTE;
- `APROVAR_SOLICITACAO`), `solicitacoesAguardandoEstoque` (aprovadas com pendente na fila e NENHUM item coberto agora;
- `REALIZAR_ENTREGA` ou `ENCERRAR_SOLICITACAO`) e `disponiveisParaEntrega` (aprovadas com ALGUM item coberto agora;
- `REALIZAR_ENTREGA`).
- As duas últimas são exclusivas e saem de uma contagem só da fila (`contarSolicitacoesPorCobertura`);
- o pedido todo suspenso não entra em nenhuma.
- Sem a ação, `{ permitido: false }`, nunca zero. "Pendências sem estoque" não muda.
- Os cartões ficam sem atalho até a 12I.
- Decisões aprovadas, fechadas sem mudar o comportamento: **D1** — o pedido com todos os itens pendentes suspensos (trabalhador ou material inativo) fica fora de "aguardando estoque" e de "disponíveis", porque não é falta de estoque nem disponibilidade operacional;
- acompanhá-lo, se um dia for preciso, será por indicador ou visão própria de bloqueados/suspensos, nunca misturado aos de estoque.
- **D2** — "aguardando estoque" é de quem tem `REALIZAR_ENTREGA` ou `ENCERRAR_SOLICITACAO` efetiva;
- sem nenhuma, `{ permitido: false }` e "—" / "sem permissão";
- nunca `MOVIMENTAR_ESTOQUE` nem o nome do perfil.
- **Notificação interna** = só os indicadores derivados do Dashboard: nada de sino, inbox, tabela genérica de notificações, lida/não lida, preferências ou popup sem decisão.
- **Pré-condição:** a entrada de estoque lê a fila da solicitação e grava o agendamento: banco persistente usado por este código precisa estar migrado até a `069` (a `069` não foi aplicada a nenhum banco de homologação ou produção;
- foi aplicada somente ao banco descartável `BANCO_PROTEGIDO_94B33F7B`, criado exclusivamente para a validação manual da 12G-6);
- suíte que exercita a entrada monta o schema com `todasAsMigrations()`.

[Proveniência e custódia da fonte](../../historico/governanca/rastreabilidade.md#s63-018).

## S63-021

- Grade de tamanhos da 12G-8 (migration `070`, `material_tamanhos`):

[Proveniência e custódia da fonte](../../historico/governanca/rastreabilidade.md#s63-021).

## S63-022

- **Conceito:** GHE = quais produtos o trabalhador pode usar;
- GRADE = quais tamanhos são válidos para o produto;
- ESTOQUE = o que pode ser entregue agora.
- A grade é explícita no cadastro do material e **nunca** é deduzida nem preenchida a partir dos lotes.
- **Transição:** material com grade usa a grade como fonte de verdade;
- material antigo sem grade mantém o comportamento legado.
- **Tamanho único:** não tem grade (400 `GRADE_NAO_SE_APLICA`).
- Sair de "possui tamanhos" exige apagar a grade na mesma alteração (409 `MATERIAL_TAMANHO_GRADE_INCOMPATIVEL`).
- **Tamanho em uso:** um tamanho com saldo, mínimo próprio ou solicitação em aberto (`PENDENTE`, `APROVADA`, `APROVADA_PARCIAL`, item não reprovado) não sai da grade (409 `MATERIAL_GRADE_TAMANHO_EM_USO`);
- lote zerado não conta.
- **Formato:** o mesmo do tamanho do lote, comparado exatamente;
- não se repete sem diferenciar maiúsculas;
- até 50 por material.
- **Onde vale a grade:**
- entrada de estoque: só tamanho da grade (400 `TAMANHO_FORA_DA_GRADE`);
- criação da solicitação: o backend recusa tamanho fora da grade;
- Pedido: `tamanhosSugeridos` vem da grade (inclusive tamanho sem estoque), o legado segue com os lotes;
- o `GET` de lotes e o `GET` do material trazem `tamanhos`.
- **Travas:** a troca da grade fica na transação da edição do material, depois do `FOR UPDATE` do material.
- Entrada (`FOR UPDATE`), solicitação (`FOR SHARE`) e o gatilho da 070 (`FOR SHARE`) se serializam com ela pela mesma trava;
- a ordem global de travas não mudou e não há segunda lógica de saldo.
- **Tela de Materiais:** o quadro estático "Exemplos de tipos" foi removido (só visual;
- a orientação de tipos é a relação Categoria → Tipo desta 12G-8).
- Não recriar.
- **Fora da 12G-8:** pictograma por material, imagem, upload e prévia (decisão: só o automático da 12G-7), listagem nova de materiais, inativar e reativar na tela, endpoint combinado de cadastro com entrada e grade automática por tipo (12H).
- **Pré-condição:** qualquer banco persistente que sirva este código precisa estar migrado até a `071`, porque o cadastro, a entrada e a solicitação leem a grade (`070`) e o cadastro lê e grava a descrição do tipo (`071`).
- A `070` e a `071` não foram aplicadas a nenhum banco persistente.

[Proveniência e custódia da fonte](../../historico/governanca/rastreabilidade.md#s63-022).

## S63-023

- migration `071`):

[Proveniência e custódia da fonte](../../historico/governanca/rastreabilidade.md#s63-023).

## S63-024

- **Listas:** o Tipo depende da Categoria.
- EPI (14, em ordem alfabética): Botina de Segurança, Capacete, Creme de Proteção, Luva, Mangote, Óculos de Proteção Ampla Visão, Óculos de Proteção Incolor, Outros, Palmilha, Proteção Auricular Concha, Proteção Auricular Descartável, Respirador PFF2, Sapato de Segurança, Viseira Película Ouro.
- Uniforme (8): Calça, Calça de Forneiro, Calça Eletricista, Camisa, Camisa de Forneiro, Camisa Eletricista, Camiseta, Outros.
- Material de consumo, Ferramenta, material sem categoria e categoria desconhecida: só "Outros" (decisão ;
- não inventar lista para Ferramenta).
- Fonte: `backend/src/utils/classificacao-material.js` e `frontend/js/materiais.js` (`TIPOS_POR_CATEGORIA`, `tiposDe`), iguais por teste.
- O nome das categorias gravadas não mudou (`Material de consumo`).
- **Autoridade:** o backend confere a lista no cadastro e, na edição, sempre que tipo ou categoria vêm na requisição (400 `TIPO_FORA_DA_CATEGORIA` em `body.tipo`);
- o legado intocado não é reconferido.
- O tipo continua opcional (`null`), nunca adivinhado;
- o nome do perfil não entra em nenhuma regra.
- **"Outros":** `tipo = 'Outros'` e a descrição em `materiais.tipo_descricao` (VARCHAR(100), aparada, não vazia, texto puro, nunca HTML ou SVG): obrigatória com "Outros" (400 `TIPO_DESCRICAO_OBRIGATORIA`), proibida com outro tipo (400 `TIPO_DESCRICAO_NAO_SE_APLICA`), `TIPO_DESCRICAO_INVALIDA` pelo schema, limpa pelo serviço quando o tipo deixa de ser "Outros" (nunca descrição escondida).
- A descrição nunca age como tipo: não ativa a regra de óculos nem sugestão de tamanho.
- Entra na auditoria como os demais campos do cadastro.
- **Legado:** tipo fora das listas continua legível e editável nos outros campos, sem conversão automática;
- a tela o mostra na edição como "Outros" + descrição e, ao salvar, converte.
- Trocar a categoria sem tipo compatível é 400.
- O CHECK "Outros" ⇔ descrição da `071` é `NOT VALID`: a migration não converte nem apaga linha;
- a linha antiga que viole a regra passa a cumpri-la quando for alterada.
- **Óculos:** "Óculos de Proteção Incolor" e "Óculos de Proteção Ampla Visão" são tipos distintos no dado gravado;
- `ehOculos` reconhece os dois e o histórico "Óculos de proteção", que vale só para o legado (editável, convertível a um dos dois sem informar o grau de novo;
- nunca aceito em cadastro novo nem como valor novo no PATCH).
- A regra de óculos com grau, a entrega e a ficha usam o mesmo predicado.
- A `071` substitui os CHECKs da 045 e da 058 pelos três nomes;
- 045 e 058 continuam intocadas.
- **Tela:** lista de tipos montada por categoria (`render.opcoesTipos`, escapado, origem conhecida da trava de `innerHTML`);
- trocar a categoria SEMPRE limpa o tipo e a descrição, no cadastro e na edição, mesmo quando o tipo era "Outros" (decisão : nunca preservar "Outros" nem a descrição anterior;
- a pessoa escolhe e descreve de novo);
- campo "Descrição do tipo" (`materialTipoCustom`);
- óculos legado como opção temporária "(legado)" só na edição;
- "Limpar" não escolhe tipo.
- **Catálogo 12G-7:** só a tabela de mapeamento ganhou os nomes oficiais com desenho adequado (Botina de Segurança → botina;
- os dois óculos → oculos;
- Proteção Auricular Concha → protetor-auricular;
- Respirador PFF2 → respirador);
- Creme, Mangote, Palmilha, Sapato, Viseira, Descartável e uniformes caem na categoria.
- Nenhum SVG novo.

[Proveniência e custódia da fonte](../../historico/governanca/rastreabilidade.md#s63-024).

## S63-025

- Nota complementar: a Classificação V2 do material (migration `082`; decisões registradas na fonte) substituiu o modelo Categoria → Tipo acima para cadastros novos: Grupo (`categoria`: `EPI` | `Vestimenta` | `Outros`) → Grupo de Proteção (12 fechados | `Outros`) → Tipo do catálogo por empresa (`tipos_material`) | `Outros`, com "Especifique…" obrigatório em cada nível "Outros";
- a própria migration converteu `Uniforme` em `Vestimenta`.
- As listas `TIPOS_POR_CATEGORIA`, `tiposDe` e o predicado `ehOculos` por nome continuam SÓ em `backend/src/utils/classificacao-material.js`, para o material LEGADO (`modelo_classificacao = 'LEGADO'`, tudo o que existia antes da `082`, editável nos campos não relacionados sem conversão);
- `frontend/js/materiais.js` deixou de ter as listas e usa o catálogo por `js/tipos-material.js`, então a afirmação "iguais por teste" acima vale para o estado .
- A regra "tipo `Outros` ⇔ descrição" da `071` passou a valer só para V2 (CHECK substituído pela `082`);
- óculos com grau em V2 é pela classificação (EPI + Proteção ocular), não pelo nome.
- Detalhe no bloco "Classificação V2" (Lote 2).

[Proveniência e custódia da fonte](../../historico/governanca/rastreabilidade.md#s63-025).

## S63-045

- Contratos da 12G-0 (sem migration, sem mudar o provisionamento do MASTER): `GET /auth/permissoes` expõe `administracao.vinculosSst` com a MESMA autoridade dos endpoints de vínculo (predicado exportado do serviço;
- a tela nunca infere pelo perfil);
- o contexto da criação (`GET /solicitacoes-epi/contexto/funcionarios` e `/contexto/:funcionarioId/materiais`, ambos `request.criar`) devolve trabalhador sem CPF e material ativo com `previstoNoGhe` e `tamanhosSugeridos` (tamanhos de lotes já existentes, sem quantidade), nunca número de estoque;
- o ainda não classificado (`exigeTamanho: null`, como a 044 deixou os antigos) também vem, para a tela explicar, e a criação continua recusando com 409 `MATERIAL_TAMANHO_NAO_CLASSIFICADO` (esconder o não classificado fazia um GHE com EPIs parecer vazio);
- o detalhe traz trabalhador, material de cada item e só id e nome de solicitante, decisor e encerrador, lidos depois da autorização e do 404, sem CPF nem e-mail;
- `GET /solicitacoes-epi/encerraveis` (`ENCERRAR_SOLICITACAO`) é a lista mínima de quem encerra, sem nada de estoque, e não amplia `/entregaveis` (menor privilégio: uma ação não abre a lista da outra).

[Proveniência e custódia da fonte](../../historico/governanca/rastreabilidade.md#s63-045).

## S63-046

- Trava por par: operações que decidem sobre o saldo de um par usam `pg_advisory_xact_lock` de 64 bits (`backend/src/utils/lock-par-estoque.js`), um par por vez, em ordem canônica.
- Ordem global de travas: idempotência, solicitação, trabalhador, materiais, pares, lotes, numeração.
- Não inverter essa ordem.

[Proveniência e custódia da fonte](../../historico/governanca/rastreabilidade.md#s63-046).

## S63-047

- Entrega direta e baixa (12C-3, feitas): por par (empresa, material, tamanho), U é o físico utilizável, D a demanda aprovada pendente, C = min(U, D), L = max(0, U − D) e G = max(0, D − U), sempre derivados da posição da cobertura (`solicitacao-epi-cobertura.repository.js`);
- desde a 12D-1 a única definição de "utilizável" e de demanda pendente são os fragmentos de `backend/src/repositories/sql/posicao-estoque.js` (aliases e parâmetros explícitos, sem `$1`/`$2`/`$3` fixos), usados também pela consulta de todos os pares (`posicao-estoque.repository.js`);
- não criar regra paralela, contador, reserva nem alocação persistida.

[Proveniência e custódia da fonte](../../historico/governanca/rastreabilidade.md#s63-047).

## S63-048

- Estoque mínimo (12D-1, migration `067`): `materiais.estoque_minimo` é o mínimo **padrão**;
- `estoque_minimos` guarda só a **sobrescrita** por (empresa, material, tamanho), apenas para material com `exige_tamanho = true` (material sem tamanho nunca tem linha ali).
- Mínimo efetivo = linha própria, inclusive 0 (zero próprio não herda), senão o padrão.
- Déficit = max(0, mínimo − L);
- necessidade = G + déficit;
- `abaixoDoMinimo` = mínimo > 0 e L < mínimo.
- A gravação do mínimo não toma advisory lock de estoque e lê o material `FOR SHARE`;
- trocar `exige_tamanho` de verdadeiro para falso ou nulo com sobrescrita existente é 409 `MATERIAL_TAMANHO_MINIMOS_INCOMPATIVEIS`, e nunca se apaga sobrescrita sozinho.
- Aplicá-la a outro banco exige autorização separada.

[Proveniência e custódia da fonte](../../historico/governanca/rastreabilidade.md#s63-048).

## S63-049

- Contratos HTTP da posição (12D-2, sem migration nova e sem ação de RBAC nova): Itens Disponíveis (`availableItems.visualizar`) lista os pares da posição, com `disponivel` sempre igual a `fisicoUtilizavel`, e filtra por `situacao` (derivada no servidor), `somenteComNecessidade` e `busca`;
- o Dashboard soma a MESMA posição (`estoqueAbaixoMinimo` compara o mínimo efetivo com o saldo livre) e só devolve cada número se o usuário vê a fonte;
- os mínimos ficam no recurso Material (`GET /materiais/:id/minimos` com `materials.visualizar`, `PUT` e `DELETE /materiais/:id/minimos/:tamanho` com `materials.editar`), com auditoria `ESTOQUE_MINIMO_DEFINIDO` e `ESTOQUE_MINIMO_REMOVIDO` na mesma transação e sem auditar o que não mudou;
- o histórico de operações aceita `ENTREGA` e `origem`, e o trabalhador, a ficha e a solicitação só saem para quem também vê `epiFicha`, nunca o CPF;
- o contexto da entrega direta traz a posição agregada por tamanho, nunca as solicitações que compõem a demanda.
- Qualquer banco persistente que sirva essas rotas precisa estar migrado até a `067`.
- CORS: os métodos são explícitos e obrigatórios por namespace em `criarCors` (menor privilégio);
- o Portal (`/api`) anuncia GET, HEAD, POST, PUT, PATCH e DELETE, e o Painel Privado (`/api/plataforma`) só GET, HEAD, POST e PATCH, e o teste `cors-metodos-das-rotas` compara as listas com as rotas montadas;
- uma rota nova com um verbo novo exige atualizar a lista do namespace dela.
- PUT e DELETE continuam métodos inseguros para a verificação de origem (CSRF), que é outra camada.

[Proveniência e custódia da fonte](../../historico/governanca/rastreabilidade.md#s63-049).

## S63-052

- A entrega direta só usa o saldo livre: a soma do ato **por par** (nunca item a item) tem de caber em L, senão `409 SALDO_LIVRE_INSUFICIENTE`.
- Ordem de travas: idempotência, trabalhador, materiais, pares, lotes, numeração.
- O par é achado por leitura sem trava do lote (material e tamanho do lote são imutáveis pela 042) e a posição é lida **depois** da trava do par;
- a conferência vem depois das validações do lote, para não mudar a ordem dos erros do Bloco 10.
- O hash da requisição e o hash histórico da `DIRETA` não mudam.
- Eventos físicos (`CA_VENCIDO`, `AVARIA`, `DESCARTE`, `PERDA`, `AJUSTE_INVENTARIO`) nunca são recusados por reserva, só pelo saldo do lote.
- Atos discricionários (`DEVOLUCAO_FORNECEDOR`, `OUTRO`) são recusados se a baixa reduzir o comprometido do par;
- lote que não participa de U (CA ausente ou vencido, material inativo) não é bloqueado.
- Ordem de travas da baixa: idempotência, material, par, lote;
- nunca lote antes do par.
- A entrada não toma a trava do par.
- `ESTOQUE_BAIXA` registra a posição antes e depois e `reduziuCobertura` (o comprometido caiu, não o físico).
- Pré-condição de banco: a baixa e a entrega direta leem a posição do par, que depende das migrations `058`, `065` e `066`.
- Qualquer banco persistente usado por este código precisa estar migrado até a `066`;
- sem isso a baixa e a DIRETA devolvem 500.
- Aplicar migration em banco persistente continua exigindo autorização explícita e separada, e as suítes de integração que exercitam a baixa devem montar o schema com todas as migrations (`todasAsMigrations()`), nunca com um prefixo antigo.
- A recusa por saldo livre é auditada (`SALDO_LIVRE_INSUFICIENTE`) somente depois do ROLLBACK da operação principal, em transação própria por par, com supressão de 60 segundos por empresa, ator, tipo de operação, material e tamanho, serializada por advisory lock em namespace próprio (nunca o da trava do par).
- Só ids e números entram no registro;
- nunca confirmação, assinatura, justificativa, observação, dispositivo, corpo, token, cookie ou segredo.
- A falha dessa auditoria não troca o erro do domínio e vai para o log técnico sanitizado.
- Não criar migration para isso sem decisão explícita.

[Proveniência e custódia da fonte](../../historico/governanca/rastreabilidade.md#s63-052).

## S63-059

- 12K-C — EPIs Entregues (;
- sem migration, sem RBAC novo;
- `pages/delivered-items.html` deixou de ser protótipo): rota `GET /entregas-epi/itens` (`epiFicha.visualizar`), repositório `entrega-epi-historico.repository.js`, módulo `frontend/js/entregas-epi-historico.js` (`EpiEntregasHistorico`), `PAGINAS.deliveredItems` abre com `epiFicha.visualizar`.
- Uma linha por item entregue, lida dos snapshots congelados da entrega, nunca do cadastro atual;
- validade = data operacional + prazo congelado;
- status Válido / Próximo (0 a 30 dias) / Vencido;
- origem Direta / Por solicitação;
- busca sem caixa e sem acento;
- CPF nunca aceito nem devolvido;
- 401/403 antes de qualquer consulta;
- isolamento por empresa.
- **Status:** implementado;
- validação manual sem documento na pasta.

[Proveniência e custódia da fonte](../../historico/governanca/rastreabilidade.md#s63-059).

## S63-060

- 12K-D — Relatórios D1–D4 (;
- sem migration, sem RBAC novo;
- `pages/reports.html` deixou de ser protótipo;
- **BASELINE CONGELADA: validação manual aprovada ;
- não reabrir sem regressão real**): `GET /api/relatorios/{estoque,proximo-vencimento,vencidos,epis-entregues}` (`relatorio.routes.js`, `relatorio.controller.js`, `relatorio.service.js`, `relatorio-{estoque,entregas}.repository.js`, `relatorio.schema.js`;
- consulta estrita: filtro desconhecido = 400;
- busca sem acento), módulo `frontend/js/relatorios.js` (`EpiRelatorios`).
- Estoque exige `materials.visualizar`;
- as três abas de entregas exigem `epiFicha.visualizar`;
- `PAGINAS.reports` abre com qualquer uma (`abrirComQualquer`).
- Regras: saldo "disponível" = `fisicoUtilizavel` oficial (CA ausente ou vencido zera e tem alerta próprio `CA_AUSENTE`);
- situação `SEM_ESTOQUE | EM_ALERTA | DISPONIVEL`;
- CA próximo do vencimento = regra oficial de 60 dias da Validade de estoque, em faixas 0–10 / 11–20 / 21–30 dias (`TROCAR_URGENTE | ATENCAO | PROXIMO`);
- cada lote é uma linha;
- exportação CSV em páginas de 100, até 100 páginas.
- Limitações aceitas pelo responsável: item vencido já substituído não é removido (não há vínculo autoritativo de substituição);
- o alerta de estoque compara o saldo utilizável com o mínimo padrão, sem descontar a demanda aprovada pendente.
- `[FONTE_PRIVADA]`);
- validação manual aprovada e baseline congelada (registro da sessão principal).

[Proveniência e custódia da fonte](../../historico/governanca/rastreabilidade.md#s63-060).

## S63-061

- 12K-D5 — Relatório: Auditoria (;
- migration `079`;
- recurso novo `reportsAudit`): `GET /api/relatorios/auditoria/{indicadores,solicitacoes-nao-atendidas,solicitacoes-reprovadas,ca-vencidos,log}` com permissão própria **`reportsAudit.visualizar`** (`RECURSOS_RELATORIOS` em `rbac/recursos.js`;
- rótulo "Relatório — Auditoria";
- toggle `reportsAudit`, grupo GERAL;
- entra em `ESCOPO_PROVISIONAMENTO_MASTER`, então bancos existentes precisam de `db:provisionar:master`);
- a rota `fichas-sem-assinatura` foi removida (404).
- Arquivos: `relatorio-auditoria.{repository,service,schema}.js`, `auditoria.repository.js` (grava `perfil_ator`), `relatorio.controller.js` e `relatorio.routes.js`, `relatorios.js`, `reports.html`, `permissoes-efetivas.js`, `grupo-permissoes.js`;
- Conteúdo: quatro cartões (Entregas pendentes;
- CA vencidos em estoque, com prévia de 5 itens e link `stock-validity.html?situacao=VENCIDO`;
- Logs de 30 dias;
- Itens reprovados);
- solicitações aprovadas não atendidas só como "Aguardando entrega" / "Parcialmente atendida" (sem "Atrasado": não há SLA);
- o indicador "Fichas sem assinatura" foi REMOVIDO no pacote final (card, tabela, rota, repositório, serviço e testes;
- `ACEITE_PRESENCIAL` e `DESENHO` seguem modalidades válidas de confirmação da entrega — correção documental autorizada pela V7, conferida em `RELATORIO-TECNICO-12K-D5.md`);
- trilha de auditoria com janela padrão de 30 dias e teto de 92 (`PERIODO_MAXIMO_EXCEDIDO`), `PERIODO_INVERTIDO`, perfil "—" para eventos anteriores à 079.
- A consulta à trilha é auditada (`AUDITORIA_LOG_CONSULTADA`, supressão de 5 minutos por usuário, só booleanos de filtro). "Notificar" desabilitado e "Em integração" (sem canal).
- CSV: BOM, `;`, CRLF, neutralização de fórmula, teto de 10.000 linhas.
- **Status:** implementado;
- Validação manual: `[FONTE_PRIVADA]` ( 13:19) registra "validação manual final APROVADA … Código congelado", enquanto a transferência V7 (`[REFERENCIA_HISTORICA_PRIVADA]`, §3.1) diz "validação manual pendente": contradição registrada, a resolver pelo responsável;
- até lá, não tratar como validado.
- A `079` não foi aplicada a banco persistente protegido.

[Proveniência e custódia da fonte](../../historico/governanca/rastreabilidade.md#s63-061).

## S63-062

- 12K-D6 — Relatório: Fiscalização (;
- migration `080`;
- recurso novo `reportsFiscal`;
- diretório novo `backend/src/storage/`): pacote de documentação em ZIP para fiscalização e auditoria externa.
- Rotas `POST /api/relatorios/fiscalizacao/previa`, `POST /api/relatorios/fiscalizacao/pacotes` e `GET /api/relatorios/fiscalizacao/pacotes[/:id[/download]]`, todas com **`reportsFiscal.visualizar`** (rótulo "Relatório — Fiscalização";
- toggle `reportsFiscal`, GERAL;
- escopo do MASTER).
- Arquivos: `config/fiscalizacao.js` (100.000 linhas por módulo, 100 MiB por ZIP, 366 dias, heartbeat 15 s, abandono 120 s), `schemas/fiscalizacao.schema.js`, `services/fiscalizacao-pacote.service.js` e `fiscalizacao-pacote.ambiente.js`, `repositories/fiscalizacao-{modulos,pacote}.repository.js`, `storage/armazenamento-local.js`, `utils/zip-limitado.js` (yazl), `utils/periodo-fiscal.js`, `scripts/fiscalizacao-recuperar-abandonados.js` (`npm run fiscalizacao:recuperar`), aba Fiscalização em `relatorios.js` e `reports.html`.
- Regras: 5 finalidades (`FISCALIZACAO_TRABALHO`, `AUDITORIA_CLIENTE`, `AUDITORIA_INTERNA`, `SOLICITACAO_JURIDICA_DOCUMENTAL`, `OUTRA`, esta com observação obrigatória, até 500);
- 4 escopos (`FICHAS_ENTREGAS_CONFIRMADAS`, `TRILHA_AUDITORIA`, `HISTORICO_ESTOQUE_CA`, `REGRAS_GHE`;
- colunas explícitas: nunca CPF, hashes, tokens ou traço de assinatura);
- período por data civil, inclusivo, ≤ 366 dias;
- snapshot `REPEATABLE READ`;
- ZIP em streaming com o teto aplicado durante a escrita (manifesto, LEIAME, CSV e JSON por módulo, posição de lotes);
- `VERSAO_FORMATO = 1`;
- idempotência por empresa (mesma chave e mesmo pedido devolvem a tentativa existente em qualquer estado;
- outro pedido = 409;
- FALHA nunca reiniciada);
- um GERANDO por empresa;
- geração abandonada (sem heartbeat por `FISCALIZACAO_ABANDONO_SEGUNDOS`) é recuperada SÓ pelo cron externo, nunca por timer na API: remove temporário e ZIP órfão e marca `FALHA` `GERACAO_ABANDONADA`, nunca promove a CONCLUIDO;
- download reconfere o SHA-256;
- outra empresa recebe o mesmo 404.
- Armazenamento: interface que um driver S3 também implementaria (`iniciar`, `abrir`, `existe`, `remover`, `removerResiduos`);
- chave só com inteiros do servidor;
- o caminho resolvido tem de ficar dentro da raiz;
- escrita em temporário publicada por link que nunca sobrescreve;
- pastas 0700 e arquivos 0600;
- `FISCALIZACAO_ARMAZENAMENTO_DIRETORIO` ausente ⇒ serviço indisponível e rotas 503 `FISCALIZACAO_INDISPONIVEL`.
- Variáveis novas em `.env.example`: `FISCALIZACAO_ARMAZENAMENTO_DIRETORIO`, `FISCALIZACAO_HEARTBEAT_SEGUNDOS`, `FISCALIZACAO_ABANDONO_SEGUNDOS`.
- Dependência nova: `yazl` 3.3.1.
- **Status:** implementado;
- pacote de validação manual gerado (`12K-D6/validacao-manual/`);
- **aprovação manual sem documento comprobatório** na pasta;
- a lista `[REFERENCIA_HISTORICA_PRIVADA]` já trata os arquivos da Fiscalização como congelados, e a transferência V7 o dá como "não iniciado": divergência registrada, a resolver pelo responsável;
- até lá, não tratar como validado nem como congelado.
- A `080` não foi aplicada a banco persistente protegido.
- Pendência anotada pelo responsável durante o D6, só para os ajustes finais do frontend: no bloco superior esquerdo do menu, remover "v1.0", mostrar "by SafeWork" e tornar o bloco clicável para o Dashboard, preservando o layout.

[Proveniência e custódia da fonte](../../historico/governanca/rastreabilidade.md#s63-062).

## S63-065

- migration `082`, descrita no inventário acima;

[Proveniência e custódia da fonte](../../historico/governanca/rastreabilidade.md#s63-065).

## S63-066

- **Modelo:** Grupo (`categoria`: `EPI` | `Vestimenta` | `Outros`) → Grupo de Proteção (12 fechados: Proteção auditiva, contra quedas, da cabeça, das mãos, das pernas, dos braços, dos pés, facial, ocular, da pele (membros superiores), respiratória e do tronco | `Outros`) → Tipo (`tipoMaterialId` do catálogo da empresa | `Outros`). "Outros" em qualquer nível exige o "Especifique…" correspondente (`categoriaDescricao`, `grupoProtecaoDescricao`, `tipoDescricao`) e nunca é linha do catálogo;
- campo que não se aplica NUNCA é aceito (nada escondido chega ao banco).
- O material anterior é `LEGADO`: edita campos não relacionados sem conversão (`classificacaoIntocada`);
- alterar a classificação exige o bloco completo e o converte a V2.
- Óculos com grau: em V2, `oculosComGrau` (Sim/Não) é obrigatório para EPI + Proteção ocular, pelo grupo de proteção e não pelo nome;
- o LEGADO continua pelos três nomes históricos (`ehOculos`).
- Valor efetivo de exibição por UMA regra, em JS e em SQL, reutilizada por filtros, telas e relatórios, nunca `COALESCE` solto por consulta (decisão 1 ;
- a mesma função existe em `frontend/js/materiais.js`, conferida por teste).
- **Catálogo de tipos:** `tipos_material` por empresa;
- `CATALOGO_BASE` (26) em `backend/src/utils/classificacao-material.js` é a fonte única do seed da `082` e do provisionamento da empresa nova (`empresa-cadastro.service`).
- Rotas `GET /tipos-material` (`materials.visualizar`), `POST /tipos-material` (`materials.criar`;
- 409 `TIPO_MATERIAL_JA_EXISTE`) e `POST /tipos-material/:id/{inativar,reativar}` (`materials.editar`) — reutilizam o recurso `materials` por decisão registrada na fonte, sem recurso novo;
- `tipo-material.{routes,controller,service,repository,schema}.js`;
- auditoria `TIPO_MATERIAL_CRIADO`, `TIPO_MATERIAL_INATIVADO`, `TIPO_MATERIAL_REATIVADO`.
- Tipo inativado continua ligado ao material e ao GHE e aparece como "(inativo)".
- A importação CSV/XLSX de tipos ficou de fora (decisão registrada na fonte).
- **Frontend:** `js/tipos-material.js` (`EpiTiposMaterial`, fonte única dos caminhos do catálogo), `js/materiais.js` e `pages/materials.html` (seletor encadeado Grupo → Proteção → Tipo só com tipos ativos;
- estados `LEGADO` / `CATALOGO` / `TIPO_INATIVO` / `TIPO_INDISPONIVEL` / `OUTROS`);
- `js/catalogo-visual.js` (12G-7) passou a resolver também pelos nomes do catálogo V2 e pelo grupo efetivo (`Vestimenta` usa o desenho de uniforme;
- teste `catalogo-visual-v2.test.js`).
- A entrega grava o snapshot `material_grupo_protecao` do item (`entrega-classificacao-v2.integration.js`).
- **Achado não corrigido (decisão do responsável registrada na fonte):** `EpiTiposMaterial.mensagens.codigoDe` lê `codigo` e `detalhes` em `r.dados`, mas o envelope de erro do `EpiHttp` os traz no topo, então em `materials.html` um 400 do catálogo aparece como "Dados inválidos.";
- a página de GHE usa adaptador local.

[Proveniência e custódia da fonte](../../historico/governanca/rastreabilidade.md#s63-066).

## Consulta de dependências

Leia [o índice](../README.md), [a governança](../governanca/agentes.md) e
[as reconciliações](../../historico/governanca/reconciliacoes.md). Arquivo congelado
ou exceção exige leitura da fonte pertinente antes de ação que o afete. Campos,
erros e limites não são exemplos opcionais. Aprovação da documentação não autoriza
execução dos procedimentos ou acesso a dados.
