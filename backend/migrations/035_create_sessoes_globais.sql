-- sessoes_globais: sessão da IDENTIDADE GLOBAL (Autenticação Global —
-- Pacote 4, planejamento v2 §6.2, adendo v2.1 §4).
--
-- Representa "esta pessoa está autenticada", SEM empresa alguma: é o estado
-- que existe entre o login por e-mail+senha (identidades, 025) e a seleção
-- de uma empresa, e o que permite "trocar de empresa" sem digitar a senha
-- de novo. NÃO concede acesso operacional: o RBAC e o middleware
-- exigirSessao continuam lendo exclusivamente `sessoes` (013), que só nasce
-- depois de uma empresa ser selecionada e o vínculo (usuarios) ser
-- revalidado no servidor.
--
-- POR QUE UMA TABELA NOVA, e não `sessoes`: sessoes.usuario_id e
-- sessoes.empresa_id são NOT NULL desde a migration histórica 013 — não há
-- como representar "autenticado, empresa ainda não escolhida" ali sem
-- reescrever uma migration imutável. Esta tabela espelha a forma de
-- sessoes_plataforma (028/031), trocando administrador_id por identidade_id.
--
-- Mesmo contrato de segurança de 013/028: só SHA-256(token) em hexadecimal
-- é persistido, nunca o token em claro; a validade é decidida na consulta
-- (revogada_em, expira_em, ultimo_uso_em e identidades.ativo), nunca em
-- código que examina a linha depois.
--
-- identidade_id: ON DELETE CASCADE, como sessoes -> usuarios (013) e
-- sessoes_plataforma -> administradores_plataforma (028): uma sessão não
-- tem sentido sem a identidade. Não existe hoje caminho de exclusão física
-- de identidade (usuarios.identidade_id é RESTRICT, 025).
CREATE TABLE sessoes_globais (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  identidade_id      INTEGER NOT NULL REFERENCES identidades(id) ON DELETE CASCADE,
  token_hash         CHAR(64) NOT NULL,
  criado_em          TIMESTAMPTZ NOT NULL DEFAULT now(),
  expira_em          TIMESTAMPTZ NOT NULL,
  ultimo_uso_em      TIMESTAMPTZ NOT NULL DEFAULT now(),
  revogada_em        TIMESTAMPTZ,
  motivo_revogacao   VARCHAR(30),
  ip                 VARCHAR(45),
  dispositivo        VARCHAR(150),
  CONSTRAINT uq_sessoes_globais_token_hash UNIQUE (token_hash),
  CONSTRAINT chk_sessoes_globais_token_hash_formato CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_sessoes_globais_expira_apos_criacao CHECK (expira_em > criado_em),
  CONSTRAINT chk_sessoes_globais_motivo_formato
    CHECK (motivo_revogacao IS NULL OR motivo_revogacao ~ '^[A-Z_]{1,30}$'),
  CONSTRAINT chk_sessoes_globais_revogacao_coerente CHECK (
    (revogada_em IS NULL AND motivo_revogacao IS NULL)
    OR (revogada_em IS NOT NULL AND motivo_revogacao IS NOT NULL)
  )
);

-- Consulta principal do middleware é por token_hash (coberta pela UNIQUE).
-- Índice parcial para "revogar as sessões não revogadas da identidade X"
-- (logout completo, inativação, futura troca de senha).
CREATE INDEX idx_sessoes_globais_identidade_id_nao_revogadas
  ON sessoes_globais (identidade_id) WHERE revogada_em IS NULL;

-- Usado pela rotina de purga de sessões expiradas (mesma de 013/031).
CREATE INDEX idx_sessoes_globais_expira_em ON sessoes_globais (expira_em);

-- INATIVAÇÃO DA IDENTIDADE (adendo v2.1 §4.2, cenário c — "inativar uma
-- identidade global deve impedir TODOS os acessos dessa identidade"):
-- mesma técnica da migration 031 para administradores. A consulta de
-- validade já deixa de encontrar essas sessões (identidades.ativo entra no
-- filtro, tanto aqui quanto em sessoes via LEFT JOIN na aplicação); o
-- trigger acrescenta RASTREABILIDADE — as linhas ficam marcadas com
-- revogada_em e o motivo, em vez de simplesmente "sumirem" das consultas.
-- Alcança as duas tabelas numa única operação: a sessão global e TODAS as
-- sessões empresariais (013) de todos os vínculos daquela identidade, em
-- todas as empresas — junção pelo par (empresa_id, id) de usuarios, o mesmo
-- da FK composta fk_sessoes_usuario_mesma_empresa.
CREATE OR REPLACE FUNCTION revogar_sessoes_identidade_inativada()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE sessoes_globais
     SET revogada_em = now(),
         motivo_revogacao = 'IDENTIDADE_INATIVADA'
   WHERE identidade_id = NEW.id
     AND revogada_em IS NULL;

  UPDATE sessoes s
     SET revogada_em = now(),
         motivo_revogacao = 'IDENTIDADE_INATIVADA'
    FROM usuarios u
   WHERE u.empresa_id = s.empresa_id
     AND u.id = s.usuario_id
     AND u.identidade_id = NEW.id
     AND s.revogada_em IS NULL;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_identidades_revogar_sessoes_ao_inativar
  AFTER UPDATE ON identidades
  FOR EACH ROW
  WHEN (OLD.ativo = true AND NEW.ativo = false)
  EXECUTE FUNCTION revogar_sessoes_identidade_inativada();
