-- Entrega por solicitação: o vínculo entre o item da entrega e o item da
-- solicitação, e a origem SOLICITACAO.
--
-- A quantidade entregue de um item da solicitação é derivada: é a soma das
-- entregas ligadas a ele. Nada é contado em coluna, e o pendente (aprovada
-- menos entregue) também não é gravado. O vínculo fica no ITEM da entrega,
-- porque é o item que diz qual quantidade foi para qual item da solicitação;
-- um item da solicitação pode ser entregue em vários atos e por vários lotes.
--
-- As entregas e os itens só aceitam INSERT (058), então o vínculo nasce com o
-- item e não muda. A coluna é opcional e a entrega DIRETA fica sem vínculo:
-- as linhas que já existem continuam exatamente como estão. A 058 não é
-- alterada; o CHECK da origem é trocado aqui, como a 059 fez com o da operação.
--
-- Barreiras no banco (a mesma regra vale para quem gravar sem passar pelo
-- serviço):
--   empresa e material: FK composta (empresa, item da solicitação, material);
--   origem: DIRETA se e somente se o item não tem vínculo;
--   solicitação APROVADA ou APROVADA_PARCIAL, item APROVADO, uma só
--   solicitação por entrega, trabalhador da ficha, tamanho do lote e
--   quantidade até a aprovada: gatilho BEFORE INSERT, que trava a solicitação;
--   fechamento: no COMMIT, ENTREGUE se e somente se toda a quantidade aprovada
--   foi entregue.
--
-- O que o banco não confere, porque depende do estoque e das outras
-- solicitações: a cobertura FIFO do item e o saldo livre. Isso é do serviço,
-- sob a trava do par (12C-2 e 12C-3).
--
-- Ordem de locks: o gatilho toma a solicitação (FOR NO KEY UPDATE) quando o
-- item é gravado, depois de o serviço ter travado os lotes. Nenhum caminho
-- segura a solicitação e espera um lote: o serviço trava a solicitação antes
-- (idempotência, solicitação, trabalhador, materiais, pares, lotes), a
-- aprovação e o cancelamento não tocam lotes, e a entrega DIRETA, a baixa e a
-- entrada não gravam item com vínculo. A prova está nos testes de concorrência.

-- Lado referenciado da FK composta que prende o material do item da entrega ao
-- do item da solicitação. A unicidade (empresa, id) da 065 continua.
ALTER TABLE solicitacoes_epi_itens
  ADD CONSTRAINT uq_solicitacoes_epi_itens_empresa_id_material UNIQUE (empresa_id, id, material_id);

ALTER TABLE entregas_epi_itens
  ADD COLUMN solicitacao_item_id INTEGER;

-- MATCH SIMPLE: sem vínculo (entrega DIRETA) a FK não é conferida.
ALTER TABLE entregas_epi_itens
  ADD CONSTRAINT fk_entregas_epi_itens_item_da_solicitacao
    FOREIGN KEY (empresa_id, solicitacao_item_id, material_id)
    REFERENCES solicitacoes_epi_itens (empresa_id, id, material_id)
    ON DELETE RESTRICT;

ALTER TABLE entregas_epi
  DROP CONSTRAINT chk_entregas_epi_origem,
  ADD CONSTRAINT chk_entregas_epi_origem CHECK (origem IN ('DIRETA', 'SOLICITACAO'));

-- Soma entregue por item da solicitação, que alimenta a cobertura e a situação
-- derivada. Parcial: a entrega DIRETA não entra. A quantidade vai incluída
-- para a soma sair do índice, sem tocar a tabela.
CREATE INDEX idx_entregas_epi_itens_solicitacao_item
  ON entregas_epi_itens (empresa_id, solicitacao_item_id) INCLUDE (quantidade)
  WHERE solicitacao_item_id IS NOT NULL;

-- Conferência de cada item na gravação. Sem vínculo só confere a origem; com
-- vínculo trava a solicitação e confere o resto. Cada recusa leva o nome da
-- regra, como na 058 e na 065. O que falta (empresa, material) é da FK, que
-- roda depois: aqui a linha só segue quando o item da solicitação não existe
-- na empresa.
CREATE FUNCTION validar_vinculo_da_entrega_epi_com_solicitacao() RETURNS TRIGGER AS $$
DECLARE
  v_origem          VARCHAR(20);
  v_trabalhador     INTEGER;
  v_solicitacao_id  INTEGER;
  v_status          VARCHAR(20);
  v_trabalhador_do_pedido INTEGER;
  v_decisao         VARCHAR(10);
  v_aprovada        INTEGER;
  v_tamanho_item    VARCHAR(20);
  v_tamanho_lote    VARCHAR(20);
  v_entregue        BIGINT;
BEGIN
  SELECT e.origem, f.funcionario_id INTO v_origem, v_trabalhador
    FROM entregas_epi e
    JOIN fichas_epi f ON f.empresa_id = e.empresa_id AND f.id = e.ficha_id
   WHERE e.empresa_id = NEW.empresa_id AND e.id = NEW.entrega_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF (NEW.solicitacao_item_id IS NULL) <> (v_origem = 'DIRETA') THEN
    RAISE EXCEPTION 'o item da entrega % tem origem % e % vínculo com a solicitação: DIRETA não tem vínculo e SOLICITACAO exige em todos os itens',
        NEW.id, v_origem, CASE WHEN NEW.solicitacao_item_id IS NULL THEN 'sem' ELSE 'com' END
      USING ERRCODE = 'check_violation', CONSTRAINT = 'vinculo_origem', TABLE = 'entregas_epi_itens';
  END IF;
  IF NEW.solicitacao_item_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT i.solicitacao_id INTO v_solicitacao_id
    FROM solicitacoes_epi_itens i
   WHERE i.empresa_id = NEW.empresa_id AND i.id = NEW.solicitacao_item_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  -- Serializa quem entrega a mesma solicitação; o status e a decisão são lidos
  -- depois da trava, com o que a transação anterior confirmou.
  SELECT s.status, s.funcionario_id INTO v_status, v_trabalhador_do_pedido
    FROM solicitacoes_epi s
   WHERE s.empresa_id = NEW.empresa_id AND s.id = v_solicitacao_id
     FOR NO KEY UPDATE;
  IF v_status NOT IN ('APROVADA', 'APROVADA_PARCIAL') THEN
    RAISE EXCEPTION 'a solicitação % está % e só APROVADA ou APROVADA_PARCIAL recebe entrega', v_solicitacao_id, v_status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'vinculo_solicitacao_entregavel', TABLE = 'entregas_epi_itens';
  END IF;

  SELECT i.decisao, i.quantidade_aprovada, i.tamanho INTO v_decisao, v_aprovada, v_tamanho_item
    FROM solicitacoes_epi_itens i
   WHERE i.empresa_id = NEW.empresa_id AND i.id = NEW.solicitacao_item_id;
  IF v_decisao IS DISTINCT FROM 'APROVADO' THEN
    RAISE EXCEPTION 'o item % da solicitação % não foi aprovado e não recebe entrega', NEW.solicitacao_item_id, v_solicitacao_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'vinculo_item_aprovado', TABLE = 'entregas_epi_itens';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM entregas_epi_itens o
      JOIN solicitacoes_epi_itens oi ON oi.empresa_id = o.empresa_id AND oi.id = o.solicitacao_item_id
     WHERE o.empresa_id = NEW.empresa_id AND o.entrega_id = NEW.entrega_id AND oi.solicitacao_id <> v_solicitacao_id
  ) THEN
    RAISE EXCEPTION 'a entrega % já tem itens de outra solicitação: uma entrega atende uma solicitação só', NEW.entrega_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'vinculo_solicitacao_unica', TABLE = 'entregas_epi_itens';
  END IF;

  IF v_trabalhador_do_pedido <> v_trabalhador THEN
    RAISE EXCEPTION 'a solicitação % é de outro trabalhador que o da ficha da entrega %', v_solicitacao_id, NEW.entrega_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'vinculo_trabalhador', TABLE = 'entregas_epi_itens';
  END IF;

  -- O estoque é por material e tamanho; tamanho ausente só combina com tamanho ausente.
  SELECT l.tamanho INTO v_tamanho_lote
    FROM estoque_lotes l
   WHERE l.empresa_id = NEW.empresa_id AND l.id = NEW.lote_id;
  IF FOUND AND v_tamanho_lote IS DISTINCT FROM v_tamanho_item THEN
    RAISE EXCEPTION 'o lote % tem tamanho % e o item % da solicitação pede %',
        NEW.lote_id, COALESCE(v_tamanho_lote, '(sem tamanho)'), NEW.solicitacao_item_id, COALESCE(v_tamanho_item, '(sem tamanho)')
      USING ERRCODE = 'check_violation', CONSTRAINT = 'vinculo_tamanho', TABLE = 'entregas_epi_itens';
  END IF;

  SELECT COALESCE(sum(o.quantidade), 0) INTO v_entregue
    FROM entregas_epi_itens o
   WHERE o.empresa_id = NEW.empresa_id AND o.solicitacao_item_id = NEW.solicitacao_item_id;
  IF v_entregue + NEW.quantidade > v_aprovada THEN
    RAISE EXCEPTION 'o item % da solicitação % tem % aprovadas e % já entregues: entregar mais % passa da aprovada',
        NEW.solicitacao_item_id, v_solicitacao_id, v_aprovada, v_entregue, NEW.quantidade
      USING ERRCODE = 'check_violation', CONSTRAINT = 'vinculo_quantidade', TABLE = 'entregas_epi_itens';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_entregas_epi_itens_vinculo_solicitacao
  BEFORE INSERT ON entregas_epi_itens
  FOR EACH ROW EXECUTE FUNCTION validar_vinculo_da_entrega_epi_com_solicitacao();

-- Conferência do COMMIT, nos dois sentidos: a solicitação está ENTREGUE se e
-- somente se toda a quantidade aprovada dos itens APROVADOS foi entregue (o
-- item reprovado não conta), e nenhum item passa da aprovada. Roda quando o
-- item da entrega é gravado e quando a solicitação é atualizada, então vale
-- tanto para "fechei sem entregar tudo" quanto para "entreguei tudo e não
-- fechei". O erro leva o nome da regra, venha de onde vier.
CREATE FUNCTION exigir_entrega_coerente_da_solicitacao_epi() RETURNS TRIGGER AS $$
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
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_entregas_epi_itens_entrega_coerente
  AFTER INSERT ON entregas_epi_itens
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION exigir_entrega_coerente_da_solicitacao_epi();

CREATE CONSTRAINT TRIGGER trg_solicitacoes_epi_entrega_coerente
  AFTER UPDATE ON solicitacoes_epi
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION exigir_entrega_coerente_da_solicitacao_epi();
