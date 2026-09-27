-- Óculos de proteção com ou sem grau.
--
-- oculos_com_grau só vale para o tipo canônico "Óculos de proteção", o mesmo
-- texto da lista de tipos da tela: true é com grau, false é sem grau. NULL é
-- material de outro tipo ou óculos antigo que ainda não foi classificado.
-- Não há DEFAULT e nenhum material existente muda.

ALTER TABLE materiais
  ADD COLUMN oculos_com_grau BOOLEAN;

-- Material que não é óculos de proteção nunca guarda essa informação. Comparo
-- o tipo exato, nunca o nome do material. O tipo NULL precisa ser recusado
-- por extenso: sem isso a comparação daria NULL, e o CHECK aceitaria.
ALTER TABLE materiais
  ADD CONSTRAINT chk_materiais_oculos_com_grau_so_oculos
    CHECK (oculos_com_grau IS NULL OR (tipo IS NOT NULL AND tipo = 'Óculos de proteção'));
