-- empresas: raiz do multi-tenant. Toda tabela de negócio se relaciona a ela
-- via empresa_id, isolando os dados de cada cliente do sistema.
-- CNPJ é guardado só com os 14 dígitos — a máscara 00.000.000/0000-00 fica
-- por conta do front-end, nunca do banco.
CREATE TABLE empresas (
  id             SERIAL PRIMARY KEY,
  nome           VARCHAR(150) NOT NULL,
  cnpj           VARCHAR(14) NOT NULL,
  cidade         VARCHAR(100),
  uf             CHAR(2),
  cep            VARCHAR(9),
  endereco       VARCHAR(200),
  telefone       VARCHAR(20),
  email          VARCHAR(150),
  dpo_nome       VARCHAR(150),
  dpo_email      VARCHAR(150),
  dpo_tel        VARCHAR(20),
  ativo          BOOLEAN NOT NULL DEFAULT true,
  criado_em      TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_empresas_cnpj UNIQUE (cnpj),
  CONSTRAINT chk_empresas_cnpj_formato CHECK (cnpj ~ '^[0-9]{14}$')
);

CREATE TRIGGER trg_empresas_atualizado_em
  BEFORE UPDATE ON empresas
  FOR EACH ROW EXECUTE FUNCTION set_atualizado_em();
