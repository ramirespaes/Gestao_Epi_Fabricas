-- login_tentativas_plataforma: histórico de tentativas de login do Painel
-- Privado e base do cooldown persistente por identidade (correção final do
-- Pacote 2 — Autenticação Global, 23/09/2026, item 1 da auditoria
-- independente: "implementar proteção persistente contra tentativas
-- repetidas por identidade, aproveitando os padrões de cooldown já
-- existentes no projeto").
--
-- Espelha o CONTRATO de `login_tentativas` (migration 015, histórica,
-- intocada): mesma chave opaca de cooldown, mesmas duas formas de linha
-- (tentativa x ativação), mesmas regras de coerência. Tabela PRÓPRIA, não
-- reaproveitada, pelas mesmas razões já registradas para
-- administradores_plataforma/sessoes_plataforma/logs_auditoria_plataforma:
-- um administrador de plataforma não é um usuário empresarial, e
-- `login_tentativas.empresa_id`/`usuario_id` (FK composta com `usuarios`)
-- não têm como representar uma tentativa sem empresa alguma.
--
-- CHAVE OPACA DE COOLDOWN (chave_cooldown)
-- HMAC-SHA-256(segredo, 'PLATAFORMA' || 0x0A || email_normalizado), mesmo
-- segredo LOGIN_COOLDOWN_HMAC_SECRET já usado pelo cliente — o rótulo
-- 'PLATAFORMA' garante que a chave de um administrador nunca colide com a
-- de um usuário empresarial, mesmo com o mesmo e-mail (ver
-- src/security/cooldown.js, gerarChaveCooldownPlataforma). Sem CNPJ: o
-- login administrativo não depende de empresa alguma.
--
-- Sem empresa_id: FK SIMPLES a administradores_plataforma (não composta —
-- não há "mesma empresa" a proteger aqui, diferente de
-- fk_login_tentativas_usuario_mesma_empresa em 015). ON DELETE RESTRICT:
-- um administrador com histórico de tentativas nunca é excluído
-- fisicamente, só inativado — mesma disciplina de 015/012.
--
-- LIMIARES: reaproveita os MESMOS authConfig.cooldown.niveis já
-- configurados para o cliente (LOGIN_COOLDOWN_NIVEL1_*/NIVEL2_*) — nenhuma
-- variável de ambiente nova para este pacote.
--
-- RETENÇÃO: mesma disciplina de 015 — rotina de manutenção da aplicação,
-- não trigger. Fora do escopo desta migration.
CREATE TABLE login_tentativas_plataforma (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  chave_cooldown    CHAR(64) NOT NULL,
  administrador_id  INTEGER REFERENCES administradores_plataforma(id) ON DELETE RESTRICT,
  sucesso           BOOLEAN NOT NULL,
  motivo            VARCHAR(30),
  cooldown_ate      TIMESTAMPTZ,
  ip                VARCHAR(45),
  dispositivo       VARCHAR(150),
  criado_em         TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT chk_login_tentativas_plataforma_chave_formato
    CHECK (chave_cooldown ~ '^[0-9a-f]{64}$'),
  -- Login válido só existe com administrador identificado.
  CONSTRAINT chk_login_tentativas_plataforma_sucesso_identificado
    CHECK (NOT sucesso OR administrador_id IS NOT NULL),
  CONSTRAINT chk_login_tentativas_plataforma_motivo_formato
    CHECK (motivo IS NULL OR motivo ~ '^[A-Z_]{1,30}$'),
  -- Sucesso não tem motivo; falha e ativação de cooldown sempre têm.
  CONSTRAINT chk_login_tentativas_plataforma_motivo_coerente
    CHECK ((sucesso AND motivo IS NULL) OR (NOT sucesso AND motivo IS NOT NULL)),
  -- Ativação de cooldown, nos dois sentidos — mesma regra de 015.
  CONSTRAINT chk_login_tentativas_plataforma_cooldown_coerente
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
CREATE INDEX idx_login_tentativas_plataforma_chave_criado_em
  ON login_tentativas_plataforma (chave_cooldown, criado_em DESC);

-- "Esta chave está em cooldown agora?" — índice parcial, só ativações.
CREATE INDEX idx_login_tentativas_plataforma_chave_cooldown_ate
  ON login_tentativas_plataforma (chave_cooldown, cooldown_ate DESC)
  WHERE cooldown_ate IS NOT NULL;

-- "Tentativas identificadas do administrador X" (investigação de segurança).
CREATE INDEX idx_login_tentativas_plataforma_administrador_id
  ON login_tentativas_plataforma (administrador_id) WHERE administrador_id IS NOT NULL;

-- Usado pela futura rotina de purga por retenção.
CREATE INDEX idx_login_tentativas_plataforma_criado_em ON login_tentativas_plataforma (criado_em);
