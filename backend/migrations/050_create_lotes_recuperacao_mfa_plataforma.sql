-- lotes_recuperacao_mfa_plataforma: cada geração de recovery codes de um
-- administrador é um lote. Um código só vale enquanto o seu lote está
-- ATIVO, então revogar o lote invalida todos os códigos restantes de uma
-- vez. O índice único parcial garante no banco um único lote ATIVO por
-- administrador: regenerar é revogar o atual e criar outro, na mesma
-- transação.
CREATE TABLE lotes_recuperacao_mfa_plataforma (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  administrador_id  INTEGER NOT NULL REFERENCES administradores_plataforma(id) ON DELETE RESTRICT,
  estado            VARCHAR(20) NOT NULL,
  criado_em         TIMESTAMPTZ NOT NULL DEFAULT now(),
  revogado_em       TIMESTAMPTZ,
  motivo_revogacao  VARCHAR(30),

  -- Base da FK composta dos códigos: o código é sempre do dono do lote.
  CONSTRAINT uq_lotes_recuperacao_mfa_plataforma_id_administrador UNIQUE (id, administrador_id),
  CONSTRAINT chk_lotes_recuperacao_mfa_plataforma_estado CHECK (estado IN ('ATIVO', 'REVOGADO')),
  CONSTRAINT chk_lotes_recuperacao_mfa_plataforma_revogacao_coerente
    CHECK (
      (estado = 'ATIVO' AND revogado_em IS NULL AND motivo_revogacao IS NULL)
      OR (estado = 'REVOGADO' AND revogado_em IS NOT NULL AND motivo_revogacao IS NOT NULL)
    ),
  CONSTRAINT chk_lotes_recuperacao_mfa_plataforma_motivo_formato
    CHECK (motivo_revogacao IS NULL OR motivo_revogacao ~ '^[A-Z_]{1,30}$')
);

CREATE UNIQUE INDEX uq_lotes_recuperacao_mfa_plataforma_ativo
  ON lotes_recuperacao_mfa_plataforma (administrador_id) WHERE estado = 'ATIVO';
