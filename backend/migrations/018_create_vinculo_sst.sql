-- vinculo_sst: participação funcional na Segurança do Trabalho (SST),
-- independente do perfil técnico do vínculo empresarial (usuarios.perfil).
-- Existência da linha = a pessoa integra a SST NAQUELA empresa; revogar é
-- um DELETE — mesmo padrão de existência-concede/ausência-nega já usado
-- por usuario_bloqueios (011), só que com o sinal invertido (lá a
-- existência nega; aqui a existência é uma condição habilitadora, nunca
-- suficiente sozinha — ver nota abaixo).
--
-- Ao contrário de usuario_bloqueios, empresa_id é repetido aqui de
-- propósito: permite duas FKs compostas, no mesmo padrão de
-- fk_sessoes_usuario_mesma_empresa (013, que também introduziu a UNIQUE
-- (empresa_id, id) em usuarios reaproveitada abaixo), garantindo no
-- próprio PostgreSQL — não só por validação do service — que tanto o
-- beneficiário quanto quem concedeu pertencem à MESMA empresa. Uma
-- concessão cruzada entre empresas é estruturalmente impossível.
--
-- Participar da SST não concede nenhuma ação de negócio sozinha: é uma
-- condição adicional, avaliada junto de permissoes_acao/usuario_bloqueios/
-- usuario_autorizacoes pela camada de autorização (fora desta migration),
-- nunca um substituto delas. MASTER dispensa esta tabela por completo,
-- por decisão da camada de autorização — não há exceção de perfil
-- nenhuma representada aqui na estrutura.
--
-- Sem id SERIAL: usuario_id já é único por natureza (uma pessoa participa
-- ou não da SST daquela empresa, nunca "duas vezes"), então ele mesmo é a
-- chave primária.
CREATE TABLE vinculo_sst (
  usuario_id     INTEGER PRIMARY KEY,
  empresa_id     INTEGER NOT NULL,
  concedido_por  INTEGER NOT NULL,
  concedido_em   TIMESTAMPTZ NOT NULL DEFAULT now(),
  motivo         TEXT,
  CONSTRAINT fk_vinculo_sst_usuario_mesma_empresa
    FOREIGN KEY (empresa_id, usuario_id)
    REFERENCES usuarios (empresa_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_vinculo_sst_concedido_por_mesma_empresa
    FOREIGN KEY (empresa_id, concedido_por)
    REFERENCES usuarios (empresa_id, id) ON DELETE RESTRICT
);
