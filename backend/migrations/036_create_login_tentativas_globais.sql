-- login_tentativas_globais: tentativas de login e cooldown do LOGIN GLOBAL
-- do Portal do Cliente (Autenticação Global — Pacote 4). Espelha 015
-- (login_tentativas) e 030 (login_tentativas_plataforma) para o quarto
-- contexto de cooldown do projeto: a chave é derivada só do e-mail
-- normalizado, sob o rótulo 'IDENTIDADE_GLOBAL' (src/security/cooldown.js),
-- porque o login global não envolve CNPJ nem empresa alguma.
--
-- POR QUE NÃO REAPROVEITAR login_tentativas (015): lá, um login
-- bem-sucedido EXIGE empresa_id e usuario_id
-- (chk_login_tentativas_sucesso_identificado) — no login global, no
-- instante do sucesso, ainda não há empresa nem vínculo escolhido, só a
-- identidade. Representar isso em 015 exigiria enfraquecer uma constraint
-- histórica. Tabela própria, mesma disciplina.
--
-- identidade_id: vínculo SIMPLES (identidade é global, não há "mesma
-- empresa" a proteger), ON DELETE RESTRICT como em 030 — identidade
-- identificada numa tentativa é inativada, não excluída; linhas antigas
-- saem pela retenção (LOGIN_TENTATIVAS_RETENCAO_DIAS), nunca por cascata.
--
-- RELÓGIO: criado_em e cooldown_ate devem ser gravados pela aplicação com
-- clock_timestamp(), nunca now() — mesma nota das migrations 015/030.
CREATE TABLE login_tentativas_globais (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  chave_cooldown  CHAR(64) NOT NULL,
  identidade_id   INTEGER REFERENCES identidades(id) ON DELETE RESTRICT,
  sucesso         BOOLEAN NOT NULL,
  motivo          VARCHAR(30),
  cooldown_ate    TIMESTAMPTZ,
  ip              VARCHAR(45),
  dispositivo     VARCHAR(150),
  criado_em       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_login_tentativas_globais_chave_formato
    CHECK (chave_cooldown ~ '^[0-9a-f]{64}$'),
  -- Login válido só existe com identidade identificada.
  CONSTRAINT chk_login_tentativas_globais_sucesso_identificado
    CHECK (NOT sucesso OR identidade_id IS NOT NULL),
  CONSTRAINT chk_login_tentativas_globais_motivo_formato
    CHECK (motivo IS NULL OR motivo ~ '^[A-Z_]{1,30}$'),
  -- Sucesso não tem motivo; falha e ativação de cooldown sempre têm.
  CONSTRAINT chk_login_tentativas_globais_motivo_coerente
    CHECK ((sucesso AND motivo IS NULL) OR (NOT sucesso AND motivo IS NOT NULL)),
  -- Ativação de cooldown, nos dois sentidos — mesma regra de 015/030.
  CONSTRAINT chk_login_tentativas_globais_cooldown_coerente
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

-- Contagem de falhas recentes por chave (janela de tempo, mais recente primeiro).
CREATE INDEX idx_login_tentativas_globais_chave_criado_em
  ON login_tentativas_globais (chave_cooldown, criado_em DESC);

-- "Há cooldown vigente para esta chave?" — só as linhas de ativação.
CREATE INDEX idx_login_tentativas_globais_chave_cooldown_ate
  ON login_tentativas_globais (chave_cooldown, cooldown_ate DESC)
  WHERE cooldown_ate IS NOT NULL;

-- Auditoria por identidade (só linhas identificadas).
CREATE INDEX idx_login_tentativas_globais_identidade_id
  ON login_tentativas_globais (identidade_id) WHERE identidade_id IS NOT NULL;

-- Retenção/purga por idade.
CREATE INDEX idx_login_tentativas_globais_criado_em ON login_tentativas_globais (criado_em);
