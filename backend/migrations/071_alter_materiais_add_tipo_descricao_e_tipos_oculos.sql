-- 071 — 12G-8: "Outros" com descrição própria e os dois tipos de óculos de proteção.
--
-- materiais.tipo_descricao existe só quando tipo = 'Outros': é a descrição que a
-- pessoa dá ao tipo, aparada, não vazia, até 100 caracteres. A relação
-- "Outros" ⇔ descrição entra NOT VALID de propósito: linha antiga que já tenha
-- 'Outros' gravado como texto livre não é convertida nem apagada por esta
-- migration; ao ser alterada, passa a cumprir a regra.
--
-- Óculos: 'Óculos de Proteção Incolor' e 'Óculos de Proteção Ampla Visão' são
-- tipos distintos; 'Óculos de proteção' continua reconhecido só para o que já
-- existe. Os CHECKs da 045 (materiais) e da 058 (cópia do material na entrega)
-- são substituídos por versões com os três nomes. As migrations antigas não mudam.

ALTER TABLE materiais
  ADD COLUMN tipo_descricao VARCHAR(100);

ALTER TABLE materiais
  ADD CONSTRAINT chk_materiais_tipo_descricao_formato
    CHECK (tipo_descricao IS NULL OR (btrim(tipo_descricao) = tipo_descricao AND char_length(tipo_descricao) > 0));

ALTER TABLE materiais
  ADD CONSTRAINT chk_materiais_tipo_descricao_so_outros
    CHECK ((tipo IS NOT DISTINCT FROM 'Outros') = (tipo_descricao IS NOT NULL)) NOT VALID;

ALTER TABLE materiais
  DROP CONSTRAINT chk_materiais_oculos_com_grau_so_oculos;

ALTER TABLE materiais
  ADD CONSTRAINT chk_materiais_oculos_com_grau_so_oculos
    CHECK (oculos_com_grau IS NULL
           OR (tipo IS NOT NULL AND tipo IN ('Óculos de proteção', 'Óculos de Proteção Incolor', 'Óculos de Proteção Ampla Visão')));

ALTER TABLE entregas_epi_itens
  DROP CONSTRAINT chk_entregas_epi_itens_material_oculos;

ALTER TABLE entregas_epi_itens
  ADD CONSTRAINT chk_entregas_epi_itens_material_oculos
    CHECK (material_oculos_com_grau IS NULL
           OR (material_tipo IS NOT NULL AND material_tipo IN ('Óculos de proteção', 'Óculos de Proteção Incolor', 'Óculos de Proteção Ampla Visão')));
