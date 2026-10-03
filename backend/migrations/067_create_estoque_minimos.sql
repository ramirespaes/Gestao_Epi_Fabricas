-- Mínimo de estoque por tamanho.
--
-- O mínimo padrão continua em materiais.estoque_minimo e vale para o tamanho
-- que não tem linha aqui. Esta tabela guarda só a SOBRESCRITA de um tamanho:
-- a linha com mínimo 0 significa "este tamanho não tem mínimo" e prevalece
-- sobre o padrão; a ausência de linha herda o padrão. Material que não usa
-- tamanho não tem linha aqui: o próprio padrão do cadastro é o mínimo do seu
-- único par. O gatilho abaixo só aceita material com exige_tamanho = true.
--
-- É configuração, não saldo nem movimentação: nada aqui é somado ao estoque, e
-- a gravação não toma trava de par. O mínimo é comparado, na leitura, com o
-- saldo livre do par (empresa, material, tamanho), nunca com o físico.
--
-- O tamanho é o mesmo texto dos lotes (até 20 caracteres, sem espaço nas
-- pontas), e a UNIQUE comum por empresa, material e tamanho serve também ao
-- ON CONFLICT da gravação. A empresa vem do material por FK composta, então
-- um mínimo de material de outra empresa é estruturalmente impossível.
CREATE TABLE estoque_minimos (
  id             INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  empresa_id     INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  material_id    INTEGER NOT NULL,
  tamanho        VARCHAR(20) NOT NULL,
  minimo         INTEGER NOT NULL,
  criado_em      TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_estoque_minimos_par UNIQUE (empresa_id, material_id, tamanho),
  CONSTRAINT fk_estoque_minimos_material_mesma_empresa
    FOREIGN KEY (empresa_id, material_id)
    REFERENCES materiais (empresa_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT chk_estoque_minimos_minimo CHECK (minimo >= 0),
  CONSTRAINT chk_estoque_minimos_tamanho CHECK (btrim(tamanho) = tamanho AND char_length(tamanho) > 0)
);

CREATE TRIGGER trg_estoque_minimos_atualizado_em
  BEFORE UPDATE ON estoque_minimos
  FOR EACH ROW EXECUTE FUNCTION set_atualizado_em();

-- Só material que exige tamanho recebe mínimo por tamanho. O material é lido com
-- FOR SHARE: a troca da classificação (que trava o material FOR UPDATE) espera
-- até o fim desta gravação, e a gravação que chega depois da troca vê o valor
-- novo. A conferência contrária, recusar a troca enquanto houver mínimo próprio,
-- é do serviço de materiais. Material de outra empresa ou inexistente: a FK
-- composta recusa.
CREATE FUNCTION validar_material_do_estoque_minimo() RETURNS TRIGGER AS $$
DECLARE
  exige BOOLEAN;
BEGIN
  SELECT exige_tamanho INTO exige
    FROM materiais
   WHERE empresa_id = NEW.empresa_id AND id = NEW.material_id
   FOR SHARE;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF exige IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'o material % não exige tamanho: o mínimo dele é o padrão do cadastro', NEW.material_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_estoque_minimos_validar_material
  BEFORE INSERT OR UPDATE OF empresa_id, material_id ON estoque_minimos
  FOR EACH ROW EXECUTE FUNCTION validar_material_do_estoque_minimo();
