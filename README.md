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
└── .gitignore
```

## Frontend

O frontend está localizado integralmente em `frontend/`.

O ponto de entrada da aplicação é `frontend/index.html`.

A estrutura interna utiliza caminhos relativos entre `index.html`, `pages/`, `css/` e `js/`.

## Backend

O backend está localizado integralmente em `backend/` e concentra a API, configuração do servidor, acesso ao PostgreSQL, migrations e regras de negócio.

## Testes e cobertura do backend

O backend usa o runner nativo `node:test` com `node:assert/strict`, e `supertest` para os testes HTTP. A cobertura é medida pela instrumentação nativa do Node 24, sem biblioteca adicional.

Atualmente existem testes permanentes para a fundação da autenticação (Bloco 5: configuração, normalização, senha, política de senha, token de sessão, cooldown e erros HTTP) e para a camada de validação de entrada (Bloco 6: schemas Zod, middleware de validação e tratamento de erros).

### Comandos oficiais

```bash
npm test               # executa a suíte, sem cobertura
npm run test:cobertura # executa a suíte e imprime a cobertura por arquivo (linhas, ramos e funções)
npm run test:ci        # executa a suíte com cobertura, exige no mínimo 75% de linhas e grava coverage/lcov.info
```

Todos devem ser executados dentro de `backend/`.

### Requisito de cobertura

A cobertura mínima obrigatória do projeto é:

- Backend: 75% de linhas.
- Frontend: 25%.

O backend já aplica o limiar de 75% em `npm run test:ci`, que termina com código de saída diferente de zero quando qualquer teste falha ou quando a cobertura de linhas fica abaixo do mínimo. O pipeline de integração contínua deverá executar `npm ci` e `npm run test:ci`, e qualquer uma dessas duas condições deve bloquear o CI. O workflow do GitHub Actions será criado em etapa própria.

A meta obrigatória de 25% de cobertura do frontend será implementada em etapa própria, antes da entrega acadêmica. O frontend ainda não possui infraestrutura de testes.

### Escopo da cobertura

A cobertura mede `backend/src/**`. A única exclusão é `backend/src/server.js`, e ela existe apenas porque esse arquivo é o entrypoint da aplicação: carrega as variáveis de ambiente, importa `app.js` e abre a porta, sem nenhuma regra de negócio. Nenhum arquivo é excluído para aumentar artificialmente a porcentagem, e novos módulos com regra de negócio devem permanecer no escopo de cobertura. A suíte carrega todos os módulos de `src/` para que cada um apareça no relatório com seu percentual real, inclusive os que ainda não têm teste dedicado.

### Estado atual

Resultado validado na última execução de `npm run test:ci`:

| Métrica | Valor |
|---|---|
| Testes | 148, sem falhas |
| Linhas | 99,46% |
| Ramos | 96,67% |
| Funções | 99,06% |

Esses percentuais representam o estado atual e vão variar conforme novos módulos forem adicionados. O requisito permanente continua sendo no mínimo 75% de linhas no backend.

### Histórico e adoção de TDD

Os testes permanentes dos Blocos 5 e 6 foram escritos depois da implementação desses módulos, convertendo as verificações utilizadas durante a revisão técnica de cada arquivo em testes automatizados. Eles não foram produzidos por TDD e não devem ser apresentados como tal.

A partir do Bloco 7 o desenvolvimento adota o ciclo: escrever o teste, observar a falha esperada, implementar o mínimo necessário, ver o teste passar e então refatorar.

### Segurança da suíte

- Os testes não dependem do `.env` real, de PostgreSQL nem de serviços externos nesta etapa.
- O segredo HMAC usado nos testes é gerado em memória a cada execução, em `backend/test/setup.js`, e nunca é gravado em disco.
- A suíte não persiste dados sensíveis e verifica que senhas, e-mails, CNPJs, tokens, cookies e cabeçalhos de autorização não aparecem em respostas nem em logs.
- O diretório `coverage/` não é versionado.
