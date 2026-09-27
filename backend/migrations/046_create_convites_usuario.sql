-- convites_usuario e convite_usuario_tentativas: convite de uma pessoa
-- para um vínculo novo DENTRO de uma empresa (Bloco 9, parte F). Mesmo
-- desenho aprovado para o convite do primeiro MASTER (033/034), agora
-- emitido por quem administra usuários da própria empresa:
--
--   1. Quem convida informa e-mail, nome e perfil. NENHUM vínculo nem
--      identidade nasce nesse instante — só esta linha.
--   2. Token opaco de alta entropia (src/security/token.js), do qual SÓ o
--      SHA-256 hexadecimal fica em token_hash. O token em claro existe
--      apenas na criação (para a entrega) e no aceite. Nunca em banco,
--      log, auditoria ou mensagem de erro.
--   3. No aceite, dois caminhos: identidade global inexistente => a pessoa
--      define a própria senha, e identidade + vínculo nascem na mesma
--      transação; identidade existente => a senha ATUAL dela é exigida
--      antes do vínculo (prova de titularidade, nunca só o e-mail).
--   4. Uso único, prazo de validade e cancelamento por quem administra.
--
-- SITUAÇÃO DERIVADA, NUNCA UMA COLUNA "status" (mesma regra da 033):
--   PENDENTE  = aceito_em IS NULL AND cancelado_em IS NULL AND expira_em > now()
--   ACEITO    = aceito_em IS NOT NULL
--   CANCELADO = cancelado_em IS NOT NULL
--   EXPIRADO  = os dois nulos AND expira_em <= now()
--
-- ISOLAMENTO: criado_por e usuario_id são FKs COMPOSTAS (empresa_id, ...)
-- -> usuarios (empresa_id, id) via uq_usuarios_empresa_id (013). Nem quem
-- convida nem o vínculo que nasce do aceite podem ser de OUTRA empresa,
-- mesmo por erro de aplicação. ON DELETE RESTRICT: convite é registro
-- histórico e usuários não são apagados fisicamente.
--
-- nome e perfil são os do vínculo que vai nascer. perfil é FK para o
-- catálogo de perfis (002), como em usuarios. Quem pode convidar para cada
-- perfil é regra do serviço, não do banco.
--
-- email_convite fica só na forma normalizada (minúsculas, sem espaços nas
-- pontas), a mesma de src/utils/normalizacao.js: o índice dos pendentes
-- compara a coluna diretamente.
CREATE TABLE convites_usuario (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  empresa_id       INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  email_convite    VARCHAR(150) NOT NULL,
  nome             VARCHAR(150) NOT NULL,
  perfil           VARCHAR(20) NOT NULL REFERENCES perfis(codigo) ON DELETE RESTRICT ON UPDATE CASCADE,
  token_hash       CHAR(64) NOT NULL,
  criado_por       INTEGER NOT NULL,
  criado_em        TIMESTAMPTZ NOT NULL DEFAULT now(),
  expira_em        TIMESTAMPTZ NOT NULL,
  cancelado_em     TIMESTAMPTZ,
  aceito_em        TIMESTAMPTZ,
  identidade_id    INTEGER REFERENCES identidades(id) ON DELETE RESTRICT,
  usuario_id       INTEGER,
  CONSTRAINT uq_convites_usuario_token_hash UNIQUE (token_hash),
  CONSTRAINT fk_convites_usuario_criado_por_mesma_empresa
    FOREIGN KEY (empresa_id, criado_por)
    REFERENCES usuarios (empresa_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_convites_usuario_usuario_mesma_empresa
    FOREIGN KEY (empresa_id, usuario_id)
    REFERENCES usuarios (empresa_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_convites_usuario_token_hash_formato CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_convites_usuario_email_normalizado
    CHECK (email_convite <> '' AND email_convite = lower(btrim(email_convite))),
  CONSTRAINT chk_convites_usuario_nome_preenchido CHECK (btrim(nome) <> ''),
  CONSTRAINT chk_convites_usuario_expira_apos_criacao CHECK (expira_em > criado_em),
  -- Aceito e cancelado são desfechos mutuamente exclusivos.
  CONSTRAINT chk_convites_usuario_desfecho_unico
    CHECK (NOT (aceito_em IS NOT NULL AND cancelado_em IS NOT NULL)),
  -- Aceito sempre sabe quem aceitou e qual vínculo nasceu; pendente nunca
  -- carrega nenhum dos dois (nascem juntos, na mesma transação do aceite).
  CONSTRAINT chk_convites_usuario_aceite_coerente
    CHECK (
      (aceito_em IS NULL AND identidade_id IS NULL AND usuario_id IS NULL)
      OR (aceito_em IS NOT NULL AND identidade_id IS NOT NULL AND usuario_id IS NOT NULL)
    )
);

-- "Convites pendentes desta empresa" (tela Novo usuário) e "já existe
-- convite em aberto para este e-mail nesta empresa?" (serviço, sob trava
-- consultiva, antes de criar outro): só as linhas ainda não resolvidas.
CREATE INDEX idx_convites_usuario_empresa_email_pendentes
  ON convites_usuario (empresa_id, email_convite)
  WHERE aceito_em IS NULL AND cancelado_em IS NULL;

CREATE INDEX idx_convites_usuario_empresa_id ON convites_usuario (empresa_id);

-- Futura rotina de purga de convites vencidos há muito tempo.
CREATE INDEX idx_convites_usuario_expira_em ON convites_usuario (expira_em);

-- Tentativas de ACEITE e base do cooldown persistente, espelho da 034.
-- No caminho "identidade já existe" o aceite exige a senha atual; sem
-- proteção persistente, quem tivesse o link poderia tentar senhas por
-- força bruta. Mesmo mecanismo do login (015/030/034), tabela própria.
--
-- chave_cooldown = HMAC-SHA-256(LOGIN_COOLDOWN_HMAC_SECRET,
-- 'CONVITE_USUARIO' || 0x0A || token). Derivada do token, que é o que um
-- atacante teria em mãos: cada link tem o próprio contador. O rótulo
-- separa este espaço de chaves do convite do MASTER e dos logins. O token
-- em claro não é persistido, só o HMAC.
--
-- convite_id NULÁVEL: token que não corresponde a convite nenhum ainda
-- conta para o cooldown daquela chave. Limiares: os mesmos
-- authConfig.cooldown.niveis do login, sem variável de ambiente nova.
CREATE TABLE convite_usuario_tentativas (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  chave_cooldown  CHAR(64) NOT NULL,
  convite_id      BIGINT REFERENCES convites_usuario(id) ON DELETE RESTRICT,
  sucesso         BOOLEAN NOT NULL,
  motivo          VARCHAR(30),
  cooldown_ate    TIMESTAMPTZ,
  ip              VARCHAR(45),
  dispositivo     VARCHAR(150),
  criado_em       TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT chk_convite_usuario_tentativas_chave_formato
    CHECK (chave_cooldown ~ '^[0-9a-f]{64}$'),
  -- Aceite válido só existe com convite identificado.
  CONSTRAINT chk_convite_usuario_tentativas_sucesso_identificado
    CHECK (NOT sucesso OR convite_id IS NOT NULL),
  CONSTRAINT chk_convite_usuario_tentativas_motivo_formato
    CHECK (motivo IS NULL OR motivo ~ '^[A-Z_]{1,30}$'),
  CONSTRAINT chk_convite_usuario_tentativas_motivo_coerente
    CHECK ((sucesso AND motivo IS NULL) OR (NOT sucesso AND motivo IS NOT NULL)),
  CONSTRAINT chk_convite_usuario_tentativas_cooldown_coerente
    CHECK (
      (
        cooldown_ate IS NULL
        AND motivo IS DISTINCT FROM 'COOLDOWN_ATIVADO'
      )
      OR
      (
        cooldown_ate IS NOT NULL
        AND NOT sucesso
        AND motivo = 'COOLDOWN_ATIVADO'
        AND cooldown_ate > criado_em
      )
    )
);

CREATE INDEX idx_convite_usuario_tentativas_chave_criado_em
  ON convite_usuario_tentativas (chave_cooldown, criado_em DESC);

CREATE INDEX idx_convite_usuario_tentativas_chave_cooldown_ate
  ON convite_usuario_tentativas (chave_cooldown, cooldown_ate DESC)
  WHERE cooldown_ate IS NOT NULL;

CREATE INDEX idx_convite_usuario_tentativas_convite_id
  ON convite_usuario_tentativas (convite_id) WHERE convite_id IS NOT NULL;

CREATE INDEX idx_convite_usuario_tentativas_criado_em ON convite_usuario_tentativas (criado_em);
