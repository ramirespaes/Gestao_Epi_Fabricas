-- 089 — Atendimento Token (Etapa J, J2a): guarda a primeira observação de silêncio do tablet entre as passagens do job.
--
-- `queda_suspeita_desde` é o instante em que o job viu pela primeira vez o tablet mudo há pelo menos o limiar de OFFLINE. A
-- QUEDA só é confirmada numa passagem posterior, depois do tempo adicional de confirmação; o job é um processo de vida curta,
-- então a primeira observação precisa estar no banco para sobreviver entre as execuções. Nula = sem suspeita aberta. A coluna
-- não é estado visual, não é evento e não confirma queda: quem a lê e a limpa é o monitoramento (e o heartbeat, ao cancelar).
--
-- Só esta coluna: anulável, sem DEFAULT, sem backfill, sem índice, sem CHECK e sem gatilho. Nenhuma linha existente muda
-- (todas ficam sem suspeita) e `atualizado_em` não é tocado, porque ADD COLUMN não dispara gatilho de linha. Nenhuma
-- migration anterior é alterada e esta não depende de nenhuma migration além da 086, que cria `token_dispositivos`.
--
-- Bloqueio: ADD COLUMN anulável sem DEFAULT só altera o catálogo (ACCESS EXCLUSIVE por instantes, sem reescrever a tabela).
ALTER TABLE token_dispositivos
  ADD COLUMN queda_suspeita_desde TIMESTAMPTZ;
