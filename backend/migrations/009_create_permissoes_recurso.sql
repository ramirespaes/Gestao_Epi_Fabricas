-- permissoes_recurso: o que cada perfil pode ver/criar/editar/excluir por
-- página/módulo (recurso) — a permissão de "onde entrar". Substitui, no
-- banco, a matriz hoje hardcoded em js/main.js (rolePermissions/allPages).
-- "recurso" usa os mesmos identificadores de página já usados no front
-- ('dashboard', 'materials', 'userAdmin' etc.).
--
-- Ver também permissoes_acao (a permissão de "o que fazer" dentro do
-- sistema) — as duas dimensões foram deliberadamente separadas em tabelas
-- distintas em vez de uma só tabela genérica.
CREATE TABLE permissoes_recurso (
  id               SERIAL PRIMARY KEY,
  empresa_id       INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  perfil           VARCHAR(20) NOT NULL REFERENCES perfis(codigo) ON DELETE RESTRICT ON UPDATE CASCADE,
  recurso          VARCHAR(60) NOT NULL,
  pode_visualizar  BOOLEAN NOT NULL DEFAULT true,
  pode_criar       BOOLEAN NOT NULL DEFAULT false,
  pode_editar      BOOLEAN NOT NULL DEFAULT false,
  pode_excluir     BOOLEAN NOT NULL DEFAULT false,
  criado_em        TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_permissoes_recurso_empresa_perfil_recurso UNIQUE (empresa_id, perfil, recurso)
);

CREATE TRIGGER trg_permissoes_recurso_atualizado_em
  BEFORE UPDATE ON permissoes_recurso
  FOR EACH ROW EXECUTE FUNCTION set_atualizado_em();
