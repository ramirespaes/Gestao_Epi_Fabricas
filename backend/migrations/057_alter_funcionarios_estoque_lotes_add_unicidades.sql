-- Chaves que as FKs compostas da entrega de EPI (058 e 059) referenciam.
--
-- funcionarios (empresa_id, id): a ficha do trabalhador só pode apontar para
-- funcionário da mesma empresa. estoque_lotes (empresa_id, id, material_id):
-- o item da entrega declara o material e o lote, e a FK prova que o lote é
-- daquele material e daquela empresa — sem gatilho.

ALTER TABLE funcionarios
  ADD CONSTRAINT uq_funcionarios_empresa_id UNIQUE (empresa_id, id);

ALTER TABLE estoque_lotes
  ADD CONSTRAINT uq_estoque_lotes_empresa_id_material UNIQUE (empresa_id, id, material_id);
