-- Pedidos de redefinição de senha dos administradores da plataforma (Painel
-- Privado). Mesmo desenho e mesmas garantias da 061, em tabela própria: o
-- namespace da plataforma não divide estrutura com o do cliente.
--
-- Redefinir a senha não mexe no segundo fator. Esta tabela não tem ligação
-- com fatores, códigos de recuperação, desafios nem sessões da plataforma:
-- depois da redefinição o login continua exigindo o TOTP.

CREATE TABLE redefinicoes_senha_plataforma (
  id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  administrador_id     INTEGER NOT NULL REFERENCES administradores_plataforma(id) ON DELETE RESTRICT,
  token_hash           CHAR(64) NOT NULL,
  criado_em            TIMESTAMPTZ NOT NULL DEFAULT now(),
  expira_em            TIMESTAMPTZ NOT NULL,
  usado_em             TIMESTAMPTZ,
  cancelado_em         TIMESTAMPTZ,
  motivo_cancelamento  VARCHAR(30),
  ip                   VARCHAR(45),
  dispositivo          VARCHAR(150),
  CONSTRAINT uq_redefinicoes_senha_plataforma_token_hash UNIQUE (token_hash),
  CONSTRAINT chk_redefinicoes_senha_plataforma_token_hash_formato CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_redefinicoes_senha_plataforma_validade
    CHECK (expira_em > criado_em AND expira_em <= criado_em + INTERVAL '4 hours'),
  CONSTRAINT chk_redefinicoes_senha_plataforma_desfecho_unico
    CHECK (NOT (usado_em IS NOT NULL AND cancelado_em IS NOT NULL)),
  CONSTRAINT chk_redefinicoes_senha_plataforma_cancelamento_coerente
    CHECK ((cancelado_em IS NULL) = (motivo_cancelamento IS NULL)),
  CONSTRAINT chk_redefinicoes_senha_plataforma_motivo_formato
    CHECK (motivo_cancelamento IS NULL OR motivo_cancelamento ~ '^[A-Z_]{1,30}$'),
  CONSTRAINT chk_redefinicoes_senha_plataforma_desfecho_apos_criacao
    CHECK ((usado_em IS NULL OR usado_em >= criado_em) AND (cancelado_em IS NULL OR cancelado_em >= criado_em)),
  CONSTRAINT chk_redefinicoes_senha_plataforma_uso_dentro_da_validade
    CHECK (usado_em IS NULL OR usado_em <= expira_em)
);

-- Um pedido pendente por administrador.
CREATE UNIQUE INDEX uq_redefinicoes_senha_plataforma_administrador_pendente
  ON redefinicoes_senha_plataforma (administrador_id)
  WHERE usado_em IS NULL AND cancelado_em IS NULL;

-- Histórico da conta e conferência do ON DELETE RESTRICT.
CREATE INDEX idx_redefinicoes_senha_plataforma_administrador_id ON redefinicoes_senha_plataforma (administrador_id);

-- Purga por retenção.
CREATE INDEX idx_redefinicoes_senha_plataforma_expira_em ON redefinicoes_senha_plataforma (expira_em);

CREATE TRIGGER trg_redefinicoes_senha_plataforma_proteger_linha
  BEFORE INSERT OR UPDATE ON redefinicoes_senha_plataforma
  FOR EACH ROW EXECUTE FUNCTION redefinicao_senha_proteger_linha();
