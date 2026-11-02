# Interfaces, Dashboard, Central e autoatendimento

Contratos consolidados. Preservar visual aprovado, acessibilidade, autoridade
real do servidor e isolamento. O catálogo da Central não equivale ao atendimento
do tablet; GET de prévia pode auditar. Históricos não liberam produção.

## Proteções contextuais

**MEM-25:** materials.html exige autorização e coordenação com o chat visual,
inclusive para inserção focal. Leitura é livre; preservar automatismos do cadastro.
**12L / S63-044:** no início daquela etapa, os ícones já preparados pelo responsável
devem ser solicitados/conferidos antes de criar novos. É requisito daquele fluxo
do Totem; não proíbe globalmente novos ícones aprovados em outras tarefas. Não
constitui autorização para iniciar 12L, importar arquivos ou redesenhar telas.
**Totem local:** seção 0, CLAUDE modificado e complemento externo são protegidos;
nenhum checkout, merge ou substituição pode sobrescrevê-los sem autorização específica.
**R06:** heartbeat foi montado no Ciclo 2; narrativa anterior de rota ausente é
histórica. Homologação/runtime atual e dependências continuam sujeitos a verificação.
**R18:** dados de execução, contagens e datas foram transferidos ao histórico;
congelamentos, exceções e requisitos não são removidos.

## S63-010

- Para a 12G: menu e botões da solicitação obedecem `visualizar`, `criar` e `editar` e as ações da SST e da entrega;
- o backend continua validando tudo.

[Proveniência e custódia da fonte](../../historico/governanca/rastreabilidade.md#s63-010).

## S63-011

- Fundação da 12G-1 (frontend, sem migration, sem rota nova): as três páginas (`request.html`, `supervisor-approval.html` e `stock-requests.html`;
- ids `request`, `supervisorApproval` e `stockRequests`, sem renomear arquivo) abrem só por `EpiEstadoPagina.montarPaginaProtegida` — o conteúdo protegido nasce oculto (`#conteudoProtegido`), aparece só depois da sessão e das permissões confirmadas e some quando a sessão termina ou muda — e mostram os estados de `js/estado-pagina.js` só como texto (nada de `innerHTML`).
- Quem abre: Pedido com `request.visualizar` OU `request.criar`;
- Aprovação com `APROVAR_SOLICITACAO` (a fila exige essa ação no servidor);
- Entregas com `REALIZAR_ENTREGA` OU `ENCERRAR_SOLICITACAO`;
- cada escrita é decidida por `EpiSolicitacoesEpi.capacidades`, nunca por um "alterar" geral nem pelo nome do perfil (o MASTER só abre o que as permissões reais dão, e a `REALIZAR_ENTREGA` provisionada abre as Entregas). `js/solicitacoes-epi.js` é a única fonte dos caminhos e da consulta das rotas da solicitação: filtro desconhecido, id, página, limite, status ou previsto inválidos são TypeError antes da rede, busca acima de 100 vira validação local, e toda solicitação não encontrada tem o mesmo texto. `js/permissoes-efetivas.js` exige a área `vinculosSst` (sem ela, nenhuma permissão).
- Na tela de Permissões do Grupo, `request` oferece Visualizar, Criar e Editar (fora do escopo do MASTER);
- Aprovação e Entregas mostram que valem as ações.

**R10:** menção antiga ao escopo MASTER não autoriza decisão ou encerramento; K2 prevalece na proibição expressa.

[Proveniência e custódia da fonte](../../historico/governanca/rastreabilidade.md#s63-011).

## S63-012

- Pedido de EPI da 12G-2 (`js/pedido-epi.js`, sem migration, sem rota nova): os EPIs oferecidos são só os do contexto com `previstoNoGhe=true` (todas as páginas), copiados campo a campo, sem nenhum número de estoque;
- o do GHE ainda não classificado (`exigeTamanho` nulo) nunca é opção nem corpo de envio, aparece num aviso que manda definir o tamanho em Materiais, e o GHE só com esses não é chamado de vazio;
- o tamanho só existe para `exigeTamanho === true`;
- motivos e limites vêm de `EpiSolicitacoesEpi.MOTIVOS` e `LIMITES_PEDIDO`, iguais aos do backend (conferido por teste), e a justificativa só vai no `OUTRO`.
- O envio usa `EpiFicha.idempotencia.chavePara` (a mesma chave enquanto o corpo não muda), uma guarda própria contra o segundo POST além do botão desabilitado, e os erros 400 vão para o campo do item pelo caminho `body.itens[i].campo`, sempre com os textos de `POR_CODIGO`, nunca o do servidor.
- Formulário por `request.criar`, "Meus pedidos" e detalhe por `request.visualizar`, cancelamento por `request.editar` e status `PENDENTE`, com confirmação.
- Nada vai para armazenamento do navegador.

[Proveniência e custódia da fonte](../../historico/governanca/rastreabilidade.md#s63-012).

## S63-015

- Navegação da 12G-5 (sem tela nova, sem rota nova, sem mudança no backend e sem migration): os três itens de "Solicitações" e os links do Início do Portal seguem só `EpiPermissoes.PAGINAS` e as permissões efetivas;
- não criar atalho entre Pedido, Aprovação e Entregas sem decisão.
- Textos de acesso nunca atribuem o acesso só ao perfil: a mensagem global de acesso negado é a mesma em `EpiPermissoes.MENSAGENS.SEM_ACESSO` e no estado "acesso negado" de `js/estado-pagina.js` (o estado é reconhecido comparando os dois).
- Só "Aprovar solicitação" abre a Aprovação;
- "Reprovar solicitação" sozinha não abre.
- As três telas têm teste próprio da volta pelo histórico: troca de empresa ou de pessoa e permissão retirada recarregam com os dados limpos;
- sessão encerrada leva ao Portal.
- **Vínculo SST:** o vínculo SST possui backend e permissões implementados, porém a interface administrativa será tratada dentro da 12J — Administração de Usuários e Acessos, evitando criação de tela transitória na 12G-5;
- até lá, nada de página, item de menu ou link de vínculo SST, e a configuração para desenvolvimento e revisão continua pela rota `POST /api/vinculos-sst` usada pelo MASTER ativo.
- **Prova de autoria** é pendência futura obrigatória, ainda sem escopo definido.

[Proveniência e custódia da fonte](../../historico/governanca/rastreabilidade.md#s63-015).

## S63-019

- Catálogo visual da 12G-7 (`js/catalogo-visual.js`, só frontend;
- sem migration, rota, contrato ou campo novo).
- Validação manual aprovada nas três telas;
- **baseline congelada**: mudar resolução, pictogramas ou telas exige decisão explícita.

[Proveniência e custódia da fonte](../../historico/governanca/rastreabilidade.md#s63-019).

## S63-020

- **Resolução:** tipo conhecido → pictograma do tipo;
- tipo desconhecido ou "Outro" → o da categoria;
- categoria desconhecida ou ausente → o genérico.
- Caixa, acentos e espaços normalizados;
- o nome nunca escolhe.
- **Segurança:** os onze SVGs são fixos e locais, definidos no módulo, que recusa carregar com elemento, atributo ou valor fora do catálogo.
- Dado do sistema só escolhe a chave e nunca entra no SVG.
- Nada de `<img>`, URL, biblioteca remota nem `innerHTML` para o pictograma.
- **Acessibilidade:** decorativo (`aria-hidden`, `focusable="false"`);
- o nome segue em texto.
- **Onde:** só Análise de estoque e Validade (mesma célula, antes do nome, sem coluna nova) e Materiais (ao lado do seletor do estoque por lote, criado pelo DOM).
- Não levar a outras telas sem decisão.
- **Escopo:** a direção antiga (imagem personalizada → ícone manual → automático por tipo) foi substituída de propósito.
- Imagem personalizada, upload e escolha gravada por material são decisão explícita da 12G-8, não pendência da 12G-7.
- **Acoplamento com as listas:** mudar as listas de tipos ou categorias exige atualizar só a tabela de mapeamento do catálogo (feito na 12G-8 para os nomes oficiais com desenho adequado, sem SVG novo);
- o teste compara as listas de `js/materiais.js`.

**Contexto:** restrições do catálogo 12G-7 não impedem evolução de imagens expressamente autorizada em frente posterior.

[Proveniência e custódia da fonte](../../historico/governanca/rastreabilidade.md#s63-020).

## S63-031

- `pages/gestao-usuarios.html`, `js/gestao-usuarios.js`;
- o ciclo de senha provisória está congelado e a validação manual dele foi aprovada, com a `074` aplicada só no descartável `BANCO_PROTEGIDO_93B95A0C`):

[Proveniência e custódia da fonte](../../historico/governanca/rastreabilidade.md#s63-031).

## S63-040

- Liberação visual controlada (TEMPORÁRIA;
- não é implementação funcional): o MASTER abre os seis protótipos ainda "Em integração" (`reports`, `delivered-items`, `self-service`, `support`, `emails-gestao`, `lgpd`;
- `config` saiu da lista ao virar a tela integrada de Configurações;
- `purchases` e `eligibility-rules` saíram como MÓDULOS TEMPORARIAMENTE DESATIVADOS / ADIADOS: fora de `INSPECAO_PROTOTIPOS` e de `PROTOTIPOS`, em `DESATIVADOS` de `js/inspecao-visual.js` — o link nunca recebe o marcador, dentro da inspeção fica `aria-disabled` e o clique só avisa, e a própria página recusa `?inspecao=1`;
- HTML, JS, testes e histórico preservados para retomada) só para inspeção.
- Regras: (1) `liberarInspecao` em `js/permissoes-efetivas.js` dá `href` com `?inspecao=1` aos `a.nav-pendente` pelo rótulo (`INSPECAO_PROTOTIPOS`) quando `permissoes.perfil === 'MASTER'` — a ÚNICA decisão do frontend pelo nome do perfil, explícita e provisória;
- não é autorização, não inferir permissões definitivas dela, e a matriz de ADMINISTRADOR, SUPERVISOR e USUÁRIO é da 12J;
- (2) o HTML das páginas integradas não mudou: `nav-pendente`, `aria-disabled` e a etiqueta "Em integração" continuam estáticos, e o link some para outro perfil, na revalidação e na falha da consulta;
- (3) `js/inspecao-visual.js` é carregado só pelos oito protótipos (seis em inspeção e os dois adiados, nos quais recusa ativar), está em `NUNCA_PUBLICAR` e fora da allowlist, age só com `?inspecao=1`, esconde a tela de login simulada, mostra a faixa fixa e recusa toda escrita na API simulada e todo submit — nunca liga protótipo a backend, nunca usa `db-api.js`, `main.js`, `localStorage` ou seed como fonte de verdade;
- (4) nada foi reorganizado, redesenhado ou corrigido nos protótipos;
- (5) quando uma dessas telas for integrada de verdade (12K em diante), ela deixa de ser `nav-pendente` e sai de `INSPECAO_PROTOTIPOS` (feito para `config` nas Configurações);
- (6) o marcador não pode se perder no segundo salto: dentro do protótipo aberto em inspeção, o `fileMap` inline da página e o `appendSessionToNavLinks` do `main.js` reescrevem a barra lateral para `reports.html`, `purchases.html` etc. sem o marcador (era assim que o login fictício com "Cobresul" aparecia no fluxo do MASTER), então `inspecao-visual.js` propaga `inspecao=1` aos links que levam a um dos oito protótipos, na carga e no clique em fase de captura, preservando `?_s=` e sem repetir o marcador, nunca a links de páginas integradas (Configurações inclusive), e esconde a tela de login simulada também por regra de estilo `!important`;
- o `href` do menu integrado é montado por `hrefDeInspecao` (uma vez só, parâmetros preservados);
- ao fim da revisão, remover a liberação é decisão do responsável.

[Proveniência e custódia da fonte](../../historico/governanca/rastreabilidade.md#s63-040).

## S63-041

- Nota complementar: dos seis protótipos acima, `reports` (12K-D) e `delivered-items` (12K-C) viraram telas integradas e saíram de `INSPECAO_PROTOTIPOS` e de `PROTOTIPOS`, como prevê a regra (5): as duas listas têm quatro entradas (`self-service`, `support`, `emails-gestao`, `lgpd`), `DESATIVADOS` continua com `purchases` e `eligibility-rules`, e `js/inspecao-visual.js` é carregado só pelos protótipos restantes.
- No roadmap registrado dois parágrafos abaixo, 12K-C, 12K-D e 12K-E deixaram de ser futuros (12K-C, 12K-D, 12K-D5 e 12K-D6 têm bloco próprio nesta seção;
- 12K-E, GHE, Histórico de Funcionários e as frentes seguintes entram nos Lotes 2 e 3 da atualização documental), e o Totem avançou como Atendimento Token (Etapas A a J na `main` pela PR #57;
- Etapa I do Totem com homologação bloqueada e não congelada;
- Etapa K não iniciada). `self-service.html` continua protótipo, intocado e em inspeção;
- `config` continua integrado.

[Proveniência e custódia da fonte](../../historico/governanca/rastreabilidade.md#s63-041).

## S63-050

- só as páginas existentes, sem mexer no menu global):

[Proveniência e custódia da fonte](../../historico/governanca/rastreabilidade.md#s63-050).

## S63-051

- A tela só mostra o que o servidor mediu: físico utilizável, comprometido, saldo livre, sem cobertura, mínimo efetivo com a origem (`PROPRIO` ou `PADRAO`), déficit, necessidade e a situação (`abaixoDoMinimo` é a medida pelo saldo livre).
- Nunca recalcular essas grandezas no navegador nem reinterpretar `disponivel`.
- O Dashboard mostra "—" e "sem permissão" quando o indicador vem `{ permitido: false }`, nunca um zero mascarado.
- Detalhe omitido pelo servidor não é buscado por outro caminho nem ganha espaço reservado ou aviso de permissão: o histórico de `ENTREGA` mostra ficha, trabalhador (nome e matrícula) e solicitação só se vieram na linha, e o CPF nunca é lido.
- A entrega direta nunca mostra quais solicitações compõem o comprometido.
- Nada disso vai para `localStorage` ou `sessionStorage`.
- Mínimo por tamanho: o mínimo do cadastro é o **Mínimo padrão**;
- a sobrescrita só existe para material com `exigeTamanho === true`, e a tela nem envia `PUT` ou `DELETE` para material de tamanho único ou não classificado (o servidor continua recusando com 409).
- Mínimo próprio 0 é válido e é diferente de herdar o padrão;
- remover é `DELETE`, nunca gravar zero.
- O painel lista só tamanhos com lote ou com sobrescrita, nunca uma linha para cada tamanho possível.
- Entrega direta: depois de `409 SALDO_LIVRE_INSUFICIENTE` a tela relê a posição de cada material do rascunho e **não envia nova tentativa** (botão e `confirmar()` bloqueados) até a releitura dar certo;
- `SALDO_INSUFICIENTE` (saldo do lote) continua um caso à parte.
- Na baixa, só devolução ao fornecedor e `OUTRO` dependem do saldo livre, e a mensagem de recusa nunca sugere um motivo físico para passar.
- Toda tela nova ou alterada que passe a usar módulo novo precisa do módulo no sandbox dos testes de página, na lista de scripts e em `frontend/publicacao/allowlist.json`;
- a trava de `innerHTML` do `interface-e6.test.js` só aceita origens escapadas conhecidas.
- A listagem de lotes `listarDisponiveis`/`contarDisponiveis` do repositório de lotes foi removida na 12D-3 (sem consumidor de produção);
- os itens de Itens Disponíveis saem só da posição por par, e o teste de equivalência compara a posição com `listarPorMaterial`.

[Proveniência e custódia da fonte](../../historico/governanca/rastreabilidade.md#s63-051).

## S63-076

- **Arquitetura e decisões do responsável:** tablet COMPARTILHADO da empresa, ativado por QR de uso único (10 min) que emite uma credencial persistente e revogável do dispositivo;
- atendimento curto por trabalhador identificado por CPF (11 dígitos) OU matrícula exata, **sem segundo fator** (decisão encerrada: data de nascimento, crachá, PIN e senha descartados);
- pedidos com origem `AUTOATENDIMENTO` (já prevista na 065) no fluxo normal da SST, sem fluxo paralelo;
- regra B1: material físico cadastrado, sem exigir saldo;
- **nenhum indicador de estoque e nenhum "Reservar"** no tablet;
- rede corporativa OBRIGATÓRIA (IP fixo ou túnel;
- sem rede = bloqueado);
- heartbeat ~60 s e offline após ~3 min;
- tabela lateral `solicitacoes_autoatendimento`;
- RBAC por toggles;
- administração na entrada de menu existente "Autoatendimento (Totem)" renomeada "Atendimento Token" (sem item novo);
- `self-service.html` preservado e intocado;
- referência visual oficial do tablet `[FONTE_PRIVADA]` (35 466 B;
- protótipo com `localStorage`, saldos e "Reserve";
- **intocável**);
- os ícones do Totem já foram desenhados pelo responsável.
- A correção da `AUTODECISAO_PROIBIDA` pelo vínculo `usuarios.funcionario_id` (073) é requisito registrado e **não implementado**.
- **A — banco e RBAC (11/10;
- CONGELADA;
- n/a para homologação, é estrutura):** `086`/`087`;
- 9 permissões = recurso `atendimentoToken` (visualizar, criar, editar) + 6 ações;
- 21/21 e mutação 35/35;
- **B — administração dos dispositivos (11/10;
- validação final aprovada;
- CONGELADA, 16 arquivos):** `GET/POST /api/atendimento-token/dispositivos`, `GET/PATCH /:id`, `POST /:id/revogar`;
- `token-dispositivo.*`;
- recurso `atendimentoToken` + `TOKEN_REVOGAR_DISPOSITIVO` no escopo do MASTER e em `ACOES_COM_EFEITO`;
- decisões DB-1..DB-5: tablet revogado é somente leitura (409 `DISPOSITIVO_REVOGADO`), revogação repetida 200 `alterado:false`, revogar zera `credencial_hash` e a anterior, cancela a ativação pendente e encerra o atendimento aberto;
- só o nome é obrigatório;
- texto em branco vira `null`;
- histórico de localização por `logs_auditoria` (`dados_anteriores`/`dados_novos`, evento `ALTERACAO`), sem migration, porque o gatilho da 014 recusa chave JSONB com "token"/"credencial".
- O reforço S1–S3 provou ausência de vazamento de credencial em qualquer coluna da auditoria e dos eventos (12 de 12 vazamentos simulados mortos).
- Mutação 51/52 (1 equivalente).
- **C — ativação e autenticação do tablet (11/10;
- validação final aprovada;
- CONGELADA, 28 arquivos):** `POST /dispositivos/:id/ativacao` (`TOKEN_GERAR_ATIVACAO`;
- código de 256 bits, só o hash no banco, uso único, ≤ 10 min, um pendente por tablet), `POST /tablet/ativar`, `GET /tablet/estado`;
- `token-ativacao.*`, `token-tablet.*`, `token-credencial.repository.js`, `middleware/autenticacao-dispositivo.js`;
- decisões D-C1..D-C8: TUNEL negado sem atestação, IP_FIXO só host exato, recuperação de tablet ATIVO por nova ativação que substitui a credencial atomicamente e sem anterior, carência 120 s, rotação 24 h, cookie `gepi_tablet` (`SESSAO_DISPOSITIVO_COOKIE_NOME`) com `Path=/api/atendimento-token/tablet` e 180 dias com expiração absoluta no servidor (`DISPOSITIVO_ROTACAO_HORAS`, `DISPOSITIVO_CARENCIA_SEGUNDOS`, `DISPOSITIVO_COOKIE_DIAS` no `.env.example`);
- limites por IP folgados (NAT) e finos por tablet;
- `/atendimento-token/tablet*` fora do limitador geral da API (`limitadorGeralSalvoTablet`);
- CSRF: `POST ativar` exige Origin/Referer da allowlist e JSON (415 para `text/plain` e formulário).
- Corridas S0–S5 determinísticas (`token-tablet-corridas.integration.js`, sincronização por `pg_blocking_pids`, sem sleeps).
- Quatro arquivos receberam acréscimos legítimos da D (aceitos pelo responsável e documentados, sem reescrever a baseline C).
- Pendências de implantação: **D-C9** (SameSite=Strict só para `gepi_tablet`;
- não alterar agora), `GET /estado` rotaciona a credencial (efeito em GET, avaliar cross-site), `TRUST_PROXY_HOPS` exato na AWS (valor maior que o real permite forjar IP), fronteira de rede do TUNEL, MDM/atestação do tipo de equipamento (User-Agent não prova), HTTPS/CORS/Origin/Path.
- **D — atendimento do trabalhador (11/10;
- validação final aprovada;
- CONGELADA, 17 arquivos;
- sem migration, `088` suspensa):** `POST/GET /tablet/atendimento`, `POST /atividade`, `POST /encerrar`;
- cookie `gepi_atendimento` SameSite=Strict;
- identificação por CPF ou MATRICULA com tipo explícito (CPF só estrutura;
- matrícula por igualdade exata do cadastro, sensível a caixa, zeros preservados, sem fallback);
- só o primeiro nome na resposta;
- **60 s de inatividade DESLIZANTES, sem teto**, só `POST atividade` renova (polling, GET e heartbeat nunca);
- 10 tentativas/min por tablet (em memória: com várias instâncias o limite efetivo se multiplica);
- 404 único `FUNCIONARIO_NAO_IDENTIFICADO` e 401 único `ATENDIMENTO_INVALIDO`;
- motivos de encerramento só os da 086;
- **"recusar não é encerrar"**: funcionário não ATIVO ou atendimento anterior à reativação do tablet → 401 sem fechar o registro e sem motivo falso;
- reativação detectada por `token_ativacoes.usado_em` (consumo do código, `clock_timestamp()` sob a trava do tablet) e reconferência da credencial sob a trava (correção determinística da janela de reativação, `D-JANELA-REATIVACAO` e `D-CORRECAO-JANELA`). 91/91;
- mutação 62 mortos de 67 (5 equivalentes).
- **E — catálogo (12/10;
- validação técnica aprovada;
- CONGELADA, 12 arquivos):** `GET /tablet/atendimento/catalogo` (`token-catalogo.*`, `repositories/sql/catalogo-token.js`);
- leitura pura `READ ONLY REPEATABLE READ`, não renova os 60 s nem reemite cookie;
- seleção = material da empresa, ativo, `exige_tamanho` classificado (nulo excluído), previsto no GHE ATUAL por vínculo direto ou por tipo ATIVO (tipo inativo não concede;
- decisões D-E1..D-E11), com ao menos um tamanho quando exige;
- saldo nunca filtra nem aparece;
- tipo genérico nunca é item;
- `imagem: { disponivel: false }` (**E15 bloqueado**: não existe estrutura de imagens no sistema;
- a biblioteca de imagens na Gestão de Estoque — upload, MIME/tamanho, isolamento por empresa, storage compatível com AWS, fallback — é obrigatória antes da homologação final do Totem).
- **F — pedido (12/10;
- validação técnica aprovada;
- CONGELADA documental, 14 arquivos):** `POST /tablet/atendimento/pedido` e `GET /pedidos/:chave` (`token-pedido.*`);
- cria a solicitação REAL `AUTOATENDIMENTO` pelas mesmas peças da 12G-6 (numeração, idempotência, auditoria), sem solicitante, `PENDENTE`, sem ler nem gravar estoque;
- aceite e persistência numa só transação (idempotência → tablet com credencial reconferida → atendimento `FOR UPDATE` = PONTO DE ACEITE → trabalhador `FOR NO KEY UPDATE` → materiais `FOR SHARE` → numeração), sucesso só depois do COMMIT, 202 `EM_PROCESSAMENTO` por try-lock, um pedido por atendimento (encerrado `PEDIDO_ENVIADO` na mesma transação), repetição idempotente devolve o original, 409 `ITEM_NAO_AUTORIZADO` pelo catálogo da E, 1 a 20 itens com `ITEM_REPETIDO`;
- D-F2: motivos só `SUBSTITUICAO_PRAZO`, `DESGASTE_DANO`, `PERDA_EXTRAVIO` (sem `ADMISSAO`, `OUTRO` ou observação);
- **D-F6 = Alternativa A do responsável**: a recuperação do resultado vale só pelo atendimento original enquanto o cookie vale (~60 s);
- a consulta posterior é da G e é outra operação. 58/58.
- **G — solicitações em aberto e duplicidade (12/10;
- validação técnica aprovada;
- CONGELADA documental, 10 arquivos):** `GET /tablet/atendimento/solicitacoes` (`token-solicitacoes.*`;
- `{ temDisponiveis, itens: [{ materialId, nome, tamanho, situacao, quantidade, retiradaParcial }] }`;
- situações `DISPONIVEL_PARA_RETIRADA` — só `coberta` > 0 pela fila FIFO;
- aprovar NÃO é disponibilidade —, `AGUARDANDO_ESTOQUE`, `AGUARDANDO_APROVACAO`, `INDISPONIVEL`, derivadas da 12G-6;
- estados fechados não aparecem;
- sem número de pedido, CPF, matrícula ou saldo);
- duplicidade por item **só no Totem** (409 `ITEM_JA_SOLICITADO` em `token-pedido.service.js`, após a trava do trabalhador;
- única alteração autorizada na F);
- o canal interno não é bloqueado por desenho (G16c: característica aceita, não unicidade global). 47/47 + 5.
- **H — Central Administrativa (12–13/10;
- CONGELADA COM RESSALVAS, aprovação do responsável ):** bloco "Central de Atendimento Token" abaixo.
- **I — Totem (13/10;
- I-G1 a I-G5 executados;
- BLOQUEIO DE HOMOLOGAÇÃO;
- NÃO CONGELADA):** bloco "Totem" abaixo.
- **J — monitoramento, alertas, histórico, destinatários, Dashboard (13–14/10):** **J1 só documentação** (`[REFERENCIA_HISTORICA_PRIVADA]`–`07`;
- decisões D1–D30 em `02-MATRIZ-DECISOES.md`, a maioria PENDENTE — aprovadas: destinatários SST/TI por empresa com CRUD, canais Dashboard/Central/e-mail da mesma fonte, carrinhos abandonados só como contagem derivada, princípio de sem timer na API;
- exceções X1–X15;
- o `07` prevalece);
- **J2a implementado e homologado no dedicado** (bloco "Bloco I / J2a" abaixo);
- J2b, J3a, J3b, J4a, J4b, J4c, J5 e J6 **não iniciados**;
- as abas Monitoramento e Histórico da Central seguem "em integração" e `TOKEN_VISUALIZAR_MONITORAMENTO`/`TOKEN_VISUALIZAR_HISTORICO` seguem sem enforcement.
- o mestre de 11/10 também enumera subincrementos técnicos K1–K11 — K1 estrutura … K8b prévia … K11 hardening — que **não se confundem** com as etapas de gestão A–K).
- Em a V7 informou que outra sessão implementa o K2 na branch `feature/bloco12-etapa-k`;
- este registro não documenta a Etapa K (nenhuma evidência lida) e a ordem J × K segue sem decisão escrita (P-15).
- **Nota de atualização:** o texto acima descreve o estado do checkpoint e fica preservado como registro histórico.
- O K3 e os demais incrementos da Etapa K não foram iniciados.
- **K — atualização (ciclo K1+K2):** a situação "NÃO INICIADA" acima é a do checkpoint e da primeira documentação (inclusive a frase "este registro não documenta a Etapa K", já superada) e fica preservada como registro histórico, assim como a menção "Etapa K não iniciada" na nota de "Liberação visual controlada".
- Em a Etapa K foi efetivamente iniciada, na branch `feature/bloco12-etapa-k`, pelo ciclo **K1+K2**: o K1 (diagnóstico de autoridade, somente leitura) está concluído e o K2 (proteção da autoridade no serviço) está implementado, com testes sem banco aprovados;
- a integração com PostgreSQL e a homologação do K2 seguem pendentes (blocos "Etapa K — K1" e "Etapa K — K2" abaixo).
- Por decisão do responsável, comunicada pela V7 como instrução de trabalho (sem documento próprio), a Etapa K é desenvolvida e entregue de dois em dois incrementos (K1+K2, K3+K4, K5+K6 e assim sucessivamente);
- cada par exige autorização expressa (seções 5 e 61) e a entrega Git segue só do responsável.
- O "Bloco K" dessas instruções é tratado aqui como a Etapa K do plano A–K (equivalência ainda a confirmar pelo responsável: item 1 da seção 9 do checkpoint), e a numeração K1/K2 deste ciclo, adotada nas instruções da V7, não corresponde à lista K1–K11 do mestre (nela, K1 é estrutura e K2 é backend).
- O K3, o K4 e os demais incrementos não foram iniciados.
- P-14 (planejamento próprio da etapa) e P-15 (ordem J × K) continuam pendentes, sem decisão escrita do responsável: a cadência de dois em dois incrementos não é planejamento da etapa nem decisão sobre J × K.

[Proveniência e custódia da fonte](../../historico/governanca/rastreabilidade.md#s63-076).

## S63-078

- **Backend (decisões D1–D7 em `[REFERENCIA_HISTORICA_PRIVADA]`):** `GET /atendimento-token/visao-geral`, `GET /dispositivos/:id/ativacao` (estado derivado `NENHUMA | PENDENTE | EXPIRADA | CONSUMIDA | CANCELADA`, sem estado persistido), `GET /previa/catalogo?funcionarioId=` (`TOKEN_PREVIA_CATALOGO_REAL`;
- reusa `montarCatalogoDoFuncionario`, extraído de `token-catalogo.service.js` por D6;
- grava **uma auditoria `TOKEN_PREVIA_CONSULTADA` por consulta**, só o id: a prévia não é só leitura no sentido de auditoria), `GET/POST /redes` e `POST /redes/:id/desativar` (`TOKEN_GERENCIAR_REDES`;
- D5: só IP exato, sem TUNEL, sem exclusão, com auditoria;
- desativar um IP deixa o tablet 403 `REDE_NAO_AUTORIZADA` sem revogar a credencial);
- **Tela, seis abas:** Visão Geral (indicadores);
- Dispositivos (cadastro, consulta, detalhes, edição, revogação);
- Ativação (QR gerado com a biblioteca local, código só em memória e descartado em sete situações, contagem, descarte e substituição — "Fechar e descartar" só apaga o QR do navegador, a ativação continua pendente até vencer ou ser substituída —, e as redes autorizadas);
- Monitoramento e Histórico (**só a estrutura, "em integração", Etapa J**);
- Prévia e Testes (**hoje = "Prévia do catálogo"**: busca do funcionário por nome ou matrícula via `GET /funcionarios`, que exige `employeeHistory.visualizar` — **não** concedido automaticamente —, só funcionário ATIVO, resultado dentro do item do funcionário com um só botão "Ver prévia"/"Fechar prévia" (S4, homologada ) e aviso fixo "Prévia administrativa, somente leitura: mostra o que o tablet exibiria para o funcionário escolhido.
- Não abre atendimento, não cria pedido, reserva nem entrega e não é o atendimento real.").
- Menu: `ajustarMenuAtendimentoToken` em `permissoes-efetivas.js` troca o rótulo "Autoatendimento (Totem)" por "Atendimento Token" (`atendimento-token.html`, `data-pagina="atendimentoToken"`) só para quem abre a Central (`PAGINAS.atendimentoToken`: `atendimentoToken.visualizar` OU `TOKEN_GERAR_ATIVACAO` OU `TOKEN_GERENCIAR_REDES` OU `TOKEN_PREVIA_CATALOGO_REAL`, `abrirComQualquer`);
- o HTML das 23 páginas não foi editado (a troca em massa é decisão pendente).
- Conteúdo do QR (`conteudoQr`, alterado pela Etapa I com derrogação documentada): `<origem>/totem/#ativar=<código>`.
- **Toggles:** os sete `token*` do bloco "Toggles e avisos";
- sem toggle, só o MASTER e quem recebeu pelas APIs diretas usa a Central.
- **Fragilidade latente transferida à K, sem mudar a regra:** o avaliador dispensa o vínculo SST do MASTER (`exigeSst && !ehMaster`);

[Proveniência e custódia da fonte](../../historico/governanca/rastreabilidade.md#s63-078).

## S63-080

- **O que existe:** a aba "Prévia e Testes" mostra a **lista do catálogo real** do funcionário/GHE (`GET /atendimento-token/previa/catalogo`, mesma regra de seleção do tablet, somente leitura, auditada), descrita acima. `js/atendimento-token-tela.js` e `pages/atendimento-token.html` **não** carregam `frontend/totem/`, não usam `iframe` e não reproduzem as telas do tablet (conferido no código ).
- Não declarar a simulação visual como implementada.
- **O requisito do responsável:** mestre `[FONTE_PRIVADA]`, aba 5: "Prévia e Testes — mesma interface visual do HTML real, com catálogo real do funcionário/GHE via endpoint administrativo somente leitura;
- simular fluxo/carrinho sem escrever pedidos, estoque ou entregas.
- Provar por testes que não usa rotas de escrita;
- sem credencial de dispositivo no admin." (na tabela A–K, atribuída à Etapa J "read-only, sem pedidos reais na prévia";
- na lista técnica, ao subincremento K8b "prévia");
- reafirmado em `[FONTE_PRIVADA]` §4.3: "(5) Prévia e Testes somente leitura/sem pedido real".
- **Por que ficou de fora:** a decisão D2 da H (`[REFERENCIA_HISTORICA_PRIVADA]`) aprovou "começar só com o catálogo" para tocar menos baselines;
- o termo da H §1 lista a "integração do HTML aprovado do Totem" como fora do escopo da H;
- nenhum documento posterior (Etapa I, J, checkpoint do Bloco I, transferência V7 de 13/10) decidiu em que incremento a simulação visual será feita.
- **Regras já fixadas para quando for feita:** reaproveitar obrigatoriamente a interface já aprovada do Totem (`frontend/totem/`, derivada de `token-epi.html`), sem redesenho;
- sessão administrativa e RBAC, nunca credencial de dispositivo no admin;
- nenhum pedido real, nenhuma movimentação de estoque, nenhuma entrega e nenhuma rota de escrita, provado por teste;
- nenhum dado pessoal além do necessário.
- A alocação a um incremento (J ou K) é decisão do responsável, não deste registro.

[Proveniência e custódia da fonte](../../historico/governanca/rastreabilidade.md#s63-080).

## S63-082

- **Origem e adaptação (Q0, aprovada):** página DERIVADA do HTML aprovado pelo responsável (`[FONTE_PRIVADA]`, 35 466 B, SHA-256 `08458202…3eaf`, intocado): as quatro telas preservadas (Identifique-se com teclado numérico 3×4, Produtos "Olá, {primeiro nome}", Tamanhos, Confirmação), CSS transposto sem mudar valores, identidade visual mantida;
- removido o demonstrativo (`localStorage`, produtos falsos, quantidades, "Reservar"/"Reservado"/reserva, chip "Demonstração", chips de função/setor/GHE/matrícula);
- nenhum saldo, estoque, lote ou reserva na tela. `[REFERENCIA_HISTORICA_PRIVADA]` classificou cada elemento como A (preservar), B (substituir), C (já atendido pelo backend) ou D (dependência).
- **Decisões Q0–Q8 (`[REFERENCIA_HISTORICA_PRIVADA]`, 13/10):** Q1 QR `https://<origem>/totem/#ativar=<código>`;
- `boot.js` é o primeiro script, lê o fragmento, o remove com `replaceState` antes de qualquer rede e o entrega uma vez por `tomar()` (nunca storage, DOM, console, histórico);
- consumo só por toque em `POST /tablet/ativar`.
- Q2 textos integrais (confirmação neutra sem produto nem tamanho;
- texto único para "não ativado" e "revogado", porque o backend não os distingue).
- Q3 ícones locais, sem recurso externo.
- Q4 tablet dedicado em modo quiosque (recomendação;
- decisão operacional pendente).
- Q5 quantidade 1 por item, 1 a 20 itens.
- Q6 limpeza imediata ao fim/expiração;
- 20 s só na confirmação neutra;
- 30 s só para digitação abandonada.
- Q7 renovação só por ação explícita (nunca `mousemove`, `scroll`, temporizador, polling ou GET), uma em voo, intervalo mínimo e teto.
- Q8 transporte próprio `TotemHttp` (sem `console`, sem registrar caminho com a chave de idempotência, tempo limite, `Retry-After`);
- API resolvida pela regra de `portal/config.js`;
- publicação pela allowlist (os quatro arquivos estão nela).
- I-G2 ativação e identificação CPF/matrícula com seletor explícito (41;
- exceção autorizada à baseline H: só `conteudoQr` e seu teste);
- I-G3 sessão de 60 s alimentada pelo servidor, consulta G com a marca "✓ Solicitado", catálogo E com placeholder de imagem (46);
- I-G4 carrinho em memória, motivo por item (3 autorizados), revisão, envio real idempotente com chave UUID só em memória, confirmação neutra, resultado incerto com "Enviar novamente" (mesma chave) e 409 de duplicidade (45);
- I-G5 validação integrada (`.motivos` em 3 colunas;
- 12 testes de chaves de idempotência;
- Isolamento entre funcionários em duas camadas: geração de estado da página (resposta de geração antiga é descartada) e barreira sobre o cookie do atendimento (nenhuma identificação nova com uma pendente;
- só o recarregamento encerra o bloqueio).
- A interface nunca lê nem remove a credencial do tablet.
- **Status (decisão da V5, `[REFERENCIA_HISTORICA_PRIVADA]`): "I-G5 EXECUTADO COM BLOQUEIO DE HOMOLOGAÇÃO — ETAPA I NÃO CONGELADA.
- Nenhuma nova implementação está autorizada."** Pendências de usabilidade (controles parcialmente fora da área visível;
- confirmar em tablet real;

[Proveniência e custódia da fonte](../../historico/governanca/rastreabilidade.md#s63-082).

## S63-092

- Continuam pendentes a homologação manual do K2, a re-homologação das baselines F e G e o hash do termo F.
- CI verde não é homologação nem autorização de produção.
- Ficam também **superadas**, para o K3 e o K4 deste ciclo, as frases "O K3 e os demais incrementos da Etapa K não foram iniciados" e "O K3, o K4 e os demais incrementos não foram iniciados" dos bullets "K — NÃO INICIADA", "K — atualização " e do estado do K2 acima;
- não substituem os K3 (credencial) e K4 (identificação) da lista do mestre, que são as Etapas C e D, congeladas, nem os identificadores de cenários de teste "K1…K5".
- **K3 (backend):** a rota existente `POST /api/atendimento-token/tablet/heartbeat` passou a ser montada em `app.js` (instância `tokenHeartbeatRoutes`, exportada por `routes/token-heartbeat.routes.js`, na cadeia de `/api` depois de `tokenTabletRoutes`): atrás do CORS, da verificação de Origin e do JSON, fora do limitador geral por IP e com os limites próprios já definidos (600 por minuto por IP e 120 por minuto por tablet, cota separada das demais rotas do tablet).
- Credencial, rotação, cookies, rede, isolamento por empresa e autoridade do tablet não mudaram;
- a empresa e o tablet continuam vindo só de `req.dispositivo`.
- Resolve o P-01 (a frase "rota NÃO montada em app.js" dos blocos J2a e dos pendentes fica superada).
- RED 9 de 11, com o 12º e o 13º, das cotas independentes e do limite por IP, acrescentados depois e validados por mutação;
- a autenticação e o registro do contato foram substituídos na fronteira do serviço, porque não há banco local;
- a prova com credencial verdadeira em PostgreSQL é a da suíte `token-j-heartbeat`, na CI).
- **K4 (frontend):** `frontend/totem/totem.js` passou a enviar a batida: a primeira depois de o servidor não recusar o tablet e de a tela inicial estar posta (ou ao fim de uma ativação bem-sucedida), depois a cada 60 s com jitter de ±10 % (54 a 66 s), por `setTimeout` remarcado só quando a batida anterior termina, nunca duas ao mesmo tempo nem timer duplicado (idempotente em reinícios da página). 401 e 403 seguem a semântica já implementada (tela de não autorizado ou de rede) e param a batida;
- falha de rede e 5xx não mudam a tela nem o ritmo;
- 429 respeita o `Retry-After` (até 120 s).
- A batida é assunto do tablet: usa o transporte existente sem a barreira do atendimento, corpo `{}` sem query, sem armazenamento do navegador, não renova a sessão do funcionário e não carrega dado de funcionário ou pedido.
- HTML, CSS e `boot.js` do Totem **não foram alterados** (SHA-256 conferidos).
- **Exceções aos congelamentos (V7 e Ramires), estritas e documentadas no K3K4-01:** `backend/src/app.js` (baselines B a G e pino D-14 do manifesto do Bloco I), `backend/src/routes/token-heartbeat.routes.js` (pino D-06), `frontend/totem/totem.js` (Etapa I, não congelada, bloqueada para homologação;
- a frase da V5 de 13/10, "nenhuma nova implementação está autorizada", tem aqui exceção só para o K4) e `backend/.env.example` (pino D-13) apenas para documentar `TOKEN_JOB_DB_SCHEMA` (comentada, porque a variável definida e vazia é inválida;
- resolve o P-06).
- Os pinos D-06, D-13 e D-14 do manifesto do Bloco I passam a divergir por desenho;
- regenerar o manifesto segue pendente, só com autorização.
- O restante das baselines B a I continua válido.
- **Pré-condição de banco do K3 (atualiza a lista de pré-condições por funcionalidade):** a rota montada grava o contato com um UPDATE que escreve `queda_suspeita_desde`, coluna criada só pela **migration `089`**.
- O banco que serve a API com tablets ativos precisa estar na `089`: em banco abaixo dela cada batida autenticada devolve 500 (sem sintoma na tela do Totem, com ruído de log), o que vale para o descartável de homologação da Central (`087`) e para os bancos persistentes.
- Antes de apontar um Totem com K4 para qualquer banco persistente, aplicar a `089` com autorização própria (P-07).
- Não é defeito do K3/K4: a dependência já existia no código do J2a e a rota estava desligada.
- **Estado : IMPLEMENTADO — TESTES SEM BANCO VERDES — CI DA PR DO CICLO 2 E SUÍTES DE INTEGRAÇÃO PENDENTES — NÃO HOMOLOGADO EM TABLET REAL.** Em cópia limpa do working tree (sem os arquivos com sufixo "2", como a CI): backend unitário 3657 testes (3655 passam, 2 TODO) e frontend 3149 (3136 passam, 1 ignorado, 12 TODO), nenhuma falha;
- cobertura de linhas do backend 81,74 % (mínimo da CI: 75 %).
- Pendências: CI da futura PR (inclusive as suítes `token-j-*` e do Token em PostgreSQL);
- a `089` no banco que serve a API (pré-condição acima) e, para o heartbeat ter efeito de monitoramento, o job operacional (P-02 a P-04);
- a tela "fora da rede" continua só se recuperando pelo recarregamento da página (como as demais operações).
- Etapa I continua bloqueada para homologação e não congelada.
- **Decisão (Ramires e V7) — homologação operacional do Totem adiada para a implantação na nuvem (Ciclo 2, K3/K4):** a ausência de um tablet físico e do ambiente definitivo não bloqueia a conclusão do desenvolvimento, a preparação da PR nem o merge do Ciclo 2, desde que a CI seja aprovada e não existam defeitos críticos conhecidos.
- posteriormente, deverão ser realizados testes no tablet definitivo e na rede corporativa.
- Antes da ativação operacional devem ser verificadas a migration `089` (pré-condição acima;
- verificar não é aplicar, e aplicá-la continua exigindo autorização própria por banco), as configurações de segurança e as demais dependências de implantação (por exemplo, as já registradas em "Segurança do Atendimento Token", item "Implantação (pendente)";
- a decisão não fixou a lista completa).
- **Não declarar o Totem homologado para produção antes dessas verificações**: cumpri-las é condição necessária, não suficiente, e o Totem continua NÃO homologado.
- A ausência de falhas de segurança comprovadas até o momento não equivale à homologação completa de segurança.
- Ficam preservadas todas as pendências técnicas documentadas;
- a corrida de respostas antigas da batida, que era uma delas (K3K4-01, seção 9, item 7), foi corrigida depois, (bullet seguinte).
- A decisão não altera código, testes, baselines nem o estado acima ("NÃO HOMOLOGADO EM TABLET REAL" e a Etapa I bloqueada para homologação e não congelada continuam valendo);
- ela define que a falta do tablet e do ambiente definitivo não bloqueia a PR nem o merge e que a homologação operacional fica para depois da implantação na nuvem. "Ativação operacional" é o termo da decisão, que não o define, e não se confunde com a ativação do tablet por QR.
- CI verde continua não sendo homologação nem autorização de implantação em produção, e a decisão não autoriza Git, merge nem implantação (o Git continua só do responsável).
- **Correção da corrida de respostas antigas da batida (autorizada pela V7;
- só `frontend/totem/totem.js` e testes;
- `iniciarHeartbeat` não envia nova batida porque a antiga ainda está em voo, e a resposta antiga 401/403, ao chegar com a presença de novo ativa, bloqueava de novo a tela já liberada.
- Correção mínima: a presença tem um contador de vida (`heartbeat.vida`, incrementado em `pararHeartbeat`);
- a resposta de uma batida enviada numa vida anterior é descartada e a presença atual segue no ritmo normal (`agendarHeartbeat(0)`), sem segunda batida simultânea.
- O caso análogo sem bloqueio anterior (um 401/403 antigo que chega depois de um `popstate` com `/estado` 200), provado por sonda, foi tratado em seguida, na mesma data e por autorização da V7, com `heartbeat.vida += 1` no início de `reiniciar()` (testes K4-25 e K4-26;
- K3K4-02, seção 8).
- O 401/403 da presença atual continua bloqueando como antes (K4-08, K4-19, K4-23).
- família do Totem 368, 0 falhas;
- Hashes depois da correção: `totem.js` `b1e286bc…`, `totem-i.js` `3ef538fb…`, `totem-k4-heartbeat.test.js` `b1848cff…`;
- os valores anteriores citados nos blocos acima são os de antes desta correção.
- Depois do limite (b): K4 31 de 31, família do Totem 372, frontend completo em cópia limpa 3159, contrato do backend 14 de 14, todos sem falhas;
- `totem.js` `9ee5d2f8…` e `totem-k4-heartbeat.test.js` `831c815f…` (`totem-i.js` inalterado).
- A avaliação focalizada do `proxy-addr` (K3K4-03) concluiu que o alerta não é explorável na configuração atual (o SafeWork só aceita `false` ou inteiro de saltos) e recomenda tratá-lo como condição de implantação, em bloco de dependências próprio;
- nenhuma dependência, `package.json` ou lockfile foi alterado, e a decisão sobre o tratamento continua com a V7 e Ramires.
- A aplicação continua não declarada apta à produção até o tratamento ou a justificativa formal aprovada (`PENDENCIA-SEGURANCA-NPM.txt`).

[Proveniência e custódia da fonte](../../historico/governanca/rastreabilidade.md#s63-092).

## Consulta de dependências

Leia [o índice](../README.md), [a governança](../governanca/agentes.md) e
[as reconciliações](../../historico/governanca/reconciliacoes.md). Arquivo congelado
ou exceção exige leitura da fonte pertinente antes de ação que o afete. Campos,
erros e limites não são exemplos opcionais. Aprovação da documentação não autoriza
execução dos procedimentos ou acesso a dados.

## Integração de imagens sem regressão do cadastro

Preservar automatismos do nome, Grupo→Proteção→Tipo, tamanho/grade e validações
de materials.html/materiais.js. Não trocar pelo protótipo. Contrato histórico da
integração: campo compacto de imagem após grade e antes de fabricante/código,
seleção provisória do formulário até salvar, nunca associação implícita por Tipo,
Grupo ou GHE. A posição/visual é baseline: alteração futura só no escopo aprovado.
Não sobrescrever campo digitado ao sugerir nome. Testes de caracterização protegem
o comportamento existente; não reabrir a baseline por reorganização documental.
