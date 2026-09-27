-- Abertura do estoque por lote a partir de estoque_tamanhos.
--
-- Cada saldo positivo vira um lote SALDO_INICIAL, com a sua operação, na
-- empresa do material. Levo o CA do material só quando número e validade
-- estão completos; sem o par, o lote fica sem CA e nada é inventado. CA já
-- vencido é copiado como está, e o saldo continua inteiro.
-- estoque_tamanhos e materiais não mudam; saldo zero não gera lote.

DO $$
BEGIN
  -- Esta abertura acontece uma única vez.
  IF EXISTS (SELECT 1 FROM estoque_lotes WHERE origem = 'SALDO_INICIAL') THEN
    RAISE EXCEPTION 'o saldo inicial já foi migrado para estoque_lotes';
  END IF;
  -- Tamanho vazio não forma lote; prefiro parar a migração a perder saldo.
  IF EXISTS (SELECT 1 FROM estoque_tamanhos WHERE quantidade > 0 AND btrim(tamanho) = '') THEN
    RAISE EXCEPTION 'há saldo em estoque_tamanhos com tamanho vazio: corrija antes de migrar';
  END IF;
END $$;

-- Aparo tamanho e CA como o serviço faz ao gravar.
WITH saldos AS (
  SELECT et.id AS saldo_id,
         m.empresa_id,
         m.id AS material_id,
         btrim(et.tamanho) AS tamanho,
         et.quantidade,
         btrim(m.ca_numero) AS ca_numero,
         m.ca_validade,
         (btrim(m.ca_numero) <> '' AND m.ca_validade IS NOT NULL) IS TRUE AS ca_completo
    FROM estoque_tamanhos et
    JOIN materiais m ON m.id = et.material_id
   WHERE et.quantidade > 0
)
INSERT INTO estoque_lotes (empresa_id, material_id, tamanho, ca_numero, ca_validade, origem, quantidade_entrada)
SELECT empresa_id,
       material_id,
       tamanho,
       CASE WHEN ca_completo THEN ca_numero END,
       CASE WHEN ca_completo THEN ca_validade END,
       'SALDO_INICIAL',
       quantidade
  FROM saldos
 ORDER BY saldo_id;

-- A abertura não veio de uma requisição: fica sem responsável e sem chave.
INSERT INTO estoque_operacoes (empresa_id, lote_id, tipo, quantidade)
SELECT empresa_id, id, 'SALDO_INICIAL', quantidade_entrada
  FROM estoque_lotes
 WHERE origem = 'SALDO_INICIAL'
 ORDER BY id;

-- Confiro agora, e não no commit, que cada lote aberto aqui tem a sua
-- operação. A próxima migration pode alterar estoque_lotes na mesma transação,
-- e o PostgreSQL recusa ALTER TABLE com verificação adiada pendente. Depois
-- devolvo o gatilho ao modo adiado para o resto da transação.
SET CONSTRAINTS trg_estoque_lotes_exigir_entrada IMMEDIATE;
SET CONSTRAINTS trg_estoque_lotes_exigir_entrada DEFERRED;
