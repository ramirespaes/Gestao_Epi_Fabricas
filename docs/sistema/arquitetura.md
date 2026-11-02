# Arquitetura e fontes técnicas

Preparado em 02/11/2026 para revisão. Base técnica local: `efea5bad7fd433f699b78831a01c69866438f2ab`.
Não comprova GitHub remoto, banco aplicado ou runtime ativo.

Backend Node.js/CommonJS, Express e PostgreSQL 16; frontend separado com caminhos
relativos preservados. Node mínimo do backend: 22, confirmado na referência local;
Node 20 era proposta histórica. Controllers coordenam HTTP, services negócios,
repositories SQL parametrizado. Não migrar CommonJS ou reorganizar caminhos sem
decisão explícita. Dependências e scripts vigentes vêm do package da referência,
não de lista histórica. Consulte estado-atual.md para a fotografia técnica.

## Contratos gerais preservados

### Origem CLAUDE §1 — linha 9

> Texto registrado preservado. Versões, contagens, aplicação em banco e aprovações são fotografias;
> alterações expressas são reconciliadas na rastreabilidade. As garantias técnicas não são revogadas por idade.

# 1. Projeto

Sistema web para Gestão de Equipamentos de Proteção Individual — EPIs.

O projeto possui frontend e backend separados por responsabilidade.

Estrutura principal:

```text
gestao-epi/
├── backend/
├── frontend/
├── README.md
├── RFC-V1
├── RFC-V1.md.docx
├── CLAUDE.md
└── .gitignore
```

---

### Origem CLAUDE §2 — linha 30

> Texto registrado preservado. Versões, contagens, aplicação em banco e aprovações são fotografias;
> alterações expressas são reconciliadas na rastreabilidade. As garantias técnicas não são revogadas por idade.

# 2. Backend

O backend está localizado integralmente em:

```text
backend/
```

Tecnologias principais:

- Node.js
- CommonJS
- Express 5
- PostgreSQL 16
- `pg`
- Argon2
- Zod
- Helmet
- express-rate-limit
- cookie
- `otpauth` — MFA TOTP
- `nodemailer` 10.0.13 — transporte SMTP do e-mail transacional
- Supertest para testes HTTP

Nota complementar (15/10/2026): desde 07–11/10/2026 o backend também depende de `yazl` 3.3.1 (ZIP em streaming do Relatório de Fiscalização, 12K-D6), `pdfkit` 0.20.2 e `write-excel-file` 4.1.1 (exportação PDF/XLSX do Histórico de Funcionários, pacote I), instaladas com a análise da seção 31; o `npm audit` ficou igual antes e depois dessas instalações (6 vulnerabilidades anteriores, uma crítica em `proxy-addr` via Express — pendência registrada em `[FONTE_PRIVADA]`; a aplicação não é declarada apta à produção enquanto ela não for avaliada; nunca `npm audit fix` sem autorização). `node-pg-migrate` 9.0.0 consta em `devDependencies` sem uso localizado no código (a confirmar). A lista acima descreve o estado de 06/10/2026 e não foi reescrita.

O arquivo `backend/package.json` utiliza:

```json
"type": "commonjs"
```

Portanto, preservar CommonJS enquanto não houver decisão arquitetural explícita para migração.

Não converter silenciosamente o backend para ESM.

---

### Origem CLAUDE §3 — linha 68

> Texto registrado preservado. Versões, contagens, aplicação em banco e aprovações são fotografias;
> alterações expressas são reconciliadas na rastreabilidade. As garantias técnicas não são revogadas por idade.

# 3. Frontend

O frontend está localizado integralmente em:

```text
frontend/
```

Estrutura principal:

```text
frontend/
├── IMAGEN/
├── css/
│   └── main.css
├── js/
│   ├── db-api.js
│   └── main.js
├── pages/
└── index.html
```

Preservar os caminhos relativos existentes entre:

- `index.html`
- `pages/`
- `css/`
- `js/`

Antes de mover qualquer arquivo ou diretório do frontend, verificar todas as referências de caminho.

Não reorganizar diretórios silenciosamente.

---

### Origem CLAUDE §34 — linha 798

> Texto registrado preservado. Versões, contagens, aplicação em banco e aprovações são fotografias;
> alterações expressas são reconciliadas na rastreabilidade. As garantias técnicas não são revogadas por idade.

# 34. Node.js

O ambiente atual de desenvolvimento utiliza Node moderno.

Ao definir `engines`, preferir compatibilidade mínima coerente com o projeto e suas dependências.

Não alterar a versão mínima suportada sem explicar impacto.

A versão mínima aprovada para o backend é Node.js 22 ou superior, declarada em `backend/package.json`:

```json
{
  "engines": {
    "node": ">=22"
  }
}
```

Essa decisão se refere ao backend.

Não adicionar essa configuração silenciosamente.

---

### Origem CLAUDE §51 — linha 1087

> Texto registrado preservado. Versões, contagens, aplicação em banco e aprovações são fotografias;
> alterações expressas são reconciliadas na rastreabilidade. As garantias técnicas não são revogadas por idade.

# 51. Controllers, services e repositories

Preservar separação de responsabilidades.

Preferência arquitetural:

```text
route/controller
    ↓
service
    ↓
repository
    ↓
PostgreSQL
```

Controllers não devem concentrar SQL ou regras complexas de segurança.

Repositories não devem decidir regra de negócio.

Services devem coordenar regras de negócio e segurança.

---


## Aplicação e dependências

Consulte [o índice](../README.md), [a governança](../governanca/agentes.md) e
[as reconciliações](../../historico/governanca/reconciliacoes.md).
Não executar procedimentos por constarem nesta proposta.

## MEM-27 — executor injetado e ausência de pool global

Repositórios recebem executor de consultas por parâmetro, no formato
`funcao(executor, ...)`. Nenhum repository ou service importa diretamente o pool
de `src/config/database.js`. O service coordena transação com o executor adequado;
o repository não escolhe banco/tenant por estado global. A regra preserva
isolamento e evolução arquitetural; necessidade de violação exige apresentar
conflito e alternativa para decisão antes de implementar. Esta revisão não afirma
conformidade de todos os arquivos de código nem autoriza refatoração funcional.
