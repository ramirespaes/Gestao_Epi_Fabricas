-- Configurações / vínculo usuário ↔ funcionário (05/10/2026): o usuário
-- empresarial pode ser ligado, de forma EXPLÍCITA e opcional, ao funcionário
-- que ele é na MESMA empresa. Usuário e funcionário continuam entidades
-- distintas: CPF e matrícula ficam só em funcionarios e são lidos por este
-- vínculo, nunca copiados para usuarios ou identidades nem inferidos por
-- nome, e-mail, CPF ou matrícula. A identidade (global) não recebe vínculo.
--
-- Integridade declarativa, sem gatilho: a FK composta (empresa_id,
-- funcionario_id) usa a unicidade uq_funcionarios_empresa_id (057), então o
-- funcionário é sempre da empresa do usuário; a unicidade (empresa_id,
-- funcionario_id) impede dois usuários da empresa no mesmo funcionário
-- (NULL não participa). Nenhuma linha existente é vinculada: a coluna nasce
-- nula para todos; o vínculo é sempre um ato explícito posterior.

ALTER TABLE usuarios
  ADD COLUMN funcionario_id INTEGER;

ALTER TABLE usuarios
  ADD CONSTRAINT fk_usuarios_funcionario_mesma_empresa
    FOREIGN KEY (empresa_id, funcionario_id)
    REFERENCES funcionarios (empresa_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT uq_usuarios_empresa_funcionario
    UNIQUE (empresa_id, funcionario_id);
