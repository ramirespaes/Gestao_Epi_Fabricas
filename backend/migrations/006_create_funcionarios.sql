-- funcionarios: colaboradores da empresa-cliente que recebem EPI.
-- Opcionalmente vinculados a um Grupo Homogêneo de Exposição.
--
-- fk_funcionarios_ghe_mesma_empresa é uma FK composta (empresa_id,
-- grupo_homogeneo_id) -> grupos_homogeneos_exposicao(empresa_id, id): impede
-- no banco que um funcionário da Empresa A aponte para um GHE da Empresa B.
-- Como grupo_homogeneo_id é NULLABLE, o vínculo continua opcional (FK
-- composta com qualquer coluna NULL é ignorada pelo Postgres).
--
-- ON DELETE é RESTRICT (não SET NULL): numa FK de múltiplas colunas, SET
-- NULL zeraria TODAS as colunas da FK, inclusive empresa_id — que é NOT
-- NULL. Isso quebraria a exclusão do GHE. RESTRICT é a opção segura em
-- qualquer versão do Postgres: para apagar um GHE ainda referenciado, a
-- aplicação precisa antes desvincular (UPDATE ... SET grupo_homogeneo_id =
-- NULL) os funcionários que apontam pra ele.
CREATE TABLE funcionarios (
  id                  SERIAL PRIMARY KEY,
  empresa_id          INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  grupo_homogeneo_id  INTEGER,
  matricula           VARCHAR(30) NOT NULL,
  nome                VARCHAR(150) NOT NULL,
  cpf                 VARCHAR(11) NOT NULL,
  data_nascimento     DATE,
  setor               VARCHAR(100),
  funcao              VARCHAR(100),
  cracha              VARCHAR(30),
  telefone            VARCHAR(20),
  ativo               BOOLEAN NOT NULL DEFAULT true,
  criado_em           TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em       TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Únicas por empresa. Matrícula não é reaproveitada mesmo com o
  -- funcionário inativo (ativo = false) — permanece reservada de propósito.
  CONSTRAINT uq_funcionarios_empresa_matricula UNIQUE (empresa_id, matricula),
  CONSTRAINT uq_funcionarios_empresa_cpf UNIQUE (empresa_id, cpf),
  CONSTRAINT chk_funcionarios_cpf_formato CHECK (cpf ~ '^[0-9]{11}$'),
  CONSTRAINT fk_funcionarios_ghe_mesma_empresa
    FOREIGN KEY (empresa_id, grupo_homogeneo_id)
    REFERENCES grupos_homogeneos_exposicao (empresa_id, id)
    ON DELETE RESTRICT
);

CREATE INDEX idx_funcionarios_grupo_homogeneo_id ON funcionarios (grupo_homogeneo_id);

CREATE TRIGGER trg_funcionarios_atualizado_em
  BEFORE UPDATE ON funcionarios
  FOR EACH ROW EXECUTE FUNCTION set_atualizado_em();
