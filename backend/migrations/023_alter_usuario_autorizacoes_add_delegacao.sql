-- usuario_autorizacoes: evolução estrutural para suportar delegação de
-- autorizações individuais de ação (Bloco 8, Incremento 8, Etapa 5A,
-- Subetapa 3H). Só estrutura — nenhuma rota, service ou repository lê ou
-- decide com base em pode_delegar/origem_id ainda; usuarioTemAutorizacaoIndividual
-- continua exatamente como está, e continuará funcionando sem alteração:
-- ela só verifica se EXISTE alguma linha para usuario_id+acao_codigo,
-- direta ou delegada, o que as duas colunas novas não mudam.
--
-- pode_delegar BOOLEAN NOT NULL DEFAULT false: todas as linhas já
-- existentes nascem sem o direito de delegar — receber autorização para
-- EXECUTAR uma ação nunca concedeu, e continua não concedendo, o direito
-- de DELEGÁ-la. Atribuir true é sempre um ato explícito e separado,
-- responsabilidade de uma camada de serviço futura, não desta migration.
-- Grupo de acesso (020/021) não tem — e não ganha aqui — nenhuma noção de
-- pode_delegar: delegação é sempre um atributo de uma autorização
-- INDIVIDUAL específica, nunca de um grupo inteiro.
--
-- origem_id INTEGER NULL, auto-referenciando usuario_autorizacoes(id):
-- NULL numa autorização direta (tipicamente concedida pelo MASTER, sem
-- nascer de nenhuma outra); preenchido numa autorização delegada, apontando
-- para a autorização que fundamentou a delegação. A integridade do vínculo
-- é garantida inteiramente por uma FK composta (sem trigger nem lógica em
-- aplicação):
--
--   FOREIGN KEY (origem_id, empresa_id, acao_codigo, autorizado_por)
--   REFERENCES usuario_autorizacoes (id, empresa_id, acao_codigo, usuario_id)
--
-- Lida por coluna, essa FK obriga simultaneamente que a linha referenciada
-- por origem_id: (a) exista; (b) pertença à MESMA empresa; (c) seja da
-- MESMA ação; e (d) tenha como beneficiário (usuario_id) exatamente quem
-- concedeu (autorizado_por) a linha delegada — ou seja, só quem RECEBEU a
-- autorização de origem pode aparecer como concedente da autorização que
-- dela deriva. Isso é o que a migration pediu como "correspondência entre
-- o beneficiário da autorização de origem e o concedente da autorização
-- filha", inteiramente verificado pelo PostgreSQL a cada INSERT/UPDATE,
-- sem depender de nenhuma validação de aplicação. O lado referenciado
-- precisa de uma UNIQUE própria (id já é único sozinho por ser PK; a
-- ampliação para (id, empresa_id, acao_codigo, usuario_id) é redundante
-- em termos de unicidade, mas obrigatória para servir de alvo de uma FK
-- composta — mesmo raciocínio já usado por uq_usuarios_empresa_id, 013).
--
-- Autorizações diretas (origem_id NULL) nunca são avaliadas por essa FK:
-- o modo de correspondência padrão do PostgreSQL para FK composta
-- (MATCH SIMPLE) dispensa a checagem inteira quando qualquer uma das
-- colunas do lado referenciador é NULL — e origem_id é sempre a primeira
-- delas.
--
-- ON DELETE CASCADE no origem_id: excluir fisicamente a autorização de
-- origem remove em cascata suas autorizações delegadas descendentes
-- (diretas e, transitivamente, delegações de delegações) — a "revogação
-- de descendentes quando a origem é efetivamente excluída" pedida nesta
-- subetapa é inteiramente responsabilidade do PostgreSQL, sem nenhuma
-- rotina de aplicação. Alterar pode_delegar de true para false é uma
-- operação SEPARADA (um UPDATE, não um DELETE): impede delegações NOVAS a
-- partir dali, mas não apaga nem revoga o que já foi delegado — igual ao
-- texto da autorização desta subetapa. A revogação retroativa das
-- concessões já delegadas, se um dia for decidida, é regra administrativa
-- explícita, fora do escopo desta migration.
ALTER TABLE usuario_autorizacoes
  ADD COLUMN pode_delegar BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN origem_id INTEGER;

ALTER TABLE usuario_autorizacoes
  ADD CONSTRAINT uq_usuario_autorizacoes_id_empresa_acao_usuario
    UNIQUE (id, empresa_id, acao_codigo, usuario_id);

ALTER TABLE usuario_autorizacoes
  ADD CONSTRAINT fk_usuario_autorizacoes_origem_valida
    FOREIGN KEY (origem_id, empresa_id, acao_codigo, autorizado_por)
    REFERENCES usuario_autorizacoes (id, empresa_id, acao_codigo, usuario_id)
    ON DELETE CASCADE;

-- A UNIQUE (usuario_id, acao_codigo) de 019 foi criada antes de existir a
-- noção de origem: ela impediria, incorretamente, uma autorização direta
-- coexistir com uma delegada (ou duas delegadas de origens diferentes)
-- para o mesmo usuário e ação. Substituída aqui — nunca em 019 — por dois
-- índices únicos PARCIAIS, que distinguem por origem_id em vez de
-- depender da semântica de NULL de uma UNIQUE comum (que trataria cada
-- origem_id NULL como distinto dos demais e deixaria passar duplicação
-- indevida de autorizações diretas):
--
--   direta   (origem_id IS NULL)     — no máximo uma por usuário+ação;
--   delegada (origem_id IS NOT NULL) — no máximo uma por usuário+ação+
--                                       origem, permitindo livremente
--                                       várias origens independentes para
--                                       o mesmo usuário e a mesma ação.
ALTER TABLE usuario_autorizacoes
  DROP CONSTRAINT uq_usuario_autorizacoes_usuario_acao;

CREATE UNIQUE INDEX uq_usuario_autorizacoes_direta_usuario_acao
  ON usuario_autorizacoes (usuario_id, acao_codigo)
  WHERE origem_id IS NULL;

CREATE UNIQUE INDEX uq_usuario_autorizacoes_delegada_usuario_acao_origem
  ON usuario_autorizacoes (usuario_id, acao_codigo, origem_id)
  WHERE origem_id IS NOT NULL;

-- Sem índice equivalente até aqui para "quem foi delegado a partir desta
-- autorização" (localizar descendentes de uma origem) nem para o próprio
-- CASCADE de exclusão acima localizar as linhas dependentes — mesmo
-- raciocínio de idx_grupo_permissoes_acao_acao_codigo (021).
CREATE INDEX idx_usuario_autorizacoes_origem_id ON usuario_autorizacoes (origem_id);
