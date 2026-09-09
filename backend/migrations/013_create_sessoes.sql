-- sessoes: sessões autenticadas mantidas no servidor (uma linha por login).
-- O navegador recebe apenas um token opaco aleatório (32 bytes) num cookie
-- HttpOnly; aqui fica somente o SHA-256 hexadecimal desse token
-- (token_hash). O token em claro NUNCA é gravado — um vazamento desta
-- tabela não permite reutilizar nenhuma sessão.
--
-- Uma sessão é considerada válida quando, simultaneamente:
--   revogada_em IS NULL
--   AND expira_em > now()                       (expiração absoluta)
--   AND ultimo_uso_em > now() - <inatividade>   (expiração por inatividade,
--                                                valor vindo do .env)
--   AND usuarios.ativo = true AND empresas.ativo = true (via JOIN na consulta)
--
-- Logout/inativação não apagam a linha: marcam revogada_em + motivo, o que
-- preserva rastreabilidade. A purga física de linhas antigas (expiradas ou
-- revogadas há mais de N dias) é feita por rotina de manutenção da
-- aplicação, não por trigger — ver docs/arquitetura-auth.md.
--
-- Preparação para o futuro, sem uso nesta etapa:
--   autenticado_via   : 'SENHA' hoje; 'GOOGLE', 'APPLE', 'PASSKEY' etc. depois.
--   mfa_verificado_em : preenchido quando um segundo fator for confirmado.
-- Não usamos CHECK IN (...) nesses dois campos pelo mesmo motivo das tabelas
-- perfis/acoes: um valor novo não deve exigir alteração de estrutura.

-- Garante que (empresa_id, id) seja referenciável por FK composta. Existe
-- para que sessoes.empresa_id nunca possa divergir de usuarios.empresa_id
-- (mesmo padrão de uq_ghe_empresa_id em 004). Não altera dados nem colunas
-- de usuarios — apenas adiciona uma constraint.
ALTER TABLE usuarios
  ADD CONSTRAINT uq_usuarios_empresa_id UNIQUE (empresa_id, id);

CREATE TABLE sessoes (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  usuario_id         INTEGER NOT NULL,
  empresa_id         INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  token_hash         CHAR(64) NOT NULL,
  autenticado_via    VARCHAR(20) NOT NULL DEFAULT 'SENHA',
  mfa_verificado_em  TIMESTAMPTZ,
  criado_em          TIMESTAMPTZ NOT NULL DEFAULT now(),
  expira_em          TIMESTAMPTZ NOT NULL,
  ultimo_uso_em      TIMESTAMPTZ NOT NULL DEFAULT now(),
  revogada_em        TIMESTAMPTZ,
  motivo_revogacao   VARCHAR(30),
  ip                 VARCHAR(45),
  dispositivo        VARCHAR(150),
  CONSTRAINT uq_sessoes_token_hash UNIQUE (token_hash),
  -- Único vínculo sessão -> usuário. É composta de propósito: não existe FK
  -- simples em usuario_id, então uma sessão jamais pode apontar para um
  -- usuário de outra empresa, mesmo por erro de aplicação.
  CONSTRAINT fk_sessoes_usuario_mesma_empresa
    FOREIGN KEY (empresa_id, usuario_id)
    REFERENCES usuarios (empresa_id, id) ON DELETE CASCADE,
  CONSTRAINT chk_sessoes_token_hash_formato CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_sessoes_autenticado_via_formato CHECK (autenticado_via ~ '^[A-Z_]{1,20}$'),
  CONSTRAINT chk_sessoes_expira_apos_criacao CHECK (expira_em > criado_em),
  CONSTRAINT chk_sessoes_revogacao_coerente CHECK (
    (revogada_em IS NULL AND motivo_revogacao IS NULL)
    OR (revogada_em IS NOT NULL AND motivo_revogacao IS NOT NULL)
  )
);

-- Consulta principal do middleware é por token_hash (coberta pela UNIQUE).
-- Índice parcial para "revogar todas as sessões não revogadas do usuário X"
-- (logout global, inativação, troca de senha) sem varrer sessões já revogadas.
-- Observação: uma sessão pode estar expirada e ainda não revogada — por isso
-- o nome do índice fala em "não revogadas", não em "ativas".
CREATE INDEX idx_sessoes_usuario_id_nao_revogadas
  ON sessoes (usuario_id) WHERE revogada_em IS NULL;

-- Usado pela rotina de purga de sessões expiradas.
CREATE INDEX idx_sessoes_expira_em ON sessoes (expira_em);
