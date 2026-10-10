-- Código do GHE e vínculo GHE × tipo do catálogo (evolução GHE / importação GHE-EPI, Incremento 1).
--
-- ESTRITAMENTE ADITIVA. Não move, não recalcula e não apaga dado algum: nenhum UPDATE, DELETE, INSERT, TRUNCATE ou DROP.
-- Nenhum backfill. ghe_materiais, funcionarios, materiais, tipos_material, entregas, solicitações e os snapshots
-- históricos (previsto_no_ghe, ghe_nome) não são tocados. Esta migration não altera nenhuma outra tabela existente.
--
-- 1) grupos_homogeneos_exposicao.codigo
--    Identificação administrativa do GHE (ex.: GHE-002). NULL no banco apenas para preservar os GHEs legados, anteriores
--    a esta migration. Para GHE NOVO o código é obrigatório no serviço/API e na interface (Incremento 2), e o formato
--    "GHE-" + 3 a 6 dígitos é regra do serviço. No banco vale só a forma canônica: aparado, maiúsculo, de 1 a 30
--    caracteres e sem caractere de controle. A unicidade é por empresa e só quando o código existe: empresas
--    diferentes podem repetir o mesmo código e vários GHEs legados sem código convivem.
--
-- 2) ghe_tipos_material
--    Regra principal dos EPIs de um GHE: o GHE é ligado a um TIPO do catálogo da empresa (tipos_material, 082), não a um
--    material de estoque concreto. A classificação diz se o EPI é OBRIGATORIO ou NAO_OBRIGATORIO naquele GHE. Os dois
--    contam como "previsto no GHE" (a regra de previsto_no_ghe é do Incremento 4). O vínculo direto GHE × material
--    (ghe_materiais) continua existindo como exceção e legado. A tabela nasce VAZIA: nenhum vínculo é inventado a
--    partir de ghe_materiais.
--
--    ISOLAMENTO MULTIEMPRESA NO BANCO: as duas FKs compostas garantem que o GHE e o tipo pertencem à MESMA empresa da
--    linha (mesmo desenho de ghe_materiais, 041). ON DELETE RESTRICT: GHE e tipo são inativados, nunca apagados. O
--    tipo inativado continua ligado ao GHE. empresa_id segue o padrão das tabelas de negócio (CASCADE a partir de
--    empresas). idx_ghe_tipos_material_tipo atende a consulta pelo lado do tipo ("em quais GHEs este tipo está"); o
--    lado do GHE é coberto pelo índice da própria UNIQUE (prefixo empresa_id, grupo_homogeneo_id).

ALTER TABLE grupos_homogeneos_exposicao
  ADD COLUMN codigo VARCHAR(30);

ALTER TABLE grupos_homogeneos_exposicao
  ADD CONSTRAINT chk_ghe_codigo_canonico CHECK (
    codigo IS NULL
    OR (codigo = btrim(codigo)
        AND codigo = upper(codigo)
        AND char_length(codigo) BETWEEN 1 AND 30
        AND codigo !~ '[[:cntrl:]]'));

CREATE UNIQUE INDEX uq_ghe_empresa_codigo
  ON grupos_homogeneos_exposicao (empresa_id, codigo)
  WHERE codigo IS NOT NULL;

CREATE TABLE ghe_tipos_material (
  id                  SERIAL PRIMARY KEY,
  empresa_id          INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  grupo_homogeneo_id  INTEGER NOT NULL,
  tipo_material_id    INTEGER NOT NULL,
  classificacao       VARCHAR(20) NOT NULL,
  criado_em           TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_ghe_tipos_material UNIQUE (empresa_id, grupo_homogeneo_id, tipo_material_id),
  CONSTRAINT chk_ghe_tipos_material_classificacao CHECK (classificacao IN ('OBRIGATORIO', 'NAO_OBRIGATORIO')),
  CONSTRAINT fk_ghe_tipos_material_ghe_mesma_empresa
    FOREIGN KEY (empresa_id, grupo_homogeneo_id)
    REFERENCES grupos_homogeneos_exposicao (empresa_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_ghe_tipos_material_tipo_mesma_empresa
    FOREIGN KEY (empresa_id, tipo_material_id)
    REFERENCES tipos_material (empresa_id, id)
    ON DELETE RESTRICT
);

CREATE INDEX idx_ghe_tipos_material_tipo ON ghe_tipos_material (empresa_id, tipo_material_id);

CREATE TRIGGER trg_ghe_tipos_material_atualizado_em
  BEFORE UPDATE ON ghe_tipos_material
  FOR EACH ROW EXECUTE FUNCTION set_atualizado_em();
