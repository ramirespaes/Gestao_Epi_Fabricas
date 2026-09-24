# Gestão de EPIs

Sistema para gestão de Equipamentos de Proteção Individual (EPIs), com frontend web e backend separados por responsabilidade.

## Estado do projeto

O desenvolvimento está organizado em 11 incrementos.

| Incremento | Situação |
|---|---|
| 1 a 7 | Incorporados à `main` |
| 8 — RBAC (perfis, grupos de acesso, permissões, autorizações individuais e delegação) | Implementação técnica concluída até a Subetapa 3V, incluindo o complemento de consulta de destinatários de delegação; ainda em processo de versionamento e encerramento no Git — **não incorporado à `main`** |
| 9 a 11 | Ainda previstos, sem implementação iniciada |

O Incremento 8 existe integralmente na branch `feature/bloco-08-incremento-08`. Sua incorporação à `main` depende da conclusão do fluxo de commits, push, Pull Request e merge, ainda não realizado. As seções de RBAC, API HTTP e as migrations `017`–`024` abaixo descrevem esse incremento pelo estado do código na working tree dessa branch, não pelo conteúdo atual de `main`.

## Estrutura do projeto

```text
gestao-epi/
├── backend/                # API, banco de dados, migrations e regras de negócio
├── frontend/               # Interface web
│   ├── IMAGEN/             # Imagens utilizadas na documentação/interface
│   ├── css/
│   │   └── main.css
│   ├── js/
│   │   ├── db-api.js
│   │   └── main.js
│   ├── pages/              # Páginas HTML do sistema
│   └── index.html
├── RFC-V1                  # Especificação funcional do sistema
├── RFC-V1.md.docx
├── README.md
├── CLAUDE.md               # Regras obrigatórias de desenvolvimento do projeto
└── .gitignore
```

## Frontend

O frontend está localizado integralmente em `frontend/`.

O ponto de entrada da aplicação é `frontend/index.html`.

A estrutura interna utiliza caminhos relativos entre `index.html`, `pages/`, `css/` e `js/`.

### Frontend legado

As 21 páginas originais em `frontend/pages/`, `frontend/js/db-api.js` (simulador de API em `localStorage`) e `frontend/js/main.js` (RBAC replicado localmente para a demonstração) permanecem preservados e funcionando exatamente como antes. Nenhuma delas foi migrada para a API HTTP real — as duas camadas coexistem sem se tocar.

### Frontend administrativo HTTP (Incremento 8)

Quatro páginas novas em `frontend/pages/` consomem a API HTTP real, com autenticação por sessão e cookie `HttpOnly` (nunca `localStorage`):

| Página | Função |
|---|---|
| `grupos-acesso.html` | Cadastro, listagem, edição, inativação e reativação de grupos de acesso |
| `grupo-permissoes.html` | Configuração das permissões de cada grupo, por recurso e por ação |
| `grupo-usuarios.html` | Vinculação e desvinculação de usuários aos grupos |
| `autorizacoes-individuais.html` | Consulta, concessão, delegação e revogação de autorizações individuais |

Seis módulos JavaScript em `frontend/js/` dão suporte a essas páginas: `api-http.js` e `auth-session.js` (fundação HTTP e sessão) mais um módulo por página (`grupos-acesso.js`, `grupo-permissoes.js`, `grupo-usuarios.js`, `autorizacoes-individuais.js`).

### Portal do Cliente (Autenticação Global — Pacote 4)

`frontend/portal/` é a entrada dos clientes: login **somente por e-mail e senha** (identidade global), seleção de empresa e ambiente inicial autenticado. Usa o backend real, sessões no PostgreSQL e cookies `HttpOnly`; nada de sessão é guardado no navegador.

| Página | Função |
|---|---|
| `portal/index.html` | Login (e-mail, senha, Entrar) |
| `portal/empresas.html` | "Selecione sua empresa" (e troca de empresa); mensagem própria quando não há empresa ativa vinculada |
| `portal/inicio.html` | Usuário, perfil e empresa ativa; **TROCAR DE EMPRESA**, **Sair da empresa** e **Sair**; módulos já integrados e módulos em integração |

Fluxo: uma empresa autorizada → entra direto; duas ou mais → escolhe; nenhuma → sem acesso operacional. Três cookies distintos: `gepi_sessao_global` (identidade; não dá acesso operacional), `gepi_sessao` (empresa selecionada; o mesmo que o RBAC sempre usou) e `gepi_sessao_admin` (Painel Privado). O login legado por CNPJ recusa vínculos ligados a uma identidade global — há uma única credencial válida por pessoa.

Módulos de `frontend/pages/` ainda baseados em `localStorage` não são apresentados como dados da empresa; sua integração é o Bloco 9 — Etapa C.

Em desenvolvimento, sirva `frontend/` em `http://localhost:5500` (Portal: `/portal/`) e em `http://localhost:5501` (Painel Privado: `/painel-privado/`), com o backend em `http://localhost:3000` — cada portal só é aceito pela allowlist de CORS/Origin do seu próprio namespace.

### Conexão futura da página institucional

`frontend/institucional/` já prevê os dois botões de acesso (`linkEmpresas`, `linkAdmin`), alimentados pelo objeto `PORTAIS` do próprio arquivo; com os valores vazios, a página mostra um aviso em vez de navegar. Quando os subdomínios estiverem publicados (não estão hoje), a conexão será apenas preencher, com autorização específica para alterar aquela página:

| Botão | Valor de `PORTAIS` | Destino previsto |
|---|---|---|
| Acesso Empresas | `empresas` | Portal do Cliente em `app.safeworkengenharia.com.br` (caminho final conforme a publicação, por exemplo `/portal/`) |
| Acesso Restrito | `restrito` | Painel Privado em `admin.safeworkengenharia.com.br` (por exemplo `/painel-privado/`) |

Pré-requisitos antes de preencher: API servida sob `/api` (cliente) e `/api/plataforma` (Painel) na mesma origem de cada portal; `CORS_ORIGIN` e `PLATAFORMA_CORS_ORIGIN` com as origens `https://` reais (disjuntas); `PLATAFORMA_HOST` definido; cookies `Secure`.

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

Além do `MASTER`, um `ADMINISTRADOR` pode receber, por autorização individual, o direito de administrar grupos, permissões de grupo ou vínculos de usuário — sem qualquer autoridade de administração concedida implicitamente por perfil.

Preservados em toda a extensão do RBAC: **isolamento multiempresa** (nenhuma consulta ou escrita alcança dado de outra empresa — o identificador de empresa vem sempre da sessão) e **auditoria transacional** (toda escrita administrativa é registrada em `logs_auditoria`, na mesma transação da alteração; consultas não geram registro de auditoria).

Adiados para depois do encerramento do Incremento 8: página de acesso negado com indicação de quem pode conceder a autorização, botão de solicitação de acesso, notificações de pedidos, e o workflow de CI/CD mencionado na seção de testes.

## API HTTP

A API do Incremento 8 soma **23 endpoints**, em **20 caminhos distintos** (três caminhos aceitam dois métodos HTTP cada), distribuídos em **10 arquivos de rota** (`backend/src/routes/`), todos montados na mesma cadeia `/api` de `backend/src/app.js`, com CORS restrito, verificação de origem, rate limit e validação de conteúdo aplicados uma única vez para todas as rotas.

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

`health` é pública, sem exigência de sessão. O login (`POST /api/auth/login`) também é público — é o próprio ponto de entrada da autenticação. O logout aceita chamada sem sessão válida, por comportamento idempotente. As demais rotas — todas as administrativas do RBAC — exigem sessão autenticada; nenhuma decide autorização por si mesma, apenas autenticação. A autoridade administrativa é sempre resolvida na camada de serviço, relendo o estado do banco a cada chamada.

## Banco de dados e migrations

O banco do projeto é PostgreSQL 16. As migrations ficam em `backend/migrations/` e existem hoje arquivos versionados de `000` a `024` (25 no total), que devem ser executados em ordem crescente de prefixo.

As migrations `000` a `016` já estão incorporadas à `main` e aplicadas ao banco principal. As migrations `017` a `024` pertencem ao Incremento 8 (estrutura de SST, autorizações individuais e delegação, grupos de acesso e suas permissões, e as ações administrativas granulares) e **ainda não foram aplicadas ao banco principal** — foram validadas apenas em schemas temporários pela suíte de integração (ver seção de testes). A existência dos arquivos `.sql` no repositório não significa que a estrutura já exista no `public` de nenhum banco além dos schemas de teste.

Versionar uma migration não significa que ela já foi aplicada. O schema `public` de um banco só passa a ter a estrutura depois de uma execução explícita e autorizada. Criar a migration e aplicá-la são decisões separadas.

Migrations já incorporadas ao histórico não são alteradas retroativamente. Quando uma estrutura precisa mudar, a correção entra em uma migration nova.

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

Em um banco vazio, a partir de `main`, a primeira execução de `npm run db:migrate:status` apresenta as 17 migrations como pendentes e pode terminar com código de saída 2. Esse código sinaliza pendência, não erro de configuração, e é o resultado esperado antes da primeira aplicação. Ao final da sequência, `npm run db:migrate:status` deve relatar 17 migrations aplicadas, nenhuma pendente e código de saída 0.

Na branch `feature/bloco-08-incremento-08` — ainda não incorporada à `main` — o mesmo diretório contém 25 arquivos (`000` a `024`); rodar os mesmos comandos ali aplicaria também as 8 migrations do Incremento 8 a esse banco. Isso não foi feito no banco principal em nenhum momento do desenvolvimento do Incremento 8.

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

As migrations de `000` a `024` são protegidas por um manifesto de checksums SHA-256 em `backend/migrations/checksums.json` (25 entradas, todas íntegras na última verificação). O `npm run db:migrate:verificar` recalcula o digest de cada arquivo e o compara com o registro, detectando alteração de conteúdo, remoção e renomeação.

Uma migration já aplicada não deve ser alterada. O manifesto só aceita registro automático de migration nova, e recusa qualquer atualização que encubra mudança em arquivo histórico. Correções de estrutura entram sempre em uma migration nova.

Para manter os digests estáveis entre plataformas, o `.gitattributes` da raiz fixa os arquivos `.sql` em fim de linha LF.

### Baseline

O baseline registra migrations como aplicadas sem executar o SQL delas. Existe apenas para bancos cuja estrutura foi criada antes do controle de migrations, e não faz parte da instalação normal.

Por isso o comando exige confirmação explícita, recusa banco vazio e recusa banco que já tenha histórico registrado. Em uma instalação nova, o caminho correto é sempre `npm run db:migrate`.

O sinalizador de confirmação registra a intenção de quem executa, e não comprova que a estrutura do banco corresponde ao conjunto de migrations. Essa equivalência precisa ser verificada antes, por auditoria do catálogo do PostgreSQL, comparando tabelas, colunas, constraints, índices, funções e gatilhos com o que as migrations declaram. Sem essa auditoria, o baseline pode registrar como aplicadas migrations cujo efeito não está presente no banco.

## Testes e cobertura do backend

O backend usa o runner nativo `node:test` com `node:assert/strict`, e `supertest` para os testes HTTP. A cobertura é medida pela instrumentação nativa do Node 24, sem biblioteca adicional.

Atualmente existem testes permanentes para a fundação da autenticação (Bloco 5: configuração, normalização, senha, política de senha, token de sessão, cooldown e erros HTTP), para a camada de validação de entrada (Bloco 6: schemas Zod, middleware de validação e tratamento de erros) e para a segurança HTTP (Bloco 7: cabeçalhos, CORS, verificação de origem, política de conteúdo, limite de payload, rate limit e cookies). O Incremento 8 acrescentou a suíte completa do RBAC — repositories, services, controllers, rotas e middleware de autorização.

Além dessa suíte padrão existe uma suíte separada de integração, que valida migrations contra um PostgreSQL real e não roda junto com `npm test`. O Incremento 8 também criou uma suíte de testes de frontend própria (`frontend/test/`, runner nativo `node:test`), inexistente até então — ver "Estado atual" abaixo.

### Comandos oficiais

```bash
npm test                # executa a suíte padrão, sem cobertura
npm run test:cobertura  # executa a suíte padrão e imprime a cobertura por arquivo (linhas, ramos e funções)
npm run test:ci         # executa a suíte padrão com cobertura, exige no mínimo 75% de linhas e grava coverage/lcov.info
npm run test:integracao # executa os testes de migration contra PostgreSQL real, fora da suíte padrão
```

Todos devem ser executados dentro de `backend/`.

Os três primeiros não precisam de banco. O `npm run test:integracao` exige um PostgreSQL acessível e as variáveis `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER` e `DB_PASSWORD` no ambiente.

### Testes de integração de migrations

Os arquivos com sufixo `.integration.js`, em `backend/test/integracao/`, validam migrations contra um PostgreSQL real. Eles ficam fora do glob de `npm test`, que carrega somente `test/**/*.test.js`, e por isso nunca rodam junto com a suíte padrão.

Cada execução:

- cria um schema temporário exclusivo, com nome gerado aleatoriamente;
- restringe o `search_path` a esse schema;
- aplica ali apenas as migrations necessárias ao caso testado;
- remove o schema com `DROP SCHEMA ... CASCADE` ao final, inclusive quando o teste falha.

As migrations dos ensaios são aplicadas exclusivamente em schemas temporários. Os testes podem consultar o estado do schema `public` para comprovar o isolamento, comparando a estrutura antes e depois da execução, mas não modificam seus objetos nem seus dados. As credenciais vêm exclusivamente do ambiente e não aparecem no código nem na saída dos testes.

Os arquivos de integração são executados em série, com `--test-concurrency=1`. O motivo é o advisory lock do runner de migrations, que tem alcance de banco inteiro e permite apenas uma execução por vez. Em paralelo, um arquivo bloquearia o outro. A serialização reflete essa restrição real da ferramenta e não contorna nenhuma falha intermitente.

### Requisito de cobertura

A cobertura mínima obrigatória do projeto é:

- Backend: 75% de linhas.
- Frontend: 25%.

O backend já aplica o limiar de 75% em `npm run test:ci`, que termina com código de saída diferente de zero quando qualquer teste falha ou quando a cobertura de linhas fica abaixo do mínimo. O pipeline de integração contínua deverá executar `npm ci` e `npm run test:ci`, e qualquer uma dessas duas condições deve bloquear o CI. O workflow do GitHub Actions será criado em etapa própria.

O frontend passou a ter suíte de testes própria no Incremento 8 (`frontend/package.json`, runner nativo `node:test`, sem dependências externas — ver "Estado atual" abaixo), mas ainda sem instrumentação de cobertura. A meta obrigatória de 25% de cobertura do frontend permanece pendente de medição, a ser implementada em etapa própria antes da entrega acadêmica.

### Escopo da cobertura

A cobertura mede `backend/src/**`. A única exclusão é `backend/src/server.js`, e ela existe apenas porque esse arquivo é o entrypoint da aplicação: carrega as variáveis de ambiente, importa `app.js` e abre a porta, sem nenhuma regra de negócio. Nenhum arquivo é excluído para aumentar artificialmente a porcentagem, e novos módulos com regra de negócio devem permanecer no escopo de cobertura. A suíte carrega todos os módulos de `src/` para que cada um apareça no relatório com seu percentual real, inclusive os que ainda não têm teste dedicado.

Os testes `.integration.js` não entram no cálculo da cobertura. A medição acontece em `npm run test:cobertura` e `npm run test:ci`, que carregam apenas `test/**/*.test.js`. A suíte de integração valida estrutura de banco, não código de `src/`.

### Estado atual

**Backend, fim do Incremento 7** — última medição de cobertura, por `npm run test:ci`:

| Métrica | Valor |
|---|---|
| Testes | 310 |
| Aprovados | 310 |
| Falhas | 0 |
| Linhas | 99,60% |
| Ramos | 97,42% |
| Funções | 99,37% |

| Métrica (integração) | Valor |
|---|---|
| Testes | 45 |
| Aprovados | 45 |
| Falhas | 0 |

**Backend e frontend, Incremento 8** — resultado da validação registrada em 22/09/2026 (execução direta de `npm test` e `npm run test:integracao` no backend, `npm test` no frontend, e `node scripts/verificar-checksums.js`; números apenas documentados aqui, não reexecutados nesta atualização do README):

| Suíte | Testes | Aprovados | Falhas |
|---|---:|---:|---:|
| Backend — unitário (`npm test`) | 978 | 978 | 0 |
| Backend — integração PostgreSQL (`npm run test:integracao`) | 716 | 716 | 0 |
| Frontend (`npm test`, dentro de `frontend/`) | 301 | 301 | 0 |
| Checksums das migrations | 25 | 25 íntegras | — |

Os 978 testes unitários do backend substituem os 310 anteriores (o Incremento 8 soma às suítes de autenticação/validação/segurança já existentes toda a suíte do RBAC). **A cobertura de linhas/ramos/funções não foi remedida para esse total** — a tabela de percentuais acima permanece a última disponível, referente aos 310 testes do fim do Incremento 7. Confirmar o percentual para os 978 testes atuais, com `npm run test:ci`, é uma pendência em aberto. Da mesma forma, os 716 testes de integração e os 25 checksums substituem, por serem mais recentes, os números de 45 testes e 17 migrations do estado anterior.

O requisito permanente continua sendo no mínimo 75% de linhas no backend.

### Histórico e adoção de TDD

Os testes permanentes dos Blocos 5 e 6 foram escritos depois da implementação desses módulos, convertendo as verificações utilizadas durante a revisão técnica de cada arquivo em testes automatizados. Eles não foram produzidos por TDD e não devem ser apresentados como tal.

A partir do Bloco 7 o desenvolvimento adota o ciclo: escrever o teste, observar a falha esperada, implementar o mínimo necessário, ver o teste passar e então refatorar.

### Segurança da suíte

- A suíte padrão não depende do `.env` real, de PostgreSQL nem de serviços externos.
- A suíte de integração depende de um PostgreSQL real e lê as credenciais exclusivamente do ambiente.
- Nos testes de integração as migrations são executadas somente em schema temporário exclusivo, removido em cascata ao final. O schema `public` não é alterado.
- O segredo HMAC usado nos testes é gerado em memória a cada execução, em `backend/test/setup.js`, e nunca é gravado em disco.
- A suíte não persiste dados sensíveis e verifica que senhas, e-mails, CNPJs, tokens, cookies e cabeçalhos de autorização não aparecem em respostas nem em logs.
- O diretório `coverage/` não é versionado.
