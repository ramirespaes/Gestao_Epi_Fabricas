-- 076 — Matrícula, setor e horário de trabalho do usuário administrativo
-- (Gestão de Usuários, Novo → Usuário; decisão de 05/10/2026)
--
-- Dados do VÍNCULO da pessoa com a empresa: ficam em usuarios, sem nenhuma
-- relação com o cadastro operacional de funcionarios. Nulos para os vínculos
-- existentes; a tela de criação os exige (matrícula e setor obrigatórios,
-- horário opcional). A matrícula é única dentro da empresa, comparada
-- exatamente (mesma disciplina do funcionário).
--
-- Horário de trabalho: representação simples, dois horários (início e fim),
-- sempre os dois ou nenhum. Nesta fase é dado administrativo/informativo:
-- não participa de login, sessão nem middleware.

ALTER TABLE usuarios
  ADD COLUMN matricula               VARCHAR(30),
  ADD COLUMN setor                   VARCHAR(100),
  ADD COLUMN horario_trabalho_inicio TIME,
  ADD COLUMN horario_trabalho_fim    TIME;

ALTER TABLE usuarios
  ADD CONSTRAINT chk_usuarios_matricula_formato
    CHECK (matricula IS NULL OR (btrim(matricula) = matricula AND length(matricula) BETWEEN 1 AND 30)),
  ADD CONSTRAINT chk_usuarios_setor_formato
    CHECK (setor IS NULL OR (btrim(setor) = setor AND length(setor) BETWEEN 1 AND 100)),
  ADD CONSTRAINT chk_usuarios_horario_trabalho
    CHECK ((horario_trabalho_inicio IS NULL) = (horario_trabalho_fim IS NULL));

CREATE UNIQUE INDEX uq_usuarios_empresa_matricula
  ON usuarios (empresa_id, matricula)
  WHERE matricula IS NOT NULL;
