-- acoes: três ações administrativas de gestão de acessos (Bloco 8,
-- Incremento 8, Etapa 5A, Subetapa 3Q). Só dados — nenhuma coluna,
-- constraint, índice ou trigger é criada ou alterada aqui; o catálogo
-- `acoes` (003) e suas duas colunas de autorização (017) permanecem
-- exatamente como estão.
--
-- POR QUE ESTA MIGRATION EXISTE: até a Subetapa 3P, a autoridade
-- administrativa sobre grupos de acesso (3J), permissões de grupo (3K)
-- e vínculos usuário-grupo (3L) era exclusiva do MASTER, decidida no
-- ponto único src/services/autoridade-administrativa.js. O comentário
-- daquele módulo já previa a entrada do "ADMINISTRADOR expressamente
-- autorizado, consultando a autorização individual da ação
-- administrativa correspondente QUANDO ELA EXISTIR" — e ela não
-- existia: o catálogo tinha oito ações de negócio (entrega, estoque,
-- solicitação, senha, usuários, funcionários, configurações), nenhuma
-- representando "administrar a configuração de acesso". Sem uma ação
-- no catálogo, não há o que conceder pela infraestrutura de
-- autorizações individuais (019/023 + Subetapas 3I/3P), porque
-- usuario_autorizacoes.acao_codigo é FK para `acoes`.
--
-- UMA AÇÃO POR OPERAÇÃO ADMINISTRATIVA, de propósito: três códigos
-- distintos, um por domínio administrativo, para que o MASTER possa
-- autorizar um ADMINISTRADOR a configurar permissões SEM autorizá-lo a
-- criar ou inativar grupos, ou a mover pessoas entre grupos. Um código
-- único ("administrar acessos") tornaria a concessão tudo-ou-nada e
-- impossibilitaria essa granularidade — que é justamente o objetivo
-- desta subetapa.
--
--   ADMINISTRAR_GRUPOS_ACESSO    -> grupo-acesso.service.js (3J/3M):
--                                   criar, alterar, inativar, reativar,
--                                   buscar e listar grupos.
--   ADMINISTRAR_PERMISSOES_GRUPO -> grupo-permissao.service.js (3K/3N):
--                                   configurar e consultar as permissões
--                                   de recurso e de ação de um grupo.
--   ADMINISTRAR_VINCULOS_GRUPO   -> grupo-usuario.service.js (3L/3O):
--                                   vincular, transferir, desvincular e
--                                   consultar os usuários de um grupo.
--
-- MODO OBRIGATORIA, NUNCA ALTERNATIVA: em OBRIGATORIA, para qualquer
-- perfil que não seja MASTER a autorização individual é indispensável —
-- permissoes_acao sozinha não basta, mesmo com permitido = true (017).
-- É exatamente essa semântica que impede o que a subetapa proíbe:
-- conceder autoridade administrativa AUTOMATICAMENTE a todos os
-- usuários do perfil ADMINISTRADOR. Se estas ações fossem ALTERNATIVA,
-- uma única linha em permissoes_acao (ADMINISTRADOR, ..., true)
-- promoveria o perfil inteiro de uma vez; em OBRIGATORIA, cada
-- ADMINISTRADOR precisa de uma linha PRÓPRIA em usuario_autorizacoes,
-- concedida nominalmente pelo MASTER (concederDireta, Subetapa 3I, que
-- recusa concedente não-MASTER e autoconcessão).
--
-- exige_sst permanece no padrão false: administrar configuração de
-- acesso não é atividade de Segurança do Trabalho, e vinculo_sst (018)
-- não é consultado para estas três ações. Nada aqui altera as regras de
-- SST nem as ações que as exigem (APROVAR_SOLICITACAO,
-- REPROVAR_SOLICITACAO permanecem intocadas).
--
-- DELEGAÇÃO CONTINUA SENDO UM ATO SEPARADO: nada nestas linhas concede
-- pode_delegar. Como qualquer autorização individual, a concessão nasce
-- com pode_delegar = false (023) e só recebe true por decisão explícita
-- do MASTER na concessão — "poder executar não é poder delegar"
-- continua valendo, agora também para autoridade administrativa, sem
-- nenhuma regra nova: é a mesma cadeia de origem da 3H/3I.
--
-- MASTER NÃO É AFETADO: continua com autoridade administrativa plena
-- por perfil, sem precisar de nenhuma destas linhas — a dispensa do
-- MASTER é decidida na camada de autorização, nunca no catálogo (017).
--
-- Nenhuma ação preexistente é alterada, desativada ou renomeada. Esta
-- migration é puramente aditiva: três INSERTs.
INSERT INTO acoes (codigo, nome, descricao, modo_autorizacao_individual) VALUES
  ('ADMINISTRAR_GRUPOS_ACESSO',    'Administrar grupos de acesso',
   'Criar, alterar, inativar, reativar e consultar grupos de acesso da própria empresa.',
   'OBRIGATORIA'),
  ('ADMINISTRAR_PERMISSOES_GRUPO', 'Administrar permissões de grupo',
   'Configurar e consultar as permissões de recurso e de ação dos grupos de acesso da própria empresa.',
   'OBRIGATORIA'),
  ('ADMINISTRAR_VINCULOS_GRUPO',   'Administrar vínculos de usuários a grupos',
   'Vincular, transferir, desvincular e consultar os usuários dos grupos de acesso da própria empresa.',
   'OBRIGATORIA');
