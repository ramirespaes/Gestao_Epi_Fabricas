-- empresas.cnpj: adequação ao formato alfanumérico do CNPJ adotado pela
-- Receita Federal.
--
-- As 12 primeiras posições passam a aceitar dígitos e letras maiúsculas de
-- A a Z; as duas últimas permanecem exclusivamente numéricas.
--
-- Esta migration substitui somente a expressão de chk_empresas_cnpj_formato e
-- preserva o nome da constraint. Nada mais da tabela muda: o tipo VARCHAR(14),
-- o NOT NULL da coluna, uq_empresas_cnpj, empresas_pkey, os demais índices e a
-- trigger trg_empresas_atualizado_em seguem intactos.
--
-- O formato novo é um superconjunto estrito do anterior, então o ADD revalida
-- as linhas existentes sem rejeitar nenhum CNPJ já gravado.
--
-- Minúsculas continuam recusadas de propósito, para que exista uma única
-- representação canônica persistida. Normalizar a entrada para maiúsculas é
-- responsabilidade da aplicação, em src/utils/normalizacao.js.

ALTER TABLE empresas
  DROP CONSTRAINT chk_empresas_cnpj_formato;

ALTER TABLE empresas
  ADD CONSTRAINT chk_empresas_cnpj_formato
  CHECK (cnpj ~ '^[0-9A-Z]{12}[0-9]{2}$');
