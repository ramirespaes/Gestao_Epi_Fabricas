-- acoes: (1) separa MOVIMENTAR_ESTOQUE em duas ações independentes,
-- ENTRADA_ESTOQUE (entrada por lote) e BAIXA_ESTOQUE (baixa / saída); e
-- (2) passa IMPORTAR_FUNCIONARIOS de NENHUMA para ALTERNATIVA. Só dados:
-- nenhuma coluna, constraint, índice ou gatilho muda.
--
-- POR QUE (1): a entrada e a baixa dependiam da mesma ação, então não podiam
-- ser liberadas separadamente. As duas novas seguem o desenho de
-- MOVIMENTAR_ESTOQUE (ALTERNATIVA, sem SST). MOVIMENTAR_ESTOQUE permanece no
-- catálogo, intacta e sem uso nas rotas; nenhuma linha dela é apagada.
--
-- POR QUE (2): a importação de funcionários tem permissão própria. Em modo
-- NENHUMA a ação não aceitava concessão individual, então o acesso binário
-- (ligar/desligar por usuário) não conseguia LIGAR. ALTERNATIVA = perfil/grupo
-- OU concessão individual, como ENTRADA_ESTOQUE. Nenhuma linha de
-- usuario_autorizacoes existia para ela (o modo NENHUMA nunca as consultou); o
-- que mudaria de efeito é a consulta passar a considerá-las, e a conferência
-- abaixo recusa rodar se houver alguma, para ninguém ganhar acesso sem revisão.
--
-- CONTINUIDADE (1): quem já tinha MOVIMENTAR_ESTOQUE não perde a função sem
-- aviso. O que existe por perfil, por grupo, por bloqueio individual e por
-- concessão individual (DIRETA e DELEGADA) é copiado para as duas novas ações,
-- com o mesmo valor. Não define padrão novo para nenhum perfil: só espelha o
-- estado atual. As concessões delegadas apontam para a concessão de quem
-- delegou (origem_id, da mesma ação); a cópia refaz essa cadeia nível a nível
-- com os ids novos, então a delegação continua coerente e a mesma pessoa
-- continua podendo delegar o que recebeu.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM usuario_autorizacoes WHERE acao_codigo = 'IMPORTAR_FUNCIONARIOS') THEN
    RAISE EXCEPTION 'há autorização individual gravada para IMPORTAR_FUNCIONARIOS; revise-a antes de aplicar a 078';
  END IF;
END
$$;

UPDATE acoes SET modo_autorizacao_individual = 'ALTERNATIVA'
 WHERE codigo = 'IMPORTAR_FUNCIONARIOS';

INSERT INTO acoes (codigo, nome, descricao, modo_autorizacao_individual) VALUES
  ('ENTRADA_ESTOQUE', 'Entrada de estoque por lote', 'Registrar entrada de estoque por lote', 'ALTERNATIVA'),
  ('BAIXA_ESTOQUE',   'Registrar baixa / saída de estoque', 'Registrar baixa ou saída de estoque por lote', 'ALTERNATIVA');

INSERT INTO permissoes_acao (empresa_id, perfil, acao_codigo, permitido)
SELECT p.empresa_id, p.perfil, n.codigo, p.permitido
  FROM permissoes_acao p
  CROSS JOIN (VALUES ('ENTRADA_ESTOQUE'), ('BAIXA_ESTOQUE')) AS n (codigo)
 WHERE p.acao_codigo = 'MOVIMENTAR_ESTOQUE';

INSERT INTO grupo_permissoes_acao (empresa_id, grupo_acesso_id, acao_codigo, permitido)
SELECT g.empresa_id, g.grupo_acesso_id, n.codigo, g.permitido
  FROM grupo_permissoes_acao g
  CROSS JOIN (VALUES ('ENTRADA_ESTOQUE'), ('BAIXA_ESTOQUE')) AS n (codigo)
 WHERE g.acao_codigo = 'MOVIMENTAR_ESTOQUE';

INSERT INTO usuario_bloqueios (usuario_id, acao_codigo, motivo, bloqueado_por)
SELECT b.usuario_id, n.codigo, b.motivo, b.bloqueado_por
  FROM usuario_bloqueios b
  CROSS JOIN (VALUES ('ENTRADA_ESTOQUE'), ('BAIXA_ESTOQUE')) AS n (codigo)
 WHERE b.acao_codigo = 'MOVIMENTAR_ESTOQUE';

-- Concessões individuais (diretas e delegadas), da raiz para as delegações, trocando o origem_id pelo id novo.
DO $$
DECLARE
  nova TEXT;
  r RECORD;
  origem_nova INTEGER;
  id_nova INTEGER;
BEGIN
  CREATE TEMP TABLE _mapa_autorizacoes_078 (acao_codigo VARCHAR(60) NOT NULL, id_antigo INTEGER NOT NULL, id_novo INTEGER NOT NULL) ON COMMIT DROP;
  FOREACH nova IN ARRAY ARRAY['ENTRADA_ESTOQUE', 'BAIXA_ESTOQUE'] LOOP
    FOR r IN
      WITH RECURSIVE cadeia AS (
        SELECT a.id, a.empresa_id, a.usuario_id, a.motivo, a.autorizado_por, a.criado_em, a.pode_delegar, a.origem_id, 0 AS nivel
          FROM usuario_autorizacoes a
         WHERE a.acao_codigo = 'MOVIMENTAR_ESTOQUE' AND a.origem_id IS NULL
        UNION ALL
        SELECT a.id, a.empresa_id, a.usuario_id, a.motivo, a.autorizado_por, a.criado_em, a.pode_delegar, a.origem_id, c.nivel + 1
          FROM usuario_autorizacoes a
          JOIN cadeia c ON a.origem_id = c.id
         WHERE a.acao_codigo = 'MOVIMENTAR_ESTOQUE'
      )
      SELECT * FROM cadeia ORDER BY nivel, id
    LOOP
      origem_nova := NULL;
      IF r.origem_id IS NOT NULL THEN
        SELECT m.id_novo INTO STRICT origem_nova
          FROM _mapa_autorizacoes_078 m
         WHERE m.acao_codigo = nova AND m.id_antigo = r.origem_id;
      END IF;
      INSERT INTO usuario_autorizacoes (empresa_id, usuario_id, acao_codigo, motivo, autorizado_por, criado_em, pode_delegar, origem_id)
      VALUES (r.empresa_id, r.usuario_id, nova, r.motivo, r.autorizado_por, r.criado_em, r.pode_delegar, origem_nova)
      RETURNING id INTO id_nova;
      INSERT INTO _mapa_autorizacoes_078 (acao_codigo, id_antigo, id_novo) VALUES (nova, r.id, id_nova);
    END LOOP;
  END LOOP;
  -- Toda concessão de MOVIMENTAR_ESTOQUE precisa ter sido copiada para as duas ações.
  IF (SELECT count(*) FROM usuario_autorizacoes WHERE acao_codigo = 'MOVIMENTAR_ESTOQUE') * 2
     <> (SELECT count(*) FROM _mapa_autorizacoes_078) THEN
    RAISE EXCEPTION 'cópia das concessões de MOVIMENTAR_ESTOQUE incompleta';
  END IF;
END
$$;
