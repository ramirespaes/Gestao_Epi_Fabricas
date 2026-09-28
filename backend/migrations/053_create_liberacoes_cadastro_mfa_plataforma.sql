-- liberacoes_cadastro_mfa_plataforma: autorização de uso único, emitida
-- pelo CLI, para um administrador sem fator ativo cadastrar o TOTP. É o que
-- impede o primeiro cadastro de ser "confiar em quem chegar primeiro": só a
-- senha não basta, é preciso o código entregue fora de banda.
--
-- Só o hash fica aqui: SHA-256 hexadecimal de
-- "safework|mfa|liberacao|f1|a<administrador_id>|<código canônico>"
-- (src/security/codigos-mfa.js). O domínio "liberacao" separa estes códigos
-- dos recovery codes, que nunca valem como liberação.
--
-- Situação derivada, sem coluna de status:
--   ABERTA     consumida_em e revogada_em nulos (vencida ou não)
--   CONSUMIDA  consumida_em preenchido
--   REVOGADA   revogada_em preenchido
-- No máximo uma aberta por administrador; emitir outra exige revogar antes a
-- aberta, mesmo vencida. O consumo respeita o prazo pelo relógio do banco.
CREATE TABLE liberacoes_cadastro_mfa_plataforma (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  administrador_id  INTEGER NOT NULL REFERENCES administradores_plataforma(id) ON DELETE RESTRICT,
  codigo_hash       CHAR(64) NOT NULL,
  origem            VARCHAR(20) NOT NULL,
  criado_em         TIMESTAMPTZ NOT NULL DEFAULT now(),
  expira_em         TIMESTAMPTZ NOT NULL,
  consumida_em      TIMESTAMPTZ,
  revogada_em       TIMESTAMPTZ,
  motivo_revogacao  VARCHAR(30),

  CONSTRAINT uq_liberacoes_cadastro_mfa_plataforma_codigo_hash UNIQUE (codigo_hash),
  CONSTRAINT chk_liberacoes_cadastro_mfa_plataforma_codigo_hash_formato
    CHECK (codigo_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_liberacoes_cadastro_mfa_plataforma_origem
    CHECK (origem IN ('CLI_LIBERACAO', 'CLI_CRIACAO', 'CLI_RESET')),
  CONSTRAINT chk_liberacoes_cadastro_mfa_plataforma_expira_apos_criacao
    CHECK (expira_em > criado_em),
  -- Consumida e revogada são desfechos mutuamente exclusivos.
  CONSTRAINT chk_liberacoes_cadastro_mfa_plataforma_desfecho_unico
    CHECK (NOT (consumida_em IS NOT NULL AND revogada_em IS NOT NULL)),
  CONSTRAINT chk_liberacoes_cadastro_mfa_plataforma_revogacao_coerente
    CHECK ((revogada_em IS NULL) = (motivo_revogacao IS NULL)),
  CONSTRAINT chk_liberacoes_cadastro_mfa_plataforma_motivo_formato
    CHECK (motivo_revogacao IS NULL OR motivo_revogacao ~ '^[A-Z_]{1,30}$')
);

CREATE UNIQUE INDEX uq_liberacoes_cadastro_mfa_plataforma_aberta
  ON liberacoes_cadastro_mfa_plataforma (administrador_id)
  WHERE consumida_em IS NULL AND revogada_em IS NULL;
