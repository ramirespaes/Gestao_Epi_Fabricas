-- ghe_materiais: vínculo GHE ↔ EPI (material) — Bloco 9, Etapa C, Parte C5.
--
-- Relação simples "EPIs vinculados ao GHE": presença da linha = vínculo.
-- Sem obrigatório/elegível, sem tipo de vínculo e sem periodicidade própria
-- (a periodicidade continua em materiais.prazo_uso_dias). Sem coluna
-- `ativo`: remover o vínculo apaga a linha; criação e remoção ficam
-- registradas em logs_auditoria (mecanismo existente, migrations 012/014).
--
-- ISOLAMENTO MULTIEMPRESA NO BANCO: as duas FKs compostas garantem que o
-- GHE e o material pertencem à MESMA empresa da linha — mesmo desenho de
-- fk_funcionarios_ghe_mesma_empresa (006). Para a FK composta de
-- materiais, esta migration acrescenta uq_materiais_empresa_id
-- (empresa_id, id), no mesmo padrão de uq_ghe_empresa_id (004): constraint
-- nova sobre a tabela histórica 007, que permanece intocada. Não altera
-- dados — `id` já é chave primária, então (empresa_id, id) já é único.
--
-- ON DELETE RESTRICT: GHE e material são inativados, nunca apagados, pela
-- aplicação; um vínculo nunca desaparece por exclusão física de uma das
-- pontas. empresa_id segue o padrão de todas as tabelas de negócio
-- (ON DELETE CASCADE a partir de empresas).
--
-- uq_ghe_materiais impede vínculo duplicado. idx_ghe_materiais_material
-- atende a consulta pelo lado do material ("em quais GHEs este EPI está");
-- o lado do GHE já é coberto pelo índice da própria UNIQUE (prefixo
-- empresa_id, grupo_homogeneo_id).
ALTER TABLE materiais
  ADD CONSTRAINT uq_materiais_empresa_id UNIQUE (empresa_id, id);

CREATE TABLE ghe_materiais (
  id                  SERIAL PRIMARY KEY,
  empresa_id          INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  grupo_homogeneo_id  INTEGER NOT NULL,
  material_id         INTEGER NOT NULL,
  criado_em           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_ghe_materiais UNIQUE (empresa_id, grupo_homogeneo_id, material_id),
  CONSTRAINT fk_ghe_materiais_ghe_mesma_empresa
    FOREIGN KEY (empresa_id, grupo_homogeneo_id)
    REFERENCES grupos_homogeneos_exposicao (empresa_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_ghe_materiais_material_mesma_empresa
    FOREIGN KEY (empresa_id, material_id)
    REFERENCES materiais (empresa_id, id)
    ON DELETE RESTRICT
);

CREATE INDEX idx_ghe_materiais_material ON ghe_materiais (empresa_id, material_id);
