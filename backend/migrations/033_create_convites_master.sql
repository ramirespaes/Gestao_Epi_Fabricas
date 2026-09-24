-- convites_master: convite do PRIMEIRO MASTER de uma empresa contratante
-- (Pacote 3 — Autenticação Global, 23/09/2026). Implementa o desenho
-- aprovado no planejamento v2 (§8) e no adendo técnico v2.1 (§5):
--
--   1. O administrador de plataforma cadastra a empresa e informa o e-mail
--      de quem deverá ser o primeiro MASTER — NENHUM vínculo é criado
--      nesse instante. Só uma linha nasce aqui.
--   2. Token opaco de alta entropia (mesmo gerador de src/security/token.js,
--      32 bytes aleatórios), do qual SÓ o SHA-256 hexadecimal é persistido
--      em token_hash — o token em claro existe apenas no instante da
--      criação (para ser entregue à pessoa convidada) e no instante da
--      aceitação (quando a pessoa o apresenta). Nunca em banco, log,
--      auditoria ou mensagem de erro.
--   3. Ao aceitar, dois caminhos — nunca automáticos: identidade global
--      inexistente => a pessoa define uma senha e identidade + vínculo
--      MASTER nascem NA MESMA TRANSAÇÃO; identidade já existente => a
--      senha ATUAL daquela identidade é exigida antes de qualquer vínculo
--      (prova de titularidade — nunca vincula só porque o e-mail bateu).
--   4. Uso único (aceito_em preenchido recusa qualquer nova aceitação),
--      prazo de validade (expira_em) e cancelamento manual pelo
--      administrador (cancelado_em, adendo v2.1 §5 item 3).
--
-- SITUAÇÃO DERIVADA, NUNCA UMA COLUNA "status": mesma disciplina de
-- sessoes/sessoes_plataforma (validade decidida por timestamps na consulta,
-- não por um rótulo redundante que poderia divergir):
--   PENDENTE  = aceito_em IS NULL AND cancelado_em IS NULL AND expira_em > now()
--   ACEITO    = aceito_em IS NOT NULL
--   CANCELADO = cancelado_em IS NOT NULL
--   EXPIRADO  = os dois nulos AND expira_em <= now()
--
-- QUEM CONVIDOU x QUEM ACEITOU (adendo v2.1 e instrução expressa do
-- Pacote 3): criado_por é o ADMINISTRADOR DA PLATAFORMA que gerou o
-- convite (auditado em logs_auditoria_plataforma); identidade_id/usuario_id
-- são a PESSOA que aceitou e o vínculo empresarial resultante (a aceitação
-- é auditada em logs_auditoria, a trilha EMPRESARIAL, atribuída ao novo
-- usuário — nunca ao administrador da plataforma, que não praticou aquele
-- ato).
--
-- usuario_id é FK COMPOSTA (empresa_id, usuario_id) -> usuarios (empresa_id,
-- id) via uq_usuarios_empresa_id (013), exatamente como sessoes (013) e
-- login_tentativas (015): o vínculo criado pelo aceite jamais pode apontar
-- para um usuário de OUTRA empresa, mesmo por erro de aplicação. ON DELETE
-- RESTRICT nos dois: um convite aceito é registro histórico, e a pessoa/o
-- vínculo que o aceitou não são apagados fisicamente por baixo dele.
--
-- empresa_id ON DELETE CASCADE, como no planejamento v2: empresas não são
-- excluídas fisicamente (só inativadas) — a cláusula é só coerência
-- estrutural com o restante do schema, nunca um caminho de uso previsto.
CREATE TABLE convites_master (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  empresa_id       INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  email_convite    VARCHAR(150) NOT NULL,
  token_hash       CHAR(64) NOT NULL,
  criado_por       INTEGER NOT NULL REFERENCES administradores_plataforma(id) ON DELETE RESTRICT,
  criado_em        TIMESTAMPTZ NOT NULL DEFAULT now(),
  expira_em        TIMESTAMPTZ NOT NULL,
  cancelado_em     TIMESTAMPTZ,
  aceito_em        TIMESTAMPTZ,
  identidade_id    INTEGER REFERENCES identidades(id) ON DELETE RESTRICT,
  usuario_id       INTEGER,
  CONSTRAINT uq_convites_master_token_hash UNIQUE (token_hash),
  CONSTRAINT fk_convites_master_usuario_mesma_empresa
    FOREIGN KEY (empresa_id, usuario_id)
    REFERENCES usuarios (empresa_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_convites_master_token_hash_formato CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_convites_master_expira_apos_criacao CHECK (expira_em > criado_em),
  -- Aceito e cancelado são desfechos mutuamente exclusivos.
  CONSTRAINT chk_convites_master_desfecho_unico
    CHECK (NOT (aceito_em IS NOT NULL AND cancelado_em IS NOT NULL)),
  -- Um convite aceito SEMPRE sabe quem aceitou e qual vínculo nasceu; um
  -- convite não aceito NUNCA carrega esses dois (nascem juntos no aceite,
  -- na mesma transação — nunca "meio-aceito").
  CONSTRAINT chk_convites_master_aceite_coerente
    CHECK (
      (aceito_em IS NULL AND identidade_id IS NULL AND usuario_id IS NULL)
      OR (aceito_em IS NOT NULL AND identidade_id IS NOT NULL AND usuario_id IS NOT NULL)
    )
);

-- "Convites desta empresa" (tela do Painel Privado) e "existe convite
-- pendente para este e-mail nesta empresa?" (serviço, antes de criar outro):
-- índice parcial só nas linhas ainda não resolvidas, que são as únicas que
-- essa pergunta precisa varrer.
CREATE INDEX idx_convites_master_empresa_email_pendentes
  ON convites_master (empresa_id, lower(email_convite))
  WHERE aceito_em IS NULL AND cancelado_em IS NULL;

CREATE INDEX idx_convites_master_empresa_id ON convites_master (empresa_id);

-- Futura rotina de purga de convites vencidos há muito tempo.
CREATE INDEX idx_convites_master_expira_em ON convites_master (expira_em);
