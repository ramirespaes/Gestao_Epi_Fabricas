-- funcionarios: data de admissão (Bloco 9, Etapa C, Parte C4 — decisão D2
-- de 25/09/2026: a planilha de importação exige "Contratação" e a tabela
-- 006 não tinha onde guardá-la).
--
-- ALTER ADITIVO sobre a tabela histórica 006, que permanece intocada
-- (CLAUDE.md §12). Coluna NULÁVEL e sem DEFAULT: nenhum registro existente
-- é alterado, nenhum backfill — um funcionário anterior a esta migration
-- simplesmente não tem data de admissão registrada.
--
-- DATE, sem hora e sem fuso: é um dia do calendário. A aplicação a devolve
-- sempre como texto AAAA-MM-DD formatado no PostgreSQL (to_char), nunca
-- como Date do Node (mesma correção aplicada à validade do CA).
--
-- Barreiras estruturais (a regra de negócio fica na aplicação, que recusa
-- antes com erro de domínio; estes CHECKs são a segunda barreira):
--   * nenhuma data anterior a 1900-01-01 (erro de digitação/ano de 2 dígitos);
--   * admissão sempre DEPOIS do nascimento, quando os dois existem.
-- Data futura NÃO é barrada (admissão agendada é legítima).
ALTER TABLE funcionarios
  ADD COLUMN data_admissao DATE;

ALTER TABLE funcionarios
  ADD CONSTRAINT chk_funcionarios_data_admissao_minima
    CHECK (data_admissao IS NULL OR data_admissao >= DATE '1900-01-01'),
  ADD CONSTRAINT chk_funcionarios_admissao_apos_nascimento
    CHECK (data_admissao IS NULL OR data_nascimento IS NULL OR data_admissao > data_nascimento);
