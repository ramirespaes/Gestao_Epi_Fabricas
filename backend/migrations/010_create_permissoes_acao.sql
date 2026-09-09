-- permissoes_acao: se um perfil PODE executar uma ação de negócio específica
-- (aprovar solicitação, movimentar estoque, redefinir senha etc.) — a
-- permissão de "o que fazer", separada da permissão de recurso ("onde
-- entrar", em permissoes_recurso). Corresponde ao conceito de
-- blockedActions/actionPermissions que hoje só existe hardcoded em
-- js/main.js.
--
-- As ações em si vêm do catálogo "acoes" (tabela), não de um CHECK IN (...)
-- aqui — uma ação nova é um INSERT em acoes, sem alterar esta estrutura.
CREATE TABLE permissoes_acao (
  id             SERIAL PRIMARY KEY,
  empresa_id     INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  perfil         VARCHAR(20) NOT NULL REFERENCES perfis(codigo) ON DELETE RESTRICT ON UPDATE CASCADE,
  acao_codigo    VARCHAR(60) NOT NULL REFERENCES acoes(codigo) ON DELETE RESTRICT ON UPDATE CASCADE,
  permitido      BOOLEAN NOT NULL DEFAULT true,
  criado_em      TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_permissoes_acao_empresa_perfil_acao UNIQUE (empresa_id, perfil, acao_codigo)
);

-- Útil para consultas do tipo "quem usa esta ação" antes de desativá-la em
-- "acoes" — não é coberto pela UNIQUE acima, que tem empresa_id como líder.
CREATE INDEX idx_permissoes_acao_acao_codigo ON permissoes_acao (acao_codigo);

CREATE TRIGGER trg_permissoes_acao_atualizado_em
  BEFORE UPDATE ON permissoes_acao
  FOR EACH ROW EXECUTE FUNCTION set_atualizado_em();
