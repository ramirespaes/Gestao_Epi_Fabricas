-- Encerramento da solicitação de EPI aprovada que não será mais entregue
-- (pendência D6 do Bloco 12, 12E-2).
--
-- ENCERRADA é um estado final novo, que só vem de APROVADA ou
-- APROVADA_PARCIAL. Encerrar não apaga nem desfaz nada: as entregas já feitas,
-- os lotes, a ficha e as operações ficam como estão, e a quantidade entregue
-- continua derivada das entregas ligadas aos itens (066). O que deixa de
-- existir é a demanda pendente: a posição de estoque só conta solicitações
-- APROVADA e APROVADA_PARCIAL, então a parte aprovada e ainda não entregue
-- sai de D sem nenhum contador, reserva ou alocação gravada.
--
-- Quem encerra, quando e por quê ficam na própria solicitação, como a decisão
-- e o cancelamento. A justificativa é obrigatória e efetivamente preenchida.
-- Não há regra de autodecisão para o encerramento: quem criou a solicitação
-- pode encerrá-la se tiver a autoridade (a proibição continua valendo para
-- aprovar e reprovar). A autoridade é a ação ENCERRAR_SOLICITACAO, que exige
-- SST e autorização individual OBRIGATORIA, como as outras duas decisões da
-- Segurança do Trabalho. Esta migration não concede a ação a ninguém.
--
-- As funções de proteção e de conferência da 065 e da 066 são trocadas aqui
-- (CREATE OR REPLACE), com o mesmo corpo e só o que o estado novo pede; as
-- migrations antigas não mudam.
--
-- Também entra o índice de "Minhas solicitações" (12E-1): com cerca de 90 mil
-- solicitações, a consulta fazia Seq Scan em cerca de 2,6 a 3,2 ms e caiu para
-- cerca de 0,04 ms com ele.

ALTER TABLE solicitacoes_epi
  ADD COLUMN encerrada_por INTEGER,
  ADD COLUMN encerrada_em TIMESTAMPTZ,
  ADD COLUMN justificativa_encerramento TEXT;

ALTER TABLE solicitacoes_epi
  ADD CONSTRAINT fk_solicitacoes_epi_encerrador_mesma_empresa
    FOREIGN KEY (empresa_id, encerrada_por)
    REFERENCES usuarios (empresa_id, id)
    ON DELETE RESTRICT;

-- A ENCERRADA foi decidida antes (vem de APROVADA ou APROVADA_PARCIAL), então a
-- decisão continua obrigatória para ela.
ALTER TABLE solicitacoes_epi
  DROP CONSTRAINT chk_solicitacoes_epi_status,
  ADD CONSTRAINT chk_solicitacoes_epi_status
    CHECK (status IN ('PENDENTE', 'APROVADA', 'APROVADA_PARCIAL', 'REPROVADA', 'CANCELADA', 'ENTREGUE', 'ENCERRADA')),
  DROP CONSTRAINT chk_solicitacoes_epi_decisao,
  ADD CONSTRAINT chk_solicitacoes_epi_decisao CHECK (
    (decidida_por IS NULL) = (decidida_em IS NULL)
    AND (status IN ('APROVADA', 'APROVADA_PARCIAL', 'REPROVADA', 'ENTREGUE', 'ENCERRADA')) = (decidida_em IS NOT NULL));

-- Quem, quando e a justificativa existem juntos e só na ENCERRADA. A
-- justificativa não tem espaço nas pontas nem caractere de controle, então
-- espaços, tabulações e quebras de linha sozinhos não contam como texto.
ALTER TABLE solicitacoes_epi
  ADD CONSTRAINT chk_solicitacoes_epi_encerramento CHECK (
    (encerrada_por IS NULL) = (encerrada_em IS NULL)
    AND (encerrada_em IS NULL) = (justificativa_encerramento IS NULL)
    AND (status = 'ENCERRADA') = (encerrada_em IS NOT NULL)
    AND (justificativa_encerramento IS NULL
         OR (btrim(justificativa_encerramento) = justificativa_encerramento
             AND char_length(justificativa_encerramento) BETWEEN 1 AND 500
             AND justificativa_encerramento !~ '[[:cntrl:]]'))),
  -- Relógio do banco, como a decisão: o encerramento nunca é anterior a ela.
  ADD CONSTRAINT chk_solicitacoes_epi_ordem_do_encerramento
    CHECK (encerrada_em IS NULL OR encerrada_em >= decidida_em);

-- Transições: a única novidade é APROVADA ou APROVADA_PARCIAL para ENCERRADA.
-- ENCERRADA, como ENTREGUE, não sai de onde está, e por isso nada do
-- encerramento muda depois de gravado.
CREATE OR REPLACE FUNCTION proteger_solicitacao_epi() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'PENDENTE' THEN
      RAISE EXCEPTION 'solicitacoes_epi nasce PENDENTE (recebeu %)', NEW.status;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'solicitacoes_epi não aceita %: a solicitação é histórico', TG_OP;
  END IF;
  IF (NEW.id, NEW.empresa_id, NEW.numero, NEW.funcionario_id, NEW.ghe_id, NEW.origem_solicitacao,
      NEW.solicitante_usuario_id, NEW.quantidade_itens, NEW.observacao, NEW.chave_idempotencia,
      NEW.requisicao_hash, NEW.criada_em)
     IS DISTINCT FROM
     (OLD.id, OLD.empresa_id, OLD.numero, OLD.funcionario_id, OLD.ghe_id, OLD.origem_solicitacao,
      OLD.solicitante_usuario_id, OLD.quantidade_itens, OLD.observacao, OLD.chave_idempotencia,
      OLD.requisicao_hash, OLD.criada_em) THEN
    RAISE EXCEPTION 'solicitacoes_epi: a identidade da solicitação % não pode ser alterada', OLD.id;
  END IF;
  IF NOT ((OLD.status = 'PENDENTE' AND NEW.status IN ('APROVADA', 'APROVADA_PARCIAL', 'REPROVADA', 'CANCELADA'))
          OR (OLD.status IN ('APROVADA', 'APROVADA_PARCIAL') AND NEW.status IN ('ENTREGUE', 'ENCERRADA'))) THEN
    RAISE EXCEPTION 'solicitacoes_epi: transição de % para % não é permitida (solicitação %)', OLD.status, NEW.status, OLD.id;
  END IF;
  IF OLD.status <> 'PENDENTE'
     AND (NEW.decidida_por, NEW.decidida_em, NEW.cancelada_por, NEW.cancelada_em, NEW.justificativa_cancelamento)
         IS DISTINCT FROM
         (OLD.decidida_por, OLD.decidida_em, OLD.cancelada_por, OLD.cancelada_em, OLD.justificativa_cancelamento) THEN
    RAISE EXCEPTION 'solicitacoes_epi: a decisão e o cancelamento já gravados da solicitação % não podem ser alterados', OLD.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Conferência do COMMIT da 065: a ENCERRADA tem, como a ENTREGUE, todos os
-- itens decididos e ao menos um aprovado.
CREATE OR REPLACE FUNCTION exigir_decisao_coerente_da_solicitacao_epi() RETURNS TRIGGER AS $$
DECLARE
  v_solicitacao_id INTEGER;
  v_status VARCHAR(20);
  v_total INTEGER;
  v_pendentes INTEGER;
  v_aprovados INTEGER;
  v_reprovados INTEGER;
  v_integrais INTEGER;
BEGIN
  IF TG_TABLE_NAME = 'solicitacoes_epi' THEN
    v_solicitacao_id := NEW.id;
  ELSE
    v_solicitacao_id := NEW.solicitacao_id;
  END IF;
  SELECT status INTO v_status
    FROM solicitacoes_epi
   WHERE empresa_id = NEW.empresa_id AND id = v_solicitacao_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT count(*),
         count(*) FILTER (WHERE decisao IS NULL),
         count(*) FILTER (WHERE decisao = 'APROVADO'),
         count(*) FILTER (WHERE decisao = 'REPROVADO'),
         count(*) FILTER (WHERE decisao = 'APROVADO' AND quantidade_aprovada = quantidade)
    INTO v_total, v_pendentes, v_aprovados, v_reprovados, v_integrais
    FROM solicitacoes_epi_itens
   WHERE empresa_id = NEW.empresa_id AND solicitacao_id = v_solicitacao_id;
  IF NOT (CASE v_status
            WHEN 'PENDENTE' THEN v_pendentes = v_total
            WHEN 'CANCELADA' THEN v_pendentes = v_total
            WHEN 'APROVADA' THEN v_integrais = v_total
            WHEN 'APROVADA_PARCIAL' THEN v_pendentes = 0 AND v_aprovados >= 1 AND v_integrais < v_total
            WHEN 'REPROVADA' THEN v_reprovados = v_total
            WHEN 'ENTREGUE' THEN v_pendentes = 0 AND v_aprovados >= 1
            WHEN 'ENCERRADA' THEN v_pendentes = 0 AND v_aprovados >= 1
            ELSE false
          END) THEN
    RAISE EXCEPTION 'a solicitação % está % e as decisões dos itens não correspondem a esse estado', v_solicitacao_id, v_status
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'trg_solicitacoes_epi_coerencia_decisao',
            TABLE = 'solicitacoes_epi';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Conferência do COMMIT da 066: a ENCERRADA não pode ter tudo o que foi
-- aprovado entregue (nesse caso o fechamento é ENTREGUE). Entregar a última
-- quantidade e encerrar na mesma transação é recusado. Entregar depois de
-- encerrada já é recusado pelo gatilho da gravação da 066, que só aceita
-- APROVADA e APROVADA_PARCIAL e não muda.
CREATE OR REPLACE FUNCTION exigir_entrega_coerente_da_solicitacao_epi() RETURNS TRIGGER AS $$
DECLARE
  v_solicitacao_id INTEGER;
  v_status VARCHAR(20);
  v_aprovados INTEGER;
  v_completos INTEGER;
  v_excedidos INTEGER;
BEGIN
  IF TG_TABLE_NAME = 'solicitacoes_epi' THEN
    v_solicitacao_id := NEW.id;
  ELSE
    IF NEW.solicitacao_item_id IS NULL THEN
      RETURN NULL;
    END IF;
    SELECT i.solicitacao_id INTO v_solicitacao_id
      FROM solicitacoes_epi_itens i
     WHERE i.empresa_id = NEW.empresa_id AND i.id = NEW.solicitacao_item_id;
    IF NOT FOUND THEN
      RETURN NULL;
    END IF;
  END IF;

  SELECT s.status INTO v_status
    FROM solicitacoes_epi s
   WHERE s.empresa_id = NEW.empresa_id AND s.id = v_solicitacao_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT count(*) FILTER (WHERE i.decisao = 'APROVADO'),
         count(*) FILTER (WHERE i.decisao = 'APROVADO' AND COALESCE(e.entregue, 0) = i.quantidade_aprovada),
         count(*) FILTER (WHERE COALESCE(e.entregue, 0) > COALESCE(i.quantidade_aprovada, 0))
    INTO v_aprovados, v_completos, v_excedidos
    FROM solicitacoes_epi_itens i
    LEFT JOIN LATERAL (
      SELECT sum(ei.quantidade) AS entregue
        FROM entregas_epi_itens ei
       WHERE ei.empresa_id = i.empresa_id AND ei.solicitacao_item_id = i.id
    ) e ON true
   WHERE i.empresa_id = NEW.empresa_id AND i.solicitacao_id = v_solicitacao_id;

  IF v_excedidos > 0 THEN
    RAISE EXCEPTION 'a solicitação % tem item entregue além da quantidade aprovada', v_solicitacao_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_solicitacoes_epi_entrega_coerente', TABLE = 'solicitacoes_epi';
  END IF;
  IF v_status = 'ENTREGUE' AND NOT (v_aprovados >= 1 AND v_completos = v_aprovados) THEN
    RAISE EXCEPTION 'a solicitação % está ENTREGUE, mas a quantidade aprovada não foi entregue por inteiro', v_solicitacao_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_solicitacoes_epi_entrega_coerente', TABLE = 'solicitacoes_epi';
  END IF;
  IF v_status IN ('APROVADA', 'APROVADA_PARCIAL') AND v_aprovados >= 1 AND v_completos = v_aprovados THEN
    RAISE EXCEPTION 'a solicitação % está inteiramente entregue e precisa passar a ENTREGUE na mesma transação', v_solicitacao_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_solicitacoes_epi_entrega_coerente', TABLE = 'solicitacoes_epi';
  END IF;
  IF v_status = 'ENCERRADA' AND v_aprovados >= 1 AND v_completos = v_aprovados THEN
    RAISE EXCEPTION 'a solicitação % está ENCERRADA, mas toda a quantidade aprovada foi entregue: o fechamento é ENTREGUE', v_solicitacao_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_solicitacoes_epi_entrega_coerente', TABLE = 'solicitacoes_epi';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

INSERT INTO acoes (codigo, nome, descricao, exige_sst, modo_autorizacao_individual) VALUES
  ('ENCERRAR_SOLICITACAO', 'Encerrar solicitação',
   'Encerrar a solicitação de EPI aprovada que não será mais entregue, liberando a quantidade ainda não entregue.',
   true, 'OBRIGATORIA');

-- "Minhas solicitações": as do solicitante na empresa, das mais recentes para
-- as antigas (listarMinhas e contarMinhas). Também atende a FK composta do
-- solicitante.
CREATE INDEX idx_solicitacoes_epi_solicitante
  ON solicitacoes_epi (empresa_id, solicitante_usuario_id, criada_em DESC, id DESC);
