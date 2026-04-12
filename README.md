EPI Management System
Sobre o Projeto
Este projeto tem como objetivo digitalizar o processo de solicitação, aprovação e entrega de Equipamentos de Proteção Individual (EPI) em ambientes industriais.

A solução busca melhorar:
- Rastreabilidade das entregas
- Controle de estoque
- Conformidade com normas de segurança do trabalho
- Eficiência operacional da área de SST
Problema
Em muitas empresas, o processo ainda ocorre manualmente:

1. Trabalhador solicita o EPI em formulário
2. Supervisor aprova
3. Segurança do Trabalho separa o equipamento
4. Entrega é registrada em ficha física
5. Auditorias são feitas manualmente

Isso gera problemas como:
- Retrabalho administrativo
- Risco de erro humano
- Falta de rastreabilidade
- Dificuldade em auditorias
- Controle ineficiente de estoque
Objetivo
Criar um sistema que permita:

- Solicitação digital de EPIs
- Aprovação por supervisor
- Registro automático da entrega
- Assinatura eletrônica do trabalhador
- Controle de estoque
- Geração de relatórios auditáveis
Funcionalidades
Cadastro de EPIs
- Descrição do equipamento
- Fabricante
- Número do CA
- Validade do CA

Solicitação de EPI
- Trabalhador solicita o EPI
- Sistema envia para aprovação do supervisor

Aprovação
- Supervisor aprova ou rejeita a solicitação

Entrega
- SST registra a entrega
- Sistema gera automaticamente a ficha de EPI

Controle de Estoque
- Registro de entrada e saída
- Alertas de estoque mínimo

Relatórios
- Histórico de EPIs por trabalhador
- Entregas por período
- Consumo por setor
Tecnologias Sugeridas
Backend
- Node.js
- Express
- PostgreSQL

Frontend
- React
- TypeScript
- TailwindCSS

Infraestrutura
- Docker
- REST API
- JWT Authentication
Conformidade Normativa
O sistema foi projetado considerando:

- NR-06 — Equipamento de Proteção Individual
- NR-01 — Gestão de documentos digitais

Essas normas permitem que o registro de entrega de EPI seja realizado por sistema eletrônico,
desde que seja possível gerar relatórios e manter a rastreabilidade das informações.
Roadmap
Possíveis evoluções:

- Autenticação biométrica
- Assinatura digital ICP-Brasil
- Integração com ERP
- Integração com PGR
- Alertas inteligentes de reposição
- Dashboard de indicadores de segurança
Autor
Projeto acadêmico voltado à digitalização da gestão de EPIs em ambientes industriais.

Sugestões:

Bruno Franzosi - O trabalho se destaca bastante por trazer um problema real e aplicável dentro da indústria, o que torna a proposta muito relevante. A solução está bem alinhada com a realidade operacional. Como melhoria, poderia incluir um pequeno cenário de uso (exemplo prático do sistema funcionando no dia a dia), o que deixaria ainda mais tangível.
