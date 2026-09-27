-- acoes: GERENCIAR_USUARIOS passa a exigir autorização individual
-- (OBRIGATORIA) — Bloco 9, parte F. Só dados: nenhuma coluna, constraint,
-- índice ou trigger muda.
--
-- POR QUE: a gestão de usuários da empresa (convidar, alterar nome e
-- perfil, inativar, reativar) usa o mesmo ponto único de autoridade das
-- telas de grupos (src/services/autoridade-administrativa.js): MASTER
-- ativo por perfil, ou ADMINISTRADOR ativo com autorização individual
-- PRÓPRIA para a ação. Aquele ponto recusa qualquer ação em modo NENHUMA,
-- e GERENCIAR_USUARIOS estava em NENHUMA desde a 017. Em OBRIGATORIA, como
-- as três ações da 024, permissoes_acao e grupos nunca bastam: cada
-- ADMINISTRADOR precisa de uma concessão nominal do MASTER. Assim o perfil
-- ADMINISTRADOR inteiro nunca ganha essa autoridade de uma vez.
--
-- exige_sst continua false: administrar usuários não é atividade de SST.
--
-- CONCESSÕES ANTIGAS: com o modo em NENHUMA, uma linha de
-- usuario_autorizacoes para esta ação não tinha efeito, e o serviço de
-- autorizações nunca cria uma. Se alguma existir mesmo assim, mudar o modo
-- a ativaria de surpresa, sem ninguém rever. Por isso a migration recusa
-- rodar nesse caso, em vez de apagar ou manter a linha em silêncio: quem
-- opera decide antes o que fazer com ela.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM usuario_autorizacoes WHERE acao_codigo = 'GERENCIAR_USUARIOS') THEN
    RAISE EXCEPTION 'há autorização individual gravada para GERENCIAR_USUARIOS; revise-a antes de aplicar a 047';
  END IF;
END
$$;

UPDATE acoes
   SET modo_autorizacao_individual = 'OBRIGATORIA',
       descricao = 'Convidar usuários e alterar nome, perfil e situação dos usuários da própria empresa.'
 WHERE codigo = 'GERENCIAR_USUARIOS';
