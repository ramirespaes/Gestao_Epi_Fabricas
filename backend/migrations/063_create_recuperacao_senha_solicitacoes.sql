-- Solicitações de recuperação de senha, para o limite por e-mail.
--
-- Cada linha guarda só a chave HMAC-SHA-256 do e-mail normalizado e o escopo
-- (PORTAL ou PLATAFORMA). Não há e-mail em claro, conta, nem resultado do
-- envio: a linha é gravada igual exista ou não a conta, e por isso a tabela
-- não revela quem tem cadastro. O escopo separa os dois namespaces mesmo que
-- a mesma pessoa use o mesmo e-mail nos dois.

CREATE TABLE recuperacao_senha_solicitacoes (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  escopo       VARCHAR(20) NOT NULL,
  chave        CHAR(64) NOT NULL,
  criado_em    TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip           VARCHAR(45),
  dispositivo  VARCHAR(150),
  CONSTRAINT chk_recuperacao_senha_solicitacoes_escopo CHECK (escopo IN ('PORTAL', 'PLATAFORMA')),
  CONSTRAINT chk_recuperacao_senha_solicitacoes_chave_formato CHECK (chave ~ '^[0-9a-f]{64}$')
);

-- Contagem das solicitações recentes de uma chave dentro da janela do limite.
CREATE INDEX idx_recuperacao_senha_solicitacoes_escopo_chave_criado_em
  ON recuperacao_senha_solicitacoes (escopo, chave, criado_em DESC);

-- Purga por retenção.
CREATE INDEX idx_recuperacao_senha_solicitacoes_criado_em ON recuperacao_senha_solicitacoes (criado_em);
