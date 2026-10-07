-- Gestão de Usuários (05/10/2026): senha PROVISÓRIA da identidade global.
-- O usuário criado diretamente na empresa recebe uma senha provisória do
-- administrador e troca obrigatoriamente no primeiro acesso; a identidade é
-- a autoridade da senha, então o estado mora aqui, nunca em usuarios.
--
-- Integridade declarativa, sem gatilho: provisória exige as duas datas
-- (definição e expiração, esta depois daquela); sem provisória as duas são
-- nulas. Linhas existentes — o primeiro MASTER do Painel Privado e quem já
-- definiu a própria senha — recebem false e não mudam de comportamento. A
-- validade (48 h, ou 72 h na sexta-feira) é calculada pela aplicação no
-- fuso operacional; o banco só guarda os instantes.

ALTER TABLE identidades
  ADD COLUMN senha_provisoria             BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN senha_provisoria_definida_em TIMESTAMPTZ,
  ADD COLUMN senha_provisoria_expira_em   TIMESTAMPTZ;

ALTER TABLE identidades
  ADD CONSTRAINT chk_identidades_senha_provisoria
    CHECK (
      (senha_provisoria
        AND senha_provisoria_definida_em IS NOT NULL
        AND senha_provisoria_expira_em IS NOT NULL
        AND senha_provisoria_expira_em > senha_provisoria_definida_em)
      OR
      (NOT senha_provisoria
        AND senha_provisoria_definida_em IS NULL
        AND senha_provisoria_expira_em IS NULL)
    );
