-- usuario_autorizacoes: autorização individual e positiva para um usuário
-- específico executar uma ação de negócio, independente (e potencialmente
-- além) do que permissoes_acao concede ao perfil dele. Contraparte
-- estrutural de usuario_bloqueios (011): lá a existência da linha NEGA;
-- aqui a existência da linha CONCEDE.
--
-- O alcance de cada concessão depende de acoes.modo_autorizacao_individual
-- (017), decidido no catálogo, nunca por esta tabela nem por quem a
-- consulta:
--   NENHUMA     — esta tabela é ignorada por completo para aquela ação.
--   ALTERNATIVA — esta concessão soma-se à de permissoes_acao (OR).
--   OBRIGATORIA — para qualquer perfil que não seja MASTER, esta linha é
--                 indispensável, mesmo que permissoes_acao já autorizasse
--                 o perfil inteiro.
--
-- Mesmas duas FKs compostas de vinculo_sst (018), pela mesma razão:
-- beneficiário (usuario_id) e concedente (autorizado_por) precisam
-- pertencer à mesma empresa, garantido no próprio PostgreSQL — nunca só
-- por validação do service.
--
-- id SERIAL (diferente de vinculo_sst): um mesmo usuario_id pode ter várias
-- autorizações individuais, uma por acao_codigo — por isso usuario_id
-- sozinho não pode ser chave primária aqui. A UNIQUE abaixo impede
-- duplicidade da mesma autorização, mesmo padrão de
-- uq_usuario_bloqueios_usuario_acao (011).
CREATE TABLE usuario_autorizacoes (
  id             SERIAL PRIMARY KEY,
  empresa_id     INTEGER NOT NULL,
  usuario_id     INTEGER NOT NULL,
  acao_codigo    VARCHAR(60) NOT NULL REFERENCES acoes(codigo) ON DELETE RESTRICT ON UPDATE CASCADE,
  motivo         TEXT,
  autorizado_por INTEGER NOT NULL,
  criado_em      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_usuario_autorizacoes_usuario_acao UNIQUE (usuario_id, acao_codigo),
  CONSTRAINT fk_usuario_autorizacoes_usuario_mesma_empresa
    FOREIGN KEY (empresa_id, usuario_id)
    REFERENCES usuarios (empresa_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_usuario_autorizacoes_autorizado_por_mesma_empresa
    FOREIGN KEY (empresa_id, autorizado_por)
    REFERENCES usuarios (empresa_id, id) ON DELETE RESTRICT
);
