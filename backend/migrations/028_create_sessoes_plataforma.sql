-- sessoes_plataforma: sessões autenticadas do Painel Privado da plataforma
-- (Autenticação Global — Pacote 2, 23/09/2026). Mesmo contrato de segurança
-- de `sessoes` (migration 013) — token opaco de alta entropia, só o
-- SHA-256 hexadecimal chega ao banco, expiração absoluta, expiração por
-- inatividade, revogação, rastreabilidade — numa tabela própria, porque a
-- sessão de um administrador de plataforma não tem `empresa_id` nem
-- `usuario_id`: não existe contexto empresarial nenhum a carregar.
--
-- Reaproveitar `sessoes` exigiria tornar `empresa_id`/`usuario_id` (ambos
-- NOT NULL desde a 013, migration histórica, nunca alterada) opcionais só
-- para caber um ator que não tem nenhum dos dois — abriria exatamente a
-- ambiguidade estrutural que a separação de autoridades pretende evitar.
--
-- SEM `autenticado_via`/`mfa_verificado_em` (campos "para o futuro" da 013):
-- esta primeira versão só tem login por senha; se o Painel Privado um dia
-- precisar do mesmo campo, entra por migration aditiva própria, no mesmo
-- espírito, sem reabrir esta.
CREATE TABLE sessoes_plataforma (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  administrador_id   INTEGER NOT NULL REFERENCES administradores_plataforma(id) ON DELETE CASCADE,
  token_hash         CHAR(64) NOT NULL,
  criado_em          TIMESTAMPTZ NOT NULL DEFAULT now(),
  expira_em          TIMESTAMPTZ NOT NULL,
  ultimo_uso_em      TIMESTAMPTZ NOT NULL DEFAULT now(),
  revogada_em        TIMESTAMPTZ,
  motivo_revogacao   VARCHAR(30),
  ip                 VARCHAR(45),
  dispositivo        VARCHAR(150),
  CONSTRAINT uq_sessoes_plataforma_token_hash UNIQUE (token_hash),
  CONSTRAINT chk_sessoes_plataforma_token_hash_formato CHECK (token_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX idx_sessoes_plataforma_administrador_id_nao_revogadas
  ON sessoes_plataforma (administrador_id) WHERE revogada_em IS NULL;
