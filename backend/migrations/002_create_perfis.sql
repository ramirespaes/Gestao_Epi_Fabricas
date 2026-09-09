-- perfis: catálogo de papéis de acesso. usuarios e as tabelas de permissão
-- referenciam esta tabela por FK em vez de um CHECK IN (...) duplicado em
-- cada uma. Adicionar um perfil novo no futuro é só um INSERT aqui — não
-- exige alterar a estrutura de nenhuma outra tabela.
CREATE TABLE perfis (
  codigo         VARCHAR(20) PRIMARY KEY,
  nome           VARCHAR(60) NOT NULL,
  descricao      TEXT,
  ativo          BOOLEAN NOT NULL DEFAULT true,
  criado_em      TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_perfis_atualizado_em
  BEFORE UPDATE ON perfis
  FOR EACH ROW EXECUTE FUNCTION set_atualizado_em();

INSERT INTO perfis (codigo, nome) VALUES
  ('MASTER',        'Master'),
  ('ADMINISTRADOR', 'Administrador'),
  ('SUPERVISOR',    'Supervisor'),
  ('USUARIO',       'Usuário');
