-- estoque_tamanhos: saldo de estoque de cada material, por tamanho/grade.
-- Sem empresa_id próprio: o isolamento por empresa já vem de material_id ->
-- materiais.empresa_id; duplicar a coluna aqui só criaria risco de
-- inconsistência (registro apontando para empresa diferente da do material).
CREATE TABLE estoque_tamanhos (
  id             SERIAL PRIMARY KEY,
  material_id    INTEGER NOT NULL REFERENCES materiais(id) ON DELETE CASCADE,
  tamanho        VARCHAR(20) NOT NULL,
  quantidade     INTEGER NOT NULL DEFAULT 0,
  criado_em      TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_estoque_tamanhos_material_tamanho UNIQUE (material_id, tamanho),
  CONSTRAINT chk_estoque_tamanhos_quantidade CHECK (quantidade >= 0)
);

-- Nenhum índice extra em material_id: a UNIQUE acima já cobre esse lookup
-- (material_id é a coluna líder da constraint composta).

CREATE TRIGGER trg_estoque_tamanhos_atualizado_em
  BEFORE UPDATE ON estoque_tamanhos
  FOR EACH ROW EXECUTE FUNCTION set_atualizado_em();
