# Pessoas, GHE, contas e acessos

Contratos funcionais consolidados por unidade de origem. Usuário administrativo
e funcionário operacional são entidades distintas. Empresa/ator vêm da sessão.
CPF imutável; setor/função não trocam GHE automaticamente; importação não atualiza
existentes. Menu não concede autoridade. Baselines e proteção de arquivos são
requisitos, não narrativa descartável.

## Reconciliações aplicáveis

**R05 — contagens históricas superadas:** as menções a 78 migrations (000–077),
8/11/19/26 toggles e números de testes descrevem marcos de origem; não são
inventário vigente. Main local da referência contém 96 SQL até 096, sem 088,
segundo AD-02. Contagem efetiva de toggles e estado dos bancos exigem verificação
específica quando necessários; não foram conferidos nesta revisão.
**R10:** regra MASTER/SST é a proteção obrigatória do K2.
**R11:** Classificação V2 e previsão híbrida não convertem legado automaticamente.
**096:** o contrato de situações evolui na referência local; datas efetivas e
privacidade constam de estado-atual.md. Não inferir aplicação em banco.

## S63-016

- Nota complementar: a frase acima sobre o vínculo SST foi superada (evidências em `[FONTE_PRIVADA]`, 17:28): o vínculo SST passou a ser ligado e desligado em Novo/Alterar usuário da Gestão de Usuários (`vinculo-sst.service.js`;
- padrão desligado;
- só o MASTER ativo;
- auditado), junto dos toggles `aprovarSolicitacoes` e `reprovarSolicitacoes` (grupo ADMINISTRACAO, modo concessão).
- O acesso efetivo à aprovação continua exigindo o vínculo SST E a permissão, `AUTODECISAO_PROIBIDA` não mudou e o MASTER não é configurável.
- validação manual específica sem documento localizado.
- A 12J continua responsável pela matriz por perfil;
- detalhe no bloco "Toggles e avisos" (Lote 2).
- A **Prova de autoria** continua pendência obrigatória da fase final.

[Proveniência e custódia da fonte](../../historico/governanca/rastreabilidade.md#s63-016).

## S63-026

- Importação de funcionários da 12G-9 (`frontend/pages/import-employees.html`, `js/funcionarios.js`, `funcionario.service.js`, `funcionario.schema.js`, `grupo-homogeneo-exposicao.repository.js`;

[Proveniência e custódia da fonte](../../historico/governanca/rastreabilidade.md#s63-026).

## S63-027

- **Coluna GHE obrigatória** na planilha, com o nome exato do GHE da empresa.
- Coluna ausente = erro estrutural antes da prévia (caso A, `COLUNAS_AUSENTES`);
- célula vazia = só aquela linha (caso B).
- Nunca GHE padrão, aproximado (`buscarPorNome` é igualdade exata, a de `uq_ghe_empresa_nome`), de outra empresa ou criado pela importação;
- inativo recusa a linha.
- Códigos: `FUNCIONARIO_GHE_NAO_INFORMADO`, `FUNCIONARIO_GHE_INEXISTENTE`, `FUNCIONARIO_GHE_INATIVO`, sempre com `campos: ['ghe']` e sem ecoar o nome informado;
- decididos antes de abrir transação.
- O vínculo grava o id resolvido e relê o GHE `FOR SHARE` na transação da linha.
- **Existente = CPF na empresa** (`buscarPorCpf`;
- regra oficial `uq_funcionarios_empresa_cpf`), comparado antes de gravar: `JA_CADASTRADO` com `FUNCIONARIO_JA_CADASTRADO` (sem alterações) ou `FUNCIONARIO_JA_CADASTRADO_DIVERGENTE` + `divergencias: [{ campo, atual }]` na ordem matrícula, nome, setor, função, admissão, nascimento, telefone, GHE (pelo nome).
- NUNCA alterar, reativar, completar nem registrar auditoria de alteração;
- `atualizar` não é chamado pela importação. `atual` só dos campos do instantâneo de auditoria;
- `dataNascimento` e `telefone` vêm só como `{ campo }`;
- CPF nunca;
- o valor da planilha nunca é ecoado;
- opcional vazio na planilha não diverge;
- a resposta traz `funcionarioId` e `ativo`.
- Matrícula de outro CPF segue `DUPLICADO`;
- corrida no INSERT segue `FUNCIONARIO_CPF_EM_USO` (aceito `DUPLICADO` ou `JA_CADASTRADO`, sempre uma linha só no banco).
- **Resumo e auditoria:** `resumo` = cadastrados, jaCadastrados, divergentes, duplicados, recusados, erros;
- `FUNCIONARIOS_IMPORTACAO_LOTE` guarda os contadores e `linhas: [{ linha, situacao, codigo, funcionarioId, campos }]` (nomes de campos, nunca valores).
- Nenhum evento novo de auditoria.
- **Tela:** `CABECALHOS.ghe`, `OBRIGATORIAS` com GHE, `LIMITES.ghe = 150`, modelo CSV com GHE, prévia com a coluna GHE entre Cargo e Status;
- `fluxo.consolidar` devolve `nome`, `ativo`, `divergencias` (com `rotulo`, `atual`, `planilha` da própria prévia e `oculto`), `resumo` com `total` e `naoImportados`, e `porMotivo`;
- `fluxo.rotulo` dá o texto por pessoa;
- `render.relatorio` lista todas as linhas (Linha, Nome, Matrícula, Resultado, Detalhes) com a tabela Campo / Sistema atual / Planilha e "Nenhuma alteração realizada".
- O valor atual de `cpf`, `dataNascimento` e `telefone` nunca é exibido, mesmo que venha do servidor;
- tudo escapado.
- A prévia continua local: GHE inexistente ou inativo e funcionário existente só na confirmação (a conferência prévia de GHE por nome exigiria rota nova;
- melhoria futura, não criar sem decisão).
- **Fora do escopo** (decisão registrada na fonte): nova tela de funcionários, filtro ou busca por GHE no Histórico, atualização em lote, merge, criação automática de GHE.
- Nenhum número de estoque, CPF ou dado de outra empresa na tela.
- **Regra definitiva do funcionário já cadastrado (congelada ):** a importação serve SOMENTE para cadastrar funcionários novos.
- Existente (CPF na empresa) → identificar, comparar quando aplicável, informar "JÁ CADASTRADO" e NÃO alterar: nenhum UPDATE, nenhuma sobrescrita, nenhuma troca de GHE, setor, função, telefone ou situação, nenhuma reativação, nenhum completamento ou correção automática;
- divergência é informativa e NUNCA autoriza alteração.
- Confrontada com o código : o único caminho de escrita da importação é `gravarCadastro` → `funcionarioRepo.criar` (INSERT puro, sem `ON CONFLICT`);
- `atualizar` só é chamado por `alterar` e `alterarEstado`, que a importação não invoca;
- a corrida de CPF termina em violação de unicidade e ROLLBACK.
- Qualquer alteração de funcionário existente (setor, função, GHE, telefone, situação) é da etapa futura **12K-E — Gestão / Edição de Funcionários**, com histórico (valor anterior, valor novo, data/hora, responsável, motivo);
- mudar setor ou função não troca o GHE automaticamente, o GHE é alterado explicitamente;
- o histórico anterior nunca é apagado.
- Não iniciar a 12K-E sem autorização.

[Proveniência e custódia da fonte](../../historico/governanca/rastreabilidade.md#s63-027).

## S63-028

- Configurações (`frontend/pages/config.html`, `js/configuracoes.js`, `js/tema.js`;
- migration `072`;
- implementação funcional, concluída tecnicamente, aguardando validação manual): a página deixou de ser protótipo (sem `db-api.js`, `main.js` legado, seed ou login fictício), abre para qualquer sessão empresarial válida (`PAGINAS.config = { abrir: [], alterar: [] }`), mostra só a própria conta e saiu de `INSPECAO_PROTOTIPOS`.
- **Minha Conta** = nome, e-mail de login, telefone, perfil · situação (`Master · Ativo`, com `ativo` real de `usuarios` lido pelo `me`), CPF, matrícula e último acesso (`criado_em` da sessão global anterior;
- sem fonte real, "—").
- Editáveis: e-mail, telefone e senha;
- somente leitura: nome, perfil, situação, CPF, matrícula e último acesso.
- **Vínculo usuário ↔ funcionário (decisão corrigida ;
- migration `073`):** usuário e funcionário continuam entidades distintas;
- CPF e matrícula ficam SÓ em `funcionarios` e chegam à tela pelo vínculo EXPLÍCITO `usuarios.funcionario_id` (nulo por padrão;
- FK composta `(empresa_id, funcionario_id) → funcionarios(empresa_id, id)` sobre a unicidade da 057, `ON DELETE RESTRICT`;
- unicidade `(empresa_id, funcionario_id)`, NULL livre;
- sem gatilho;
- nenhuma linha vinculada pela migration).
- A identidade (global) nunca recebe `funcionario_id`, e nada é copiado para `usuarios` ou `identidades`.
- Nenhuma inferência por nome, e-mail, CPF, matrícula, empresa ou perfil: `usuarioRepo.buscarContaOperacional` liga só por `u.funcionario_id` e filtra só por empresa e id da sessão;
- sem vínculo, `GET /auth/global/me` devolve `contexto.usuario.funcionario = { vinculado: false, matricula: null, cpfMascarado: null }` e a tela mostra "Não vinculado".
- O CPF sai SÓ mascarado (`mascararCpf`, `***.***.***-XX`, o padrão da aplicação);
- não existe regra de revelação do CPF no sistema e nenhuma foi criada;
- a matrícula sai integral.
- Quem administra o vínculo é fluxo administrativo futuro (12J ou 12K-E);
- até lá o vínculo é gravado só por ato explícito autorizado.
- **Decisão de domínio: existem dois tipos de pessoa — o funcionário da fábrica (`funcionarios`, que recebe EPI) e a pessoa administrativa, que hoje existe só como conta (`usuarios` + `identidades`), sem cadastro próprio e sem CPF ou matrícula em lugar nenhum.** Solução provisória adotada (opção C): a 073 fica como está e serve só a quem também for, explicitamente, um registro de `funcionarios`;
- conta administrativa sem vínculo mostra "CPF: Não vinculado" e "Matrícula: Não vinculado", com os campos visíveis;
- a conta MASTER do responsável NÃO é vinculada a nenhum funcionário da fábrica;
- `funcionarios` não vira cadastro genérico de pessoa e não se cria tabela de pessoa administrativa nem migration para isso.
- **DECISÃO FUTURA (não bloqueia Configurações):** a forma definitiva do cadastro da pessoa administrativa (pessoa que terá acesso, tipo de perfil, CPF, matrícula, demais dados e a relação com usuário, identidade e empresa) será analisada na tela de Administração de Usuários / Configurações de Acessos, sobre o fluxo já desenhado;
- não antecipar essa arquitetura.
- **Modelo:** telefone, tema e modo visual ficam em `identidades` (`072`: `telefone VARCHAR(20)` nulo, `tema` em sistema|claro|escuro, `modo_visual` em padrao|alto_contraste|deuteranopia|protanopia|tritanopia|baixa_visao|monocromatico, com CHECKs;
- sem tabela 1:1);
- `src/utils/preferencias-aparencia.js` é a única lista.
- **Leitura:** `GET /auth/global/me` traz `identidade` (id, e-mail, telefone, tema, modoVisual, ultimoAcessoEm) e `GET /auth/me` traz `preferencias` (padrão para o usuário legado sem identidade);
- nenhuma rota de leitura nova.
- **Escrita:** `PATCH /api/auth/global/conta` (telefone nulo ou 1–20, tema e modoVisual, pelo menos um campo;
- `conta.service.js` lê a identidade `FOR UPDATE`, audita `CONTA_ATUALIZADA` só com os nomes dos campos alterados e não audita o que não mudou) e `PATCH /api/auth/global/email` (`troca-email-global.service.js`: senha atual obrigatória, com o mesmo cooldown, trava e tratamento de falha do login global;
- e-mail normalizado e validado;
- igual ao atual é 400 `EMAIL_IGUAL_AO_ATUAL`;
- em uso, ou corrida 23505, é 409 `EMAIL_INDISPONIVEL` genérico, sem revelar o dono;
- altera só a identidade da sessão;
- cancela redefinições pendentes;
- revoga TODAS as outras sessões globais e empresariais e preserva a atual;
- audita `EMAIL_ALTERADO` só com contagens;
- o aviso `EMAIL_ALTERADO` vai ao e-mail antigo pela infraestrutura existente, depois do COMMIT, informativo, sem senha nem token, e a falha do aviso não desfaz nada;
- não há verificação do novo e-mail, que vale no próximo login);
- os dois restritos à identidade da sessão (o cliente nunca envia identidade ou usuário) e o de e-mail com `limitadorTrocaEmail`.
- Senha: só `POST /api/auth/global/senha` por `portal/trocar-senha.html`, sem segundo fluxo.
- **Aparência:** por identidade, persistida no backend, aplicada em todas as páginas integradas (`sessao-empresarial.js` chama `EpiTema.aplicarPreferencias` com a resposta de `/auth/me`), auto-salva (selecionar → aplicar → persistir → confirmar discretamente, sem botão "Salvar aparência";
- reverte se o PATCH falhar);
- `localStorage` só como cache da primeira pintura, numa chave única (`safework-aparencia`, só tema e modo visual), lido por `iniciar` sem gravar, reescrito a cada resposta do servidor, que sempre vence, e apagado no logout.
- Modo Quiosque e Resumo de Permissões foram removidos da tela (o Quiosque é da 12L;
- a matriz é da 12J).
- Responsividade: `css/main.css` empilha `.account-summary` na largura de celular.
- **Pré-condição:** qualquer banco persistente que sirva este código precisa estar migrado até a `073` (o `me` lê `usuarios.funcionario_id`);
- a `072` e a `073` não foram aplicadas a nenhum banco persistente protegido, só a schemas temporários do banco de teste `gestao_epi_teste_local` e ao banco descartável de validação `BANCO_PROTEGIDO_93B95A0C` (cópia da homologação criada para a validação manual;
- As suítes antigas com lista fixa de migrations que leem `identidades` ou o `me` passaram a incluir a `072` e a `073`.

[Proveniência e custódia da fonte](../../historico/governanca/rastreabilidade.md#s63-028).

## S63-029

- migration `074`;
- grupos, permissões, integrantes, autorizações e o restante de `safe-work-usuarios.html`, o alvo visual congelado, NÃO iniciados):

[Proveniência e custódia da fonte](../../historico/governanca/rastreabilidade.md#s63-029).

## S63-030

- **Arquitetura:** o Painel Privado provisiona a empresa e o primeiro MASTER (convite da `033`/`034`, intocado);
- os demais usuários nascem dentro da empresa por `POST /api/administracao/usuarios` `{ nome, email, tipoConta, senhaProvisoria }` (`schemas.criar`, estrito), empresa só da sessão, `GERENCIAR_USUARIOS` pela autoridade administrativa central e `exigirPerfilGerenciavel` (ADMINISTRADOR só SUPERVISOR e USUARIO), política real de senha (400 `VALIDACAO` em `body.senhaProvisoria`), Argon2id, transação sob `travaDaEmpresa`, auditoria `USUARIO_CRIADO` só com ids, perfil, origem e `acessoProvisorioExpiraEm` (nunca chave com o segmento "senha": o gatilho da `014` recusa a linha com P0001).
- **ZERO e-mail** na criação;
- o serviço não importa nada de e-mail, entrega ou convite (teste de fonte).
- E-mail já com identidade: 409 `IDENTIDADE_EMAIL_JA_EXISTENTE`, sem sobrescrever, sem vínculo, sem convite. `convites_usuario` (`046`) fica, fora do fluxo normal. (A redefinição administrativa de senha, antes fora do escopo, foi SUPERADA : ver "Alterar senha" no bloco das funções principais.) CPF/matrícula do usuário administrativo continua em aberto.
- **Estado (074):** `identidades.senha_provisoria` (NOT NULL DEFAULT false), `senha_provisoria_definida_em`, `senha_provisoria_expira_em`, CHECK `chk_identidades_senha_provisoria` (true ⇒ as duas datas e expiração > definição;
- false ⇒ ambas nulas).
- Nunca flag em `usuarios`. `identidadeRepo.criar` recebe `senhaProvisoria: { definidaEm, expiraEm }`;
- `atualizarSenhaHash` (troca e redefinição) grava a senha e limpa os três campos no mesmo UPDATE.
- A projeção da identidade e `buscarCredencialPorEmail` expõem `senhaProvisoria` e `senhaProvisoriaExpiraEm`;
- as duas sessões devolvem `senhaProvisoria` no topo do contexto (nunca dentro de `usuario`).
- **Validade (`utils/senha-provisoria.js`):** 48 horas;
- 72 quando `definidaEm` cai numa sexta-feira em `America/Sao_Paulo` (`FUSO` de `data-operacional.js`);
- sábado e domingo 48;
- sem renovação;
- `expirada` é verdadeira no instante exato.
- O instante vem de `clock_timestamp()` do banco.
- **Login e bloqueio:** senha correta + provisória válida → sessão normal e `identidade.trocaSenhaObrigatoria: true` (login e `GET /auth/global/me`);
- expirada → 401 `SENHA_PROVISORIA_EXPIRADA`, sem sessão, sem registrar falha nem cooldown;
- caminho "Esqueci minha senha". `criarExigirSessaoGlobal({ permitirSenhaProvisoria })` e `criarExigirSessao({ permitirSenhaProvisoria })`: sem a opção, 403 `TROCA_SENHA_OBRIGATORIA` ("Defina uma nova senha para continuar") depois de `registrarUso`.
- Só `GET /auth/global/me` e `POST /auth/global/senha` usam `exigirSessaoGlobalComSenhaProvisoria`;
- selecionar empresa, conta, Portal e tudo o mais ficam bloqueados;
- logout não passa pelo middleware.
- Rota nova que precise aceitar a sessão em troca obrigatória é decisão explícita.
- **Frontend:** `portal-cliente.js` (`decisao.destino` → `trocarSenha` antes de qualquer outro destino), `sessao-empresarial.js` (403 `TROCA_SENHA_OBRIGATORIA` → `portal/trocar-senha.html`), `portal/trocar-senha.js` (aviso da provisória).
- Nada vai para armazenamento do navegador;
- o servidor continua a autoridade.
- **Banco:** a `074` existe só em schemas temporários de `gestao_epi_teste_local`;
- NÃO foi aplicada ao descartável `BANCO_PROTEGIDO_93B95A0C` (exige autorização específica) nem a banco protegido.
- Suítes de integração com lista fixa de migrations que passam pela sessão empresarial ou global precisam incluir `'074'`.

[Proveniência e custódia da fonte](../../historico/governanca/rastreabilidade.md#s63-030).

## S63-032

- **Alvo visual:** `safe-work-usuarios.html` (anexo do responsável, cópia em `[FONTE_PRIVADA]`) é a referência congelada.
- A única adaptação autorizada é a moldura padrão do SafeWork;
- dentro da área de conteúdo o HTML aprovado fica intocado (cabeçalho, toolbar, filtros, busca, Exportar, tabela/cartões, tema, foco, menu de ações, modal, `#permView`, toast).
- A folha do protótipo foi transcrita sem mudar valores e restrita a `.gu` (tokens no contêiner;
- escuro por `html[data-theme="dark"] .gu`), com só os neutralizadores necessários contra `main.css` (`.brand`, `.grid`, `.switch`, margem de `p`).
- A barra do sistema do protótipo ficou dentro do conteúdo como contexto da sessão (decisão final, visual aprovado): esquerda = só o nome real da empresa (`whoEmpresa`, na `.brand`);
- direita = "Nome - Perfil" reais na mesma linha (`whoNome`, `whoPerfil`, pelos elementos `empresa` e `usuario` de `EpiSessaoEmpresarial.montar`);
- nada de "Safe Work" ou "Gestão de EPIs" nessa barra, nada hardcoded.
- O título "Gestão de usuários" da página continua.
- O ícone sanduíche e sua responsividade não foram tocados (análise futura).
- Qualquer outra mudança visual exige decisão do responsável;
- o espaçamento da moldura somado ao da página continua como está.
- **Autoridade:** `PAGINAS.gestaoUsuarios = { abrir: [['usuarios', 'consultar']], alterar: [] }`, a mesma da Administração de Usuários;
- nenhuma permissão nova;
- nada pelo nome do perfil;
- o menu oculto não é segurança.
- Menu: entrada `data-pagina="gestaoUsuarios"` logo depois de `userAdmin` em todas as páginas com menu, inclusive `config.html` (autorização limitada );
- as seis telas antigas continuam até autorização para retirá-las;
- Início do Portal e `RECURSOS` da Permissões do Grupo não mudaram.
- **Dados:** só `GET /administracao/usuarios` por `EpiUsuarios.acoes.listar` (agora com `limite` 1–100);
- `carregarTodos` consome a paginação real em segundo plano (100 por página, teto de 50 páginas com aviso `LISTA_INCOMPLETA`), sem `situacao` nem `busca` na consulta: situação (`ativo` real), busca (id, nome, e-mail, grupo), ordenação e agrupamento por grupo são locais sobre o conjunto real;
- tabela e cartões usam o mesmo conjunto;
- CSV só com ID, Usuário, Login (e-mail), Perfil, Grupo, E-mail e Status, célula neutralizada contra fórmula. "Login" = e-mail da identidade, sem sufixo.
- Desde (075–077) a projeção traz `cpfMascarado` (só o mascarado, validado pelo formato na tela), `matricula`, `setor`, `horarioTrabalho` ("08:00 - 18:00" ou "—") e `acessoQualquerIp` (derivado no servidor;
- ausente = "—", nunca inventado);
- Setor, Horário e Acesso de qualquer IP ordenam, CPF mascarado não ordena;
- "Agrupar por Setor" agrupa pelo setor real ("Sem setor").
- Empresa(s) e Visualiza logs continuam "—" (sem fonte consolidada);
- "Bloqueado" nunca aparece.
- Nada de `users`, `EMPRESAS`, `SETORES`, `MODELOS`, `localStorage` (`safework-usuarios-v1`, `safework-tema`);
- o conteúdo é montado só com nós e texto (`render(document, …)`), sem `innerHTML` (o harness de páginas não interpreta `innerHTML`).
- **Controles não integrados:** Novo › Grupo (Novo › Usuário é real : bloco próprio abaixo), Desbloquear, e as ações da linha (Alterar, Duplicar, Configurar permissões, Copiar permissões, Alterar senha, Desabilitar/Habilitar) ficam visíveis e só mostram `TEXTOS.EM_INTEGRACAO` pelo toast do HTML;
- nenhum modal falso, nenhuma escrita, nenhum armazenamento.
- Guia rápido = texto fixo.
- Tema = aparência por identidade (`EpiTema.aplicarPreferencias` + `PATCH /auth/global/conta`, `CAMINHO_CONTA` igual ao das Configurações;
- falha reverte).
- Foco = classe no contêiner.
- **Nomenclatura:** "GHE e EPIs" passou a "Gestão de GHE" só na apresentação (menu de todas as páginas, título e `<h2>` de `employee-groups.html`, Início do Portal e o nome em `RECURSOS` da Permissões do Grupo);
- arquivo, id `employeeGroups`, rota e recurso não mudaram. `config.html` recebeu só as duas linhas de menu (o nome novo e a entrada Gestão de Usuários) por autorização limitada ;
- formulário, conta, senha, e-mail, telefone, aparência, APIs e comportamento das Configurações continuam congelados.
- **Pedido de EPI para o MASTER (diagnóstico e decisão registrados na fonte):** `pages/request.html` e as rotas `/api/solicitacoes-epi` nunca saíram;
- a página abre com `request.visualizar` OU `request.criar` e o menu segue a mesma regra.
- O MASTER não via o Pedido porque a regra do 12E/12F excluía `request` do escopo de provisionamento (no descartável, o perfil MASTER tinha só os oito recursos do escopo e nenhuma linha de `request`).
- Decisão final: a regra estrutural foi corrigida em `ESCOPO_PROVISIONAMENTO_MASTER` (`request`: visualizar, criar, editar), o ponto único que o Painel Privado usa ao cadastrar a empresa e que `db:provisionar:master` reaplica (só o AUSENTE);
- nenhum outro perfil recebe `request.*` por isso;
- nada no frontend decide pelo nome do perfil.
- O descartável `BANCO_PROTEGIDO_93B95A0C` foi reprovisionado pelo próprio responsável (`db:provisionar:master -- --empresa 1 --executar`: uma linha `request` inserida para o perfil MASTER da empresa 1, nada apagado nem recriado), e a validação manual do Pedido de EPI com o MASTER foi APROVADA .
- Nenhuma pendência restante nesse ponto.
- **Navegação oculta (;
- só ocultação;
- validação manual APROVADA ):** `NAVEGACAO_OCULTA` em `js/permissoes-efetivas.js` (`stockValidity`, `grupos-acesso`, `grupo-permissoes`, `grupo-usuarios`, `autorizacoes-individuais`, `newUser`, `userAdmin`) nunca aparece em `aplicarMenu`, com ou sem permissão — vale para o menu lateral de todas as páginas integradas e para o Início do Portal, que usam a mesma função;
- `NAVEGACAO_OCULTA_PENDENTES` ("Compras / Entradas", "Regras Função / Setor") recebe `display:none` em `liberarInspecao`;
- na barra legada dos protótipos em inspeção, `js/inspecao-visual.js` injeta a regra `!important` para `NAVEGACAO_OCULTA_LEGADA` (o `main.js` reexibe os itens com `display:flex`).
- Sem item cinza, placeholder ou etiqueta: os itens somem.
- Nada foi apagado: páginas, módulos, rotas, permissões, testes e o acesso direto legado continuam (`podeAbrir` não muda).
- **Pendência obrigatória:** quando a Gestão de Usuários estiver 100% funcional, testada e validada, revisar e DESATIVAR DEFINITIVAMENTE as seis telas legadas que ela substitui (Grupos de Acesso, Permissões do Grupo, Integrantes do Grupo, Autorizações Individuais, Novo Usuário, Administração de Usuários), antes do Git consolidado da Gestão de Usuários.
- Validade de estoque, Compras / Entradas e Regras Função / Setor ficam só adiados, preservados para retomada.
- **Próximas subetapas (não iniciar sem autorização;
- permissões;
- vínculo SST;
- CPF/matrícula administrativa;

[Proveniência e custódia da fonte](../../historico/governanca/rastreabilidade.md#s63-032).

## S63-033

- migrations `075`, `076` e `077`;
- as três migrations foram aplicadas ao descartável `BANCO_PROTEGIDO_93B95A0C` por autorização específica (pelo `db:migrate` com `DB_NAME` explícito;
- dados existentes intactos, nenhum usuário criado) e ambiente pronto, AGUARDANDO A VALIDAÇÃO MANUAL;
- fora de `gestao_epi_teste_local` e do descartável NÃO foram aplicadas a nenhum banco;
- aplicá-las a qualquer outro banco persistente exige autorização separada):

[Proveniência e custódia da fonte](../../historico/governanca/rastreabilidade.md#s63-033).

## S63-034

- **Domínio:** usuário administrativo ≠ funcionário operacional (`funcionarios` continua só de quem recebe EPI;
- `usuarios.funcionario_id` da 073 não entra aqui). `identidades.cpf` (075: CHAR(11) canônico, CHECK de formato, índice único parcial `uq_identidades_cpf` — único no SISTEMA inteiro —, nulo nas identidades anteriores, SEM backfill, e gatilho `trg_identidades_cpf_imutavel`: definido, nunca é trocado nem removido, nem por MASTER, nem por UPDATE direto;
- nenhuma rota aceita `cpf` em alteração — `PATCH /administracao/usuarios/:id` e `PATCH /auth/global/conta` o recusam como campo extra). `usuarios.matricula` (VARCHAR(30), aparada, única por empresa por `uq_usuarios_empresa_matricula`), `usuarios.setor` (VARCHAR(100)), `horario_trabalho_inicio/fim` (TIME, os dois ou nenhum;
- turno noturno aceito) — 076. `usuario_ips_permitidos` (077: INET de host, CHECK de máscara 32/128, UNIQUE por empresa+usuário+ip, FK composta `(empresa_id, usuario_id) → usuarios(empresa_id, id)`): sem linha = qualquer endereço;
- com linha = só os cadastrados.
- **Contrato:** `POST /api/administracao/usuarios` estendido (nenhum endpoint concorrente): `{ nome, email, tipoConta, senhaProvisoria, cpf*, matricula*, setor*, horarioTrabalho?, ipsPermitidos?, grupoAcessoId? }`, estrito (confirmação da senha, empresa, perfil, permissões, `funcionarioId` → 400). `cpf` = `cpfComDigitosVerificadores`;
- `horarioTrabalho` = `{ inicio, fim }` HH:MM (`HORARIO_INVALIDO`);
- `ipsPermitidos` até 20, cada um por `utils/ip.normalizarIp` (`IP_INVALIDO`);
- `grupoAcessoId` = `idCorpo`.
- Serviço `usuario-administracao.service.criar`, UMA transação sob a trava da empresa, nesta ordem: autoridade → perfil gerenciável → MASTER com grupo (409 `USUARIO_MASTER_SEM_GRUPO`, o mesmo código do vínculo) → política de senha → e-mail (409 `IDENTIDADE_EMAIL_JA_EXISTENTE` / `USUARIO_VINCULO_EXISTENTE`) → CPF (409 `IDENTIDADE_CPF_JA_EXISTENTE`) → matrícula (409 `USUARIO_MATRICULA_JA_EXISTENTE`) → grupo (`grupoAcessoRepo.buscarPorId` da empresa da sessão: 404 `GRUPO_NAO_ENCONTRADO` para inexistente OU de outra empresa, 409 `GRUPO_INATIVO`) → hash → `identidadeRepo.criar` com `cpf` (23505 traduzido pela constraint: CPF ou e-mail) → `usuarioRepo.criar` com matrícula, setor, horário e grupo (23505 `uq_usuarios_empresa_matricula` → 409) → `usuarioIpRepo.inserir` (dedup) → auditoria `USUARIO_CRIADO` com `temCpf`, `matricula`, `setor`, `horarioTrabalho` booleano, `grupoAcessoId`, `ipsPermitidos` (contagem) — NUNCA o CPF, os IPs ou a senha.
- Falha em qualquer passo = ROLLBACK, sem auditoria.
- Resposta 201: `usuario` (projeção da listagem, sem CPF), `senhaProvisoriaExpiraEm`, `administrativo` (`cpfMascarado` `***.***.***-XX`, matrícula, setor, horário, IPs gravados, grupo).
- A listagem `GET` e o detalhe (`usuario-administracao.repository`, mesma PROJECAO) projetam `cpfMascarado` (via `mascararCpf`;
- o CPF em claro não sai do mapeamento), `matricula`, `setor`, `horarioTrabalho` (`{inicio, fim}` HH:MM ou null) e `acessoQualquerIp` (NOT EXISTS na 077);
- a lista de IPs nunca sai pela listagem (futuro Alterar Usuário).
- **Grupo é OPCIONAL para os quatro perfis** (decisão ;
- teste prova cada um nascendo sem grupo);
- a recusa de grupo PARA MASTER (409 `USUARIO_MASTER_SEM_GRUPO`) não é obrigação, é a proibição da 3L (`grupo-usuario.service.js`: o middleware não consulta grupo para MASTER, o vínculo seria sem efeito e enganoso), **mantida por decisão **: a autoridade do MASTER é própria e máxima, ele não usa grupo, nenhum grupo automático para MASTER, a 3L não muda.
- Painel Privado inalterado: o primeiro MASTER nasce automaticamente no aceite do convite (`convite-master.service`, perfil fixo `MASTER`, sem seletor de perfil nem de grupo;
- schemas do Painel não têm `perfil` nem `grupo`).
- **Formulário:** `formulario.grupoSeAplica(tipoConta)` (falso só para `MASTER`, o tipo escolhido no formulário para quem está sendo criado — NUNCA o perfil de quem age, e nunca autorização: o servidor continua a autoridade) e `formulario.ajustarGrupo(document)` (chamado no `change` do select de tipo de conta): com Master, o select Grupo fica vazio, desabilitado e a primeira opção vira "Não se aplica" (`TEXTOS.GRUPO_NAO_SE_APLICA`) dentro do próprio campo, sem banner, aviso ou elemento extra (só a regra `.gu .in:disabled`, opacidade);
- trocar o perfil limpa o grupo, e voltar a ADMINISTRADOR/SUPERVISOR/USUARIO reabre o campo vazio ("Sem grupo"), opcional;
- `corpo` e `validar` ignoram o grupo quando o tipo é Master (a tela nunca envia grupo com Master).
- **Restrição por IP (servidor):** `sessao.repository.buscarValidaPorHash` devolve `restricaoIp` (EXISTS na 077, fora de `usuario`);
- `criarExigirSessao` compara `ipDaRequisicao(req)` (= `req.ip` sob `TRUST_PROXY_HOPS`, normalizado;
- nunca cabeçalho lido pela aplicação) com `usuarioIpRepo.acessoPermitido` ANTES de `registrarUso` e ANTES do gate da senha provisória → 403 `ACESSO_IP_NAO_PERMITIDO`, sem renovar nem revogar (de endereço permitido a sessão segue). `contexto-empresarial.service.selecionar` faz a mesma conferência depois do vínculo (a seleção automática do login falha com 403 e a sessão global é compensada;
- com duas empresas, só a restrita recusa).
- A sessão GLOBAL não é restrita: a lista é do vínculo na empresa.
- Horário de trabalho NÃO entra em middleware nenhum (teste prova). `TRUST_PROXY_HOPS` errado anula ou bloqueia a restrição (`.env.example`).
- Frontend: `sessao-empresarial.js` mostra `MENSAGENS.IP_NAO_PERMITIDO` (motivo `FALHA` + `mensagem`) e `portal-cliente.js` tem texto próprio para o código.
- **Tela:** `render.modalNovoUsuario(doc, { grupos, perfis })` (nós e texto;
- classes `g-user1`/`g-user2`/`g-est` do HTML aprovado;
- ids `nu-<campo>`;
- `data-campo`): Nome completo\*, CPF\* (máscara por `formulario.mascaraCpf`), E-mail\*, Perfil / Tipo de conta\* (só `perfisGerenciaveis` da listagem real, que `carregarTodos` passou a devolver), Senha provisória\*, Confirmar senha provisória\* (só na tela), IP(s) permitido(s), Grupo de acesso (ativos reais por `EpiGrupos.acoes.listar({ ativo: true })` — `js/grupos-acesso.js` carregado pela página, fonte única do caminho), Setor\*, Matrícula\*, Horário de/até;
- sem Status, dois fatores, caixas de perfil, Permissões ou Empresa(s) (decisão: não reorganizar o modal além disso). `formulario.validar` (regras do servidor), `formulario.corpo` (contrato exato;
- CPF só dígitos;
- nunca a confirmação), `formulario.erroDoServidor` (400 por `body.<campo>`, 409/404/403 por código → `POR_CODIGO`/`ERROS`, nunca o texto do servidor), `EpiUsuarios.acoes.criar`.
- Sucesso: `f.reset()`, fecha e descarta o modal, toast `TEXTOS.NOVO_USUARIO_SUCESSO` ("Usuário criado com sucesso.
- Informe ao usuário o e-mail e a senha provisória pelos meios internos da empresa."), recarrega a listagem real.
- Nada em `localStorage`/`sessionStorage`;
- nenhuma decisão pelo nome do perfil (MASTER sem grupo é recusa do servidor mostrada no campo).
- **Suítes com lista fixa de migrations** que passam pela sessão empresarial ou global precisam de `'075', '076', '077'` (feito nas 30 existentes);
- contagens do manifesto: 78 migrations, `000` a `077`. `test/helpers/cpf-ficticio.js` gera CPFs válidos para fixtures.
- Fora do escopo desta subetapa (as funções da linha foram feitas depois, bloco seguinte): MFA.

**R05:** contagens deste marco são históricas; inventário atual exige fonte da versão, sem presumir vigência.

[Proveniência e custódia da fonte](../../historico/governanca/rastreabilidade.md#s63-034).

## S63-035

- Novo → Usuário validado e CONGELADO;
- o descartável `BANCO_PROTEGIDO_93B95A0C` segue na `077` e o backend dele precisa ser reiniciado para carregar o código novo;

[Proveniência e custódia da fonte](../../historico/governanca/rastreabilidade.md#s63-035).

## S63-036

- **A — Desabilitar/Reativar:** `POST /administracao/usuarios/:id/inativar|reativar` (já existiam: ativo=false, gatilho da 038 revoga as sessões do vínculo, último MASTER protegido, auditoria `USUARIO_INATIVADO/REATIVADO`).
- Novo: login com credenciais certas e nenhuma empresa utilizável com vínculo desabilitado responde 401 `USUARIO_DESATIVADO` "Usuário desativado.
- Procure o administrador da empresa." (`usuarioRepo.contarVinculosInativosDaIdentidade`;
- só DEPOIS de a senha conferir, a sessão global nasce e é compensada;
- senha errada continua genérica).
- Tela: "Desabilitar usuário" pede confirmação ("Desabilitar acesso de [Nome]?"), "Reativar usuário" age direto;
- ambos recarregam a listagem real.
- Nada é apagado.
- **B — Novo → Grupo:** modal na própria página sobre `POST /grupos-acesso` (infraestrutura da 3M: MASTER, unicidade por empresa `GRUPO_NOME_EM_USO`, auditoria);
- campos Nome* e Descrição;
- o grupo nasce sem integrantes e SEM permissão (nenhuma pelo nome);
- aparece no seletor do Novo Usuário (a lista é relida ao abrir).
- Grupo não é setor.
- **C — Alterar usuário:** o MESMO modal em modo edição (`render.modalNovoUsuario` com `modo`);
- `GET /administracao/usuarios/:id/edicao` (autoridade de escrita + perfil gerenciável;
- CPF COMPLETO canônico só aqui, auditado `USUARIO_DADOS_CONSULTADOS` sem o CPF;
- a listagem segue mascarada) e `PATCH /administracao/usuarios/:id` estendido: nome, e-mail, tipoConta, matrícula, setor, horarioTrabalho (null limpa), ipsPermitidos (substitui;
- [] limpa;
- valem na hora), grupoAcessoId (null retira). `cpf` e senha NUNCA entram (strictObject).
- Regras: matrícula única (409), grupo existente/ativo/da empresa, MASTER com grupo 409 e virar MASTER limpa o grupo, último MASTER protegido, ADMINISTRADOR não promove MASTER, e-mail só se a identidade tem UM vínculo (senão 409 `EMAIL_IDENTIDADE_COMPARTILHADA`: a identidade é global), e-mail em uso 409, troca de e-mail preserva a senha, cancela redefinições e revoga as sessões do afetado (`USUARIO_EMAIL_ALTERADO` sem o e-mail), o ator não se tranca fora (409 `IP_TRANCARIA_O_PROPRIO_ATOR`).
- Auditoria `USUARIO_DADOS_ALTERADOS` (antes/depois sem CPF e sem IPs: só contagens).
- **D — Duplicar usuário:** modo `duplicar` do mesmo modal: dados pessoais vazios;
- só perfil (se o ator o cria) e grupo (achado pelo nome entre os ativos) vêm do modelo;
- nota discreta "Usando [Nome] como modelo de acesso". `POST /administracao/usuarios` aceita `usuarioModeloId` (da empresa;
- senão 404 `USUARIO_MODELO_NAO_ENCONTRADO`): na MESMA transação, `copia-acesso.service.copiarAcessoIndividual` copia as camadas individuais (exceções de recurso, bloqueios e concessões diretas) SÓ quando o ator é MASTER e o destino não é MASTER;
- senão informa (`copiaDeAcesso.motivo` `SOMENTE_MASTER`/`DESTINO_MASTER`).
- Falha = rollback total.
- **E — Alterar senha (SUPERA a regra antiga de reset administrativo fora do escopo):** `POST /administracao/usuarios/:id/senha-provisoria` `{ senhaProvisoria }`: NUNCA senha definitiva;
- reutiliza o ciclo da `074` (Argon2id, 48 h/72 h, troca obrigatória), revoga todas as sessões, cancela pedidos de redefinição, sem e-mail;
- auditoria `REDEFINICAO_ADMINISTRATIVA_SENHA` (ator, alvo, empresa, validade;
- nunca senha/hash).
- Recusa: a própria conta (409 `USUARIO_SENHA_PROPRIA`, vai às Configurações) e identidade com vínculo em outra empresa (409 `SENHA_IDENTIDADE_COMPARTILHADA`: senha é global).
- Autoridade `GERENCIAR_USUARIOS` e perfil gerenciável (D3).
- **F — Configurar permissões:** `GET /administracao/usuarios/:id/permissoes` devolve o catálogo REAL em camadas: recursos/operações com efeito (`rbac/recursos.js` `RECURSOS_COM_EFEITO` + `ROTULOS_RECURSOS`, do backend) e todas as linhas de `acoes`;
- por célula: `perfil`, `grupo`, `individual`, `efetivo` (= `autorizacao.avaliarPermissaoRecurso/Acao`, as funções do middleware, perguntadas para o alvo) e `origem` (por `opiniaoIndividual/opiniaoDoGrupo`, agora exportadas);
- ações trazem `estado` (PADRAO/CONCEDIDA/BLOQUEADA), `estadosPermitidos`, `motivoNegado`, `regras` (SST, AUTODECISAO_PROIBIDA).
- Escrita (SÓ MASTER ativo, nunca no MASTER, que é fixo): `PATCH .../permissoes/recursos/:recurso` (tri-state por operação, só operações com efeito;
- tudo null apaga a linha de `usuario_permissoes_recurso`) e `PUT .../permissoes/acoes/:codigo` `{ estado }` (CONCEDIDA = `concederDireta` da 3I, só ação ativa em modo ALTERNATIVA/OBRIGATORIA;
- BLOQUEADA = `usuario_bloqueios` e retira a concessão direta;
- transacional);
- novo `permissao-individual.repository.js` e `permissao-usuario.service.js`;
- auditoria `USUARIO_PERMISSAO_RECURSO_ALTERADA/ACAO_ALTERADA`.
- ADMINISTRADOR autorizado CONSULTA (SUPERVISOR/USUARIO) mas não altera (sem escalada);
- a delegação (3I) e o vínculo SST não mudam.
- Tela: `js/permissoes-usuario.js` monta tudo do que a API devolve (nenhuma lista de páginas/ações no navegador;
- teste prova), controles com efeito real (Herdar/Permitir/Negar;
- Padrão/Concedida/Bloqueada), fixos como "Fixo", linha recalculada com a resposta.
- O menu e o acesso direto refletem pelo `/auth/permissoes` do alvo na próxima avaliação.
- **G — Copiar permissões:** `POST /administracao/usuarios/:id/permissoes/copiar` `{ origemId }` (destino = :id): numa transação, grupo da origem (se ativo) e, só para ator MASTER, as camadas individuais SUBSTITUEM as do destino;
- perfil e dados pessoais do destino nunca mudam;
- MASTER não é origem nem destino (409 `USUARIO_MASTER_PERMISSOES_FIXAS`);
- outra empresa 404;
- resposta diz o que ficou de fora (`GRUPO_INATIVO`, `SOMENTE_MASTER`);
- auditoria `USUARIO_PERMISSOES_COPIADAS`.
- Tela: origem fixa, destino da lista real, resumo e "Copiar permissões de [Origem] para [Destino]?" antes de confirmar.
- A lista PUT do teste de CORS ganhou `PUT /administracao/usuarios/:id/permissoes/acoes/:codigo`.
- O teste antigo de mass assignment deixou de recusar `email`/`grupoAcessoId` (agora válidos).
- **Correções pós-validação manual:** (1) "Usuário não encontrado" ao Alterar: causa raiz = o backend na porta 3000 (iniciado antes do código das funções) devolvia 404 `ROTA_NAO_ENCONTRADA` para `/edicao` e `/permissoes`, e a tela mostrava QUALQUER 404 como "Usuário não encontrado";
- os IDs estavam certos (`usuarios.id` da listagem no menu, no GET e no PATCH).
- Correção: 404 só vira "não encontrado" com o código do servidor (`USUARIO_NAO_ENCONTRADO`/`USUARIO_ORIGEM_NAO_ENCONTRADO`);
- rota inexistente tem texto próprio (`INDISPONIVEL`);
- teste com `usuarios.id` ≠ `identidade_id` cobre listagem, GET e PATCH. (2) Modais: o overlay é `fixed; inset:0`;
- passa a começar no `left` real de `main.content` (medido ao abrir e no resize: 260px no desktop, 0 no responsivo), sem valor fixo e sem mexer em largura/visual. (3) **MASTER único por empresa (DECISÃO DEFINITIVA, supera a possibilidade anterior de cadastrar MASTER pela tela):** só o Painel Privado cria o MASTER.
- Backend: `POST /administracao/usuarios` e o convite de usuário recusam `tipoConta` MASTER (409 `MASTER_SOMENTE_PELO_PAINEL_PRIVADO`), `PATCH` não promove (mesmo código) nem rebaixa o MASTER (409 `USUARIO_MASTER_PERFIL_FIXO`;
- MASTER→MASTER é no-op), duplicar com modelo MASTER é 409 `USUARIO_MODELO_MASTER`;
- a listagem devolve `perfisCadastraveis` (gerenciáveis sem MASTER) e `perfilFixo` por linha.
- Tela: Novo/Duplicar/Alterar nunca oferecem Master (nem desabilitado);
- editar o Master mostra só "Master", travado, e não envia `tipoConta`;
- o Master não tem "Duplicar usuário".
- Painel Privado intocado.
- O descartável tem dois MASTERs (ids 1 e 3) por dado criado na validação sob a regra antiga: NÃO foi apagado nem migrado.
- **Matriz de toggles NÃO definida:** a regra de autoridade das camadas individuais (só MASTER grava) é a atual e será revista no checklist posterior;
- registrado para a etapa futura: MASTER único, autoridade máxima, sem grupo, acessos estruturais fixos, não configurado por toggles;
- ADMINISTRADOR/SUPERVISOR/USUARIO terão configuração-base e ajustes individuais.
- Token/Totem intocados.
- **Fechamento de permissões:** (A) login de usuário desativado: o backend já devolvia 401 `USUARIO_DESATIVADO` (só após a senha conferir);
- o defeito era `portal/login.js` mapear QUALQUER 401 para "E-mail ou senha inválidos";
- agora `Portal.mensagens.deLogin` usa o código (`USUARIO_DESATIVADO` → "Usuário desativado.
- Procure o administrador da empresa.";
- `SENHA_PROVISORIA_EXPIRADA` → orientação de recuperação;
- demais 401 genéricos;
- senha errada de desativado segue genérica). (B) Catálogo da tela de permissões só com o que tem EFEITO REAL: recursos/operações = exatamente o que as rotas exigem (teste `catalogo-com-efeito` varre `src`), ações = `ACOES_COM_EFEITO` em `rbac/recursos.js` (as 9 aplicadas pelo backend;
- `ALTERAR_CONFIGURACOES`, `IMPORTAR_FUNCIONARIOS` e `REDEFINIR_SENHA` existem na tabela `acoes` mas NÃO têm uso no código e por isso não aparecem nem aceitam configuração — 404);
- testes de efeito real com o middleware de produção (URL direta, `/auth/permissoes` do menu, persistência, SST não contornável). (C) Copiar com efeito real (mesmo acesso efetivo, URL direta e menu, idempotente, terceiro intocado).
- A matriz definitiva por perfil e a autoridade de quem administra os toggles NÃO foram alteradas (comportamento atual: só MASTER grava as camadas individuais).

[Proveniência e custódia da fonte](../../historico/governanca/rastreabilidade.md#s63-036).

## S63-037

- Configurar permissões binário (;
- sem migration;
- AGUARDANDO CHECKLIST DE PERFIS): a tela mostra só interruptores ON/OFF do resultado EFETIVO, sem Herdar/Permitir/Bloquear nem tabela técnica.
- Catálogo em `backend/src/rbac/toggles.js`: `TOGGLES` (só os com enforcement real: dashboard, histórico de funcionários, ficha de EPI, Gestão de GHE somente consulta, análise de estoque, operações de estoque, cadastrar produto, Gestão de Usuários = ação `GERENCIAR_USUARIOS`) e `PENDENCIAS` (os outros 11 dos 19 aprovados, com motivo;
- nenhum toggle decorativo).
- API: `GET /administracao/usuarios/:id/acessos` e `PUT .../acessos/:toggle` `{ ligado }` (só MASTER grava;
- MASTER é fixo;
- auditoria `USUARIO_ACESSO_ALTERADO` só do que mudou).
- O serviço volta a camada individual ao padrão e só grava concessão ou bloqueio individual se o efeito real ainda diferir do pedido, então não sobra exceção redundante.
- **BASELINE CONGELADA (validação manual aprovada no descartável): migration `078` e toggles de Estoque e Importação;
- não reabrir sem regressão real.** Atualização (migration `078`, autorizada só para isso): `MOVIMENTAR_ESTOQUE` foi separada em `ENTRADA_ESTOQUE` (POST entradas) e `BAIXA_ESTOQUE` (POST baixas), ambas ALTERNATIVA;
- a 078 espelha para as duas novas o que já existia de `MOVIMENTAR_ESTOQUE` por perfil, grupo, bloqueio e concessão individual (direta e delegada);
- `MOVIMENTAR_ESTOQUE` continua no catálogo, sem uso nas rotas.
- Cadastrar Produto, Entrada por Lote e Registrar Baixa são três toggles independentes (ligar também garante a leitura de `materials`, desligar mexe só na regra própria) e a página Gestão de Estoque abre com qualquer um dos três (`PAGINAS.materials`, `abrirComQualquer`);
- com os três OFF fica fechada.
- A rota de importação de funcionários exige a ação `IMPORTAR_FUNCIONARIOS` (não mais `employeeHistory.criar`), que entrou no escopo do MASTER e na página de importação.
- A própria 078 (ainda não aplicada a nenhum banco real, complementada com autorização ) também passa `IMPORTAR_FUNCIONARIOS` de NENHUMA para ALTERNATIVA, então o toggle de Importação de Funcionários existe (ON = concessão individual, OFF = bloqueio individual, independente de `employeeHistory.criar`);
- a 078 recusa rodar se houver autorização individual gravada para essa ação, e copia para ENTRADA/BAIXA as concessões de `MOVIMENTAR_ESTOQUE` diretas e delegadas (refazendo a cadeia de `origem_id` com os ids novos).
- O alerta manual de falta de estoque agora usa `ENTRADA_ESTOQUE`.
- Bancos já migrados precisam da 078 e de `db:provisionar:master` (MASTER recebe `IMPORTAR_FUNCIONARIOS`).
- Pendências restantes: Relatórios, EPIs Entregues, Gestão de Colaboradores, Configurações, Suporte, Gestão de E-mail, LGPD e Token sem rota ou página com enforcement.
- A matriz por perfil NÃO foi definida.
- A página de Gestão de Estoque derivada dos três toggles fica para depois da separação da ação.

**R05:** contagens deste marco são históricas; inventário atual exige fonte da versão, sem presumir vigência.

[Proveniência e custódia da fonte](../../historico/governanca/rastreabilidade.md#s63-037).

## S63-038

- Nota complementar: as contagens deste bloco e as do bloco "Novo → Usuário administrativo" acima ("78 migrations, `000` a `077`";
- `TOGGLES` com 8 itens e `PENDENCIAS` com "os outros 11 dos 19") descrevem o estado .
- Em há 89 migrations (`000`–`089`, sem `088`;
- ver seção 12 e o inventário na seção 63) e `backend/src/rbac/toggles.js` tem **26 toggles em 6 grupos** (`GERAL`, `COLABORADORES`, `EPIS`, `ESTOQUE`, `ATENDIMENTO`, `ADMINISTRACAO`) e **8 pendências** `SEM_ENFORCEMENT` (`relatorios`, `episEntregues`, `gestaoColaboradores`, `configuracoes`, `suporte`, `gestaoEmail`, `privacidadeLgpd`, `tokenMonitoramentoHistorico`).
- Das "pendências restantes" listadas acima, Relatórios ganhou enforcement próprio pelos recursos `reportsAudit` e `reportsFiscal` (blocos 12K-D5 e 12K-D6 nesta seção) e Token ganhou sete toggles (`tokenVisualizar`, `tokenCadastrar`, `tokenEditar`, `tokenRevogar`, `tokenGerarAtivacao`, `tokenRedes`, `tokenPrevia`;
- Atendimento Token, Etapa H).
- Os demais toggles criados entre (SST e aprovar/reprovar, entregas por solicitação com `semBloqueio`, cadastrar/editar funcionário, exportar histórico), as dependências entre toggles, os avisos de `rbac/avisos-acessos.js` e o aviso `DEPENDENCIA_REABILITADA` ficam para o bloco "Toggles e avisos" (Lote 2 da atualização documental).
- A matriz por perfil continua NÃO definida;
- o estudo `[FONTE_PRIVADA]` aguarda revisão do responsável.

**R05:** contagens deste marco são históricas; inventário atual exige fonte da versão, sem presumir vigência.

[Proveniência e custódia da fonte](../../historico/governanca/rastreabilidade.md#s63-038).

## S63-039

- **BASELINE CONGELADA (validação manual final aprovada ): Gestão de Usuários;
- não reabrir sem regressão real.** Gestão de Usuários — fechamento e aposentadoria das seis telas legadas (;
- sem migration): a Gestão de Usuários passou a cobrir também **Grupos** (botão "Grupos": lista de ativos e inativos, Editar nome/descrição por `PATCH /grupos-acesso/:id`, Inativar com confirmação e Reativar pelas rotas existentes, e **Permissões do grupo** como interruptores ON/OFF).
- As permissões do grupo usam `GET /grupos-acesso/:id/acessos` e `PUT /grupos-acesso/:id/acessos/:toggle` `{ ligado }` (`grupo-acessos.service.js`, uma visão binária sobre `grupo_permissoes_*` e o serviço de permissões de grupo existente: autoridade, trava, auditoria `GRUPO_PERMISSAO_*`, isolamento por empresa e a regra de não alterar o próprio grupo são os dele).
- ON = o grupo concede;
- OFF = retira a opinião (`null`, nunca `false`, que bloquearia o que o perfil permite);
- só os acessos de `toggles.js` que o grupo consegue conceder (ação em modo ALTERNATIVA;
- Gestão de Usuários, OBRIGATORIA, não entra);
- ligar também concede a leitura de que o acesso depende.
- Integrantes: vincular, trocar e desvincular continuam por Alterar usuário › Grupo.
- Autorizações individuais: Configurar permissões ON/OFF;
- a interface de delegação foi APOSENTADA (dados, histórico e backend de autorizações ficam).
- Convite de usuário interno: APOSENTADO na interface (o convite do primeiro MASTER é do Painel Privado e não foi tocado;
- o backend `/administracao/convites-usuario` e a página pública `portal/aceitar-convite.html` ficam para convites já enviados).
- Desbloquear (placeholder sem contrato) foi removido da tela e segue como pendência separada (cooldown automático, Reativar e Alterar senha existem).
- As seis páginas (`grupos-acesso`, `grupo-permissoes`, `grupo-usuarios`, `autorizacoes-individuais`, `new-user`, `user-admin`) viraram páginas de REDIRECIONAMENTO (só o tema, nenhum módulo, nenhuma API, nenhum controle;
- `meta refresh` + `location.replace` para `gestao-usuarios.html`, preservando a query);
- os módulos `js/grupos-acesso.js`, `grupo-permissoes.js`, `grupo-usuarios.js`, `autorizacoes-individuais.js` e `usuarios.js` e seus testes ficam (reutilizados ou preservados).
- Compras / Entradas, Regras Função / Setor e Validade de Estoque seguem só adiados.

[Proveniência e custódia da fonte](../../historico/governanca/rastreabilidade.md#s63-039).

## S63-053

- Vínculo SST: concedido e removido só pelo MASTER ativo da empresa.
- O MASTER administra vínculos, mas não é alvo de um novo vínculo (`VINCULO_SST_NAO_SE_APLICA_AO_MASTER`);
- vínculo legado de MASTER não é removido automaticamente.
- Usuário inativo não recebe vínculo novo, e o vínculo de um inativo pode ser removido.

[Proveniência e custódia da fonte](../../historico/governanca/rastreabilidade.md#s63-053).

## S63-063

- continuação de "Configurar permissões binário" e da nota complementar acima): o catálogo `backend/src/rbac/toggles.js` passou de 8 para **26 toggles**, em `GRUPOS` `GERAL` (`dashboard`, `reportsAudit`, `reportsFiscal`), `COLABORADORES` (`historicoFuncionarios`, `cadastrarFuncionario`, `editarFuncionario`, `importacaoFuncionarios`, `exportarHistoricoFuncionarios`), `EPIS` (`fichaEpi`, `entregasSolicitacao`, `gestaoGhe`), `ESTOQUE` (`analiseEstoque`, `operacoesEstoque`, `cadastrarProduto`, `entradaLote`, `registrarBaixa`), `ATENDIMENTO` (`tokenVisualizar`, `tokenCadastrar`, `tokenEditar`, `tokenRevogar`, `tokenGerarAtivacao`, `tokenRedes`, `tokenPrevia`) e `ADMINISTRACAO` (`gestaoUsuarios`, `aprovarSolicitacoes`, `reprovarSolicitacoes`);
- cada toggle é um recurso + operação ou uma ação com enforcement real, e as 8 `PENDENCIAS` seguem `SEM_ENFORCEMENT` com motivo (`gestaoColaboradores` com texto novo : coberto por Cadastrar/Editar Funcionário;
- `tokenMonitoramentoHistorico`: Etapa J).

**R05:** contagens deste marco são históricas; inventário atual exige fonte da versão, sem presumir vigência.

[Proveniência e custódia da fonte](../../historico/governanca/rastreabilidade.md#s63-063).

## S63-064

- **Dependências:** 9 toggles dependem de uma leitura (cadastrar/editar funcionário → `employeeHistory.visualizar`;
- cadastrar produto, entrada por lote e registrar baixa → `materials.visualizar`;
- `tokenCadastrar`, `tokenEditar`, `tokenRevogar`, `tokenGerarAtivacao` → `atendimentoToken.visualizar`), aplicadas só ao LIGAR (ligar concede também a leitura;
- desligar mexe só na regra própria);
- `rbac/dependencias-acessos.js` dá rótulo e chave da dependência para a auditoria e os avisos.
- Decisão : ligar um dependente reabilita uma leitura bloqueada sem 409 — a auditoria registra `contexto.causa = 'dependencia'` e o PUT devolve o aviso `DEPENDENCIA_REABILITADA` (conferência manual não executada, conforme o termo de congelamento da Etapa H do Token).
- **Flags:** `entregasSolicitacao` (ação `REALIZAR_ENTREGA`;
- `[FONTE_PRIVADA]`, 17:49) tem `semBloqueio`: desligar só retira a concessão individual e nunca cria bloqueio;
- `aprovarSolicitacoes` e `reprovarSolicitacoes` ( 17:28) têm `concessao` e só produzem efeito com o vínculo SST (nota em "Navegação da 12G-5");
- `importacaoFuncionarios` e `exportarHistoricoFuncionarios` não têm dependência.
- **Grupo × individual:** 22 toggles podem ser concedidos por grupo (ON = o grupo concede;
- OFF = `null`, nunca `false`);
- 4 são só individuais (`gestaoUsuarios`, `aprovarSolicitacoes`, `reprovarSolicitacoes`, `tokenRedes`: ações OBRIGATORIA ou de concessão).
- **Avisos (`rbac/avisos-acessos.js`;
- "Correções do MASTER", , `[FONTE_PRIVADA]`):** regra única pelas dependências do catálogo;
- `GET` e `PUT` de `/administracao/usuarios/:id/acessos` e de `/grupos-acesso/:id/acessos` devolvem `{ acesso, avisos }` com os códigos `FUNCIONARIOS_SEM_VISUALIZAR`, `EXPORTAR_HISTORICO_SEM_VISUALIZAR`, `TOKEN_SEM_CONSULTAR` e `PREVIA_SEM_HISTORICO_FUNCIONARIOS`;
- o aviso só informa, nunca revoga (decisão do responsável: não revogar criar/editar ao desligar visualizar);
- no grupo é calculado sobre a CONFIGURAÇÃO do grupo (ligado = o grupo concede) e o texto nunca diz que integrantes perderam acesso.
- MASTER ativo: "Gestão de Usuários" aparece ligado e fixo pela autoridade administrativa de leitura (`temAutoridadeAdministrativaLeitura`, só na leitura), SEM gravar `GERENCIAR_USUARIOS` no perfil;
- Aprovar/Reprovar seguem desligados para ele. `js/permissoes-usuario.js` não conhece recursos nem toggles (monta tudo do que a API devolve);
- `gestao-usuarios.html` ganhou `avisoDependencias`. `RECURSOS_COM_LEITURA_NA_ATRIBUICAO_DIRETA = ['employeeHistory']` (`operacoesGarantidasNaAtribuicaoDireta`).
- **Sem toggle, com efeito real:** `request.*`, `ENCERRAR_SOLICITACAO`, `materials.editar`, `employeeGroups.criar|editar`, `stockValidity.visualizar` e `ADMINISTRAR_GRUPOS_ACESSO|ADMINISTRAR_PERMISSOES_GRUPO|ADMINISTRAR_VINCULOS_GRUPO`.
- **Em banco e sem uso no código:** `MOVIMENTAR_ESTOQUE`, `ALTERAR_CONFIGURACOES`, `REDEFINIR_SENHA`, `TOKEN_VISUALIZAR_MONITORAMENTO`, `TOKEN_VISUALIZAR_HISTORICO`. `ACOES_COM_EFEITO` em `rbac/recursos.js` tem 16 ações: `ENTRADA_ESTOQUE`, `BAIXA_ESTOQUE`, `IMPORTAR_FUNCIONARIOS`, `EXPORTAR_HISTORICO_FUNCIONARIOS`, `REALIZAR_ENTREGA`, `APROVAR_SOLICITACAO`, `REPROVAR_SOLICITACAO`, `ENCERRAR_SOLICITACAO`, `GERENCIAR_USUARIOS`, as três `ADMINISTRAR_*` e `TOKEN_REVOGAR_DISPOSITIVO`, `TOKEN_GERAR_ATIVACAO`, `TOKEN_GERENCIAR_REDES`, `TOKEN_PREVIA_CATALOGO_REAL`.

**R05:** contagens deste marco são históricas; inventário atual exige fonte da versão, sem presumir vigência.

[Proveniência e custódia da fonte](../../historico/governanca/rastreabilidade.md#s63-064).

## S63-067

- migrations `081` e `084`, descritas no inventário acima;

[Proveniência e custódia da fonte](../../historico/governanca/rastreabilidade.md#s63-067).

## S63-068

- **S1 — situação (`084`):** `funcionarios.situacao` `ATIVO | AFASTADO | INATIVO` é a fonte da verdade e `ativo` é gerada;
- `utils/situacao-funcionario.js` concentra as transições permitidas e a elegibilidade a EPI (só ATIVO recebe, pede e é atendido).
- **S2 — `POST /funcionarios/:id/situacao`** (`employeeHistory.editar`): auditoria `FUNCIONARIO_SITUACAO_ALTERADA`;
- o AFASTADO não recebe nem solicita EPI (`FUNCIONARIO_AFASTADO`), mas a decisão da SST sobre um pedido já existente não depende da situação;
- as rotas legadas `inativar`/`reativar` mapeiam para INATIVO/ATIVO.
- **S3 — GHE:** `GET /funcionarios/ghes` (`employeeHistory.visualizar`) devolve os GHEs do formulário;
- `grupoHomogeneo { id, codigo, descricao }` nas respostas;
- a troca de GHE é auditada como `FUNCIONARIO_GHE_ALTERADO`.
- Mudar setor ou função NÃO troca o GHE;
- o GHE é alterado explicitamente, como previa o roadmap da 12K-E.
- **S4 — cadastro e edição individuais:** `POST /funcionarios` (`employeeHistory.criar`) e `PATCH /funcionarios/:id` (`employeeHistory.editar`): CPF imutável;
- `situacao` e `ativo` nunca vêm do cliente;
- setor, função, GHE e data de admissão obrigatórios;
- datas pela data civil de São Paulo com `relogio` injetado no controller;
- `FUNCIONARIO_DATA_NASCIMENTO_INVALIDA`;
- `FUNCIONARIO_GHE_OBRIGATORIO` ao tentar GHE → null.
- Matrícula opcional (`081`);
- na importação em lote (`POST /funcionarios/importacao` e `GET /funcionarios/importacao/ghes`, ambas pela ação `IMPORTAR_FUNCIONARIOS`) a Situação passa a ser obrigatória, "Ativo", e a regra "existente nunca é alterado" da 12G-9 não mudou.
- **RBAC:** toggles `cadastrarFuncionario` (`employeeHistory.criar`) e `editarFuncionario` (`employeeHistory.editar`), dependentes de `visualizar`;
- `null` explícito em `visualizar` com criar/editar verdadeiros → 400 `VALOR_NAO_PERMITIDO`;
- a importação segue com permissão própria. `PAGINAS.funcionarios = { abrir: employeeHistory.visualizar, alterar: employeeHistory.editar }`;
- `PAGINAS.importEmployees` passou a abrir pela ação `IMPORTAR_FUNCIONARIOS`.
- **CPF — `POST /funcionarios/:id/cpf/revelar`** (`employeeHistory.editar`): `Cache-Control: no-store`;
- limite de 10 por minuto por ator e empresa, aplicado DEPOIS da autorização e ANTES da validação (429 com `Retry-After`);
- uma linha de auditoria por revelação (finalidade EDICAO), nunca o CPF;
- auditoria falha ⇒ 500 e nenhum CPF.
- A tela mostra o CPF completo por cerca de 30 s;
- listagens e buscas nunca aceitam nem devolvem CPF.
- **Frontend:** `pages/funcionarios.html` (título "Cadastro de Colaboradores";
- item de menu `data-pagina="funcionarios"` entre Ficha de EPI e Histórico de Funcionários nas páginas integradas e no Início do Portal) e `js/gestao-funcionarios.js` (`EpiGestaoFuncionarios`: listar, cadastrar, editar, trocar GHE, alterar situação — INATIVO não vai direto a AFASTADO —, filtro de situação, paginação, busca local por nome/matrícula/setor/cargo/GHE, moldura e responsividade padrão).
- **Pendência confirmada :** `pages/funcionarios.html` e `js/gestao-funcionarios.js` NÃO estão em `frontend/publicacao/allowlist.json`, contrariando a regra da 12D-3 (correção só com autorização;
- não é alteração documental).
- "fechados e congelados " conforme registro da sessão principal, **sem termo de congelamento na pasta**;
- os nove arquivos protegidos (`AGENTS.md` e oito `… 2.js`) conferidos como preservados (`S4-integridade`, classe A, 9 de 9).

[Proveniência e custódia da fonte](../../historico/governanca/rastreabilidade.md#s63-068).

## S63-069

- migration `083`, descrita no inventário acima;

[Proveniência e custódia da fonte](../../historico/governanca/rastreabilidade.md#s63-069).

## S63-070

- **I0 — baseline:** `lista-congelados-funcionarios.txt` e `lista-congelados-fiscalizacao.txt` definem o que não podia mudar;
- nove arquivos protegidos 9 de 9.
- **I2 — código do GHE:** obrigatório para GHE novo, formato `GHE-` + 3 a 6 dígitos (`utils/codigo-ghe.js`;
- regra do serviço e da interface), único por empresa, editável;
- o GHE legado continua com `codigo` NULL.
- Exceções autorizadas em testes congelados de funcionários (`excecao-congelados/*.diff`, com justificativa: só a infraestrutura de schema das suítes passou a incluir a `083`).
- **I3 — GHE × tipo:** `GET /grupos-homogeneos/:id/tipos-material` (`employeeGroups.visualizar`), `PUT` e `DELETE /grupos-homogeneos/:id/tipos-material/:tipoId` (`employeeGroups.editar`;
- classificação `OBRIGATORIO | NAO_OBRIGATORIO`;
- reutiliza o recurso, sem recurso novo);
- `ghe-tipo-material.{routes,controller,service,repository,schema}.js`.
- O vínculo direto `ghe_materiais` continua como exceção e legado.
- **I4 — "previsto no GHE" híbrido:** `repositories/sql/previsto-ghe.js` é a definição única: vínculo direto OU vínculo por tipo (`ghe_tipos_material` × `materiais.tipo_material_id`);
- os dois contam como previsto;
- os snapshots históricos (`previsto_no_ghe`, `ghe_nome`) não são recalculados.
- Pedido, entrega e o catálogo do Token usam a mesma definição.
- **I5 e I5C — importação GHE/EPI:** `POST /grupos-homogeneos/importacao/preview` (só leitura) e `POST /grupos-homogeneos/importacao/confirmar` (exige `employeeGroups.criar` E `editar`;
- corpo até 512 KiB;
- transação única com trava por empresa;
- revalida;
- idempotente;
- seguro sob concorrência;
- auditoria com origem `IMPORTACAO_GHE_EPI`);
- `ghe-importacao.{routes,controller,service,repository,schema}.js` e `utils/ghe-importacao.js`.
- A importação nunca cria tipo (complemento A1 no bloco "Pedido de EPI × GHEs importados" abaixo).
- **I6A, I6B e I6C — frontend:** `pages/employee-groups.html` mostra Código / Descrição / Situação (Setor, Função e `descricao` saíram da tela), GHE × tipo como gestão principal e os vínculos diretos a materiais como bloco secundário (`js/grupos-homogeneos.js`);
- `js/importacao-ghe.js` lê `.xlsx` no navegador por `vendor/read-excel-file-9.3.10.min.js` (até 1000 linhas, 10 MB) e chama prévia e confirmação;
- `publicacao/allowlist.json` atualizada;
- correção de UX de rolagem (`I6C-ux-scroll`).
- A nomenclatura "Gestão de GHE" não mudou.
- **validação manual e congelamento não documentados na pasta**.

[Proveniência e custódia da fonte](../../historico/governanca/rastreabilidade.md#s63-070).

## S63-071

- migration `085`, descrita no inventário acima;
- evidências em `[FONTE_PRIVADA]`, `J-homologacao` e `Auditoria-pre-git`): `pages/employee-history.html` (a frase "`employee-history.html` intocado" do bloco 12G-9 vale para ) e `js/historico-funcionarios.js`, sem mexer em `js/funcionarios.js` (importação).

[Proveniência e custódia da fonte](../../historico/governanca/rastreabilidade.md#s63-071).

## S63-072

- **A e B — busca única e ficha:** um campo só;
- nome ou matrícula vão por GET (`GET /funcionarios`);
- CPF completo (11 dígitos) vai SÓ no corpo de `POST /funcionarios/consulta-cpf` (Opção A: inválido, incompleto ou com letras é recusado localmente sem requisição;
- sem fallback;
- matrícula numérica de 11 dígitos não é buscável);
- selecionar carrega `GET /funcionarios/:id` (nome, matrícula, setor, cargo, GHE atual, situação);
- CPF e telefone não aparecem.
- Exibição condicional: ficha, indicadores e linhas do tempo ficam ocultos até o detalhe real;
- CPF recusado localmente mantém a ficha aberta.
- **C — EPIs:** `GET /fichas-epi?funcionarioId=` → `GET /fichas-epi/:id/entregas` (exige `epiFicha.visualizar`;
- sem ela, "Sem permissão para ver o histórico de EPIs.");
- corpo 200 inválido = falha;
- ficha de outro funcionário = falha genérica com nova tentativa;
- `previstoNoGhe` e confirmação ficam fora da tela.
- **D — indicadores:** quatro cartões a partir do `resumo` da ficha devolvido pelo servidor (`ficha-epi.repository.js` ampliado;
- "hoje" = dia de São Paulo do banco, `HOJE` exportado de `entrega-epi-historico.repository.js`);
- nunca recalculados no navegador.
- **E, F e G — eventos:** `GET /funcionarios/:id/eventos?tipo=GHE|SITUACAO|CADASTRAL[&de&ate]` (`employeeHistory.visualizar`;
- `funcionario-eventos.{service,repository}.js`), reconstruídos de `logs_auditoria`, sem migration: GHE com dedupe do par `FUNCIONARIO_ALTERADO` + `FUNCIONARIO_GHE_ALTERADO` da mesma transação e `atual` só do GHE gravado pelo id, da empresa da sessão (o legado só tem o id;
- código e descrição nulos);
- SITUACAO de `FUNCIONARIO_SITUACAO_ALTERADA`, `INATIVADO`/`REATIVADO` (legado, com dedupe) e `CRIADO` (chave `ativo`);
- CADASTRAL com um evento por operação e `alteracoes: [{ campo, anterior, novo }]` só quando antes ≠ depois (nome, matrícula, setor, função, data de admissão como texto `YYYY-MM-DD`;
- telefone e nascimento nunca, só "informado";
- crachá não).
- **H — período:** `de`/`ate` pelo dia de São Paulo de `criado_em` (`PERIODO_INVERTIDO`;
- parcial aceito no backend, como nas entregas;
- a tela exige as duas datas), aplicado aos quatro históricos;
- o período persiste na troca de pessoa e "Limpar" o desfaz;
- `GET /fichas-epi` nunca leva período;
- o cartão do período não usa `.filters-grid`.
- **J — permissão de exportar:** ação `EXPORTAR_HISTORICO_FUNCIONARIOS` (`085`), toggle `exportarHistoricoFuncionarios` (COLABORADORES, sem dependência, independente de visualizar), aviso `EXPORTAR_HISTORICO_SEM_VISUALIZAR`, MASTER pelo escopo de provisionamento;
- `services/exportacao-historico-autorizacao.service.js` `avaliar()` → `{ visualizar, exportar, permitido }` (exportar exige os dois).
- **I — exportação:** `POST /funcionarios/:id/historico/exportacao { formato: pdf | xlsx, de?, ate? }` (autorização no serviço, antes de qualquer leitura;
- `PERIODO_INCOMPLETO`, `PERIODO_INVERTIDO`, `DATA_INVALIDA`;
- 403 `EXPORTACAO_NAO_AUTORIZADA`;
- 404 `FUNCIONARIO_NAO_ENCONTRADO`;
- 422 `EXPORTACAO_GRANDE_DEMAIS` acima de 5.000 registros por seção, nunca truncar;
- 429 `EXPORTACAO_LIMITE_EXCEDIDO` com 10 por minuto contados pela auditoria sob advisory lock, válido entre instâncias;
- 500 `EXPORTACAO_FALHOU`);
- `funcionario-historico-exportacao.service.js`, `exportacao-historico/{formatos,formatacao,pdf,xlsx}.js` (modelo neutro de documento;
- `pdfkit` A4 paisagem;
- `write-excel-file` com uma planilha por seção e proteção contra injeção de fórmula), `repositories/exportacao-historico.repository.js`;
- sem `epiFicha.visualizar`, entregas e indicadores saem `null`;
- auditoria `FUNCIONARIO_HISTORICO_EXPORTADO` (formato, período, seções, contagens, bytes, sha256 do arquivo).
- Decisões D1–D8 em `[REFERENCIA_HISTORICA_PRIVADA]`.

[Proveniência e custódia da fonte](../../historico/governanca/rastreabilidade.md#s63-072).

## S63-073

Contexto de execução preservado na fonte, sem obrigação técnica removida.

[Proveniência e custódia da fonte](../../historico/governanca/rastreabilidade.md#s63-073).

## S63-074

- **Causa (diagnóstico aprovado ):** os GHEs criados pela importação GHE/EPI só têm vínculo por TIPO (`ghe_tipos_material`) e os materiais legados não têm `tipo_material_id`, então o Pedido não oferecia nada;
- `previsto-ghe.js` está correto.
- Decisão: NÃO converter os quatro materiais legados do banco de validação. `B1-DIAGNOSTICO` (só leitura em `BANCO_PROTEGIDO_8EA96C0A`): 184 trabalhadores em 32 GHEs com vínculo por tipo e nenhum material ofertável.
- **Plano aprovado:** A1 tipos não encontrados na prévia + cadastrar o tipo pela rota existente → A2 materiais compatíveis por tipo → A3 cadastro de material com tipo pré-selecionado → A5 aviso no Pedido → A6 pedido manual de "Outros" (o backend já aceita fora do GHE;
- falta a tela;
- todo material exige CA, e `exige_ca` sem API é tema da 12H) → A4 legado (baixa prioridade). "Outros" preservado.
- **A1:** `resumo.tiposNaoEncontrados: [{ nome, variantes, linhas, ghes, reservado, nomeExcedeLimite }]` DENTRO de `resumo` (o nível principal tem asserção homologada de chaves);
- a prévia lista os tipos ausentes e a tela (`js/importacao-ghe.js`, `employee-groups.html`) permite cadastrá-los por `POST /tipos-material` (409 `TIPO_MATERIAL_JA_EXISTE`);
- a importação nunca cria tipo;
- três listas de scripts de página ajustadas com `tipos-material.js`.
- `A1-HOMOLOGACAO` preparou planilha fictícia.
- **A3 (renomeada pelo responsável):** estado do catálogo junto ao Tipo (`#materialTipoEstado`, estados E1–E5, só `textContent`) e sugestão de nome só no cadastro novo (`formulario.sugestaoNome`, que não sobrescreve nome digitado);
- D2 óculos e D3 "Outros" sem mudança;
- só `materiais.js` e `materials.html`.
- Complemento "proteções por Grupo" (`protecoesDoCatalogo`;
- D1 catálogo ativo do grupo + Outros;
- D2 falha = lista completa com aviso `#materialProtecaoEstado`), com 8 ajustes de teste autorizados;
- **A2:** situação da classificação do material escolhido em Estoque por lote (`#materialClassificacaoAtual`, abaixo de `#gradeMaterialHelper`, só `textContent`): `CATALOGO | TIPO_INATIVO | TIPO_INDISPONIVEL | OUTROS | LEGADO` (`situacaoClassificacao` S1–S6, `textoClassificacao` T1–T5);
- só `materiais.js` e `materials.html`;

[Proveniência e custódia da fonte](../../historico/governanca/rastreabilidade.md#s63-074).

## Consulta de dependências

Leia [o índice](../README.md), [a governança](../governanca/agentes.md) e
[as reconciliações](../../historico/governanca/reconciliacoes.md). Arquivo congelado
ou exceção exige leitura da fonte pertinente antes de ação que o afete. Campos,
erros e limites não são exemplos opcionais. Aprovação da documentação não autoriza
execução dos procedimentos ou acesso a dados.
