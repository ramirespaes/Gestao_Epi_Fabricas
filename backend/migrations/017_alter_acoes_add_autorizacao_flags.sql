-- acoes: dois atributos novos que a camada de autorização usa para decidir,
-- além de permissoes_acao (por perfil), se uma ação também exige
-- participação na SST (vinculo_sst, migration 018) e/ou aceita ou exige
-- autorização individual (usuario_autorizacoes, migration 019).
--
-- Os dois vivem no catálogo, não em cada ponto de código que monta uma
-- rota: uma ação nova que precise dessas exigências só precisa de um
-- INSERT/UPDATE aqui, nunca de um parâmetro que alguém possa esquecer de
-- passar ao montar a rota.
--
-- modo_autorizacao_individual:
--   NENHUMA     — usuario_autorizacoes nunca é consultada para esta ação.
--   ALTERNATIVA — concessão por perfil (permissoes_acao) OU por autorização
--                 individual (usuario_autorizacoes) — qualquer uma basta.
--   OBRIGATORIA — para qualquer perfil que não seja MASTER, a autorização
--                 individual é indispensável; permissoes_acao sozinha não
--                 basta, mesmo com permitido = true.
--
-- Sem CHECK IN (...) engessando os quatro perfis: a exceção de MASTER
-- (dispensa de exige_sst e de modo_autorizacao_individual) é decidida pela
-- camada de autorização, não pelo banco — este catálogo só descreve a
-- ação, nunca o perfil de quem a executa.
--
-- Nenhuma trigger de coerência entre este catálogo e o conteúdo futuro de
-- usuario_autorizacoes é criada nesta migration — avaliada e deliberadamente
-- não aprovada ainda.
ALTER TABLE acoes
  ADD COLUMN exige_sst BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN modo_autorizacao_individual VARCHAR(20) NOT NULL DEFAULT 'NENHUMA';

ALTER TABLE acoes
  ADD CONSTRAINT chk_acoes_modo_autorizacao_individual
    CHECK (modo_autorizacao_individual IN ('NENHUMA', 'ALTERNATIVA', 'OBRIGATORIA'));

-- Valores funcionais aprovados para as quatro ações que participam deste
-- desenho. As demais ações do catálogo (GERENCIAR_USUARIOS,
-- IMPORTAR_FUNCIONARIOS, ALTERAR_CONFIGURACOES, REDEFINIR_SENHA)
-- permanecem nos valores padrão (exige_sst = false, modo = NENHUMA) —
-- nenhuma expansão além do que foi aprovado nesta subetapa.
UPDATE acoes SET exige_sst = true, modo_autorizacao_individual = 'OBRIGATORIA'
  WHERE codigo IN ('APROVAR_SOLICITACAO', 'REPROVAR_SOLICITACAO');

UPDATE acoes SET modo_autorizacao_individual = 'ALTERNATIVA'
  WHERE codigo IN ('MOVIMENTAR_ESTOQUE', 'REALIZAR_ENTREGA');
