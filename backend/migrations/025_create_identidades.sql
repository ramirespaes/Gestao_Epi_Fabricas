-- identidades: identidade global de autenticação (Autenticação Global —
-- Subetapa 1, 23/09/2026), separada da conta empresarial.
--
-- POR QUE ESTA TABELA EXISTE: até aqui, uma linha de `usuarios` era, ao
-- mesmo tempo, o vínculo com uma empresa (perfil, grupo, estado) E a
-- identidade de login (e-mail, hash de senha) — por isso a mesma pessoa
-- precisava de senhas independentes em empresas diferentes, e não havia
-- como fazer login só com e-mail+senha sem informar antes o CNPJ da
-- empresa. `identidades` passa a ser a ÚNICA fonte de verdade de e-mail e
-- senha para quem for migrado a este modelo; `usuarios` PERMANECE a conta/
-- vínculo empresarial (perfil, grupo, estado), sem se tornar uma segunda
-- fonte de verdade — ver `usuarios.identidade_id` mais abaixo.
--
-- Dado minimizado de propósito (CLAUDE.md §44): só o necessário para
-- autenticar. Nome de exibição continua em `usuarios.nome`, por vínculo,
-- exatamente como hoje.
--
-- SEM `empresa_id`: identidade é global por definição, não pertence a
-- nenhuma empresa — diferente de toda outra tabela deste esquema.
CREATE TABLE identidades (
  id             SERIAL PRIMARY KEY,
  email          VARCHAR(150) NOT NULL,
  senha_hash     VARCHAR(255) NOT NULL,
  ativo          BOOLEAN NOT NULL DEFAULT true,
  criado_em      TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Unicidade global (não por empresa) e case-insensitive: mesmo padrão
-- funcional já usado em uq_usuarios_empresa_email_lower (005) e em
-- uq_grupos_acesso_empresa_nome_lower (020) — índice único de expressão,
-- porque PostgreSQL não tem UNIQUE de expressão como constraint nomeada
-- direta. 'Luis@x.com' e 'luis@x.com' contam como o mesmo e-mail em toda a
-- plataforma, não só dentro de uma empresa.
CREATE UNIQUE INDEX uq_identidades_email_lower ON identidades (lower(email));

CREATE TRIGGER trg_identidades_atualizado_em
  BEFORE UPDATE ON identidades
  FOR EACH ROW EXECUTE FUNCTION set_atualizado_em();

-- usuarios.identidade_id: vínculo OPCIONAL (nullable) a uma identidade
-- global. FK SIMPLES, não composta: identidades não tem empresa_id, então
-- não há "mesma empresa" a proteger aqui (diferente de grupo_acesso_id,
-- 020, que é composta porque grupos_acesso pertence a uma empresa).
--
-- ON DELETE RESTRICT: uma identidade com vínculo empresarial ativo nunca
-- pode ser apagada fisicamente por baixo do vínculo — mesma disciplina já
-- usada para não perder rastreabilidade (grupos_acesso, 020; empresas/
-- usuarios em logs_auditoria, 012). Não há hoje nenhum caminho de exclusão
-- física de identidade; a coluna só formaliza a garantia com antecedência.
--
-- NASCE NULA DE PROPÓSITO, e permanece nula para toda conta que não for
-- explicitamente migrada: `usuarios.id`, `usuarios.empresa_id`,
-- `usuarios.perfil`, `usuarios.grupo_acesso_id` e todas as FKs existentes
-- que referenciam usuarios (sessoes, login_tentativas, usuario_bloqueios,
-- usuario_autorizacoes, vinculo_sst, usuario_permissoes_recurso,
-- logs_auditoria) permanecem EXATAMENTE como estão — nenhuma delas depende
-- de identidade_id, e nenhuma foi alterada por esta migration. Não existe
-- aqui nenhum UPDATE de backfill: vincular uma conta histórica a uma
-- identidade (nova ou já existente) é sempre um ato administrativo
-- deliberado, futuro, nunca inferido automaticamente pelo e-mail — o mesmo
-- e-mail pode legitimamente pertencer a contas diferentes, com senhas
-- diferentes, em empresas diferentes, sob o contrato anterior a esta
-- migration (uq_usuarios_empresa_email_lower, 005, é por empresa, nunca
-- global); juntar essas contas às cegas descartaria uma das senhas em
-- silêncio.
ALTER TABLE usuarios ADD COLUMN identidade_id INTEGER REFERENCES identidades(id) ON DELETE RESTRICT;

CREATE INDEX idx_usuarios_identidade_id ON usuarios (identidade_id);

-- Uma identidade não pode ter dois vínculos empresariais na MESMA empresa
-- (uma pessoa, uma conta por empresa). Índice PARCIAL — só alcança linhas
-- com identidade_id preenchido: contas do modelo anterior (identidade_id
-- NULL) nunca são comparadas entre si por esta regra, e continuam podendo
-- coexistir sem vínculo global, exatamente como hoje.
CREATE UNIQUE INDEX uq_usuarios_empresa_identidade
  ON usuarios (empresa_id, identidade_id)
  WHERE identidade_id IS NOT NULL;

-- usuarios.email e usuarios.senha_hash tornam-se OPCIONAIS: uma conta
-- vinculada a uma identidade não duplica e-mail/senha em usuarios — a
-- fonte de verdade passa a ser identidades.email/identidades.senha_hash, e
-- o cadastro de uma conta nova sob o modelo global grava NULL nas duas
-- colunas aqui, nunca um valor copiado (evitaria divergência silenciosa
-- se o e-mail da identidade mudar depois) nem um hash fictício (constrói
-- uma credencial que pareceria real sem nunca ter sido uma). Contas do
-- modelo anterior (identidade_id NULL), se ainda existirem, continuam
-- exigindo os dois campos preenchidos por disciplina de aplicação — o
-- banco deixou de OBRIGAR, não deixou de PERMITIR o contrato de antes.
ALTER TABLE usuarios ALTER COLUMN email DROP NOT NULL;
ALTER TABLE usuarios ALTER COLUMN senha_hash DROP NOT NULL;
