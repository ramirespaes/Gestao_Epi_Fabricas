-- Grade de tamanhos do material (Bloco 12, 12G-8).
--
-- GHE diz quais produtos o trabalhador pode usar; a GRADE diz quais tamanhos
-- são válidos para o produto; o ESTOQUE diz o que pode ser entregue agora. A
-- grade é uma propriedade explícita do material, definida no cadastro, e nunca
-- é deduzida dos lotes: um tamanho da grade pode estar sem estoque, e esta
-- tabela não guarda saldo nem movimentação.
--
-- Material com linhas aqui tem grade: a entrada de estoque e a solicitação só
-- aceitam tamanho da grade (a regra é do serviço). Material sem linhas é o
-- legado e continua com o comportamento anterior. Nada é preenchido a partir
-- dos lotes existentes.
--
-- O tamanho é o mesmo texto dos lotes (até 20 caracteres, sem espaço nas
-- pontas). Não se repete no material sem diferenciar maiúsculas, e a ordem de
-- exibição também é única. A empresa vem do material por FK composta, então
-- grade de material de outra empresa é estruturalmente impossível.
CREATE TABLE material_tamanhos (
  id           INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  empresa_id   INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  material_id  INTEGER NOT NULL,
  tamanho      VARCHAR(20) NOT NULL,
  ordem        SMALLINT NOT NULL,
  criado_em    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fk_material_tamanhos_material_mesma_empresa
    FOREIGN KEY (empresa_id, material_id)
    REFERENCES materiais (empresa_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT uq_material_tamanhos_ordem UNIQUE (empresa_id, material_id, ordem),
  CONSTRAINT chk_material_tamanhos_tamanho CHECK (btrim(tamanho) = tamanho AND char_length(tamanho) > 0),
  CONSTRAINT chk_material_tamanhos_ordem CHECK (ordem >= 1)
);

CREATE UNIQUE INDEX uq_material_tamanhos_tamanho
  ON material_tamanhos (empresa_id, material_id, upper(tamanho));

-- Só material que exige tamanho tem grade. O material é lido com FOR SHARE: a
-- troca da classificação (que trava o material FOR UPDATE) espera até o fim
-- desta gravação, e a que chega depois da troca vê o valor novo. A conferência
-- contrária, recusar sair de "possui tamanhos" com grade gravada, é do serviço
-- de materiais. Material de outra empresa ou inexistente: a FK composta recusa.
CREATE FUNCTION validar_material_da_grade() RETURNS TRIGGER AS $$
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
    RAISE EXCEPTION 'o material % não exige tamanho: não tem grade', NEW.material_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_material_tamanhos_validar_material
  BEFORE INSERT OR UPDATE OF empresa_id, material_id ON material_tamanhos
  FOR EACH ROW EXECUTE FUNCTION validar_material_da_grade();
