-- Exigência de tamanho explícita no material.
--
-- exige_tamanho diz se as novas entradas usam tamanho: true exige, false não
-- usa, NULL é material que ainda não foi classificado. Eu não classifico nada
-- aqui: os materiais que já existem ficam NULL, e os lotes antigos continuam
-- exatamente como estão, inclusive os de tamanho "Único".

ALTER TABLE materiais
  ADD COLUMN exige_tamanho BOOLEAN;

-- Lote de material sem tamanho guarda NULL, nunca um valor inventado.
ALTER TABLE estoque_lotes
  ALTER COLUMN tamanho DROP NOT NULL;

ALTER TABLE estoque_lotes
  DROP CONSTRAINT chk_estoque_lotes_tamanho,
  ADD CONSTRAINT chk_estoque_lotes_tamanho
    CHECK (tamanho IS NULL OR (btrim(tamanho) = tamanho AND char_length(tamanho) > 0));

-- A entrada operacional segue a classificação do material. O saldo inicial
-- migrado fica de fora, porque é histórico. Leio o material com FOR SHARE
-- para a classificação não mudar antes do fim desta entrada.
CREATE FUNCTION validar_tamanho_da_entrada() RETURNS TRIGGER AS $$
DECLARE
  exige BOOLEAN;
BEGIN
  SELECT exige_tamanho INTO exige
    FROM materiais
   WHERE empresa_id = NEW.empresa_id AND id = NEW.material_id
   FOR SHARE;
  IF NOT FOUND THEN
    -- Material de outra empresa ou inexistente: a FK composta recusa.
    RETURN NEW;
  END IF;
  IF exige IS NULL THEN
    RAISE EXCEPTION 'o material % não foi classificado quanto ao tamanho: a entrada fica bloqueada', NEW.material_id;
  ELSIF exige AND NEW.tamanho IS NULL THEN
    RAISE EXCEPTION 'o material % exige tamanho na entrada', NEW.material_id;
  ELSIF NOT exige AND NEW.tamanho IS NOT NULL THEN
    RAISE EXCEPTION 'o material % não usa tamanho na entrada', NEW.material_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_estoque_lotes_validar_tamanho_da_entrada
  BEFORE INSERT ON estoque_lotes
  FOR EACH ROW
  WHEN (NEW.origem = 'ENTRADA')
  EXECUTE FUNCTION validar_tamanho_da_entrada();
