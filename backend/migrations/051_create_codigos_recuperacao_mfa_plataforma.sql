-- codigos_recuperacao_mfa_plataforma: recovery codes, só como hash. O
-- código em claro existe apenas na resposta que o entrega, uma única vez.
-- codigo_hash = SHA-256 hexadecimal de
-- "safework|mfa|recuperacao|f<formato>|a<administrador_id>|<código canônico>"
-- (src/security/codigos-mfa.js); formato_versao é o <formato> desse texto.
--
-- administrador_id é redundante com o lote de propósito: entra no hash e na
-- busca. A FK composta (lote_id, administrador_id) impede um código apontar
-- para o lote de outro administrador.
--
-- Um código é utilizável só se o lote está ATIVO e consumido_em é nulo; o
-- consumo é UPDATE condicional nessas duas condições, no repositório.
CREATE TABLE codigos_recuperacao_mfa_plataforma (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  lote_id           BIGINT NOT NULL,
  administrador_id  INTEGER NOT NULL,
  codigo_hash       CHAR(64) NOT NULL,
  formato_versao    SMALLINT NOT NULL,
  criado_em         TIMESTAMPTZ NOT NULL DEFAULT now(),
  consumido_em      TIMESTAMPTZ,

  CONSTRAINT uq_codigos_recuperacao_mfa_plataforma_codigo_hash UNIQUE (codigo_hash),
  CONSTRAINT fk_codigos_recuperacao_mfa_plataforma_lote_mesmo_administrador
    FOREIGN KEY (lote_id, administrador_id)
    REFERENCES lotes_recuperacao_mfa_plataforma (id, administrador_id) ON DELETE RESTRICT,
  CONSTRAINT chk_codigos_recuperacao_mfa_plataforma_codigo_hash_formato
    CHECK (codigo_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_codigos_recuperacao_mfa_plataforma_formato_versao
    CHECK (formato_versao BETWEEN 1 AND 9999)
);

-- "Quantos códigos restam neste lote?"
CREATE INDEX idx_codigos_recuperacao_mfa_plataforma_lote_disponiveis
  ON codigos_recuperacao_mfa_plataforma (lote_id) WHERE consumido_em IS NULL;
