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
