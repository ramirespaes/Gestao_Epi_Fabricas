-- logs_auditoria: trilha de auditoria (quem fez o quê, quando e de onde).
-- Append-only por design:
--  - id usa BIGINT GENERATED ALWAYS AS IDENTITY (não SERIAL/BIGSERIAL) —
--    identidade padrão SQL, sem depender de sequência manipulável à parte;
--  - empresa_id e usuario_id são ON DELETE RESTRICT: excluir uma empresa ou
--    um usuário NÃO pode arrastar nem "desidentificar" o log de auditoria
--    associado a eles (diferente de todas as outras tabelas, que usam
--    CASCADE em empresa_id). A auditoria precisa preservar para sempre qual
--    usuário realizou cada ação — um usuário com histórico de auditoria não
--    é excluído fisicamente, só inativado via usuarios.ativo = false;
--  - sem atualizado_em/trigger de atualização — nada aqui deveria mudar;
--  - as triggers abaixo bloqueiam UPDATE, DELETE e TRUNCATE na tabela
--    inteira, no próprio banco, independente de quem tenta executar — de
--    propósito, sem exceção nem para um SET NULL automático de FK.
CREATE TABLE logs_auditoria (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  empresa_id   INTEGER NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  usuario_id   INTEGER REFERENCES usuarios(id) ON DELETE RESTRICT,
  acao         VARCHAR(60) NOT NULL,
  referencia   VARCHAR(150),
  descricao    TEXT,
  ip           VARCHAR(45),
  dispositivo  VARCHAR(150),
  criado_em    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_logs_auditoria_empresa_id ON logs_auditoria (empresa_id);
CREATE INDEX idx_logs_auditoria_usuario_id ON logs_auditoria (usuario_id);
CREATE INDEX idx_logs_auditoria_criado_em ON logs_auditoria (criado_em);

-- Proteção append-only: qualquer tentativa de UPDATE, DELETE ou TRUNCATE
-- nesta tabela é rejeitada pelo próprio banco.
CREATE OR REPLACE FUNCTION bloquear_alteracao_logs_auditoria()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'logs_auditoria é append-only: operação % não é permitida', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_logs_auditoria_bloquear_update
  BEFORE UPDATE ON logs_auditoria
  FOR EACH ROW EXECUTE FUNCTION bloquear_alteracao_logs_auditoria();

CREATE TRIGGER trg_logs_auditoria_bloquear_delete
  BEFORE DELETE ON logs_auditoria
  FOR EACH ROW EXECUTE FUNCTION bloquear_alteracao_logs_auditoria();

-- TRUNCATE não dispara triggers de linha (BEFORE DELETE) — precisa de uma
-- trigger de statement própria, senão TRUNCATE apagaria o log inteiro
-- contornando a proteção acima.
CREATE TRIGGER trg_logs_auditoria_bloquear_truncate
  BEFORE TRUNCATE ON logs_auditoria
  FOR EACH STATEMENT EXECUTE FUNCTION bloquear_alteracao_logs_auditoria();
