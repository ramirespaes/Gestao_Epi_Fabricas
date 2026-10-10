-- 084 — Situação do funcionário: ATIVO | AFASTADO | INATIVO (Gestão de Funcionários, S1, decisão O1).
--
-- Até aqui `funcionarios.ativo` (BOOLEAN) era a única representação de estado e não distingue AFASTADO de INATIVO. A fonte da
-- verdade passa a ser `situacao`; `ativo` continua existindo só por COMPATIBILIDADE de leitura, como coluna GERADA
-- (`situacao = 'ATIVO'`, STORED). Não há gatilho nem duas fontes de verdade: escrever `ativo` direto passa a ser erro do
-- PostgreSQL (428C9), então as duas colunas nunca divergem. Quem lê `ativo` (entrega, solicitação, posição de estoque,
-- consultas) continua correto sem mudança: "pode receber EPI" = só ATIVO.
--
-- Backfill: ativo = true → ATIVO; ativo = false → INATIVO. Ninguém nasce AFASTADO; AFASTADO é estado novo, criado pela aplicação.
--
-- `atualizado_em` é PRESERVADO: o backfill é uma transformação técnica do modelo, não uma alteração do cadastro. Por isso o
-- gatilho trg_funcionarios_atualizado_em é desabilitado só durante o UPDATE e religado no fim, dentro desta mesma migration
-- (transacional: se algo falhar, o estado anterior, inclusive o gatilho, é restaurado).
--
-- Preservados: ids, empresa, GHE, CPF, matrícula, datas, criado_em, restrições, FKs que apontam para funcionarios, índices e
-- unicidades (nenhum deles envolve `ativo`). DEFAULT 'ATIVO' mantém válido o INSERT sem a coluna (cadastro e importação).
--
-- Bloqueio: ALTER TABLE exige ACCESS EXCLUSIVE por instantes e reescreve a tabela (coluna gerada STORED); tabela pequena.
-- Migrations já aplicadas (006, 040, 057, 073, 081) ficam intocadas.

ALTER TABLE funcionarios DISABLE TRIGGER trg_funcionarios_atualizado_em;

ALTER TABLE funcionarios
  ADD COLUMN situacao VARCHAR(10);

UPDATE funcionarios
   SET situacao = CASE WHEN ativo THEN 'ATIVO' ELSE 'INATIVO' END;

ALTER TABLE funcionarios
  ALTER COLUMN situacao SET DEFAULT 'ATIVO',
  ALTER COLUMN situacao SET NOT NULL,
  ADD CONSTRAINT chk_funcionarios_situacao CHECK (situacao IN ('ATIVO', 'AFASTADO', 'INATIVO'));

ALTER TABLE funcionarios
  DROP COLUMN ativo;

ALTER TABLE funcionarios
  ADD COLUMN ativo BOOLEAN GENERATED ALWAYS AS (situacao = 'ATIVO') STORED NOT NULL;

ALTER TABLE funcionarios ENABLE TRIGGER trg_funcionarios_atualizado_em;
