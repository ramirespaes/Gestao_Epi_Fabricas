# Gestão de EPIs

Sistema para gestão de Equipamentos de Proteção Individual (EPIs), com frontend web e backend separados por responsabilidade.

## Estado do projeto

O desenvolvimento é organizado em blocos. Situação em 01/10/2026:

| Bloco | Situação |
|---|---|
| 1 a 7 — migrations de sessões, auditoria e tentativas de login (`013` a `015`), dependências, fundação da autenticação, validação de entrada e segurança HTTP | Concluídos e incorporados à `main` |
| 8 — Autenticação real e RBAC | **Concluído** e incorporado à `main` (PRs #13 a #18). Encerramento formal na seção seguinte |
| Autenticação global, Painel Privado, Portal do Cliente e página institucional (planejamento próprio) | Concluídos e incorporados à `main` (PRs #20 a #23 e #26) |
| 9 — Integração das páginas ao backend real | Etapas A a F incorporadas à `main`: Etapas A e B (backend de materiais, estoque, funcionários e GHE, PR #19), Etapa C, partes C0 a C7 (PRs #24, #25, #27 e #28; as partes C4 e C5 executaram a Etapa D), rodada de segurança S1/S2/S3 (PR #29) e Etapas E e F (estoque por lote, permissões próprias das áreas de estoque e gestão de usuários, PR #32). Ver "Bloco 9, Etapas E e F" |
| Correções de segurança pós-auditoria e Cloudflare Turnstile no login do Portal do Cliente | Incorporados à `main` (PR #33) |
| MFA TOTP do Painel Privado (MFA-1 a MFA-10) | Incorporado à `main` (PRs #34, #35 e #36; merge `427102a`). Ver "Painel Privado e MFA TOTP" |
| Gate de segurança pré-Bloco 10 — CI no GitHub Actions, portabilidade dos testes de migration, logout seguro do Portal e atualização documental | Implementado no PR #37 |
| 10 — Entrega real de EPI, ficha, confirmação e baixa de estoque por lote | **Concluído** nas subetapas 10A a 10J, todas incorporadas à `main` (PRs #38, #39, #40, #41 e #42). Ver "Bloco 10" |
| 11 — Ciclo de vida da senha | **Em andamento.** Subetapas 11A + 11B (PR #44) e 11C + 11D (PR #45) incorporadas à `main`. Subetapas 11E + 11F implementadas e validadas na branch `feature/bloco11-11e-11f`, ainda sem commit, PR nem merge. O Bloco 11 não está concluído: a entrega real de e-mail (11H) continua pendente e o fluxo não está pronto para uso comercial. Ver "Bloco 11" |

### Bloco 10 — Entrega real de EPI, ficha, confirmação e baixa de estoque por lote

Fluxo **direto** de entrega: quem tem a ação `REALIZAR_ENTREGA` localiza o trabalhador, escolhe materiais e lotes, registra a confirmação de recebimento e o estoque baixa por lote na mesma transação. A ficha de EPI é o registro cumulativo do trabalhador, uma por funcionário na empresa, numerada em sequência por empresa; cada entrega guarda cópias dos dados da época (empresa, trabalhador, GHE, responsável e material), e o CPF nunca é copiado — sai mascarado das consultas.

| Subetapa | Conteúdo | Situação |
|---|---|---|
| 10A + 10B | Estrutura persistente: migrations `057` a `060` (fichas, entregas, itens, confirmação e vínculo com o estoque por lote) | `main`, PR #38 |
| 10C + 10D | Serviço transacional de entrega: concorrência e locks, idempotência por chave, baixa de estoque por lote, auditoria e confirmação com hash | `main`, PR #39 |
| 10E + 10F | APIs de entrega e ficha: contexto da entrega (trabalhador, materiais e lotes), consultas, histórico com cópias da época, proteção de dados (CPF só no corpo, nunca na URL) e permissões separadas para consultar e entregar | `main`, PR #40 |
| 10G + 10H | Frontend real da Ficha de EPI (`pages/epi-ficha.html` + `js/epi-ficha.js`): entrega operacional, assinatura desenhada e aceite presencial, retry idempotente, proteção contra confirmação obsoleta e contra resposta assíncrona antiga | `main`, PR #41 |
| 10I + 10J | Integração oficial: página `epiFicha` em `PAGINAS` e `prepararPagina`, menus, Portal, grupos de permissões, provisionamento do MASTER, allowlist e pacote publicado | `main`, PR #42 |

**Permissões da Ficha de EPI.** Duas autoridades independentes: consultar fichas e histórico é o recurso `epiFicha` (operação visualizar); realizar entrega é a ação `REALIZAR_ENTREGA` (modo `ALTERNATIVA`: grupo ou autorização individual). A página abre com qualquer uma das duas e mostra só o que cada uma dá. Desde a 10I, o escopo de provisionamento do MASTER (`backend/src/rbac/recursos.js`) inclui `epiFicha` (visualizar) e as ações `MOVIMENTAR_ESTOQUE` e `REALIZAR_ENTREGA`.

**Provisionamento do MASTER em bancos existentes (observação operacional).** Empresas novas provisionadas depois da 10I recebem o escopo novo automaticamente. Bancos e empresas já existentes só recebem `epiFicha.visualizar` e `REALIZAR_ENTREGA` para o MASTER quando o comando oficial `npm run db:provisionar:master` for executado com autorização específica para cada banco. Esse provisionamento não foi executado em nenhum banco persistente (`gestao_epi_demo`, `gestao_epi_dev`, `gestao_epi_migrado` ou `gestao_epi_revisao_e6_20260927`).

**Limites do Bloco 10 — funcionalidades futuras, não pendências do encerramento:**

- **Solicitação de EPI pelo trabalhador.** Fluxo futuro: o trabalhador solicita o EPI, a **Segurança do Trabalho** aprova (não o supervisor) e só então acontece a entrega. A entrega originada desse fluxo usará `origem = SOLICITACAO`; o Bloco 10 entrega o fluxo direto (`origem = DIRETA`).
- **Impressão e PDF da ficha.** A impressão oficial em duas vias continua futura; o botão "Imprimir" da página permanece desabilitado até lá.

### Bloco 11 — Ciclo de vida da senha (em andamento)

Recuperação de senha por link enviado ao e-mail da conta, no Portal do Cliente e no Painel Privado. O link é de **uso único**, com validade padrão de 60 minutos e **máxima de 4 horas**; depois de usado ou expirado, é necessário solicitar outro; quem não solicitou a redefinição pode ignorar o e-mail. Suporte humano: `suporte@safeworkengenharia.com.br`.

| Subetapa | Conteúdo | Situação |
|---|---|---|
| 11A + 11B | Persistência: migrations `061` a `064` (pedidos de redefinição do Portal e do Painel Privado, contador de solicitações e auditoria da identidade global) e repositories | `main`, PR #44 |
| 11C | Serviços de recuperação: solicitação com resposta única para qualquer desfecho, limite de 3 solicitações por hora por e-mail, redefinição com link de uso único, revogação das sessões da conta e auditoria | `main`, PR #45 |
| 11D | Integração HTTP: rotas públicas de solicitação e redefinição nos dois portais, Turnstile com action própria na solicitação do Portal e limite de requisições por IP separado por operação | `main`, PR #45 |
| 11E | Troca de senha autenticada nos dois portais (`POST /api/auth/global/senha` e `POST /api/plataforma/auth/senha`): senha atual, nova senha (e TOTP no Painel Privado), só a sessão atual continua, as demais são revogadas, pedidos de redefinição pendentes são cancelados e há auditoria e aviso de senha alterada depois do COMMIT | Implementada e validada na branch `feature/bloco11-11e-11f`; sem commit, PR nem merge |
| 11F | Frontend do ciclo de senha: "Esqueci minha senha" nos dois logins, páginas de pedido do link e de redefinição nos dois portais, troca de senha no Portal (`portal/trocar-senha.html`) e no Painel Privado (em "Segurança da conta") | Implementada e validada na branch `feature/bloco11-11e-11f`; sem commit, PR nem merge |
| 11H | Entrega real de e-mail: provedor, remetente `no-reply@safeworkengenharia.com.br` ("SafeWork Engenharia"), recuperação de senha, aviso de senha alterada, convites, template visual oficial e SPF/DKIM/DMARC | Futura, não iniciada |

**O que a 11E + 11F entregam**, implementadas e validadas na branch `feature/bloco11-11e-11f`, ainda sem commit, PR nem merge:

- **Portal do Cliente:** "Esqueci minha senha" no login (sem alterar o login nem o Turnstile dele); solicitação pública de recuperação, com a mesma confirmação para qualquer e-mail; redefinição por link, com o token só no fragmento `#token=`; troca autenticada da senha, com a senha atual, em `portal/trocar-senha.html`. Na troca, só a sessão global atual e a sessão empresarial válida ligada a ela continuam; todos os demais acessos da identidade são revogados, em todas as empresas.
- **Painel Privado:** "Esqueci minha senha" no login; recuperação e redefinição públicas, sem Turnstile; troca autenticada com senha atual e TOTP, em "Segurança da conta" (recovery code não substitui o TOTP). Na troca, só a sessão administrativa atual continua e as demais são revogadas; o fator TOTP, o secret e os recovery codes são preservados.

**O fluxo ainda não está pronto para uso comercial.** O que falta:

- **Commit, PR e merge da 11E + 11F.** Até o merge, a `main` não tem as telas nem a troca autenticada.
- **Entrega real de e-mail (subetapa 11H, futura e não iniciada).** Não há provedor de envio implementado. Fora de `production`, a mensagem é descartada (`EMAIL_MODO=desativado`) ou gravada em arquivo fora do repositório (`EMAIL_MODO=arquivo`, só desenvolvimento e teste). Em `production` nenhum dos dois modos é aceito e **o backend não sobe** até existir um mecanismo real de envio. A entrega acontece depois do COMMIT, sem fila durável nem reenvio. A 11H cobre: provedor real de e-mail; remetente `no-reply@safeworkengenharia.com.br`, com o nome "SafeWork Engenharia"; e-mails de recuperação de senha e de aviso de senha alterada; e-mails de convite de usuário e do primeiro MASTER; avaliação de "Reenviar convite"; template visual oficial de e-mail; SPF, DKIM e DMARC do domínio.
- **Restante do ciclo de vida da senha.** Não existem histórico de senhas, expiração periódica, senha temporária nem troca obrigatória no primeiro acesso.

### Próximos marcos e itens futuros

Itens ainda não concluídos:

- **Bloco 11 (em andamento):** commit, PR e merge da 11E + 11F (troca de senha autenticada e telas do ciclo de senha, hoje implementadas e validadas na branch `feature/bloco11-11e-11f`), entrega real de e-mail (11H) e o restante do ciclo de vida da senha — ver "Bloco 11"; medição da cobertura do frontend com meta mínima de 25%; testes finais e fechamento acadêmico.
- **Homologação e produção na AWS:** deploy, requisitos de publicação do frontend (entre eles a CSP no servidor estático), `TRUST_PROXY_HOPS` conforme a topologia real, chaves reais do Turnstile e do MFA, mecanismo real de entrega de e-mail (sem ele o backend não inicia em `production`) e aplicação autorizada das migrations em cada banco.
- **Hardening futuro de publicação** (junto da CSP e da implantação, Bloco 14): CSP no servidor estático, com `base-uri 'none'`; endurecer o parser do empacotador (`frontend/publicacao/empacotar.js`), que não reconhece formas anômalas de HTML, como `<script/src="...">`, nem inspeciona `<base href>`; e a proteção final no deploy. Até lá, o pacote só vale com a CSP do servidor estático — ver "Publicação do frontend do cliente".
- **Antes da produção:** limpeza e retenção das tabelas de sessões e de tentativas de login.
- **Backlog:** notificações, página "Acesso negado" com "Solicitar acesso" e reorganização de pastas. O envio real de e-mail (convites e redefinição de senha) está na 11H.
- **Melhoria futura opcional:** Cloudflare Turnstile também no login do Painel Privado, a reconsiderar só se logs ou padrões de ataque justificarem.

### Encerramento do Bloco 8

O Bloco 8 foi planejado em 11 incrementos. Todos estão concluídos ou encerrados:

| Incremento | Situação |
|---|---|
| 1 a 4 — repositórios de empresas, usuários, sessões e tentativas de login | Concluídos (PRs #13 e #14) |
| 5 e 6 — serviço de autenticação e rota de login | Concluídos (PRs #15 e #16) |
| 7 — validação de sessão, consulta da sessão atual e logout com revogação | Concluído (PR #17) |
| 8 — RBAC: perfis, grupos de acesso, permissões, autorizações individuais e delegação | Concluído (PR #18) |
| 9 — login do frontend | Absorvido pela autenticação global e pelo Portal do Cliente. O login por CNPJ foi abandonado por decisão posterior: o acesso empresarial usa e-mail, senha e seleção de empresa |
| 10 — remoção da autenticação simulada | Encerrado pela rodada de segurança S1/S2/S3 (PR #29): as páginas legadas, `js/main.js` e `js/db-api.js` ficam fora do pacote publicado, gerado por allowlist explícita e fail-closed (ver "Publicação do frontend do cliente") |
| 11 — validação final e encerramento | Validação técnica feita no fechamento do Incremento 8 (22/09/2026); encerramento documental registrado nesta seção (26/09/2026) |

Os itens abaixo ficaram fora do Bloco 8 e têm destino formal. Não são pendências do encerramento do bloco:

| Item | Destino |
|---|---|
| Cadastro de empresas | Entregue pela autenticação global (Painel Privado, PR #22) |
| Administração de usuários da empresa | Entregue no Bloco 9, parte F: convite, edição de nome e tipo de conta, inativação e reativação |
| Troca de senha | Bloco 11, subetapas 11E + 11F (implementadas e validadas na branch `feature/bloco11-11e-11f`, sem commit, PR nem merge), junto com a recuperação de senha e o restante do ciclo de vida da senha, antes da liberação comercial |
| Recuperação de senha ("Esqueci minha senha") | Bloco 11, separada da autenticação básica já entregue: backend e HTTP na `main` (11C + 11D); telas na 11F (implementadas e validadas na branch, sem commit, PR nem merge); e-mail real na 11H; antes da liberação comercial |
| Integração contínua (GitHub Actions) | Criada no gate de segurança pré-Bloco 10 (PR #37): `.github/workflows/ci.yml`, ver "Integração contínua (GitHub Actions)" |
| Cobertura mínima de 25% no frontend | Bloco 11, com os testes finais, o fechamento acadêmico e a documentação |
| Limpeza e retenção das tabelas de sessões e de tentativas de login | Requisito de hardening do deploy, antes da produção |
| Página "Acesso negado", botão "Solicitar acesso" e notificações de pedidos de acesso | Backlog formal |
| Reorganização de pastas | Backlog formal |

## Estrutura do projeto

Árvore resumida às áreas principais:

```text
gestao-epi/
├── .github/workflows/ci.yml  # CI: testes, checksums e integração com PostgreSQL 16
├── backend/                  # API, banco de dados, migrations e regras de negócio
│   ├── migrations/           # 000 a 064 e o manifesto checksums.json
│   ├── scripts/              # runner de migrations e comandos administrativos (CLI)
│   ├── src/                  # app, config, routes, controllers, services, repositories,
│   │                         # middleware, schemas, security, rbac, db, errors e utils
│   └── test/                 # suíte padrão (*.test.js) e integração (integracao/*.integration.js)
├── frontend/                 # Interface web
│   ├── portal/               # Portal do Cliente: login, seleção de empresa, início, aceite de convite e ciclo de senha
│   ├── painel-privado/       # Painel Privado da plataforma: login com MFA, empresas, segurança da conta e ciclo de senha
│   ├── institucional/        # Página institucional
│   ├── pages/                # Páginas do sistema (integradas ao backend e protótipo)
│   ├── js/                   # Módulos compartilhados (HTTP, sessão, permissões, páginas)
│   ├── css/                  # Estilos
│   ├── publicacao/           # Allowlist e empacotador do pacote publicado do cliente
│   ├── vendor/               # Biblioteca de terceiros versionada (leitura de planilhas)
│   ├── test/                 # Testes do frontend (node:test)
│   ├── IMAGEN/               # Imagens utilizadas na documentação/interface
│   └── index.html            # Redirecionamento do protótipo (só em desenvolvimento)
├── RFC-V1                    # Especificação funcional do sistema
├── RFC-V1.md.docx
├── README.md
├── CLAUDE.md                 # Regras obrigatórias de desenvolvimento do projeto
├── .gitattributes
└── .gitignore
```

## Frontend

O frontend está localizado integralmente em `frontend/`.

A entrada dos clientes é o Portal do Cliente (`frontend/portal/`). O `frontend/index.html` é o redirecionamento do protótipo: serve só em desenvolvimento e não entra no pacote publicado.

A estrutura interna utiliza caminhos relativos entre `index.html`, `pages/`, `css/` e `js/`.

### Frontend legado

Das 22 páginas originais em `frontend/pages/`, 10 já estão ligadas ao backend real: 9 no Bloco 9 (`materials.html`, `available-items.html`, `employee-history.html`, `import-employees.html`, `dashboard.html`, `stock-validity.html`, `operations.html`, `new-user.html` e `user-admin.html`) e `epi-ficha.html` (Ficha de EPI) no Bloco 10; a página `employee-groups.html` (GHE e EPIs) foi criada no próprio Bloco 9. As outras 12 continuam no repositório como protótipo, com `frontend/js/db-api.js` (simulador de API em `localStorage`) e `frontend/js/main.js` (login e RBAC simulados), usando somente dados inequivocamente sintéticos. O teste de publicação as identifica pelo critério objetivo de carregarem script externo (a biblioteca de planilhas por CDN): elas não entram no pacote publicado (ver "Publicação do frontend do cliente") e serão integradas nos blocos seguintes.

### Bloco 10 — Ficha de EPI

`epi-ficha.html` deixou de ser protótipo na 10G e virou funcionalidade oficial na 10I + 10J. A página usa a sessão empresarial do Portal (`js/sessao-empresarial.js`), as permissões efetivas pelo fluxo central `EpiPermissoes.prepararPagina` (página `epiFicha`, que abre com `epiFicha.visualizar` **ou** `REALIZAR_ENTREGA`) e as APIs reais de ficha e entrega, sem `db-api.js`, `main.js` nem biblioteca externa. As regras ficam em `js/epi-ficha.js`, testado sem navegador: busca de fichas e consulta por CPF (só no corpo de um `POST`), histórico com as cópias da época, rascunho da entrega (até 20 itens, lote escolhido explicitamente, justificativas), confirmação por **assinatura desenhada** (traços normalizados) ou **aceite presencial**, chave de idempotência reutilizada só enquanto o conteúdo não muda, "Tentar novamente" com o mesmo corpo e a mesma chave depois de falha de rede, confirmação invalidada por qualquer mudança lógica e descarte de respostas assíncronas antigas ao trocar de trabalhador. O link "Ficha de EPI" aparece nos menus e no Portal conforme a permissão, e a página e o módulo estão em `frontend/publicacao/allowlist.json`, entrando no pacote publicado.

### Frontend administrativo HTTP (Incremento 8)

Quatro páginas novas em `frontend/pages/` consomem a API HTTP real, com autenticação por sessão e cookie `HttpOnly` (nunca `localStorage`):

| Página | Função |
|---|---|
| `grupos-acesso.html` | Cadastro, listagem, edição, inativação e reativação de grupos de acesso |
| `grupo-permissoes.html` | Configuração das permissões de cada grupo, por recurso e por ação |
| `grupo-usuarios.html` | Vinculação e desvinculação de usuários aos grupos |
| `autorizacoes-individuais.html` | Consulta, concessão, delegação e revogação de autorizações individuais |

Seis módulos JavaScript em `frontend/js/` dão suporte a essas páginas: `api-http.js` e `auth-session.js` (fundação HTTP e sessão) mais um módulo por página (`grupos-acesso.js`, `grupo-permissoes.js`, `grupo-usuarios.js`, `autorizacoes-individuais.js`).

**Desde o Bloco 9, Etapa C, Parte C0**, essas quatro páginas não têm mais login próprio (o formulário por CNPJ foi removido) nem carregam `auth-session.js`. A sessão é a do Portal do Cliente, confirmada no servidor pelo módulo comum `js/sessao-empresarial.js` (`GET /api/auth/me`). Sem sessão válida, a pessoa é levada ao Portal. "Sair" encerra as sessões global e empresarial e só leva ao Portal depois que o servidor confirma a saída; "Trocar de empresa" leva à seleção do Portal. O módulo também remove os rastros do protótipo que poderiam se passar por sessão (a chave `epi-session-user` e o parâmetro `?_s=`), sem tocar no banco simulado das páginas ainda não integradas. As páginas continuam sem `db-api.js` e `main.js`.

**Desde a Parte C1**, o menu e os botões dessas páginas (e os módulos listados no início do Portal) refletem as **permissões efetivas** do usuário na empresa selecionada, obtidas de `GET /api/auth/permissoes`. O endpoint é somente leitura e usa empresa e usuário da sessão. Ele não reinterpreta o RBAC: responde com as mesmas funções que autorizam cada operação real (a decisão por recurso e por ação do middleware de autorização, a autoridade administrativa das páginas de acesso e as regras de concessão e delegação). O módulo `js/permissoes-efetivas.js` falha fechado: se a consulta falhar, vier de outra empresa ou fora do formato, nada é exibido nem liberado. Nada é guardado no navegador, e a consulta é refeita a cada carregamento. O backend continua sendo a autoridade final: chamadas diretas proibidas recebem 403.

**Desde a Parte C2**, a página original `materials.html` (Cadastro de Materiais e EPIs) está ligada ao backend real, com a interface preservada: sessão do Portal (C0), permissões efetivas (C1: abrir exige `materials.visualizar`, salvar exige `materials.criar`) e os contratos de materiais e estoque do Bloco 9, Etapa A. O módulo `js/materiais.js` monta o corpo do `POST /api/materiais` a partir do formulário (prazo de uso convertido para dias no cliente, 1 mês = 30 e 1 ano = 365, com o valor exibido antes de salvar; tipo "Outro" usa o campo livre; campos vazios são omitidos e gravados como `NULL`). "Quantidade comprada" não é atributo do material: quando preenchida, gera a **entrada inicial de estoque em lote** (`POST /api/materiais/:id/estoque/entradas`, ação `MOVIMENTAR_ESTOQUE`, com CA e validade do lote, desde a Etapa E), só depois do cadastro e só se o perfil tiver a ação; recusa da entrada não desfaz o cadastro e é informada explicitamente. O quadro de estoque mostra o saldo real do material escolhido, lote a lote (físico, bloqueado e disponível). O anexo do documento do CA continua visível e desabilitado ("em desenvolvimento"). Os campos Categoria, Código interno e Descrição passaram a existir no banco pela migration `039` (código interno único por empresa, ignorando maiúsculas). A página usa `js/pagina-base.js` (menu móvel e aviso, copiados de `main.js`) e não carrega `db-api.js`, `main.js` nem a biblioteca de planilhas; o menu lateral mantém a estrutura visual, mas os itens ainda não integrados ficam sem link, com a etiqueta "Em integração".

### Bloco 9, Etapas E e F

Desde a Etapa E o estoque é controlado **por lote** (migrations `042` a `045`): cada entrada cria um lote com CA, validade e tamanho quando o material exige (`POST /api/materiais/:id/estoque/entradas`), a baixa é feita no lote (`POST /api/estoque/lotes/:id/baixas`) e toda operação fica registrada em `estoque_operacoes`, sem edição nem exclusão. O saldo anterior à Etapa E virou saldo inicial por lote. A rota antiga `POST /api/materiais/:id/estoque/movimentar`, usada pela Parte C2, foi removida na E10, e o CA saiu do cadastro mestre do material. As páginas Validade de estoque (`stock-validity.html`, recurso `stockValidity`) e Operações de estoque (`operations.html`, recurso `operations`) têm permissão própria, provisionada para o MASTER pelo script `npm run db:provisionar:master`. O menu segue a mesma organização em todas as páginas, e as páginas integradas acompanham o tema claro ou escuro do sistema operacional (`js/tema.js`).

A parte F tornou reais as páginas de usuários da empresa:

- **Novo Usuário** (`new-user.html`): o cadastro é um **convite** (migration `046`). Quem administra informa nome, e-mail e tipo de conta; a pessoa aceita por um link com token opaco (só o SHA-256 fica no banco), de uso único, com prazo e cooldown contra tentativas de senha. Se o e-mail já tiver conta no SafeWork, a identidade global é reaproveitada e só nasce o vínculo com esta empresa. Enquanto não houver envio de e-mail, o link volta para quem convidou, fora de produção.
- **Administração de Usuários** (`user-admin.html`): lista paginada da empresa da sessão, edição de nome e tipo de conta, inativação lógica (as sessões daquele vínculo nesta empresa são revogadas; as outras empresas da mesma pessoa não mudam) e reativação do mesmo vínculo. O e-mail não é editado aqui, porque é a identidade global da pessoa. O grupo continua em Integrantes do Grupo.
- **Autoridade**: MASTER ativo, ou ADMINISTRADOR com autorização individual `GERENCIAR_USUARIOS` (migration `047`, modo `OBRIGATORIA`). Só o MASTER gerencia contas MASTER e ADMINISTRADOR; o ADMINISTRADOR autorizado gerencia SUPERVISOR e USUARIO. A empresa nunca fica sem MASTER ativo: inativar ou rebaixar o último é recusado no servidor, também sob concorrência.

### Portal do Cliente (Autenticação Global — Pacote 4)

`frontend/portal/` é a entrada dos clientes: login por **e-mail, senha e verificação Cloudflare Turnstile** (identidade global, sem TOTP), seleção de empresa e ambiente inicial autenticado. Usa o backend real, sessões no PostgreSQL e cookies `HttpOnly`; nada de sessão é guardado no navegador.

| Página | Função |
|---|---|
| `portal/index.html` | Login (e-mail, senha, verificação Turnstile, Entrar) e o link "Esqueci minha senha" |
| `portal/empresas.html` | "Selecione sua empresa" (e troca de empresa); mensagem própria quando não há empresa ativa vinculada |
| `portal/inicio.html` | Usuário, perfil e empresa ativa; **TROCAR DE EMPRESA**, **Sair da empresa**, **Sair** e o link **Trocar senha**; módulos já integrados e módulos em integração |
| `portal/recuperar-senha.html` (11F) | "Esqueci minha senha": pede o link de redefinição, com o Turnstile (action própria) e a mesma confirmação para qualquer e-mail |
| `portal/redefinir-senha.html` (11F) | Redefinição pelo link: o token chega no fragmento (`#token=`) e sai da barra de endereço antes de qualquer rede |
| `portal/trocar-senha.html` (11F) | Troca de senha com a sessão global em uso; a sessão atual continua depois da troca |

Fluxo: uma empresa autorizada → entra direto; duas ou mais → escolhe; nenhuma → sem acesso operacional. O Portal usa dois cookies: `gepi_sessao_global` (identidade; não dá acesso operacional) e `gepi_sessao` (empresa selecionada; o mesmo que o RBAC sempre usou). Os cookies do Painel Privado são outros (ver "Origens, namespaces e cookies"). O login legado por CNPJ recusa vínculos ligados a uma identidade global — há uma única credencial válida por pessoa.

**Turnstile.** O widget da Cloudflare é carregado só no login do Portal. A página obtém a site key e a action em `GET /api/auth/global/turnstile`, e `POST /api/auth/global/login` só chega à verificação de senha com um token válido, conferido no Siteverify com action e hostname esperados. Em `production`, as duas chaves reais (`TURNSTILE_PORTAL_SITE_KEY` e `TURNSTILE_PORTAL_SECRET_KEY`) são obrigatórias e chaves de teste são recusadas; fora de `production`, sem chaves configuradas, valem as chaves oficiais de teste da Cloudflare.

**Sair.** "Sair" (`POST /api/auth/global/logout`) e "Sair da empresa" (`POST /api/auth/logout`) só são dados como concluídos com resposta 2xx do servidor, que é quem revoga a sessão e remove o cookie `HttpOnly`. Sem essa confirmação (falha de rede, 403, 429, 5xx ou resposta inválida), a página não navega nem finge que a sessão acabou: mantém o conteúdo, avisa que a saída não foi confirmada e que a sessão pode continuar ativa, e reabilita o botão para nova tentativa. Enquanto o pedido está pendente, os botões de saída ficam desabilitados. Página restaurada pelo histórico do navegador revalida a sessão no servidor antes de mostrar qualquer dado.

Módulos de `frontend/pages/` ainda baseados em `localStorage` não são apresentados como dados da empresa; a integração das páginas restantes continua nos blocos seguintes.

`portal/aceitar-convite.html` é a página pública de aceite do convite de usuário (parte F): o token chega no fragmento do link (`#token=`), nunca vai ao servidor na URL e sai da barra de endereço assim que é lido. Conta nova define a senha; conta já existente confirma a senha atual. O aceite não faz login: depois, a pessoa entra pelo `portal/index.html`.

Em desenvolvimento, sirva `frontend/` em `http://localhost:5500` (Portal: `/portal/`) e em `http://localhost:5501` (Painel Privado: `/painel-privado/`), com o backend em `http://localhost:3000` — cada portal só é aceito pela allowlist de CORS/Origin do seu próprio namespace.

### Painel Privado e MFA TOTP

`frontend/painel-privado/` é o ambiente dos administradores da plataforma: cadastro de empresas, convite do primeiro MASTER de cada empresa e segurança da própria conta. Usa a API `/api/plataforma`, uma cadeia separada da API do cliente, com CORS, verificação de origem, validação de Host e rate limit próprios.

Na subetapa 11F, o login ganha "Esqueci minha senha", com `recuperar-senha.html` e `redefinir-senha.html` (sem Turnstile; o token do link chega no fragmento `#token=`), e "Segurança da conta" ganha a troca de senha (11E), que pede a senha atual e o TOTP, mantém a sessão atual e revoga as demais, sem tocar no fator TOTP nem nos recovery codes.

O acesso exige **senha e MFA TOTP**. A senha correta não cria sessão: cria um **desafio pré-MFA** (cookie `gepi_mfa_admin`), aceito apenas pelas rotas `/api/plataforma/auth/mfa/*`. A **sessão administrativa plena** (cookie `gepi_sessao_admin`, com token novo) só nasce quando o segundo fator é concluído:

| Situação do administrador | Etapa depois da senha |
|---|---|
| TOTP ativo | Código de 6 dígitos do autenticador ou, na falta dele, um recovery code |
| Sem TOTP ativo (primeiro acesso ou depois de um reset) | Código de liberação de uso único, emitido por CLI, e cadastro do autenticador |
| Entrou com recovery code | Recadastro obrigatório de um autenticador novo |

- **TOTP:** RFC 6238 (SHA-1, 6 dígitos, período de 30 s, tolerância de ±1 período), pela biblioteca `otpauth`. Anti-replay: um código só é aceito se o seu período for posterior ao do último aceito.
- **Segredo TOTP:** cifrado em repouso com AES-256-GCM, com chave versionada (`MFA_TOTP_KEY_V<n>` e `MFA_TOTP_KEY_CURRENT_VERSION`). Sem as chaves, o backend não sobe.
- **Recovery codes:** 10 por lote, exibidos uma única vez; no banco fica só o hash. Gerar um lote novo revoga o anterior.
- **Troca do autenticador, novos recovery codes e troca de senha:** exigem sessão plena e reautenticação com senha e código TOTP (recovery code não vale). As duas primeiras encerram todas as sessões; a troca de senha mantém a sessão atual e revoga as demais.
- **Operação por CLI**, sem rota HTTP: `npm run db:criar-administrador-plataforma` (cria o administrador), `npm run db:mfa:liberar-cadastro` (emite a liberação do primeiro cadastro) e `npm run db:mfa:redefinir` (reset operacional: revoga fatores, recovery codes, desafios e sessões e emite uma liberação nova). Todos exigem `--email <email> --confirmo`.
- **Banco:** a migration `055` faz o PostgreSQL recusar, no COMMIT, sessão administrativa não revogada sem MFA comprovado; a `056` encerra desafios abertos, fatores pendentes e liberações abertas quando o administrador é inativado.

"Sair" do Painel Privado segue a mesma regra do Portal: só a resposta 2xx do servidor conclui a saída.

O Painel Privado não usa Cloudflare Turnstile. Isso é melhoria futura opcional, não requisito atual.

### Origens, namespaces e cookies

| Área | Desenvolvimento | Previsto em produção | API |
|---|---|---|---|
| Página institucional | servida junto com `frontend/` | `www.safeworkengenharia.com.br` | — |
| Portal do Cliente | `http://localhost:5500/portal/` | `app.safeworkengenharia.com.br` | `/api` (em desenvolvimento, `http://localhost:3000/api`) |
| Painel Privado | `http://localhost:5501/painel-privado/` | `admin.safeworkengenharia.com.br` | `/api/plataforma` (em desenvolvimento, `http://localhost:3000/api/plataforma`) |

Cada namespace só aceita as origens da sua própria allowlist (`CORS_ORIGIN` para o cliente, `PLATAFORMA_CORS_ORIGIN` para o Painel Privado), sem curinga e com `https` obrigatório em produção. Os subdomínios de produção ainda não estão publicados.

Cookies de sessão, todos `HttpOnly`, com `Secure` obrigatório em produção. Os nomes abaixo são os padrões, configuráveis em `backend/.env`, e a configuração recusa nomes repetidos entre eles:

| Cookie | Uso |
|---|---|
| `gepi_sessao_global` | Identidade global do Portal do Cliente; sozinho não dá acesso operacional |
| `gepi_sessao` | Empresa selecionada no Portal; é o cookie que o RBAC usa |
| `gepi_mfa_admin` | Desafio pré-MFA do Painel Privado; não é sessão |
| `gepi_sessao_admin` | Sessão administrativa plena do Painel Privado, criada só depois do MFA |

O navegador recebe apenas um token opaco; o banco guarda somente o SHA-256 dele.

### Conexão futura da página institucional

`frontend/institucional/` já prevê os dois botões de acesso (`linkEmpresas`, `linkAdmin`), alimentados pelo objeto `PORTAIS` do próprio arquivo. Em ambiente local (`localhost`, `127.0.0.1` ou `[::1]`), os botões apontam para o Portal (porta 5500) e o Painel Privado (porta 5501). Em qualquer outro host valem só os destinos de `PORTAIS_PRODUCAO`, hoje vazios: a página mostra um aviso em vez de navegar. Quando os subdomínios estiverem publicados (não estão hoje), a conexão será apenas preencher `PORTAIS_PRODUCAO`, com autorização específica para alterar aquela página:

| Botão | Valor de `PORTAIS_PRODUCAO` | Destino previsto |
|---|---|---|
| Acesso Empresas | `empresas` | Portal do Cliente em `app.safeworkengenharia.com.br` (caminho final conforme a publicação, por exemplo `/portal/`) |
| Acesso Restrito | `restrito` | Painel Privado em `admin.safeworkengenharia.com.br` (por exemplo `/painel-privado/`) |

Pré-requisitos antes de preencher: API servida sob `/api` (cliente) e `/api/plataforma` (Painel) na mesma origem de cada portal; `CORS_ORIGIN` e `PLATAFORMA_CORS_ORIGIN` com as origens `https://` reais (disjuntas); `PLATAFORMA_HOST` definido; cookies `Secure`.

### Publicação do frontend do cliente

Em homologação e produção, publica-se somente o pacote gerado por `npm run publicacao:empacotar -- --saida <diretório>` (em `frontend/`), a partir da allowlist explícita `frontend/publicacao/allowlist.json`. As páginas legadas, `js/main.js`, `js/db-api.js`, o `index.html` da raiz e o Painel Privado ficam fora. O empacotador recusa o pacote inteiro diante de qualquer divergência que reconheça. A inspeção do HTML é por expressões regulares, não um parser completo: formas anômalas como `<script/src="...">` e um `<base href>` externo não são detectadas, e o que as cobre é a CSP obrigatória do servidor estático. Endurecer o empacotador é hardening futuro (ver "Próximos marcos e itens futuros"). Detalhes e requisitos obrigatórios do deploy, entre eles a CSP no servidor estático, estão em `frontend/publicacao/README.md`.

## Backend

O backend está localizado integralmente em `backend/` e concentra a API, configuração do servidor, acesso ao PostgreSQL 16, as migrations em `backend/migrations/` e as regras de negócio.

### Arquitetura em camadas

```text
route/controller
    ↓
service
    ↓
repository
    ↓
PostgreSQL
```

- **routes** (`backend/src/routes/`) conectam caminho, middlewares (sessão, validação Zod) e o controller — não decidem autorização.
- **controllers** (`backend/src/controllers/`) traduzem a requisição HTTP em chamada de serviço e o resultado em resposta; `empresaId`/`usuarioId` vêm exclusivamente da sessão autenticada, nunca do corpo da requisição.
- **services** (`backend/src/services/`) coordenam regra de negócio, autoridade e transações.
- **repositories** (`backend/src/repositories/`) só executam SQL parametrizado; recebem o executor (pool ou cliente de transação) por parâmetro, nunca importam o pool global.
- **schemas** (`backend/src/schemas/`), com Zod, validam formato de entrada antes do controller.
- **middleware de autorização** (`backend/src/middleware/autorizacao.js`) decide, a cada requisição, a cadeia perfil → grupo → exceção individual — descrita na próxima seção.

## RBAC (Incremento 8)

Controle de acesso baseado em papéis, com quatro camadas de decisão, sempre verificadas no servidor (o frontend pode ocultar controles conforme perfil, mas nunca é a autoridade final):

1. **Perfil** — `MASTER`, `ADMINISTRADOR`, `SUPERVISOR`, `USUARIO`. Relido do banco a cada requisição, nunca confiado ao cliente.
2. **Grupo de acesso** — grupos personalizados por empresa (ex.: Almoxarifado, Gerência), com permissão configurável por **recurso** (visualizar/criar/editar/excluir) e por **ação**, em três estados: conceder, negar ou herdar do perfil. Negar é sempre uma decisão explícita, nunca confundida com ausência de opinião do grupo.
3. **Exceção individual por recurso** — mesma semântica de três estados, mas por usuário, sobre um recurso específico.
4. **Autorização individual por ação** — concessão pontual de uma ação a um usuário, independente de perfil ou grupo, com:
   - **concessão direta**, restrita ao perfil `MASTER`;
   - **delegação**, para quem recebeu uma autorização própria marcada como repassável (`pode_delegar`) — repassar exige que a autorização de origem ainda esteja valendo para quem delega (concessão + vínculo com a SST quando a ação exige + ausência de bloqueio individual). **Poder executar uma ação não implica poder delegá-la**: as duas autoridades são independentes;
   - **revogação**, por quem concedeu a autorização ou pelo `MASTER`; revogar uma autorização que serviu de origem para outras remove as delegadas dela, mas nunca autorizações concedidas por outro caminho.

### Autoridade administrativa granular

Além do `MASTER`, um `ADMINISTRADOR` pode receber, por autorização individual, o direito de administrar grupos, permissões de grupo, vínculos de usuário ou, desde o Bloco 9 (parte F), os usuários da empresa (`GERENCIAR_USUARIOS`) — sem qualquer autoridade de administração concedida implicitamente por perfil.

Preservados em toda a extensão do RBAC: **isolamento multiempresa** (nenhuma consulta ou escrita alcança dado de outra empresa — o identificador de empresa vem sempre da sessão) e **auditoria transacional** (toda escrita administrativa é registrada em `logs_auditoria`, na mesma transação da alteração; consultas não geram registro de auditoria).

Ficaram fora do Incremento 8, com destino registrado em "Encerramento do Bloco 8": a página de acesso negado com indicação de quem pode conceder a autorização, o botão de solicitação de acesso e as notificações de pedidos (backlog formal). O workflow de CI, que também constava ali, já existe (ver "Integração contínua (GitHub Actions)").

## Segurança implementada

Resumo do que já está em vigor, sempre decidido no servidor:

- **Cabeçalhos HTTP:** Helmet (`backend/src/middleware/cabecalhos.js`) e `x-powered-by` desligado.
- **CORS por allowlist**, separada para o cliente (`/api`) e para o Painel Privado (`/api/plataforma`), sem curinga.
- **Verificação de `Origin`** nos métodos que alteram estado, antes de consumir cota de rate limit.
- **Rate limiting** geral e limitadores próprios para login, MFA e aceite de convites.
- **Payload limitado:** só JSON, até 32 KiB, validado por schemas Zod.
- **Senhas com Argon2id**, cooldown persistente de login com chave HMAC-SHA-256 e resposta pública genérica contra enumeração.
- **Sessões reais no PostgreSQL:** token opaco de 256 bits em cookie `HttpOnly`; no banco, só o SHA-256 do token.
- **Portal do Cliente:** Cloudflare Turnstile no login. **Painel Privado:** MFA TOTP obrigatório.
- **Logout** do Portal, das páginas integradas e do Painel Privado só é dado como concluído com resposta 2xx do servidor.
- **RBAC** (perfil, grupo, exceção individual e autorização individual) e **isolamento multiempresa**: a empresa vem sempre da sessão, e FKs compostas impedem associação entre empresas no banco.
- **Auditoria transacional** em `logs_auditoria` e `logs_auditoria_plataforma`, cujos gatilhos recusam chaves JSON sensíveis.
- **Publicação do frontend do cliente por allowlist**, fail-closed (`frontend/publicacao/`).
- **Migrations protegidas por checksum** SHA-256 e **CI** em todo pull request e push na `main`.

## API HTTP

A API do Incremento 8 (fotografia histórica, não o total atual da API) soma **23 endpoints**, em **20 caminhos distintos** (três caminhos aceitam dois métodos HTTP cada), distribuídos em **10 arquivos de rota** (`backend/src/routes/`), todos montados na mesma cadeia `/api` de `backend/src/app.js`, com CORS restrito, verificação de origem, rate limit e validação de conteúdo aplicados uma única vez para todas as rotas.

| Arquivo de rota | Endpoints |
|---|---|
| `health.routes.js` | Verificação de disponibilidade |
| `auth.routes.js` | Login, sessão atual, logout |
| `grupo-acesso.routes.js` | Cadastro, listagem, edição, inativação e reativação de grupos |
| `grupo-permissao.routes.js` | Consulta e configuração das permissões de um grupo, por recurso e por ação |
| `grupo-usuario.routes.js` | Consulta de vinculados, vinculação/transferência e desvinculação |
| `autorizacao-individual.routes.js` | Concessão direta, delegação e revogação de autorização individual |
| `catalogo.routes.js` | Catálogo real das ações administráveis |
| `usuario-consulta.routes.js` | Consulta administrativa de usuários da empresa |
| `autorizacao-consulta.routes.js` | Consulta das autorizações individuais de um usuário |
| `delegacao-destinatarios.routes.js` | `GET /api/delegacao/destinatarios` — a quem um usuário com autorização repassável pode delegar, sem exigir a autoridade administrativa de vínculos de grupo |

O Bloco 9 acrescentou, na mesma cadeia `/api`, as rotas de materiais, estoque por lote, itens disponíveis, GHE, funcionários, dashboard e, na parte F, `usuario-administracao.routes.js` (`/api/administracao/usuarios`) e `convite-usuario.routes.js` (`/api/administracao/convites-usuario` e as duas rotas públicas de aceite, `/api/convite-usuario/consultar` e `/api/convite-usuario/aceitar`, com limite de requisições próprio).

O Bloco 10 acrescentou `entrega-epi.routes.js`, também em `/api`: `POST /api/entregas-epi` (registrar entrega, com chave de idempotência), o contexto da entrega em `/api/entregas-epi/contexto/*` (localizar trabalhador por nome ou matrícula, consulta por CPF no corpo, contexto do trabalhador, materiais e lotes) e as consultas `GET /api/entregas-epi/:id`, `GET /api/fichas-epi`, `POST /api/fichas-epi/consulta-cpf`, `GET /api/fichas-epi/:id` e `GET /api/fichas-epi/:id/entregas`. Entrega e contexto exigem a ação `REALIZAR_ENTREGA`; ficha e histórico exigem o recurso `epiFicha` (visualizar). O CPF nunca vai na URL.

Também na cadeia `/api`, `auth-global.routes.js` atende o Portal do Cliente: `POST /api/auth/global/login` (e-mail, senha e token do Turnstile), `GET /api/auth/global/turnstile` (site key e action públicas do widget), `GET /api/auth/global/me`, `POST /api/auth/global/empresas/:id/selecionar` e `POST /api/auth/global/logout`.

A cadeia `/api/plataforma`, montada antes de `/api` e separada dela, atende o Painel Privado: login, sessão e logout da plataforma, as rotas do MFA em `/api/plataforma/auth/mfa/*`, o resumo do painel, o cadastro de empresas e o convite do MASTER (com duas rotas públicas de aceite).

A recuperação de senha (Bloco 11D, `recuperacao-senha.routes.js`, na `main` pelo PR #45) tem rotas públicas nas duas cadeias. No Portal: `POST /api/auth/global/recuperacao-senha/solicitar` (e-mail e token do Turnstile), `POST /api/auth/global/recuperacao-senha/redefinir` (token do link e nova senha) e `GET /api/auth/global/recuperacao-senha/turnstile` (site key e action do widget). No Painel Privado: `POST /api/plataforma/auth/recuperacao-senha/solicitar` e `POST /api/plataforma/auth/recuperacao-senha/redefinir`, sem Turnstile. A solicitação bem formada responde sempre `202` com `{ "status": "SOLICITACAO_RECEBIDA" }`, exista ou não a conta, esteja ela ativa ou não. A redefinição responde `200` com `{ "status": "SENHA_REDEFINIDA" }`, não cria sessão e remove os cookies de sessão do portal correspondente. O token do link só é aceito no corpo JSON: as quatro rotas POST recusam qualquer parâmetro na query string. O Turnstile da solicitação usa a action `portal_recuperacao_senha`, diferente da do login, com as mesmas chaves. Cada POST tem o próprio limite de requisições por IP, separado entre si e do login, com os mesmos parâmetros do limite de autenticação.

A troca de senha autenticada (Bloco 11E, `troca-senha.routes.js`) exige sessão em cada cadeia e não aceita parâmetro na query string. No Portal: `POST /api/auth/global/senha`, com a sessão global e o corpo `{ "senhaAtual", "novaSenha" }`. No Painel Privado: `POST /api/plataforma/auth/senha`, com a sessão administrativa plena e o corpo `{ "senhaAtual", "novaSenha", "codigo" }`, em que `codigo` é só o TOTP de 6 dígitos (recovery code não substitui). A identidade vem sempre da sessão, nunca do corpo. No Portal, a senha atual errada responde `401` com `SENHA_ATUAL_INVALIDA` e conta no cooldown do login. No Painel Privado, a senha atual errada, o TOTP errado e o TOTP repetido contam no cooldown de MFA do administrador e recebem a mesma resposta `401` com `REAUTENTICACAO_INVALIDA`, sem dizer qual fator falhou. No sucesso a resposta é `200` com `{ "status": "SENHA_ALTERADA" }`, sem cookie novo: só a sessão atual continua, as demais sessões da conta são revogadas (no Painel Privado, também os desafios de MFA abertos, sem tocar em fator, secret nem recovery codes), os pedidos de redefinição pendentes são cancelados e o aviso de senha alterada sai depois do COMMIT. Cada rota tem o próprio limite de requisições por IP, separado do login e da recuperação.

`health` é pública, sem exigência de sessão. O login (`POST /api/auth/login`) também é público — é o próprio ponto de entrada da autenticação; o login global do Portal é público, mas exige o token do Turnstile. As rotas de recuperação de senha são públicas: não exigem sessão nem MFA. O logout aceita chamada sem sessão válida, por comportamento idempotente. As demais rotas — todas as administrativas do RBAC — exigem sessão autenticada; nenhuma decide autorização por si mesma, apenas autenticação. A autoridade administrativa é sempre resolvida na camada de serviço, relendo o estado do banco a cada chamada.

## Banco de dados e migrations

O banco do projeto é PostgreSQL 16. As migrations ficam em `backend/migrations/` e existem hoje arquivos versionados de `000` a `064` (65 no total, sem lacunas), que devem ser executados em ordem crescente de prefixo.

**Bloco 11, subetapas 11A + 11B (ciclo de senha):** a `061` cria os pedidos de redefinição de senha das identidades do Portal e a `062`, os dos administradores do Painel Privado. As duas guardam só o hash do link de uso único, limitam a validade a 4 horas, aceitam um único pedido pendente por conta e, por gatilho, impedem que um pedido usado, cancelado ou expirado volte a valer. A `063` cria o contador de solicitações de recuperação por chave HMAC, sem e-mail em claro e sem ligação com conta. A `064` cria a trilha de auditoria da identidade global, que só aceita INSERT e recusa chave JSON sensível. Todas estão versionadas, no manifesto de checksums e validadas em schemas temporários; nenhuma foi aplicada a banco persistente, e aplicá-las exige autorização separada.

**Bloco 10 (PR #38):** a `057` cria as chaves compostas que as FKs da entrega referenciam (`funcionarios (empresa_id, id)` e `estoque_lotes (empresa_id, id, material_id)`), para que a ficha só aponte para funcionário da mesma empresa e o item da entrega prove, sem gatilho, que o lote é daquele material e daquela empresa. A `058` cria a ficha de EPI (uma por funcionário na empresa, numerada em sequência por empresa), a entrega (evento dentro da ficha, com cópias dos dados da empresa, do trabalhador, do GHE e do responsável da época, chave de idempotência e `origem`, hoje só `DIRETA`) e os itens (cópias do material; tamanho, CA e validade vêm do lote). A `059` faz `estoque_operacoes` aceitar a operação `ENTREGA`, ligada a exatamente um item por FK composta (empresa, item, lote, quantidade). A `060` cria a confirmação de recebimento, exatamente uma por entrega, nos modos `DESENHO` (traços em JSON) e `ACEITE_PRESENCIAL`, sem biometria; a entrega sem confirmação não passa do COMMIT e, como as tabelas só aceitam INSERT, uma entrega gravada fica fechada para sempre. Todas estão versionadas, no manifesto de checksums e validadas em schemas temporários; aplicá-las a qualquer banco persistente exige autorização separada.

**MFA TOTP do Painel Privado (PRs #34 a #36):** a `048` acrescenta ator e alvo à auditoria da plataforma, para registrar operações de CLI e eventos sem autor humano. A `049` cria os fatores de MFA (por ora só TOTP, com o segredo cifrado e o último período aceito para o anti-replay). A `050` e a `051` criam os lotes e os recovery codes, guardados só como hash. A `052` cria os desafios pré-MFA, separados da sessão. A `053` cria as liberações de cadastro de uso único emitidas por CLI. A `054` registra na sessão da plataforma o instante e o método do MFA. A `055` torna o MFA obrigatório em toda sessão não revogada do Painel Privado, conferido pelo PostgreSQL no COMMIT; ao ser aplicada, revoga com o motivo `MFA_OBRIGATORIO` as sessões anteriores que não comprovam o MFA. A `056` cria o gatilho que, na inativação de um administrador, encerra desafios abertos, revoga fatores pendentes (apagando o segredo cifrado) e revoga liberações de cadastro abertas. Todas estão versionadas, no manifesto de checksums e validadas em schemas temporários, inclusive no CI; aplicá-las a qualquer banco persistente exige autorização separada.

**Bloco 9, Etapas E e F (27/09/2026):** as migrations `042` a `045` criam o estoque por lote e as operações de estoque, migram o saldo anterior para saldo inicial por lote, e acrescentam a `materiais` a exigência de tamanho e a classificação de óculos com grau. A `046` cria `convites_usuario` e `convite_usuario_tentativas` (convite de usuário, mesmo desenho do convite do MASTER da `033`/`034`, com FKs compostas que impedem quem convida ou o vínculo criado de serem de outra empresa). A `047` coloca `GERENCIAR_USUARIOS` em modo `OBRIGATORIA` e recusa rodar se já existir autorização individual gravada para essa ação, para não ativar concessão que ninguém revisou. Todas estão versionadas, no manifesto de checksums e validadas em schemas temporários; aplicá-las a qualquer banco persistente exige autorização separada.

**Onde cada migration está aplicada:** o repositório define quais migrations estão versionadas; a tabela `pgmigrations` de cada banco (`npm run db:migrate:status`) é a fonte de verdade sobre o que está aplicado nele. O registro operacional de 24/09/2026 (Bloco 9, Etapa C, Parte C2) documenta que a migration `039` foi aplicada especificamente à `gestao_epi_demo`, com autorização específica e depois de backup validado, e que esse banco ficou, naquele momento, com 40 de 40 migrations aplicadas e nenhuma pendente. Esse registro não implica aplicação aos demais bancos persistentes. Qualquer aplicação futura a banco persistente exige verificar o alvo e autorização específica. As migrations `025` a `038` foram versionadas nas etapas posteriores ao Incremento 8 (autenticação global, Portal do Cliente e sessões).

**Registro histórico (Incremento 8, 22/09/2026):** naquele momento, as migrations `000` a `016` estavam incorporadas à `main` e aplicadas ao banco então tratado como principal. As migrations `017` a `024`, do Incremento 8 (estrutura de SST, autorizações individuais e delegação, grupos de acesso e suas permissões, e as ações administrativas granulares), ainda não haviam sido aplicadas a esse banco naquela fotografia; haviam sido validadas em schemas temporários pela suíte de integração (ver seção de testes). Este é um registro histórico e não representa, por si só, o estado posterior deste ou de outros bancos. O registro operacional de 24/09/2026, acima, documenta separadamente que a `gestao_epi_demo` chegou a `000` a `039` (40 de 40 aplicadas), depois de aplicação autorizada e backup validado. O estado atual de cada banco continua sendo o da sua tabela `pgmigrations`.

Versionar uma migration não significa que ela já foi aplicada. O schema `public` de um banco só passa a ter a estrutura depois de uma execução explícita e autorizada. Criar a migration e aplicá-la são decisões separadas.

Migrations já incorporadas ao histórico não são alteradas retroativamente. Quando uma estrutura precisa mudar, a correção entra em uma migration nova.

A migration `039_alter_materiais_add_categoria_codigo_interno_descricao.sql` (Bloco 9, Etapa C, Parte C2) acrescenta a `materiais` as colunas nuláveis `categoria`, `codigo_interno` e `descricao`, com CHECKs que recusam vazio e espaços nas pontas, teto de 500 caracteres na descrição e índice único parcial `(empresa_id, upper(codigo_interno))` para linhas com código. É aditiva: nenhum registro existente é alterado. Onde ela foi aplicada está no registro de 24/09/2026 acima; aplicá-la a outro banco persistente exige verificar o alvo e autorização específica.

A migration `016_alter_empresas_cnpj_alfanumerico.sql` altera a constraint estrutural de `empresas.cnpj` para aceitar 12 posições `[0-9A-Z]` seguidas de 2 dígitos numéricos. Ela substitui apenas a expressão da constraint e preserva o nome dela, o tipo `VARCHAR(14)`, o `NOT NULL` da coluna, a UNIQUE e a chave primária. A constraint verifica somente o formato. A conferência dos dígitos verificadores não é responsabilidade do banco.

### Configuração de acesso

O backend exige um servidor PostgreSQL 16 acessível e um banco de dados cujo proprietário seja o usuário informado na configuração, com permissão para criar objetos no schema `public`.

O acesso é configurado por cinco variáveis de ambiente, lidas de `backend/.env`:

| Variável | Conteúdo |
|---|---|
| `DB_HOST` | endereço do servidor |
| `DB_PORT` | porta do servidor |
| `DB_NAME` | nome do banco de dados |
| `DB_USER` | usuário de conexão, que deve ser o proprietário do banco |
| `DB_PASSWORD` | senha do usuário |

O arquivo `backend/.env.example` lista todas as variáveis do projeto e não contém valores reais. O `.env` não é versionado, e nenhuma credencial deve ser escrita em código, em documentação ou em argumento de linha de comando.

Além das cinco de banco, o `.env.example` traz, entre outras: o segredo do cooldown de login (`LOGIN_COOLDOWN_HMAC_SECRET`), as chaves do MFA (`MFA_TOTP_KEY_CURRENT_VERSION` e `MFA_TOTP_KEY_V1`, obrigatórias em qualquer ambiente), as chaves do Turnstile (`TURNSTILE_PORTAL_SITE_KEY` e `TURNSTILE_PORTAL_SECRET_KEY`, obrigatórias em `production`), as origens (`CORS_ORIGIN`, `PLATAFORMA_CORS_ORIGIN`, `PLATAFORMA_HOST`), os nomes dos cookies, o número de proxies confiáveis (`TRUST_PROXY_HOPS`) e os limites de requisição. Os valores reais vêm do ambiente ou de um serviço de secrets, nunca do repositório.

Variáveis da recuperação de senha (Bloco 11):

| Variável | Conteúdo |
|---|---|
| `RECUPERACAO_SENHA_VALIDADE_MINUTOS` | validade do link de redefinição; padrão 60, mínimo 5, máximo 240 (4 horas) |
| `EMAIL_MODO` | `desativado` (padrão, a mensagem é descartada) ou `arquivo` (grava a mensagem em disco; só desenvolvimento e teste) |
| `EMAIL_ARQUIVO_DIRETORIO` | obrigatória no modo `arquivo`: caminho absoluto de um diretório fora do repositório |

Em `production` o backend recusa iniciar com `EMAIL_MODO` ausente, `desativado` ou `arquivo`: a produção exige um mecanismo real de envio de e-mail, que ainda não foi implementado.

### Preparação de um ambiente novo

A sequência abaixo parte de um banco vazio e recém-criado.

```bash
cd backend
npm ci                       # instala as dependências a partir do package-lock.json
cp .env.example .env         # preencher as variáveis, inclusive as cinco de banco
npm run db:migrate:verificar # confere a integridade dos arquivos de migration
npm run db:migrate:status    # mostra o que está aplicado e o que está pendente
npm run db:migrate           # aplica as migrations pendentes
```

Em um banco vazio, a primeira execução de `npm run db:migrate:status` apresenta todas as migrations versionadas como pendentes e pode terminar com código de saída 2. Esse código sinaliza pendência, não erro de configuração, e é o resultado esperado antes da primeira aplicação. Ao final da sequência, `npm run db:migrate:status` deve relatar todas as migrations aplicadas, nenhuma pendente e código de saída 0.

O primeiro acesso ao Painel Privado também é preparado por linha de comando, dentro de `backend/`: `npm run db:criar-administrador-plataforma -- --email <email> --confirmo` cria o administrador (a senha vem da variável de ambiente `ADMINISTRADOR_PLATAFORMA_SENHA`, nunca de argumento) e `npm run db:mfa:liberar-cadastro -- --email <email> --confirmo` emite o código de liberação, exibido uma única vez, com o qual o administrador cadastra o TOTP depois de entrar com a senha.

As migrations `017` a `024`, do Incremento 8, estão na `main` desde o PR #18.

### Comandos de migration

Os três comandos têm propósitos distintos e são executados nessa ordem.

```bash
npm run db:migrate:verificar # compara os arquivos .sql com o manifesto SHA-256, sem acessar o banco
npm run db:migrate:status    # leitura apenas: aplicadas, pendentes e divergências
npm run db:migrate           # aplica as pendentes em ordem crescente de prefixo
```

A aplicação é feita pelo `node-pg-migrate`, com verificação de ordem, transação única para o lote e advisory lock que impede duas execuções simultâneas no mesmo banco. Se uma migration falhar, o lote inteiro é revertido e nenhuma das seguintes é tentada.

O histórico fica registrado na tabela `pgmigrations`, criada e mantida pela ferramenta. Ela é a fonte de verdade sobre o que já foi aplicado.

### Integridade das migrations

As migrations de `000` a `064` são protegidas por um manifesto de checksums SHA-256 em `backend/migrations/checksums.json` (65 entradas, todas íntegras na validação local de 01/10/2026). O `npm run db:migrate:verificar` recalcula o digest de cada arquivo e o compara com o registro, detectando alteração de conteúdo, remoção e renomeação.

Uma migration já aplicada não deve ser alterada. O manifesto só aceita registro automático de migration nova, e recusa qualquer atualização que encubra mudança em arquivo histórico. Correções de estrutura entram sempre em uma migration nova.

Para manter os digests estáveis entre plataformas, o `.gitattributes` da raiz fixa os arquivos `.sql` em fim de linha LF.

### Baseline

O baseline registra migrations como aplicadas sem executar o SQL delas. Existe apenas para bancos cuja estrutura foi criada antes do controle de migrations, e não faz parte da instalação normal.

Por isso o comando exige confirmação explícita, recusa banco vazio e recusa banco que já tenha histórico registrado. Em uma instalação nova, o caminho correto é sempre `npm run db:migrate`.

O sinalizador de confirmação registra a intenção de quem executa, e não comprova que a estrutura do banco corresponde ao conjunto de migrations. Essa equivalência precisa ser verificada antes, por auditoria do catálogo do PostgreSQL, comparando tabelas, colunas, constraints, índices, funções e gatilhos com o que as migrations declaram. Sem essa auditoria, o baseline pode registrar como aplicadas migrations cujo efeito não está presente no banco.

## Testes e cobertura do backend

O backend usa o runner nativo `node:test` com `node:assert/strict`, e `supertest` para os testes HTTP. A cobertura é medida pela instrumentação nativa do Node (`--experimental-test-coverage`), sem biblioteca adicional. A versão mínima do backend é o Node 22 (`engines`: `>=22`), a mesma usada no CI.

Atualmente existem testes permanentes para a fundação da autenticação (Bloco 5: configuração, normalização, senha, política de senha, token de sessão, cooldown e erros HTTP), para a camada de validação de entrada (Bloco 6: schemas Zod, middleware de validação e tratamento de erros) e para a segurança HTTP (Bloco 7: cabeçalhos, CORS, verificação de origem, política de conteúdo, limite de payload, rate limit e cookies). O Incremento 8 acrescentou a suíte completa do RBAC — repositories, services, controllers, rotas e middleware de autorização. O Bloco 10 acrescentou as suítes da entrega de EPI (serviço transacional e idempotência, schemas, rotas de entrega e ficha, escopo e provisionamento do MASTER) e, no frontend, a do módulo `js/epi-ficha.js` e da página integrada.

Além dessa suíte padrão existe uma suíte separada de integração, que valida migrations, repositórios, rotas e concorrência contra um PostgreSQL real e não roda junto com `npm test`. O Incremento 8 também criou uma suíte de testes de frontend própria (`frontend/test/`, runner nativo `node:test`), inexistente até então — ver "Estado atual" abaixo.

### Comandos oficiais

```bash
npm test                # executa a suíte padrão, sem cobertura
npm run test:cobertura  # executa a suíte padrão e imprime a cobertura por arquivo (linhas, ramos e funções)
npm run test:ci         # executa a suíte padrão com cobertura, exige no mínimo 75% de linhas e grava coverage/lcov.info
DB_NAME=gestao_epi_teste_local npm run test:integracao # executa a suíte de integração contra PostgreSQL real, fora da suíte padrão
```

Todos devem ser executados dentro de `backend/`.

Os três primeiros não precisam de banco. A suíte de integração exige um PostgreSQL acessível, as variáveis `DB_HOST`, `DB_PORT`, `DB_USER` e `DB_PASSWORD` no ambiente e o nome do banco informado explicitamente no comando, como acima: o único banco aceito é `gestao_epi_teste_local`.

O `npm run test:integracao` puro falha fechado, antes de abrir qualquer conexão, sempre que o `DB_NAME` em vigor for outro. É o que acontece enquanto o `.env` estiver apontando para `gestao_epi_homolog_local`: o comando é recusado e nenhum teste roda. O `.env` não precisa ser alterado para rodar os testes; o `DB_NAME` passado no comando vale só para aquela execução.

### Testes de integração

Os arquivos com sufixo `.integration.js`, em `backend/test/integracao/`, validam migrations, repositórios, rotas e concorrência contra um PostgreSQL real. Eles ficam fora do glob de `npm test`, que carrega somente `test/**/*.test.js`, e por isso nunca rodam junto com a suíte padrão.

Cada execução:

- cria um schema temporário exclusivo, com nome gerado aleatoriamente;
- restringe o `search_path` a esse schema;
- aplica ali apenas as migrations necessárias ao caso testado;
- remove o schema com `DROP SCHEMA ... CASCADE` ao final, inclusive quando o teste falha.

As migrations dos ensaios são aplicadas exclusivamente em schemas temporários. Os testes podem consultar o estado do schema `public` para comprovar o isolamento, comparando a estrutura antes e depois da execução, mas não modificam seus objetos nem seus dados. Um `public` vazio, como o do PostgreSQL efêmero do CI, é uma linha de base válida: o que se exige é que ela seja lida do `public` real e que nada nele mude. As credenciais vêm exclusivamente do ambiente e não aparecem no código nem na saída dos testes.

A suíte só escreve no banco `gestao_epi_teste_local`. É uma allowlist de um nome só, definida em `backend/test/integracao/helpers/banco-de-teste.js`: qualquer outro banco é recusado, seja ele de homologação, de demonstração, de desenvolvimento ou um nome qualquer. A recusa acontece em três pontos:

- o preflight do comando oficial (`pretest:integracao`) confere o nome e pergunta ao próprio PostgreSQL, com `SELECT current_database()`, em que banco a conexão caiu; se não for o banco de teste, os testes nem começam;
- cada processo de teste confere o `DB_NAME` antes de carregar qualquer arquivo de teste;
- o helper que cria o schema temporário recusa o nome antes de conectar e confirma o banco real antes do primeiro `CREATE SCHEMA`.

Quem executa um arquivo de integração isolado, fora do comando oficial, conta apenas com a conferência do helper.

Os arquivos de integração são executados em série, com `--test-concurrency=1`. O motivo é o advisory lock do runner de migrations, que tem alcance de banco inteiro e permite apenas uma execução por vez. Em paralelo, um arquivo bloquearia o outro. A serialização reflete essa restrição real da ferramenta e não contorna nenhuma falha intermitente.

### Requisito de cobertura

A cobertura mínima obrigatória do projeto é:

- Backend: 75% de linhas.
- Frontend: 25%.

O backend aplica o limiar de 75% em `npm run test:ci`, que termina com código de saída diferente de zero quando qualquer teste falha ou quando a cobertura de linhas fica abaixo do mínimo. O CI executa `npm ci` e `npm run test:ci` em todo pull request e em todo push na `main`, e qualquer uma dessas duas condições reprova o job (ver "Integração contínua (GitHub Actions)").

O frontend passou a ter suíte de testes própria no Incremento 8 (`frontend/package.json`, runner nativo `node:test`, sem dependências externas — ver "Estado atual" abaixo), mas ainda sem instrumentação de cobertura. A meta obrigatória de 25% de cobertura do frontend ainda não é medida; a instrumentação e a medição estão destinadas ao Bloco 11, com os testes finais, o fechamento acadêmico e a documentação.

### Escopo da cobertura

A cobertura mede `backend/src/**`. A única exclusão é `backend/src/server.js`, e ela existe apenas porque esse arquivo é o entrypoint da aplicação: carrega as variáveis de ambiente, importa `app.js` e abre a porta, sem nenhuma regra de negócio. Nenhum arquivo é excluído para aumentar artificialmente a porcentagem, e novos módulos com regra de negócio devem permanecer no escopo de cobertura. A suíte carrega todos os módulos de `src/` para que cada um apareça no relatório com seu percentual real, inclusive os que ainda não têm teste dedicado.

Os testes `.integration.js` não entram no cálculo da cobertura. A medição acontece em `npm run test:cobertura` e `npm run test:ci`, que carregam apenas `test/**/*.test.js`. A suíte de integração também exercita código de `src/` contra o banco real, mas fica fora dessa medição.

### Integração contínua (GitHub Actions)

O workflow `.github/workflows/ci.yml` roda em todo pull request e em todo push na `main`, com permissão só de leitura do repositório (`contents: read`), Node 22 e fuso `America/Sao_Paulo`. Não usa secrets nem `.env`, e qualquer comando que falhe reprova o job. São dois jobs:

| Job | Etapas |
|---|---|
| Backend unitário, checksums e frontend | `npm ci`, `npm run test:ci` e `npm run db:migrate:verificar` em `backend/`; `npm test` em `frontend/` |
| Integração com PostgreSQL 16 efêmero | serviço `postgres:16` criado dentro do runner, com o banco `gestao_epi_teste_local`, credenciais sintéticas e health check; `npm ci` e `npm run test:integracao` em `backend/` |

O PostgreSQL do segundo job existe só durante a execução e é descartado ao fim. Os testes continuam isolados em schemas temporários, e nenhum passo do workflow aplica migrations fora deles.

### Estado atual

Validação local das subetapas 11E + 11F do Bloco 11, em 01/10/2026, na branch `feature/bloco11-11e-11f` (não é resultado do CI do GitHub: o CI roda quando o PR existir). As subetapas 11A + 11B (PR #44) e 11C + 11D (PR #45) estão na `main`; as 11E + 11F estão implementadas e validadas nesta branch, ainda sem commit, PR nem merge, e os números abaixo já as incluem. O Bloco 11 não está concluído: falta a entrega real de e-mail (11H). A integração usou exclusivamente o banco `gestao_epi_teste_local`.

| Suíte | Testes | Suites | Aprovados | Falhas |
|---|---:|---:|---:|---:|
| Backend — unitário (`npm run test:ci`) | 2353 | 557 | 2353 | 0 |
| Backend — integração PostgreSQL 16 (`npm run test:integracao`) | 2054 | 484 | 2054 | 0 |
| Frontend (`npm test`, dentro de `frontend/`) | 1267 | 246 | 1267 | 0 |
| Checksums das migrations (`npm run db:migrate:verificar`) | 65 | — | 65 íntegras | — |

Cobertura do backend na mesma validação, pelo relatório de `npm run test:ci` (linha "all files"):

| `line %` | `branch %` | `funcs %` |
|---:|---:|---:|
| 89,34 | 94,31 | 80,17 |

O limiar do CI (`--test-coverage-lines=75`) vale para `line %`. O último resultado de CI registrado nesta seção foi o do commit `dcca3b8` (29/09/2026), anterior ao Bloco 10; medições anteriores ficam no histórico do Git.

### Histórico e adoção de TDD

Os testes permanentes dos Blocos 5 e 6 foram escritos depois da implementação desses módulos, convertendo as verificações utilizadas durante a revisão técnica de cada arquivo em testes automatizados. Eles não foram produzidos por TDD e não devem ser apresentados como tal.

A partir do Bloco 7 o desenvolvimento adota o ciclo: escrever o teste, observar a falha esperada, implementar o mínimo necessário, ver o teste passar e então refatorar.

### Segurança da suíte

- A suíte padrão não depende do `.env` real, de PostgreSQL nem de serviços externos.
- A suíte de integração depende de um PostgreSQL real e lê as credenciais exclusivamente do ambiente.
- Nos testes de integração as migrations são executadas somente em schema temporário exclusivo, removido em cascata ao final. O schema `public` não é alterado.
- O segredo HMAC e a chave do MFA usados nos testes são gerados em memória a cada execução, em `backend/test/setup.js`, e nunca são gravados em disco.
- A suíte não persiste dados sensíveis e verifica que senhas, e-mails, CNPJs, tokens, cookies e cabeçalhos de autorização não aparecem em respostas nem em logs.
- O diretório `coverage/` não é versionado.
