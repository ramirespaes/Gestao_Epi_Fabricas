# Gestão de EPIs

Sistema para gestão de Equipamentos de Proteção Individual (EPIs), com frontend web e backend separados por responsabilidade.

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

## Backend

O backend está localizado integralmente em `backend/` e concentra a API, configuração do servidor, acesso ao PostgreSQL 16, as migrations em `backend/migrations/` e as regras de negócio.

## Banco de dados e migrations

O banco do projeto é PostgreSQL 16. As migrations ficam em `backend/migrations/` e existem hoje arquivos versionados de `000` a `016`, que devem ser executados em ordem crescente de prefixo.

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

Em um banco vazio, a primeira execução de `npm run db:migrate:status` apresenta as 17 migrations como pendentes e pode terminar com código de saída 2. Esse código sinaliza pendência, não erro de configuração, e é o resultado esperado antes da primeira aplicação.

Ao final da sequência, `npm run db:migrate:status` deve relatar 17 migrations aplicadas, nenhuma pendente e código de saída 0.

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

As migrations de `000` a `016` são protegidas por um manifesto de checksums SHA-256 em `backend/migrations/checksums.json`. O `npm run db:migrate:verificar` recalcula o digest de cada arquivo e o compara com o registro, detectando alteração de conteúdo, remoção e renomeação.

Uma migration já aplicada não deve ser alterada. O manifesto só aceita registro automático de migration nova, e recusa qualquer atualização que encubra mudança em arquivo histórico. Correções de estrutura entram sempre em uma migration nova.

Para manter os digests estáveis entre plataformas, o `.gitattributes` da raiz fixa os arquivos `.sql` em fim de linha LF.

### Baseline

O baseline registra migrations como aplicadas sem executar o SQL delas. Existe apenas para bancos cuja estrutura foi criada antes do controle de migrations, e não faz parte da instalação normal.

Por isso o comando exige confirmação explícita, recusa banco vazio e recusa banco que já tenha histórico registrado. Em uma instalação nova, o caminho correto é sempre `npm run db:migrate`.

O sinalizador de confirmação registra a intenção de quem executa, e não comprova que a estrutura do banco corresponde ao conjunto de migrations. Essa equivalência precisa ser verificada antes, por auditoria do catálogo do PostgreSQL, comparando tabelas, colunas, constraints, índices, funções e gatilhos com o que as migrations declaram. Sem essa auditoria, o baseline pode registrar como aplicadas migrations cujo efeito não está presente no banco.

## Testes e cobertura do backend

O backend usa o runner nativo `node:test` com `node:assert/strict`, e `supertest` para os testes HTTP. A cobertura é medida pela instrumentação nativa do Node 24, sem biblioteca adicional.

Atualmente existem testes permanentes para a fundação da autenticação (Bloco 5: configuração, normalização, senha, política de senha, token de sessão, cooldown e erros HTTP), para a camada de validação de entrada (Bloco 6: schemas Zod, middleware de validação e tratamento de erros) e para a segurança HTTP (Bloco 7: cabeçalhos, CORS, verificação de origem, política de conteúdo, limite de payload, rate limit e cookies).

Além dessa suíte padrão existe uma suíte separada de integração, que valida migrations contra um PostgreSQL real e não roda junto com `npm test`.

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

A meta obrigatória de 25% de cobertura do frontend será implementada em etapa própria, antes da entrega acadêmica. O frontend ainda não possui infraestrutura de testes.

### Escopo da cobertura

A cobertura mede `backend/src/**`. A única exclusão é `backend/src/server.js`, e ela existe apenas porque esse arquivo é o entrypoint da aplicação: carrega as variáveis de ambiente, importa `app.js` e abre a porta, sem nenhuma regra de negócio. Nenhum arquivo é excluído para aumentar artificialmente a porcentagem, e novos módulos com regra de negócio devem permanecer no escopo de cobertura. A suíte carrega todos os módulos de `src/` para que cada um apareça no relatório com seu percentual real, inclusive os que ainda não têm teste dedicado.

Os testes `.integration.js` não entram no cálculo da cobertura. A medição acontece em `npm run test:cobertura` e `npm run test:ci`, que carregam apenas `test/**/*.test.js`. A suíte de integração valida estrutura de banco, não código de `src/`.

### Estado atual

Resultado validado na última execução de `npm run test:ci`:

| Métrica | Valor |
|---|---|
| Testes | 310 |
| Aprovados | 310 |
| Falhas | 0 |
| Linhas | 99,60% |
| Ramos | 97,42% |
| Funções | 99,37% |

Resultado validado na última execução de `npm run test:integracao`:

| Métrica | Valor |
|---|---|
| Testes | 45 |
| Aprovados | 45 |
| Falhas | 0 |

Os 45 testes de integração são uma suíte separada e não devem ser somados aos 310 da suíte padrão. Eles não participam da medição de cobertura, então a linha de cobertura acima se refere apenas aos 310.

Esses percentuais representam o estado atual e vão variar conforme novos módulos forem adicionados. O requisito permanente continua sendo no mínimo 75% de linhas no backend.

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
