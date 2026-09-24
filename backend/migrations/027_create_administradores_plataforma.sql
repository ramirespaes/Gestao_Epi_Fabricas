-- administradores_plataforma: autoridade da PLATAFORMA SafeWork, distinta de
-- qualquer conta empresarial (Autenticação Global — Pacote 2, "Primeiro
-- acesso administrativo", 23/09/2026).
--
-- POR QUE UMA TABELA PRÓPRIA, E NÃO `usuarios`: um administrador geral da
-- SafeWork NUNCA é um vínculo de nenhuma empresa cliente — não tem
-- `empresa_id`, não tem `perfil` do catálogo `perfis` (MASTER/ADMINISTRADOR/
-- SUPERVISOR/USUARIO são autoridade DENTRO de uma empresa; a plataforma é
-- autoridade SOBRE as empresas). Reaproveitar `usuarios` exigiria uma
-- empresa "fictícia" da própria SafeWork para hospedar essas contas — exatamente
-- o que o planejamento (v2, seção 4) e o adendo v2.1 (seção 2) determinam
-- evitar: "o administrador geral nunca aparece no cadastro, nas listas ou
-- nos painéis administrativos dos clientes". Com tabela própria, isso é
-- estrutural: nenhuma consulta a `usuarios`/`empresas` pode, por acidente,
-- devolver um administrador de plataforma, porque ele simplesmente não está
-- lá.
--
-- Também distinta de `identidades` (migration 025): identidade global é a
-- conta de um CLIENTE, com vínculos empresariais (`usuarios.identidade_id`).
-- Um administrador de plataforma não tem vínculo empresarial nenhum, em
-- nenhuma circunstância — é um quarto tipo de ator, ao lado de
-- administrador da plataforma / identidade global do cliente / usuário
-- vinculado à empresa / funcionário cadastrado pela empresa (funcionarios,
-- migration 006, que nunca teve login).
--
-- Dado minimizado (CLAUDE.md §44): só o necessário para autenticar. Nome de
-- exibição fica fora desta tabela de propósito — quando uma tela precisar
-- dele, entra por uma migration aditiva própria, sem reabrir esta.
CREATE TABLE administradores_plataforma (
  id             SERIAL PRIMARY KEY,
  email          VARCHAR(150) NOT NULL,
  senha_hash     VARCHAR(255) NOT NULL,
  ativo          BOOLEAN NOT NULL DEFAULT true,
  criado_em      TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Unicidade global e case-insensitive, mesmo padrão de
-- uq_identidades_email_lower (025) e uq_usuarios_empresa_email_lower (005).
CREATE UNIQUE INDEX uq_administradores_plataforma_email_lower
  ON administradores_plataforma (lower(email));

CREATE TRIGGER trg_administradores_plataforma_atualizado_em
  BEFORE UPDATE ON administradores_plataforma
  FOR EACH ROW EXECUTE FUNCTION set_atualizado_em();
