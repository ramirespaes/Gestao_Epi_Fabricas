-- grupos_homogeneos_exposicao (GHE): agrupa funcionários expostos às mesmas
-- condições de risco (setor/função/riscos), servindo de base para regras de
-- elegibilidade de EPI por grupo em vez de por funcionário individual.
--
-- uq_ghe_empresa_id (empresa_id, id) existe só para permitir a FK composta
-- de funcionarios (empresa_id, grupo_homogeneo_id) — é o que garante, no
-- banco, que um funcionário só pode se vincular a um GHE da própria empresa.
CREATE TABLE grupos_homogeneos_exposicao (
  id             SERIAL PRIMARY KEY,
  empresa_id     INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  nome           VARCHAR(150) NOT NULL,
  descricao      TEXT,
  setor          VARCHAR(100),
  funcao         VARCHAR(100),
  riscos         TEXT,
  ativo          BOOLEAN NOT NULL DEFAULT true,
  criado_em      TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_ghe_empresa_nome UNIQUE (empresa_id, nome),
  CONSTRAINT uq_ghe_empresa_id UNIQUE (empresa_id, id)
);

CREATE TRIGGER trg_ghe_atualizado_em
  BEFORE UPDATE ON grupos_homogeneos_exposicao
  FOR EACH ROW EXECUTE FUNCTION set_atualizado_em();
