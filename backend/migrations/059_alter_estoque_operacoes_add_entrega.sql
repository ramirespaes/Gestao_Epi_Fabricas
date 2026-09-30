-- estoque_operacoes aceita ENTREGA.
--
-- A operação ENTREGA pertence a exatamente um item da entrega. O vínculo é
-- declarativo: a FK composta (empresa, item, lote, quantidade) prova que a
-- operação é da mesma empresa, do mesmo lote e da mesma quantidade do item,
-- e o índice único parcial impede duas operações para o mesmo item. Sem
-- vínculo não há ENTREGA: o CHECK recusa a linha mesmo no meio da transação.
--
-- A idempotência fica no cabeçalho da entrega (058), então a operação
-- ENTREGA não carrega chave nem hash; ENTRADA e BAIXA continuam exigindo os
-- dois e SALDO_INICIAL continua sem eles. A regra passa a ser explícita por
-- tipo. A 042 não é alterada.

ALTER TABLE estoque_operacoes
  ADD COLUMN entrega_item_id INTEGER;

ALTER TABLE estoque_operacoes
  DROP CONSTRAINT chk_estoque_operacoes_tipo,
  ADD CONSTRAINT chk_estoque_operacoes_tipo
    CHECK (tipo IN ('SALDO_INICIAL', 'ENTRADA', 'BAIXA', 'ENTREGA')),
  DROP CONSTRAINT chk_estoque_operacoes_idempotencia,
  ADD CONSTRAINT chk_estoque_operacoes_idempotencia
    CHECK ((tipo IN ('SALDO_INICIAL', 'ENTREGA') AND chave_idempotencia IS NULL AND requisicao_hash IS NULL)
           OR (tipo IN ('ENTRADA', 'BAIXA') AND chave_idempotencia IS NOT NULL AND requisicao_hash IS NOT NULL)),
  ADD CONSTRAINT chk_estoque_operacoes_vinculo_entrega
    CHECK ((tipo = 'ENTREGA') = (entrega_item_id IS NOT NULL)),
  ADD CONSTRAINT fk_estoque_operacoes_item_da_entrega
    FOREIGN KEY (empresa_id, entrega_item_id, lote_id, quantidade)
    REFERENCES entregas_epi_itens (empresa_id, id, lote_id, quantidade)
    ON DELETE RESTRICT;

-- No máximo uma operação por item.
CREATE UNIQUE INDEX uq_estoque_operacoes_entrega_item
  ON estoque_operacoes (entrega_item_id)
  WHERE entrega_item_id IS NOT NULL;

-- Mesma função da 042, com a ENTREGA somando quantidade_entregue. A trava do
-- lote continua serializando operações simultâneas; entrega acima do saldo
-- cai em chk_estoque_lotes_quantidades, a última barreira.
CREATE OR REPLACE FUNCTION aplicar_estoque_operacao() RETURNS TRIGGER AS $$
DECLARE
  lote estoque_lotes%ROWTYPE;
BEGIN
  SELECT * INTO lote FROM estoque_lotes
   WHERE empresa_id = NEW.empresa_id AND id = NEW.lote_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote % não encontrado nesta empresa', NEW.lote_id;
  END IF;

  IF NEW.tipo IN ('SALDO_INICIAL', 'ENTRADA') THEN
    IF lote.origem <> NEW.tipo OR lote.quantidade_entrada <> NEW.quantidade THEN
      RAISE EXCEPTION 'a operação de entrada precisa ter o tipo e a quantidade do lote %', NEW.lote_id;
    END IF;
  ELSIF NEW.tipo = 'BAIXA' THEN
    UPDATE estoque_lotes
       SET quantidade_baixada = quantidade_baixada + NEW.quantidade
     WHERE empresa_id = NEW.empresa_id AND id = NEW.lote_id;
  ELSIF NEW.tipo = 'ENTREGA' THEN
    UPDATE estoque_lotes
       SET quantidade_entregue = quantidade_entregue + NEW.quantidade
     WHERE empresa_id = NEW.empresa_id AND id = NEW.lote_id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Confiro no COMMIT: item sem a sua operação ENTREGA não existe.
CREATE FUNCTION exigir_operacao_do_item_da_entrega_epi() RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM estoque_operacoes
     WHERE empresa_id = NEW.empresa_id AND entrega_item_id = NEW.id AND tipo = 'ENTREGA'
  ) THEN
    RAISE EXCEPTION 'o item % da entrega % precisa da sua operação ENTREGA na mesma transação', NEW.id, NEW.entrega_id
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'trg_entregas_epi_itens_exigir_operacao',
            TABLE = 'entregas_epi_itens';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_entregas_epi_itens_exigir_operacao
  AFTER INSERT ON entregas_epi_itens
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION exigir_operacao_do_item_da_entrega_epi();
