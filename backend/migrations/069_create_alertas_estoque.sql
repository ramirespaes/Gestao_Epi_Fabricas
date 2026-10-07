-- Infraestrutura durável (scheduler/outbox) do aviso de disponibilidade de EPI
-- (Bloco 12, 12G-6).
--
-- O que esta migration NÃO faz: guardar estoque, cobertura, saldo, a
-- disponibilidade de um item ou qualquer registro item a item (candidato,
-- "já comunicado", resultado por item). "Disponível para entrega" continua
-- derivado do estado real (lotes, demanda aprovada pendente e fila FIFO),
-- recalculado em toda leitura, e o e-mail é montado com a situação atual no
-- momento do envio.
--
--   alertas_estoque_agendamentos  o envio consolidado de uma empresa e tipo:
--     a janela (primeira e última entrada relevante, enviar_apos), o estado do
--     processamento, as tentativas e o resultado agregado. Uma nova entrada
--     relevante estende a janela do agendamento PENDENTE; o que já foi
--     reivindicado (ENVIANDO), espera nova tentativa (AGUARDANDO_RETRY) ou
--     terminou não muda mais de janela, e um PENDENTE novo pode existir ao lado
--     dele.
--
-- Nenhum texto livre é gravado: o erro é um código técnico.

CREATE TABLE alertas_estoque_agendamentos (
  id                         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  empresa_id                 INTEGER NOT NULL REFERENCES empresas (id) ON DELETE RESTRICT,
  tipo                       VARCHAR(40) NOT NULL,
  estado                     VARCHAR(20) NOT NULL DEFAULT 'PENDENTE',
  primeira_entrada_em        TIMESTAMPTZ NOT NULL,
  ultima_entrada_em          TIMESTAMPTZ NOT NULL,
  enviar_apos                TIMESTAMPTZ NOT NULL,
  tentativas                 INTEGER NOT NULL DEFAULT 0,
  proxima_tentativa_em       TIMESTAMPTZ,
  reivindicado_em            TIMESTAMPTZ,
  processado_em              TIMESTAMPTZ,
  codigo_ultimo_erro         VARCHAR(40),
  destinatarios_alcancados   INTEGER,
  linhas_resumo              INTEGER,
  criado_em                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em              TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT ck_alertas_estoque_agendamentos_tipo CHECK (tipo IN ('DISPONIBILIDADE_ESTOQUE_ENTREGA')),
  CONSTRAINT ck_alertas_estoque_agendamentos_estado
    CHECK (estado IN ('PENDENTE', 'ENVIANDO', 'AGUARDANDO_RETRY', 'ENVIADO', 'DESCARTADO', 'FALHA')),
  CONSTRAINT ck_alertas_estoque_agendamentos_tentativas CHECK (tentativas >= 0),
  CONSTRAINT ck_alertas_estoque_agendamentos_janela
    CHECK (ultima_entrada_em >= primeira_entrada_em AND enviar_apos >= ultima_entrada_em),
  CONSTRAINT ck_alertas_estoque_agendamentos_codigo
    CHECK (codigo_ultimo_erro IS NULL OR codigo_ultimo_erro ~ '^[A-Z][A-Z0-9_]{0,39}$'),
  CONSTRAINT ck_alertas_estoque_agendamentos_contagens
    CHECK ((destinatarios_alcancados IS NULL OR destinatarios_alcancados >= 0) AND (linhas_resumo IS NULL OR linhas_resumo >= 0)),
  CONSTRAINT ck_alertas_estoque_agendamentos_reivindicado
    CHECK (estado <> 'ENVIANDO' OR reivindicado_em IS NOT NULL),
  CONSTRAINT ck_alertas_estoque_agendamentos_retry
    CHECK (estado <> 'AGUARDANDO_RETRY' OR proxima_tentativa_em IS NOT NULL),
  CONSTRAINT ck_alertas_estoque_agendamentos_final
    CHECK (estado NOT IN ('ENVIADO', 'DESCARTADO', 'FALHA') OR processado_em IS NOT NULL)
);

-- Debounce: no máximo um PENDENTE por empresa e tipo. ENVIANDO,
-- AGUARDANDO_RETRY e os finais ficam de fora de propósito: uma entrada nova
-- durante o envio, a espera de nova tentativa ou depois de uma falha abre
-- outro PENDENTE.
CREATE UNIQUE INDEX uq_alertas_estoque_agendamentos_pendente
  ON alertas_estoque_agendamentos (empresa_id, tipo)
  WHERE estado = 'PENDENTE';

-- Processamento: os vencidos de cada estado reivindicável.
CREATE INDEX idx_alertas_estoque_agendamentos_pendentes
  ON alertas_estoque_agendamentos (enviar_apos) WHERE estado = 'PENDENTE';
CREATE INDEX idx_alertas_estoque_agendamentos_retry
  ON alertas_estoque_agendamentos (proxima_tentativa_em) WHERE estado = 'AGUARDANDO_RETRY';
CREATE INDEX idx_alertas_estoque_agendamentos_enviando
  ON alertas_estoque_agendamentos (reivindicado_em) WHERE estado = 'ENVIANDO';

CREATE TRIGGER trg_alertas_estoque_agendamentos_atualizado_em
  BEFORE UPDATE ON alertas_estoque_agendamentos
  FOR EACH ROW EXECUTE FUNCTION set_atualizado_em();

-- Transições permitidas. Valores fora do catálogo passam adiante para o CHECK
-- recusar com o código de restrição, não com o do gatilho.
CREATE OR REPLACE FUNCTION fn_alertas_estoque_agendamentos_transicao()
RETURNS trigger AS $$
DECLARE
  conhecidos CONSTANT TEXT[] := ARRAY['PENDENTE', 'ENVIANDO', 'AGUARDANDO_RETRY', 'ENVIADO', 'DESCARTADO', 'FALHA'];
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.estado <> 'PENDENTE' OR NEW.tentativas > 0 OR NEW.reivindicado_em IS NOT NULL OR NEW.processado_em IS NOT NULL THEN
      RAISE EXCEPTION 'agendamento de alerta nasce PENDENTE, sem tentativa nem processamento';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.estado IN ('ENVIADO', 'DESCARTADO', 'FALHA') THEN
    RAISE EXCEPTION 'agendamento de alerta finalizado não muda';
  END IF;
  IF NEW.empresa_id <> OLD.empresa_id OR NEW.tipo <> OLD.tipo OR NEW.primeira_entrada_em <> OLD.primeira_entrada_em THEN
    RAISE EXCEPTION 'empresa, tipo e primeira entrada do agendamento de alerta são imutáveis';
  END IF;
  IF NEW.tentativas < OLD.tentativas THEN
    RAISE EXCEPTION 'as tentativas do agendamento de alerta não diminuem';
  END IF;
  IF NOT (NEW.estado = ANY (conhecidos)) THEN
    RETURN NEW;
  END IF;
  IF (NEW.ultima_entrada_em <> OLD.ultima_entrada_em OR NEW.enviar_apos <> OLD.enviar_apos)
     AND NOT (OLD.estado = 'PENDENTE' AND NEW.estado = 'PENDENTE') THEN
    RAISE EXCEPTION 'a janela do agendamento de alerta só anda enquanto ele está PENDENTE';
  END IF;
  IF NOT (
       (OLD.estado = 'PENDENTE' AND NEW.estado IN ('PENDENTE', 'ENVIANDO'))
    OR (OLD.estado = 'ENVIANDO' AND NEW.estado IN ('ENVIANDO', 'ENVIADO', 'DESCARTADO', 'AGUARDANDO_RETRY', 'FALHA'))
    OR (OLD.estado = 'AGUARDANDO_RETRY' AND NEW.estado = 'ENVIANDO')
  ) THEN
    RAISE EXCEPTION 'transição de agendamento de alerta não permitida: % para %', OLD.estado, NEW.estado;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_alertas_estoque_agendamentos_transicao
  BEFORE INSERT OR UPDATE ON alertas_estoque_agendamentos
  FOR EACH ROW EXECUTE FUNCTION fn_alertas_estoque_agendamentos_transicao();
