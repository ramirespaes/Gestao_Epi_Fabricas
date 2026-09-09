-- acoes: catálogo de ações de negócio controláveis por permissão (distintas
-- de "recurso", que é acesso a página/módulo). Nada disso fica hardcoded na
-- estrutura do banco — nova ação é um INSERT aqui, consumido por
-- permissoes_acao e usuario_bloqueios via FK.
CREATE TABLE acoes (
  codigo         VARCHAR(60) PRIMARY KEY,
  nome           VARCHAR(120) NOT NULL,
  descricao      TEXT,
  ativo          BOOLEAN NOT NULL DEFAULT true,
  criado_em      TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_acoes_atualizado_em
  BEFORE UPDATE ON acoes
  FOR EACH ROW EXECUTE FUNCTION set_atualizado_em();

INSERT INTO acoes (codigo, nome) VALUES
  ('APROVAR_SOLICITACAO',   'Aprovar solicitação'),
  ('REPROVAR_SOLICITACAO',  'Reprovar solicitação'),
  ('MOVIMENTAR_ESTOQUE',    'Movimentar estoque'),
  ('REALIZAR_ENTREGA',      'Realizar entrega de EPI'),
  ('REDEFINIR_SENHA',       'Redefinir senha de usuário'),
  ('GERENCIAR_USUARIOS',    'Gerenciar usuários'),
  ('IMPORTAR_FUNCIONARIOS', 'Importar funcionários'),
  ('ALTERAR_CONFIGURACOES', 'Alterar configurações do sistema');
