-- login_tentativas: histórico de tentativas de login e base do cooldown
-- contra força bruta. É o controle PRINCIPAL; o limite por IP (na
-- aplicação) é apenas complementar, porque várias pessoas da mesma empresa
-- costumam sair pelo mesmo IP público/NAT.
--
-- CHAVE OPACA DE COOLDOWN (chave_cooldown)
-- Toda linha carrega HMAC-SHA-256(segredo, cnpj_normalizado || 0x0A ||
-- email_normalizado), em hexadecimal minúsculo (64 chars), calculado pela
-- aplicação. O segredo (LOGIN_COOLDOWN_HMAC_SECRET) vive só no ambiente da
-- aplicação e NUNCA é persistido. Consequências:
--   - empresa existente e CNPJ inexistente usam a MESMA chave, os MESMOS
--     limiares e a MESMA persistência — não há diferença observável de
--     comportamento entre os dois casos, mesmo após restart ou com várias
--     instâncias;
--   - CNPJ inexistente e e-mail digitado nunca são gravados em claro;
--   - sem o segredo, a chave não é reversível nem correlacionável a uma
--     pessoa a partir de listas públicas de CNPJ/e-mail;
--   - senha, hash de senha, token ou cookie NUNCA entram na composição.
-- Trocar o segredo zera, na prática, todos os cooldowns em curso.
--
-- LINHAS
--   Tentativa (cooldown_ate IS NULL):
--     sucesso = true  -> exige empresa_id e usuario_id; motivo NULL.
--     sucesso = false -> motivo obrigatório: SENHA_INVALIDA, USUARIO_INATIVO
--                        (com usuario_id), EMAIL_INEXISTENTE (empresa_id sem
--                        usuario_id), EMPRESA_INEXISTENTE (ambos NULL),
--                        EMPRESA_INATIVA (empresa_id sem usuario_id).
--   Ativação de cooldown (cooldown_ate IS NOT NULL):
--     uma linha por ativação, motivo COOLDOWN_ATIVADO, sucesso = false.
--     Tentativas feitas DURANTE o cooldown NÃO geram linha — respondem 429
--     e vão apenas ao log técnico. Isso limita o crescimento da tabela e
--     impede que um atacante prolongue o bloqueio de uma vítima.
--
-- LIMIARES (configuráveis no .env, aplicados pela aplicação)
--   5 falhas em 15 min  -> cooldown de 15 min;
--   10 falhas em 60 min -> cooldown de 60 min.
-- Contam apenas falhas de tentativa (cooldown_ate IS NULL) posteriores ao
-- último sucesso da mesma chave. Nunca há bloqueio permanente.
--
-- RETENÇÃO: linhas com mais de LOGIN_TENTATIVAS_RETENCAO_DIAS (padrão 30)
-- são removidas pela rotina de manutenção da aplicação (cron/EventBridge).
-- IP é dado pessoal; a retenção curta é deliberada.
--
-- Não existe coluna de e-mail, CNPJ, senha, hash de senha, token ou cookie.
CREATE TABLE login_tentativas (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  chave_cooldown  CHAR(64) NOT NULL,
  empresa_id      INTEGER REFERENCES empresas(id) ON DELETE CASCADE,
  usuario_id      INTEGER,
  sucesso         BOOLEAN NOT NULL,
  motivo          VARCHAR(30),
  cooldown_ate    TIMESTAMPTZ,
  ip              VARCHAR(45),
  dispositivo     VARCHAR(150),
  criado_em       TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Único vínculo tentativa -> usuário, composto de propósito (usa
  -- uq_usuarios_empresa_id da migration 013): uma tentativa nunca pode ser
  -- associada a usuário de outra empresa. ON DELETE RESTRICT: usuário
  -- identificado numa tentativa é inativado, não excluído; linhas antigas
  -- saem pela retenção.
  CONSTRAINT fk_login_tentativas_usuario_mesma_empresa
    FOREIGN KEY (empresa_id, usuario_id)
    REFERENCES usuarios (empresa_id, id) ON DELETE RESTRICT,

  CONSTRAINT chk_login_tentativas_chave_formato
    CHECK (chave_cooldown ~ '^[0-9a-f]{64}$'),
  -- usuario_id sem empresa_id deixaria a FK composta sem verificação
  -- (MATCH SIMPLE ignora a checagem quando há NULL). Proibido.
  CONSTRAINT chk_login_tentativas_usuario_exige_empresa
    CHECK (usuario_id IS NULL OR empresa_id IS NOT NULL),
  -- Login válido só existe com empresa e usuário identificados.
  CONSTRAINT chk_login_tentativas_sucesso_identificado
    CHECK (NOT sucesso OR (empresa_id IS NOT NULL AND usuario_id IS NOT NULL)),
  CONSTRAINT chk_login_tentativas_motivo_formato
    CHECK (motivo IS NULL OR motivo ~ '^[A-Z_]{1,30}$'),
  -- Sucesso não tem motivo; falha e ativação de cooldown sempre têm.
  CONSTRAINT chk_login_tentativas_motivo_coerente
    CHECK ((sucesso AND motivo IS NULL) OR (NOT sucesso AND motivo IS NOT NULL)),
  -- Ativação de cooldown, nos dois sentidos: motivo COOLDOWN_ATIVADO exige
  -- cooldown_ate, e cooldown_ate exige motivo COOLDOWN_ATIVADO, falha e
  -- prazo no futuro. Nenhuma outra linha pode carregar cooldown_ate.
  CONSTRAINT chk_login_tentativas_cooldown_coerente
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

-- Consultas do cooldown: "linhas recentes desta chave" (contagem de falhas
-- e último sucesso), sempre lendo as mais recentes primeiro.
CREATE INDEX idx_login_tentativas_chave_criado_em
  ON login_tentativas (chave_cooldown, criado_em DESC);

-- "Esta chave está em cooldown agora?" — índice parcial minúsculo, só com
-- as linhas de ativação.
CREATE INDEX idx_login_tentativas_chave_cooldown_ate
  ON login_tentativas (chave_cooldown, cooldown_ate DESC)
  WHERE cooldown_ate IS NOT NULL;

-- "Tentativas identificadas do usuário X" (investigação de segurança).
CREATE INDEX idx_login_tentativas_usuario_id
  ON login_tentativas (usuario_id) WHERE usuario_id IS NOT NULL;

-- Usado pela rotina de purga por retenção.
CREATE INDEX idx_login_tentativas_criado_em ON login_tentativas (criado_em);
