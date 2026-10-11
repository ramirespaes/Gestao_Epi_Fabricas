-- acoes: registra EXPORTAR_HISTORICO_FUNCIONARIOS, a permissão de exportar o
-- Histórico de Funcionários. Só dados: nenhuma coluna, constraint, índice ou
-- gatilho muda, e nenhuma ação existente é alterada.
--
-- Mesmo desenho de IMPORTAR_FUNCIONARIOS (078): modo ALTERNATIVA (perfil/grupo
-- OU concessão individual; o bloqueio individual continua sendo a última
-- palavra) e sem exigência de SST.
--
-- Nasce NEGADA: esta migration não grava permissão de perfil, de grupo nem
-- autorização individual para ninguém, e não copia nada de visualizar, cadastrar,
-- editar ou importar. O MASTER a recebe pelo escopo de provisionamento
-- (src/rbac/recursos.js), como as demais ações dele; bancos já existentes
-- precisam do provisionamento do MASTER depois desta migration.
--
-- A exportação (pacote I) exige esta ação E a leitura do Histórico de
-- Funcionários (src/services/exportacao-historico-autorizacao.service.js).
INSERT INTO acoes (codigo, nome, descricao, modo_autorizacao_individual) VALUES
  ('EXPORTAR_HISTORICO_FUNCIONARIOS', 'Exportar histórico de funcionários', 'Exportar o histórico de funcionários (exige também visualizar o histórico)', 'ALTERNATIVA');
