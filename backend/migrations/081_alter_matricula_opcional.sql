-- 081 — 12K-E: a matrícula passa a ser opcional (CPF continua obrigatório).
--
-- funcionarios.matricula e a cópia histórica entregas_epi.trabalhador_matricula aceitam NULL. A
-- UNIQUE (empresa_id, matricula) da 006 continua: NULL nunca colide com NULL, e a matrícula
-- informada segue única por empresa. Nenhuma matrícula é inventada ou derivada de CPF; nenhuma
-- linha existente é alterada (sem backfill); as migrations 006 e 058 não mudam.
--
-- NULL é a única forma de "sem matrícula": o CHECK recusa vazio e espaços externos. Em
-- funcionarios ele entra NOT VALID (a regra vale para toda escrita nova, sem varrer a tabela
-- nem recusar linha antiga). O CHECK do snapshot da entrega é substituído pela mesma regra de
-- antes, exceto a matrícula, que só é validada quando existe; as linhas existentes já a
-- cumprem, então ele é validado.

ALTER TABLE funcionarios
  ALTER COLUMN matricula DROP NOT NULL;

ALTER TABLE funcionarios
  ADD CONSTRAINT chk_funcionarios_matricula_formato
    CHECK (matricula IS NULL OR (btrim(matricula) = matricula AND char_length(matricula) > 0)) NOT VALID;

ALTER TABLE entregas_epi
  ALTER COLUMN trabalhador_matricula DROP NOT NULL;

ALTER TABLE entregas_epi
  DROP CONSTRAINT chk_entregas_epi_snapshots_aparados;

ALTER TABLE entregas_epi
  ADD CONSTRAINT chk_entregas_epi_snapshots_aparados CHECK (
    btrim(empresa_nome) = empresa_nome AND char_length(empresa_nome) > 0
    AND btrim(trabalhador_nome) = trabalhador_nome AND char_length(trabalhador_nome) > 0
    AND (trabalhador_matricula IS NULL OR (btrim(trabalhador_matricula) = trabalhador_matricula AND char_length(trabalhador_matricula) > 0))
    AND btrim(responsavel_nome) = responsavel_nome AND char_length(responsavel_nome) > 0
    AND (empresa_endereco IS NULL OR (btrim(empresa_endereco) = empresa_endereco AND char_length(empresa_endereco) > 0))
    AND (empresa_cidade IS NULL OR (btrim(empresa_cidade) = empresa_cidade AND char_length(empresa_cidade) > 0))
    AND (trabalhador_funcao IS NULL OR (btrim(trabalhador_funcao) = trabalhador_funcao AND char_length(trabalhador_funcao) > 0))
    AND (trabalhador_setor IS NULL OR (btrim(trabalhador_setor) = trabalhador_setor AND char_length(trabalhador_setor) > 0))
    AND (ghe_nome IS NULL OR (btrim(ghe_nome) = ghe_nome AND char_length(ghe_nome) > 0)));
