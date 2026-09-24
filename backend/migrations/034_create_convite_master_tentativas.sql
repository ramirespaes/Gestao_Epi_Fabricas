-- convite_master_tentativas: histórico de tentativas de ACEITE de convite
-- do MASTER e base do cooldown persistente (Pacote 3 — Autenticação
-- Global, 23/09/2026; adendo técnico v2.1 §5 item 2).
--
-- POR QUE EXISTE: no caminho "já existe identidade com aquele e-mail", o
-- aceite exige a senha ATUAL da identidade (prova de titularidade). Sem
-- proteção persistente, quem capturasse ou adivinhasse um link de convite
-- poderia tentar senhas por força bruta contra aquela identidade. O adendo
-- determina reaproveitar o MESMO mecanismo já aprovado e testado para o
-- login (migration 015 / 030, src/security/cooldown.js) — não inventar um
-- novo. Esta tabela é o espelho de login_tentativas_plataforma (030) para
-- este terceiro contexto de autenticação, mesma disciplina de 030 em
-- relação a 015: tabela própria por contexto, mesmas duas formas de linha
-- (tentativa x ativação), mesmas regras de coerência.
--
-- CHAVE OPACA DE COOLDOWN (chave_cooldown)
-- HMAC-SHA-256(segredo, 'CONVITE_MASTER' || 0x0A || token_do_convite), com
-- o MESMO segredo LOGIN_COOLDOWN_HMAC_SECRET. Derivada do TOKEN do convite
-- (adendo v2.1), não de CNPJ+e-mail: não há CNPJ nesta tela, e é
-- exatamente o token que um atacante teria em mãos — cada link recebe seu
-- próprio contador. O rótulo 'CONVITE_MASTER' separa este espaço de
-- chaves do do login empresarial e do do Painel Privado, mesmo sob o
-- mesmo segredo. O token em claro NÃO é persistido aqui (só o HMAC, que
-- não é reversível sem o segredo) — ver src/security/cooldown.js.
--
-- convite_id NULÁVEL: uma tentativa com token que não corresponde a
-- convite nenhum (link inválido/adivinhado) não tem convite a apontar, e
-- ainda assim precisa contar para o cooldown daquela chave. ON DELETE
-- RESTRICT: convites não são excluídos fisicamente; linhas antigas saem
-- pela retenção.
--
-- LIMIARES: os MESMOS authConfig.cooldown.niveis do login — nenhuma
-- variável de ambiente nova.
CREATE TABLE convite_master_tentativas (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  chave_cooldown  CHAR(64) NOT NULL,
  convite_id      BIGINT REFERENCES convites_master(id) ON DELETE RESTRICT,
  sucesso         BOOLEAN NOT NULL,
  motivo          VARCHAR(30),
  cooldown_ate    TIMESTAMPTZ,
  ip              VARCHAR(45),
  dispositivo     VARCHAR(150),
  criado_em       TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT chk_convite_master_tentativas_chave_formato
    CHECK (chave_cooldown ~ '^[0-9a-f]{64}$'),
  -- Aceite válido só existe com convite identificado.
  CONSTRAINT chk_convite_master_tentativas_sucesso_identificado
    CHECK (NOT sucesso OR convite_id IS NOT NULL),
  CONSTRAINT chk_convite_master_tentativas_motivo_formato
    CHECK (motivo IS NULL OR motivo ~ '^[A-Z_]{1,30}$'),
  CONSTRAINT chk_convite_master_tentativas_motivo_coerente
    CHECK ((sucesso AND motivo IS NULL) OR (NOT sucesso AND motivo IS NOT NULL)),
  CONSTRAINT chk_convite_master_tentativas_cooldown_coerente
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

CREATE INDEX idx_convite_master_tentativas_chave_criado_em
  ON convite_master_tentativas (chave_cooldown, criado_em DESC);

CREATE INDEX idx_convite_master_tentativas_chave_cooldown_ate
  ON convite_master_tentativas (chave_cooldown, cooldown_ate DESC)
  WHERE cooldown_ate IS NOT NULL;

CREATE INDEX idx_convite_master_tentativas_convite_id
  ON convite_master_tentativas (convite_id) WHERE convite_id IS NOT NULL;

CREATE INDEX idx_convite_master_tentativas_criado_em ON convite_master_tentativas (criado_em);
