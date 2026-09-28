-- fatores_mfa_plataforma: segundo fator dos administradores da plataforma.
-- Por ora só TOTP. Outro tipo (WebAuthn) entra por migration aditiva e
-- convive com este: a unicidade abaixo vale só para tipo = 'TOTP'.
--
-- O secret do TOTP nunca fica em claro. É cifrado com AES-256-GCM
-- (src/security/mfa-cripto.js): nonce de 12 bytes e, no formato 1, os 20
-- bytes cifrados seguidos da tag de 16. O AAD amarra o envelope ao
-- administrador, ao fator_uid e às versões de formato e de chave, por isso
-- fator_uid nasce na aplicação, antes do INSERT.
--
-- Ciclo de vida: PENDENTE (cadastro em curso, com prazo) -> ATIVO ->
-- REVOGADO. Revogar apaga nonce e ciphertext na mesma instrução: linha
-- revogada não depende de chave e não impede aposentar uma versão.
--
-- totp_ultimo_step_aceito é o anti-replay: só avança por UPDATE condicional
-- (step novo > último aceito), no repositório.
CREATE TABLE fatores_mfa_plataforma (
  id                       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fator_uid                UUID NOT NULL,
  administrador_id         INTEGER NOT NULL REFERENCES administradores_plataforma(id) ON DELETE RESTRICT,
  tipo                     VARCHAR(20) NOT NULL,
  estado                   VARCHAR(20) NOT NULL,
  totp_formato_versao      SMALLINT,
  totp_chave_versao        SMALLINT,
  totp_nonce               BYTEA,
  totp_segredo_cifrado     BYTEA,
  totp_algoritmo           VARCHAR(10),
  totp_digitos             SMALLINT,
  totp_periodo             SMALLINT,
  totp_ultimo_step_aceito  BIGINT,
  criado_em                TIMESTAMPTZ NOT NULL DEFAULT now(),
  pendente_expira_em       TIMESTAMPTZ,
  ativado_em               TIMESTAMPTZ,
  revogado_em              TIMESTAMPTZ,
  motivo_revogacao         VARCHAR(30),
  atualizado_em            TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT uq_fatores_mfa_plataforma_fator_uid UNIQUE (fator_uid),
  -- Base das FKs compostas dos desafios: o fator de um desafio é sempre do
  -- mesmo administrador.
  CONSTRAINT uq_fatores_mfa_plataforma_id_administrador UNIQUE (id, administrador_id),
  CONSTRAINT chk_fatores_mfa_plataforma_tipo CHECK (tipo IN ('TOTP')),
  CONSTRAINT chk_fatores_mfa_plataforma_estado CHECK (estado IN ('PENDENTE', 'ATIVO', 'REVOGADO')),
  CONSTRAINT chk_fatores_mfa_plataforma_estado_coerente
    CHECK (
      (estado = 'PENDENTE' AND pendente_expira_em IS NOT NULL AND ativado_em IS NULL
        AND revogado_em IS NULL AND motivo_revogacao IS NULL)
      OR (estado = 'ATIVO' AND ativado_em IS NOT NULL AND revogado_em IS NULL AND motivo_revogacao IS NULL)
      OR (estado = 'REVOGADO' AND revogado_em IS NOT NULL AND motivo_revogacao IS NOT NULL)
    ),
  CONSTRAINT chk_fatores_mfa_plataforma_pendente_expira_apos_criacao
    CHECK (pendente_expira_em IS NULL OR pendente_expira_em > criado_em),
  CONSTRAINT chk_fatores_mfa_plataforma_motivo_formato
    CHECK (motivo_revogacao IS NULL OR motivo_revogacao ~ '^[A-Z_]{1,30}$'),
  -- Colunas totp_* só existem em fator TOTP.
  CONSTRAINT chk_fatores_mfa_plataforma_totp_so_no_tipo
    CHECK (
      tipo = 'TOTP'
      OR (totp_formato_versao IS NULL AND totp_chave_versao IS NULL AND totp_nonce IS NULL
        AND totp_segredo_cifrado IS NULL AND totp_algoritmo IS NULL AND totp_digitos IS NULL
        AND totp_periodo IS NULL AND totp_ultimo_step_aceito IS NULL)
    ),
  -- TOTP em uso tem envelope e parâmetros completos; o step nasce na ativação.
  CONSTRAINT chk_fatores_mfa_plataforma_totp_completo
    CHECK (
      NOT (tipo = 'TOTP' AND estado IN ('PENDENTE', 'ATIVO'))
      OR (totp_formato_versao IS NOT NULL AND totp_chave_versao IS NOT NULL AND totp_nonce IS NOT NULL
        AND totp_segredo_cifrado IS NOT NULL AND totp_algoritmo IS NOT NULL AND totp_digitos IS NOT NULL
        AND totp_periodo IS NOT NULL)
    ),
  -- Revogado não guarda material cifrado (crypto-shredding).
  CONSTRAINT chk_fatores_mfa_plataforma_revogado_sem_segredo
    CHECK (estado <> 'REVOGADO' OR (totp_nonce IS NULL AND totp_segredo_cifrado IS NULL)),
  CONSTRAINT chk_fatores_mfa_plataforma_envelope_completo
    CHECK ((totp_nonce IS NULL) = (totp_segredo_cifrado IS NULL)),
  CONSTRAINT chk_fatores_mfa_plataforma_versoes
    CHECK (
      (totp_formato_versao IS NULL OR totp_formato_versao BETWEEN 1 AND 9999)
      AND (totp_chave_versao IS NULL OR totp_chave_versao BETWEEN 1 AND 9999)
    ),
  CONSTRAINT chk_fatores_mfa_plataforma_nonce_tamanho
    CHECK (totp_nonce IS NULL OR octet_length(totp_nonce) = 12),
  -- Só o formato 1 existe: 20 bytes cifrados + 16 de tag. Outro formato
  -- exige migration própria.
  CONSTRAINT chk_fatores_mfa_plataforma_segredo_formato
    CHECK (
      totp_segredo_cifrado IS NULL
      OR (totp_formato_versao IS NOT NULL AND totp_formato_versao = 1 AND octet_length(totp_segredo_cifrado) = 36)
    ),
  CONSTRAINT chk_fatores_mfa_plataforma_totp_parametros
    CHECK (
      (totp_algoritmo IS NULL OR totp_algoritmo = 'SHA1')
      AND (totp_digitos IS NULL OR totp_digitos = 6)
      AND (totp_periodo IS NULL OR totp_periodo = 30)
    ),
  CONSTRAINT chk_fatores_mfa_plataforma_step
    CHECK (totp_ultimo_step_aceito IS NULL OR totp_ultimo_step_aceito >= 0)
);

-- No máximo um TOTP ATIVO e um TOTP PENDENTE por administrador.
CREATE UNIQUE INDEX uq_fatores_mfa_plataforma_totp_ativo
  ON fatores_mfa_plataforma (administrador_id) WHERE tipo = 'TOTP' AND estado = 'ATIVO';

CREATE UNIQUE INDEX uq_fatores_mfa_plataforma_totp_pendente
  ON fatores_mfa_plataforma (administrador_id) WHERE tipo = 'TOTP' AND estado = 'PENDENTE';

-- Prontidão: quais versões de chave ainda protegem algum secret.
CREATE INDEX idx_fatores_mfa_plataforma_chave_versao
  ON fatores_mfa_plataforma (totp_chave_versao) WHERE estado IN ('PENDENTE', 'ATIVO');

-- Histórico de fatores do administrador e checagem da FK RESTRICT.
CREATE INDEX idx_fatores_mfa_plataforma_administrador_id ON fatores_mfa_plataforma (administrador_id);

CREATE TRIGGER trg_fatores_mfa_plataforma_atualizado_em
  BEFORE UPDATE ON fatores_mfa_plataforma
  FOR EACH ROW EXECUTE FUNCTION set_atualizado_em();
