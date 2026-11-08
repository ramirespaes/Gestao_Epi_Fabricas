# Índice obrigatório por assunto

Leia a governança comum antes de agir. Leia o documento completo relacionado à
tarefa e amplie por dependência/segurança. Links não significam import automático.
Registros de origem não autorizam operação. Não ler fontes históricas extensas
sem necessidade de resolver regra, congelamento, evidência ou divergência.

| Assunto / condição | Documento obrigatório | Dependências |
|---|---|---|
| Toda tarefa | [Agentes](governanca/agentes.md) | Entrada aplicável e escopo atual |
| Edição documental, evidência, gate de adoção | [Manutenção](governanca/manutencao-documental.md) | Rastreabilidade |
| Estrutura/camadas/versões | [Arquitetura](sistema/arquitetura.md) | [Estado datado](sistema/estado-atual.md) |
| Auth, sessão, senha, MFA, RBAC, privacidade | [Segurança](sistema/seguranca.md) | Pessoas/domínio e testes |
| SQL, migration, integração, concorrência | [Testes/PostgreSQL](sistema/testes-e-postgresql.md) | Contrato do domínio; operação se persistente |
| Estoque, grade, material, entrega, pedidos, relatórios | [Estoque/solicitações](sistema/estoque-e-solicitacoes.md) | Segurança; testes; interface |
| Pessoas, CPF, conta, permissões, GHE, importação | [Pessoas/GHE/acessos](sistema/pessoas-ghe-e-acessos.md) | Segurança; testes; interface |
| Frontend, Dashboard, Central, Totem | [Interfaces](sistema/interfaces-e-autoatendimento.md) | Contrato funcional; segurança; padrões existentes |
| Serviços, processos, backup, restore, AWS/deploy | [Operação](sistema/operacao.md) | Procedimento específico e autorização própria |
| Publicação, biblioteca, padrões visuais | [Fontes únicas](sistema/fontes-especializadas.md) | Segurança e operação |
| Release, CD e rollback de código da homologação | [Publicação HML](sistema/publicacao-homologacao.md), [componentes](sistema/publicacao-homologacao-componentes.md) e [automação com aprovação](sistema/publicacao-homologacao-automacao.md) | Operação; fonte única de publicação; autorização própria |
| Conflito, exceção, congelamento ou pendência | [Reconciliações](../historico/governanca/reconciliacoes.md) | [Matriz](../historico/governanca/rastreabilidade.md), fonte específica |
| Regra de comportamento ou contrato | [Governança comum](governanca/agentes.md) e contrato por assunto | A fonte privada é consultada pelo responsável somente quando necessária e autorizada |

Git público não deve receber logs, dumps, credenciais, transcript, memória privada
integral ou inventário sensível de ambiente. Originais continuam onde estavam.
