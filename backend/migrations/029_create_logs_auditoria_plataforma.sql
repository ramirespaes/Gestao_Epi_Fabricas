-- logs_auditoria_plataforma: trilha de auditoria das ações da PLATAFORMA
-- (Autenticação Global — Pacote 2, 23/09/2026; desenho já anunciado no
-- adendo técnico v2.1, seção 2). Separada de `logs_auditoria` (migration
-- 012/014, intocada) porque `logs_auditoria.empresa_id` é NOT NULL — não
-- há como registrar ali uma ação da plataforma que não pertença a nenhuma
-- empresa (ex.: um administrador sendo criado) sem inventar uma empresa
-- fictícia só para caber a linha, o que a arquitetura já rejeita.
--
-- `administrador_id` é NOT NULL e ON DELETE RESTRICT: toda linha desta
-- tabela tem, para sempre, um autor identificado — um administrador de
-- plataforma com histórico de auditoria nunca é excluído fisicamente, só
-- inativado (`administradores_plataforma.ativo = false`), mesma disciplina
-- já aplicada a `usuarios`/`empresas` na 012.
--
-- `empresa_afetada_id` é NULÁVEL: a maioria das ações administrativas mira
-- uma empresa (cadastro, alteração, ativação, suspensão — próximo pacote),
-- mas nem toda ação de plataforma precisa mirar uma; a coluna existe para
-- não fechar essa porta, sem exigir todo evento tenha uma empresa.
--
-- APPEND-ONLY: mesmas duas proteções já aprovadas e testadas para
-- `logs_auditoria` (012/014) — bloqueio de UPDATE/DELETE/TRUNCATE e recusa
-- de chave JSON sensível — reaplicadas aqui como triggers NOVOS sobre as
-- MESMAS funções PL/pgSQL genéricas já existentes
-- (`bloquear_alteracao_logs_auditoria`, `logs_auditoria_bloquear_dado_sensivel`):
-- nenhuma delas é reescrita, nenhuma migration histórica é tocada. A
-- segunda função lê `NEW.contexto`/`NEW.dados_anteriores`/`NEW.dados_novos`
-- por nome de coluna — por isso esta tabela usa exatamente esses três
-- nomes, na mesma forma da 012/014.
CREATE TABLE logs_auditoria_plataforma (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  administrador_id    INTEGER NOT NULL REFERENCES administradores_plataforma(id) ON DELETE RESTRICT,
  empresa_afetada_id  INTEGER REFERENCES empresas(id) ON DELETE RESTRICT,
  acao                VARCHAR(60) NOT NULL,
  referencia          VARCHAR(150),
  descricao           TEXT,
  ip                  VARCHAR(45),
  dispositivo         VARCHAR(150),
  contexto            JSONB,
  dados_anteriores    JSONB,
  dados_novos         JSONB,
  criado_em           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_logs_auditoria_plataforma_administrador_id ON logs_auditoria_plataforma (administrador_id);
CREATE INDEX idx_logs_auditoria_plataforma_empresa_afetada_id ON logs_auditoria_plataforma (empresa_afetada_id);
CREATE INDEX idx_logs_auditoria_plataforma_criado_em ON logs_auditoria_plataforma (criado_em);

CREATE TRIGGER trg_logs_auditoria_plataforma_bloquear_update
  BEFORE UPDATE ON logs_auditoria_plataforma
  FOR EACH ROW EXECUTE FUNCTION bloquear_alteracao_logs_auditoria();

CREATE TRIGGER trg_logs_auditoria_plataforma_bloquear_delete
  BEFORE DELETE ON logs_auditoria_plataforma
  FOR EACH ROW EXECUTE FUNCTION bloquear_alteracao_logs_auditoria();

CREATE TRIGGER trg_logs_auditoria_plataforma_bloquear_truncate
  BEFORE TRUNCATE ON logs_auditoria_plataforma
  FOR EACH STATEMENT EXECUTE FUNCTION bloquear_alteracao_logs_auditoria();

CREATE TRIGGER trg_logs_auditoria_plataforma_bloquear_dado_sensivel
  BEFORE INSERT ON logs_auditoria_plataforma
  FOR EACH ROW EXECUTE FUNCTION logs_auditoria_bloquear_dado_sensivel();
