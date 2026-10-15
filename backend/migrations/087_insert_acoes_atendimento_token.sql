-- acoes: as seis ações do Atendimento Token. Só dados: nenhuma coluna, constraint, índice ou gatilho muda, e nenhuma
-- ação existente é alterada.
--
-- Visualizar, cadastrar e editar o tablet são o recurso `atendimentoToken` (visualizar, criar, editar), sem linha no
-- banco, como os demais recursos. Estas ações são os atos sensíveis e as leituras separadas aprovadas (E1): 3 operações
-- do recurso + 6 ações = 9 permissões.
--
-- Nenhuma exige SST. TOKEN_GERENCIAR_REDES é OBRIGATORIA (só por concessão individual, como GERENCIAR_USUARIOS): a rede
-- autorizada é a barreira de rede do tablet. As demais são ALTERNATIVA (perfil/grupo OU concessão individual; o
-- bloqueio individual continua sendo a última palavra).
--
-- Nascem NEGADAS: esta migration não grava permissão de perfil, de grupo nem autorização individual para ninguém. A
-- entrada no escopo do MASTER e o enforcement nas rotas são etapas posteriores.
INSERT INTO acoes (codigo, nome, descricao, modo_autorizacao_individual) VALUES
  ('TOKEN_GERAR_ATIVACAO', 'Gerar ativação de tablet', 'Gerar o QR Code de uso único que ativa um tablet do Atendimento Token', 'ALTERNATIVA'),
  ('TOKEN_REVOGAR_DISPOSITIVO', 'Revogar tablet', 'Revogar a autorização de um tablet do Atendimento Token', 'ALTERNATIVA'),
  ('TOKEN_GERENCIAR_REDES', 'Gerenciar redes do Atendimento Token', 'Cadastrar e desativar as redes autorizadas (IP fixo ou túnel) dos tablets', 'OBRIGATORIA'),
  ('TOKEN_PREVIA_CATALOGO_REAL', 'Prévia com catálogo real', 'Usar a prévia do tablet com o catálogo real de um funcionário, sem registrar pedidos', 'ALTERNATIVA'),
  ('TOKEN_VISUALIZAR_MONITORAMENTO', 'Ver monitoramento dos tablets', 'Ver comunicação, quedas e restabelecimentos dos tablets', 'ALTERNATIVA'),
  ('TOKEN_VISUALIZAR_HISTORICO', 'Ver histórico dos tablets', 'Ver o histórico de ativações, revogações e eventos dos tablets', 'ALTERNATIVA');
