-- materiais: categoria, código interno e descrição (Bloco 9, Etapa C,
-- Parte C2 — integração do cadastro original de materiais, decisões A1,
-- C1 e G1 do planejamento).
--
-- ALTER ADITIVO sobre a tabela histórica 007, que permanece intocada
-- (CLAUDE.md §12). As três colunas nascem NULÁVEIS e sem DEFAULT: nenhum
-- registro existente é alterado, nenhum backfill, nenhuma perda — um
-- material anterior a esta migration simplesmente não tem categoria,
-- código nem descrição, exatamente como antes.
--
-- O QUE CADA COLUNA É (e o que NÃO é):
--   categoria      : classificação do item no cadastro (EPI, Uniforme,
--                    Ferramenta, Material de consumo...). Não é `tipo`,
--                    que continua sendo o tipo de EPI (Luva, Capacete...).
--                    Texto livre, sem enum fechado: a lista da tela é
--                    apresentação, e uma categoria nova não deve exigir
--                    migration.
--   codigo_interno : identificador que a empresa usa para o material
--                    (ex.: EPI-000245). ÚNICO POR EMPRESA, ignorando
--                    maiúsculas/minúsculas; empresas diferentes podem usar
--                    o mesmo código (isolamento multiempresa, CLAUDE.md
--                    §14). Índice único PARCIAL: linhas com NULL nunca
--                    entram nele, então vários materiais sem código não
--                    conflitam — "sem código" não é um código.
--   descricao      : aplicação, proteção e observações, até 500
--                    caracteres (teto reproduzido na aplicação).
--
-- VAZIO NUNCA É GRAVADO: a aplicação converte "" e espaços em NULL antes
-- de chegar aqui; os CHECKs são a segunda barreira, para que nem um
-- caminho futuro consiga gravar '' (que, no código interno, viraria um
-- "código" duplicável) ou valores com espaços nas pontas (que fariam
-- 'X-1' e 'X-1 ' parecerem códigos diferentes).
ALTER TABLE materiais
  ADD COLUMN categoria      VARCHAR(30),
  ADD COLUMN codigo_interno VARCHAR(30),
  ADD COLUMN descricao      TEXT;

ALTER TABLE materiais
  ADD CONSTRAINT chk_materiais_categoria_aparada
    CHECK (categoria IS NULL OR (btrim(categoria) = categoria AND char_length(categoria) > 0)),
  ADD CONSTRAINT chk_materiais_codigo_interno_aparado
    CHECK (codigo_interno IS NULL OR (btrim(codigo_interno) = codigo_interno AND char_length(codigo_interno) > 0)),
  ADD CONSTRAINT chk_materiais_descricao_tamanho
    CHECK (descricao IS NULL OR (btrim(descricao) = descricao AND char_length(descricao) BETWEEN 1 AND 500));

-- Unicidade do código interno por empresa, case-insensitive, só para
-- linhas com código — mesmo padrão dos índices únicos de expressão já
-- usados em uq_usuarios_empresa_email_lower (005) e
-- uq_identidades_email_lower (025). Também atende a consulta "existe
-- material com este código nesta empresa?".
CREATE UNIQUE INDEX uq_materiais_empresa_codigo_interno
  ON materiais (empresa_id, upper(codigo_interno))
  WHERE codigo_interno IS NOT NULL;
