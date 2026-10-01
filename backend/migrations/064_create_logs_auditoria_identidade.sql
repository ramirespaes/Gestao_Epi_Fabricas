-- Trilha de auditoria da identidade global.
--
-- Solicitação de recuperação, redefinição e troca de senha são eventos da
-- identidade, que pode estar ligada a várias empresas ou a nenhuma. Por isso
-- a trilha é própria e não repete o evento em cada vínculo empresarial.
--
-- ator_tipo diz quem causou o evento: IDENTIDADE, quando a própria pessoa
-- estava autenticada, ou SISTEMA, nos fluxos sem sessão (pedido e uso do link
-- de redefinição).
--
-- Mesmas garantias das outras duas trilhas: só INSERT, JSON sempre objeto,
-- limite de 16 KiB por campo e recusa de chave JSON sensível, pelas funções
-- já existentes da 012 e da 014.

CREATE TABLE logs_auditoria_identidade (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  identidade_id     INTEGER NOT NULL REFERENCES identidades(id) ON DELETE RESTRICT,
  ator_tipo         VARCHAR(20) NOT NULL,
  acao              VARCHAR(60) NOT NULL,
  referencia        VARCHAR(150),
  descricao         TEXT,
  ip                VARCHAR(45),
  dispositivo       VARCHAR(150),
  contexto          JSONB,
  dados_anteriores  JSONB,
  dados_novos       JSONB,
  criado_em         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_logs_auditoria_identidade_ator_tipo CHECK (ator_tipo IN ('IDENTIDADE', 'SISTEMA')),
  CONSTRAINT chk_logs_auditoria_identidade_contexto_objeto
    CHECK (contexto IS NULL OR jsonb_typeof(contexto) = 'object'),
  CONSTRAINT chk_logs_auditoria_identidade_dados_anteriores_objeto
    CHECK (dados_anteriores IS NULL OR jsonb_typeof(dados_anteriores) = 'object'),
  CONSTRAINT chk_logs_auditoria_identidade_dados_novos_objeto
    CHECK (dados_novos IS NULL OR jsonb_typeof(dados_novos) = 'object'),
  CONSTRAINT chk_logs_auditoria_identidade_contexto_tamanho
    CHECK (contexto IS NULL OR octet_length(contexto::text) <= 16384),
  CONSTRAINT chk_logs_auditoria_identidade_dados_anteriores_tamanho
    CHECK (dados_anteriores IS NULL OR octet_length(dados_anteriores::text) <= 16384),
  CONSTRAINT chk_logs_auditoria_identidade_dados_novos_tamanho
    CHECK (dados_novos IS NULL OR octet_length(dados_novos::text) <= 16384)
);

CREATE INDEX idx_logs_auditoria_identidade_identidade_id ON logs_auditoria_identidade (identidade_id);
CREATE INDEX idx_logs_auditoria_identidade_criado_em ON logs_auditoria_identidade (criado_em);

CREATE TRIGGER trg_logs_auditoria_identidade_bloquear_update
  BEFORE UPDATE ON logs_auditoria_identidade
  FOR EACH ROW EXECUTE FUNCTION bloquear_alteracao_logs_auditoria();

CREATE TRIGGER trg_logs_auditoria_identidade_bloquear_delete
  BEFORE DELETE ON logs_auditoria_identidade
  FOR EACH ROW EXECUTE FUNCTION bloquear_alteracao_logs_auditoria();

CREATE TRIGGER trg_logs_auditoria_identidade_bloquear_truncate
  BEFORE TRUNCATE ON logs_auditoria_identidade
  FOR EACH STATEMENT EXECUTE FUNCTION bloquear_alteracao_logs_auditoria();

CREATE TRIGGER trg_logs_auditoria_identidade_bloquear_dado_sensivel
  BEFORE INSERT ON logs_auditoria_identidade
  FOR EACH ROW EXECUTE FUNCTION logs_auditoria_bloquear_dado_sensivel();
