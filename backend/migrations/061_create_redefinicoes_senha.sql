-- Pedidos de redefinição de senha das identidades globais (Portal do Cliente).
--
-- O link enviado à pessoa leva um token aleatório; aqui fica só o SHA-256
-- dele. Cada pedido vale no máximo 4 horas, serve uma única vez e existe no
-- máximo um pendente por identidade: pedir de novo cancela o anterior. Pedido
-- usado, cancelado ou expirado nunca volta a valer.
--
-- O teto de 4 horas é contado a partir de criado_em, que o banco preenche.
-- Um criado_em informado no futuro esticaria a validade real para além do
-- teto; por isso o gatilho o recusa na inserção, sem pôr o relógio dentro de
-- uma constraint. O mesmo gatilho garante o que CHECK não alcança: o pedido
-- nasce pendente, depois só o desfecho pode ser gravado, linha encerrada é
-- imutável e pedido expirado não pode ser usado. A função é reaproveitada
-- pela 062.

CREATE TABLE redefinicoes_senha (
  id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  identidade_id        INTEGER NOT NULL REFERENCES identidades(id) ON DELETE RESTRICT,
  token_hash           CHAR(64) NOT NULL,
  criado_em            TIMESTAMPTZ NOT NULL DEFAULT now(),
  expira_em            TIMESTAMPTZ NOT NULL,
  usado_em             TIMESTAMPTZ,
  cancelado_em         TIMESTAMPTZ,
  motivo_cancelamento  VARCHAR(30),
  ip                   VARCHAR(45),
  dispositivo          VARCHAR(150),
  CONSTRAINT uq_redefinicoes_senha_token_hash UNIQUE (token_hash),
  CONSTRAINT chk_redefinicoes_senha_token_hash_formato CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_redefinicoes_senha_validade
    CHECK (expira_em > criado_em AND expira_em <= criado_em + INTERVAL '4 hours'),
  CONSTRAINT chk_redefinicoes_senha_desfecho_unico
    CHECK (NOT (usado_em IS NOT NULL AND cancelado_em IS NOT NULL)),
  CONSTRAINT chk_redefinicoes_senha_cancelamento_coerente
    CHECK ((cancelado_em IS NULL) = (motivo_cancelamento IS NULL)),
  CONSTRAINT chk_redefinicoes_senha_motivo_formato
    CHECK (motivo_cancelamento IS NULL OR motivo_cancelamento ~ '^[A-Z_]{1,30}$'),
  CONSTRAINT chk_redefinicoes_senha_desfecho_apos_criacao
    CHECK ((usado_em IS NULL OR usado_em >= criado_em) AND (cancelado_em IS NULL OR cancelado_em >= criado_em)),
  CONSTRAINT chk_redefinicoes_senha_uso_dentro_da_validade
    CHECK (usado_em IS NULL OR usado_em <= expira_em)
);

-- Um pedido pendente por identidade. O expirado continua contando até ser
-- cancelado, o que a nova solicitação faz antes de inserir.
CREATE UNIQUE INDEX uq_redefinicoes_senha_identidade_pendente
  ON redefinicoes_senha (identidade_id)
  WHERE usado_em IS NULL AND cancelado_em IS NULL;

-- Histórico da conta e conferência do ON DELETE RESTRICT.
CREATE INDEX idx_redefinicoes_senha_identidade_id ON redefinicoes_senha (identidade_id);

-- Purga por retenção.
CREATE INDEX idx_redefinicoes_senha_expira_em ON redefinicoes_senha (expira_em);

CREATE FUNCTION redefinicao_senha_proteger_linha()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.usado_em IS NOT NULL OR NEW.cancelado_em IS NOT NULL THEN
      RAISE EXCEPTION '%: pedido de redefinição nasce pendente', TG_TABLE_NAME
        USING ERRCODE = 'check_violation', CONSTRAINT = TG_NAME, TABLE = TG_TABLE_NAME;
    END IF;
    IF NEW.criado_em > clock_timestamp() THEN
      RAISE EXCEPTION '%: criado_em não pode estar no futuro', TG_TABLE_NAME
        USING ERRCODE = 'check_violation', CONSTRAINT = TG_NAME, TABLE = TG_TABLE_NAME;
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.usado_em IS NOT NULL OR OLD.cancelado_em IS NOT NULL THEN
    RAISE EXCEPTION '%: pedido encerrado não pode ser alterado', TG_TABLE_NAME
      USING ERRCODE = 'check_violation', CONSTRAINT = TG_NAME, TABLE = TG_TABLE_NAME;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['usado_em', 'cancelado_em', 'motivo_cancelamento'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['usado_em', 'cancelado_em', 'motivo_cancelamento']) THEN
    RAISE EXCEPTION '%: só o desfecho do pedido pode ser gravado', TG_TABLE_NAME
      USING ERRCODE = 'check_violation', CONSTRAINT = TG_NAME, TABLE = TG_TABLE_NAME;
  END IF;
  IF NEW.usado_em IS NOT NULL AND clock_timestamp() > OLD.expira_em THEN
    RAISE EXCEPTION '%: pedido expirado não pode ser usado', TG_TABLE_NAME
      USING ERRCODE = 'check_violation', CONSTRAINT = TG_NAME, TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_redefinicoes_senha_proteger_linha
  BEFORE INSERT OR UPDATE ON redefinicoes_senha
  FOR EACH ROW EXECUTE FUNCTION redefinicao_senha_proteger_linha();
