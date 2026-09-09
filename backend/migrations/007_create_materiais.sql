-- materiais: catálogo de EPIs (tipo, fabricante, Certificado de Aprovação,
-- prazo de uso e estoque mínimo para alertas de reposição).
-- prazo_uso_dias fica NULLABLE de propósito: existem EPIs cuja troca não é
-- baseada em periodicidade fixa. Quando preenchido, precisa ser positivo.
CREATE TABLE materiais (
  id              SERIAL PRIMARY KEY,
  empresa_id      INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  nome            VARCHAR(150) NOT NULL,
  tipo            VARCHAR(100),
  fabricante      VARCHAR(100),
  ca_numero       VARCHAR(20),
  ca_validade     DATE,
  prazo_uso_dias  INTEGER,
  unidade         VARCHAR(20) NOT NULL DEFAULT 'unidade',
  estoque_minimo  INTEGER NOT NULL DEFAULT 0,
  ativo           BOOLEAN NOT NULL DEFAULT true,
  criado_em       TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_materiais_prazo_uso_dias CHECK (prazo_uso_dias IS NULL OR prazo_uso_dias > 0),
  CONSTRAINT chk_materiais_estoque_minimo CHECK (estoque_minimo >= 0)
);

CREATE INDEX idx_materiais_empresa_id ON materiais (empresa_id);
CREATE INDEX idx_materiais_ca_numero ON materiais (ca_numero);

CREATE TRIGGER trg_materiais_atualizado_em
  BEFORE UPDATE ON materiais
  FOR EACH ROW EXECUTE FUNCTION set_atualizado_em();
