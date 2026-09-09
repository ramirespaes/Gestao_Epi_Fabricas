-- Função utilitária usada pelas triggers "trg_*_atualizado_em" das tabelas
-- abaixo: mantém a coluna atualizado_em sempre em dia em qualquer UPDATE.
CREATE OR REPLACE FUNCTION set_atualizado_em()
RETURNS TRIGGER AS $$
BEGIN
  NEW.atualizado_em = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
