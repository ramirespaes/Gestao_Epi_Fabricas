-- desafios_mfa_plataforma: estado pré-MFA do Painel Privado, separado da
-- sessão. A senha correta cria um desafio, nunca uma sessão; só o segundo
-- fator concluído cria a sessão plena, com token novo. Toda transição
-- encerra o desafio de origem e cria outro, com token novo, ligado pelo
-- desafio_anterior_id; nenhum desafio vira sessão por UPDATE.
--
-- Só o SHA-256 hexadecimal do token fica aqui. Sem IP nem User-Agent: a
-- tentativa de senha e as tentativas de MFA já os registram em
-- login_tentativas_plataforma.
--
-- Vínculos por tipo:
--   fator_pendente_id  obrigatório em CADASTRO, RECUPERACAO e SUBSTITUICAO
--   sessao_origem_id   obrigatório só em SUBSTITUICAO (a sessão que a pediu)
--   sessao_criada_id   só depois de CONCLUIDO, e nunca em LIBERACAO
-- As FKs são compostas com administrador_id: fator, sessões e desafio
-- anterior são sempre do mesmo administrador.
--
-- O limite de desafios abertos por administrador NÃO é constraint: é regra
-- do serviço, aplicada sob a trava consultiva do administrador.
--
-- Encerrar é um campo só (encerrado_em + motivo_encerramento) para consumo,
-- transição, esgotamento, logout, reset e expiração.

-- Base das FKs compostas de sessao_origem_id e sessao_criada_id.
ALTER TABLE sessoes_plataforma
  ADD CONSTRAINT uq_sessoes_plataforma_id_administrador UNIQUE (id, administrador_id);

CREATE TABLE desafios_mfa_plataforma (
  id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  administrador_id     INTEGER NOT NULL REFERENCES administradores_plataforma(id) ON DELETE RESTRICT,
  token_hash           CHAR(64) NOT NULL,
  tipo                 VARCHAR(20) NOT NULL,
  fator_pendente_id    BIGINT,
  sessao_origem_id     BIGINT,
  sessao_criada_id     BIGINT,
  desafio_anterior_id  BIGINT,
  criado_em            TIMESTAMPTZ NOT NULL DEFAULT now(),
  expira_em            TIMESTAMPTZ NOT NULL,
  falhas               SMALLINT NOT NULL DEFAULT 0,
  reinicios            SMALLINT NOT NULL DEFAULT 0,
  encerrado_em         TIMESTAMPTZ,
  motivo_encerramento  VARCHAR(30),

  CONSTRAINT uq_desafios_mfa_plataforma_token_hash UNIQUE (token_hash),
  CONSTRAINT uq_desafios_mfa_plataforma_id_administrador UNIQUE (id, administrador_id),
  CONSTRAINT fk_desafios_mfa_plataforma_fator_mesmo_administrador
    FOREIGN KEY (fator_pendente_id, administrador_id)
    REFERENCES fatores_mfa_plataforma (id, administrador_id) ON DELETE RESTRICT,
  CONSTRAINT fk_desafios_mfa_plataforma_sessao_origem_mesmo_administrador
    FOREIGN KEY (sessao_origem_id, administrador_id)
    REFERENCES sessoes_plataforma (id, administrador_id) ON DELETE RESTRICT,
  CONSTRAINT fk_desafios_mfa_plataforma_sessao_criada_mesmo_administrador
    FOREIGN KEY (sessao_criada_id, administrador_id)
    REFERENCES sessoes_plataforma (id, administrador_id) ON DELETE RESTRICT,
  CONSTRAINT chk_desafios_mfa_plataforma_token_hash_formato CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_desafios_mfa_plataforma_tipo
    CHECK (tipo IN ('LIBERACAO', 'CADASTRO', 'VERIFICACAO', 'RECUPERACAO', 'SUBSTITUICAO')),
  CONSTRAINT chk_desafios_mfa_plataforma_fator_pendente_coerente
    CHECK ((tipo IN ('CADASTRO', 'RECUPERACAO', 'SUBSTITUICAO')) = (fator_pendente_id IS NOT NULL)),
  CONSTRAINT chk_desafios_mfa_plataforma_sessao_origem_coerente
    CHECK ((tipo = 'SUBSTITUICAO') = (sessao_origem_id IS NOT NULL)),
  CONSTRAINT chk_desafios_mfa_plataforma_sessao_criada_coerente
    CHECK (
      sessao_criada_id IS NULL
      OR (encerrado_em IS NOT NULL AND motivo_encerramento = 'CONCLUIDO' AND tipo <> 'LIBERACAO')
    ),
  CONSTRAINT chk_desafios_mfa_plataforma_anterior_distinto
    CHECK (desafio_anterior_id IS NULL OR desafio_anterior_id <> id),
  CONSTRAINT chk_desafios_mfa_plataforma_expira_apos_criacao CHECK (expira_em > criado_em),
  CONSTRAINT chk_desafios_mfa_plataforma_falhas CHECK (falhas BETWEEN 0 AND 100),
  CONSTRAINT chk_desafios_mfa_plataforma_reinicios CHECK (reinicios >= 0),
  CONSTRAINT chk_desafios_mfa_plataforma_encerramento_coerente
    CHECK ((encerrado_em IS NULL) = (motivo_encerramento IS NULL)),
  CONSTRAINT chk_desafios_mfa_plataforma_motivo_formato
    CHECK (motivo_encerramento IS NULL OR motivo_encerramento ~ '^[A-Z_]{1,30}$')
);

-- Apagar um desafio antigo (purga) só desfaz o elo com o seguinte; o
-- administrador_id da linha seguinte fica intacto.
ALTER TABLE desafios_mfa_plataforma
  ADD CONSTRAINT fk_desafios_mfa_plataforma_anterior_mesmo_administrador
    FOREIGN KEY (desafio_anterior_id, administrador_id)
    REFERENCES desafios_mfa_plataforma (id, administrador_id)
    ON DELETE SET NULL (desafio_anterior_id);

-- Desafios abertos do administrador (limite, transições, logout, reset).
CREATE INDEX idx_desafios_mfa_plataforma_administrador_abertos
  ON desafios_mfa_plataforma (administrador_id) WHERE encerrado_em IS NULL;

-- Purga dos vencidos.
CREATE INDEX idx_desafios_mfa_plataforma_expira_em ON desafios_mfa_plataforma (expira_em);

-- A purga apaga desafios em lote; sem este índice, cada exclusão varreria a
-- tabela para desfazer o elo das linhas seguintes.
CREATE INDEX idx_desafios_mfa_plataforma_desafio_anterior_id
  ON desafios_mfa_plataforma (desafio_anterior_id) WHERE desafio_anterior_id IS NOT NULL;
