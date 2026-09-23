-- grupos_acesso: agrupamento de permissões configurável por empresa,
-- camada intermediária entre perfil e usuário (RBAC — Bloco 8,
-- Incremento 8, Subetapa 3A). Nomes são livres, definidos por cada
-- empresa — esta migration não cria nenhum grupo com base em perfil
-- técnico ou em responsabilidade SST. vinculo_sst (018) continua sendo a
-- única fonte de verdade para participação na SST, independente do nome
-- de qualquer grupo.
--
-- Sem exclusão física prevista: grupos são inativados (ativo = false),
-- nunca apagados — mesmo padrão já usado em usuarios/empresas/perfis/
-- acoes. Por isso a FK de usuarios.grupo_acesso_id, mais abaixo, usa
-- ON DELETE RESTRICT: apagar fisicamente um grupo ainda referenciado por
-- algum usuário é impedido pelo próprio banco, nunca resolvido
-- silenciosamente desvinculando usuários (uma FK composta com
-- ON DELETE SET NULL zeraria empresa_id junto, violando sua NOT NULL —
-- risco já identificado e evitado aqui).
--
-- Escopo desta migration (Subetapa 3A): só a estrutura. Nenhuma tabela de
-- permissão de grupo (grupo_permissoes_recurso/grupo_permissoes_acao),
-- nenhuma coluna de delegação (pode_delegar/origem_id) e nenhuma mudança
-- de middleware/repository acompanham esta migration — grupos_acesso
-- ainda não tem nenhum efeito sobre autorização; é só a base para as
-- próximas subetapas.
CREATE TABLE grupos_acesso (
  id             SERIAL PRIMARY KEY,
  empresa_id     INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  nome           VARCHAR(100) NOT NULL,
  descricao      TEXT,
  ativo          BOOLEAN NOT NULL DEFAULT true,
  criado_por     INTEGER NOT NULL,
  criado_em      TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Necessária para a FK composta de usuarios.grupo_acesso_id abaixo —
  -- mesmo padrão de uq_usuarios_empresa_id (013): garante que a FK
  -- composta nunca aponte para um grupo de empresa diferente da do
  -- usuário.
  CONSTRAINT uq_grupos_acesso_empresa_id UNIQUE (empresa_id, id),
  -- Quem criou o grupo precisa pertencer à MESMA empresa do grupo —
  -- mesmo padrão de fk_vinculo_sst_concedido_por_mesma_empresa (018) e
  -- fk_usuario_autorizacoes_autorizado_por_mesma_empresa (019).
  CONSTRAINT fk_grupos_acesso_criado_por_mesma_empresa
    FOREIGN KEY (empresa_id, criado_por)
    REFERENCES usuarios (empresa_id, id) ON DELETE RESTRICT
);

-- Índice único funcional, não uma constraint UNIQUE de expressão (que não
-- existe em PostgreSQL) — mesmo padrão de uq_usuarios_empresa_email_lower
-- (005): nome reservado por empresa, sem diferenciar maiúsculas de
-- minúsculas, e continua reservado mesmo que o grupo seja inativado
-- depois (preserva histórico e evita ambiguidade em auditoria).
CREATE UNIQUE INDEX uq_grupos_acesso_empresa_nome_lower
  ON grupos_acesso (empresa_id, lower(nome));

CREATE TRIGGER trg_grupos_acesso_atualizado_em
  BEFORE UPDATE ON grupos_acesso
  FOR EACH ROW EXECUTE FUNCTION set_atualizado_em();

-- usuarios.grupo_acesso_id: vínculo opcional (nullable) a um grupo de
-- acesso da MESMA empresa. Todos os usuários existentes recebem NULL
-- automaticamente (coluna nova, sem valor a migrar) — piso do perfil,
-- comportamento idêntico ao de hoje, sem nenhuma mudança retroativa de
-- comportamento.
ALTER TABLE usuarios ADD COLUMN grupo_acesso_id INTEGER;

ALTER TABLE usuarios
  ADD CONSTRAINT fk_usuarios_grupo_mesma_empresa
    FOREIGN KEY (empresa_id, grupo_acesso_id)
    REFERENCES grupos_acesso (empresa_id, id)
    ON DELETE RESTRICT;
