-- grupo_permissoes_recurso / grupo_permissoes_acao: permissões
-- configuráveis por grupo de acesso (020), na mesma dimensão de
-- permissoes_recurso (009) e permissoes_acao (010), mas por grupo em vez
-- de por perfil (RBAC — Bloco 8, Incremento 8, Etapa 5A, Subetapa 3B).
--
-- Tri-state, por operação/ação, de propósito — ao contrário das tabelas
-- por perfil (booleanos NOT NULL, sempre com um valor explícito):
--   NULL  = o grupo não tem opinião; herda a decisão do perfil;
--   TRUE  = o grupo concede, mesmo que o perfil não conceda;
--   FALSE = o grupo nega, mesmo que o perfil conceda.
-- Cada operação de grupo_permissoes_recurso é independente das demais —
-- ajustar "pode_editar" não reescreve nem presume nada sobre
-- "pode_visualizar"/"pode_criar"/"pode_excluir" da mesma linha.
--
-- Nesta migration as tabelas só são criadas: nenhuma leitura, middleware
-- ou rota as consulta ainda. A existência de uma linha aqui não produz
-- nenhum efeito sobre autorização nesta etapa — isso fica para uma
-- subetapa futura, quando o middleware for evoluído para consultá-las.
--
-- FK composta de isolamento multiempresa, mesmo padrão de vinculo_sst
-- (018) e usuario_autorizacoes (019): empresa_id só existe para formar a
-- FK composta contra grupos_acesso(empresa_id, id) — validade de
-- empresa_id em si já é garantida transitivamente por essa FK, sem
-- precisar de uma segunda FK direta para empresas.
--
-- ON DELETE CASCADE (diferente de usuarios.grupo_acesso_id, que usa
-- RESTRICT em 020): estas duas tabelas são dados PRÓPRIOS do grupo (a
-- configuração dele), não uma referência externa — se um grupo um dia for
-- removido fisicamente (hoje impedido enquanto tiver usuário vinculado,
-- por RESTRICT em 020), sua própria configuração de permissão deve
-- desaparecer junto, não impedir a remoção nem sobreviver órfã.
CREATE TABLE grupo_permissoes_recurso (
  id               SERIAL PRIMARY KEY,
  empresa_id       INTEGER NOT NULL,
  grupo_acesso_id  INTEGER NOT NULL,
  recurso          VARCHAR(60) NOT NULL,
  pode_visualizar  BOOLEAN,
  pode_criar       BOOLEAN,
  pode_editar      BOOLEAN,
  pode_excluir     BOOLEAN,
  criado_em        TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_grupo_permissoes_recurso_grupo_recurso UNIQUE (grupo_acesso_id, recurso),
  CONSTRAINT fk_grupo_permissoes_recurso_grupo_mesma_empresa
    FOREIGN KEY (empresa_id, grupo_acesso_id)
    REFERENCES grupos_acesso (empresa_id, id) ON DELETE CASCADE
);

CREATE TRIGGER trg_grupo_permissoes_recurso_atualizado_em
  BEFORE UPDATE ON grupo_permissoes_recurso
  FOR EACH ROW EXECUTE FUNCTION set_atualizado_em();

CREATE TABLE grupo_permissoes_acao (
  id               SERIAL PRIMARY KEY,
  empresa_id       INTEGER NOT NULL,
  grupo_acesso_id  INTEGER NOT NULL,
  acao_codigo      VARCHAR(60) NOT NULL REFERENCES acoes(codigo) ON DELETE RESTRICT ON UPDATE CASCADE,
  permitido        BOOLEAN,
  criado_em        TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_grupo_permissoes_acao_grupo_acao UNIQUE (grupo_acesso_id, acao_codigo),
  CONSTRAINT fk_grupo_permissoes_acao_grupo_mesma_empresa
    FOREIGN KEY (empresa_id, grupo_acesso_id)
    REFERENCES grupos_acesso (empresa_id, id) ON DELETE CASCADE
);

-- Útil para consultas do tipo "quem usa esta ação" antes de desativá-la em
-- "acoes" — mesmo raciocínio de idx_permissoes_acao_acao_codigo (010); não
-- é coberto pela UNIQUE acima, que tem grupo_acesso_id como líder.
CREATE INDEX idx_grupo_permissoes_acao_acao_codigo ON grupo_permissoes_acao (acao_codigo);

CREATE TRIGGER trg_grupo_permissoes_acao_atualizado_em
  BEFORE UPDATE ON grupo_permissoes_acao
  FOR EACH ROW EXECUTE FUNCTION set_atualizado_em();
