-- usuario_permissoes_recurso: exceção individual, por recurso, na mesma
-- dimensão de permissoes_recurso (009) e grupo_permissoes_recurso (021),
-- mas por USUÁRIO em vez de por perfil ou por grupo — o último nível da
-- cadeia de override (perfil -> grupo -> individual) desenhada para
-- permissões de recurso (Bloco 8, Incremento 8, Etapa 5A, Subetapa 3E).
--
-- Tri-state, por operação, de propósito — mesmo padrão de
-- grupo_permissoes_recurso, e pela mesma razão: um usuário pode ter uma
-- exceção só para "excluir" sem precisar repetir (nem presumir) opinião
-- sobre "visualizar", "criar" ou "editar" no mesmo recurso:
--   NULL  = o usuário não tem exceção nesta operação; herda a decisão de
--           grupo/perfil;
--   TRUE  = concede individualmente, mesmo que grupo/perfil neguem;
--   FALSE = nega individualmente, mesmo que grupo/perfil concedam.
-- Cada uma das quatro colunas é independente das demais — ajustar
-- "pode_excluir" não reescreve nem presume nada sobre as outras três da
-- mesma linha.
--
-- Nesta migration a tabela só é criada: nenhuma leitura, middleware ou
-- rota a consulta ainda. A existência de uma linha aqui não produz nenhum
-- efeito sobre autorização nesta etapa — isso fica para uma subetapa
-- futura, quando o middleware for evoluído para consultá-la (mesma
-- ressalva já registrada em grupos_acesso/020 e grupo_permissoes/021).
--
-- FK composta de isolamento multiempresa, mesmo padrão de vinculo_sst
-- (018) e usuario_autorizacoes (019): empresa_id garante, no próprio
-- PostgreSQL, que tanto o beneficiário (usuario_id) quanto quem concedeu
-- (concedido_por) pertencem à MESMA empresa — nunca só por validação do
-- service. Reaproveita uq_usuarios_empresa_id (013).
--
-- usuario_id com ON DELETE CASCADE (beneficiário: se o próprio usuário for
-- removido, suas exceções são dados dele, não sobrevivem órfãs — mesmo
-- padrão de fk_usuario_autorizacoes_usuario_mesma_empresa em 019).
-- concedido_por com ON DELETE RESTRICT (concedente: nunca desaparece
-- silenciosamente do rastro de quem concedeu — mesmo padrão de
-- fk_vinculo_sst_concedido_por_mesma_empresa em 018 e
-- fk_usuario_autorizacoes_autorizado_por_mesma_empresa em 019).
--
-- UNIQUE (usuario_id, recurso): no máximo uma linha de exceção por par
-- usuário/recurso — mesmo padrão de uq_grupo_permissoes_recurso_grupo_recurso
-- (021), agora com usuario_id no lugar de grupo_acesso_id.
--
-- Sem DEFAULT true em nenhuma das quatro colunas: diferente de
-- permissoes_recurso (que fixa a matriz base do perfil e por isso precisa
-- de um valor sempre presente), aqui a ausência de opinião é o estado
-- normal e mais comum — a grande maioria dos usuários nunca terá exceção
-- nenhuma, e a maioria das linhas que existirem terá opinião em só uma ou
-- duas das quatro operações.
CREATE TABLE usuario_permissoes_recurso (
  id               SERIAL PRIMARY KEY,
  empresa_id       INTEGER NOT NULL,
  usuario_id       INTEGER NOT NULL,
  recurso          VARCHAR(60) NOT NULL,
  pode_visualizar  BOOLEAN,
  pode_criar       BOOLEAN,
  pode_editar      BOOLEAN,
  pode_excluir     BOOLEAN,
  concedido_por    INTEGER NOT NULL,
  criado_em        TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_usuario_permissoes_recurso_usuario_recurso UNIQUE (usuario_id, recurso),
  CONSTRAINT fk_usuario_permissoes_recurso_usuario_mesma_empresa
    FOREIGN KEY (empresa_id, usuario_id)
    REFERENCES usuarios (empresa_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_usuario_permissoes_recurso_concedido_por_mesma_empresa
    FOREIGN KEY (empresa_id, concedido_por)
    REFERENCES usuarios (empresa_id, id) ON DELETE RESTRICT
);

CREATE TRIGGER trg_usuario_permissoes_recurso_atualizado_em
  BEFORE UPDATE ON usuario_permissoes_recurso
  FOR EACH ROW EXECUTE FUNCTION set_atualizado_em();
