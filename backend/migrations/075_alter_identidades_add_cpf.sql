-- 075 — CPF da identidade (Gestão de Usuários, Novo → Usuário; decisão de 05/10/2026)
--
-- O CPF é dado da PESSOA: fica na identidade global, nunca em usuarios e nunca
-- reaproveitado do cadastro operacional de funcionarios. Canônico (11 dígitos,
-- sem máscara), único no sistema inteiro e nulo para as identidades anteriores
-- (sem backfill: o preenchimento dos legados é decisão da futura edição de
-- usuário). Os dígitos verificadores são conferidos pela aplicação
-- (utils/normalizacao.js), como no funcionário; a constraint só garante o
-- formato.
--
-- IMUTÁVEL depois de definido: nenhum fluxo administrativo troca o CPF de uma
-- identidade que já o tem, nem o MASTER. O gatilho recusa qualquer UPDATE que
-- altere ou apague um CPF gravado; só a primeira definição (NULL -> valor) é
-- aceita.

ALTER TABLE identidades
  ADD COLUMN cpf CHAR(11);

ALTER TABLE identidades
  ADD CONSTRAINT chk_identidades_cpf_formato
    CHECK (cpf IS NULL OR cpf ~ '^[0-9]{11}$');

CREATE UNIQUE INDEX uq_identidades_cpf
  ON identidades (cpf)
  WHERE cpf IS NOT NULL;

CREATE OR REPLACE FUNCTION identidades_cpf_imutavel()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.cpf IS NOT NULL AND NEW.cpf IS DISTINCT FROM OLD.cpf THEN
    RAISE EXCEPTION 'identidades: o CPF de uma identidade não pode ser alterado nem removido';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_identidades_cpf_imutavel
  BEFORE UPDATE OF cpf ON identidades
  FOR EACH ROW
  EXECUTE FUNCTION identidades_cpf_imutavel();
