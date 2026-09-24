-- empresas: campos cadastrais completos para o cadastro centralizado do
-- Painel Privado (Pacote 3 — Cadastro de Empresas e Convite do MASTER,
-- 23/09/2026). Migration ADITIVA: todas as colunas já existentes de 001 e
-- 016 (id, nome, cnpj, cidade, uf, cep, endereco, telefone, email,
-- dpo_nome, dpo_email, dpo_tel, ativo, criado_em, atualizado_em)
-- permanecem exatamente como estão — nada aqui as ALTERA, RENOMEIA ou
-- remove.
--
-- MAPEAMENTO DE CAMPOS (decisão desta migration, registrada para não
-- exigir uma segunda leitura do schema mais tarde):
--   `nome`      já existente, NOT NULL, único (uq_empresas_cnpj é do CNPJ,
--               mas `nome` já é a razão social de fato desde a 001) ->
--               continua sendo a RAZÃO SOCIAL. Não renomeado: uma
--               renomeação quebraria toda leitura/escrita já em produção
--               (login.service.js, sessão, auditoria, testes de Pacotes
--               1 e 2) só para trocar um rótulo.
--   `endereco`  já existente -> logradouro (rua/avenida), sem número.
--   `telefone`  já existente -> CONTATO INSTITUCIONAL (telefone geral).
--   `email`     já existente -> CONTATO INSTITUCIONAL (e-mail geral).
--   `cidade`/`uf`/`cep` já existentes -> sem mudança.
--
-- NOVAS COLUNAS, todas NULÁVEIS (nenhuma delas existia antes desta
-- migration; nenhuma é obrigatória para empresas já cadastradas nem para
-- as próximas — a aplicação decide o que exige em cada tela):
--   nome_fantasia                 -- nome fantasia, quando aplicável.
--   inscricao_estadual            -- número da IE. Formato livre de
--                                    propósito: varia por UF, uma única
--                                    regex nacional excluiria estados
--                                    válidos. NUNCA preenchido
--                                    automaticamente com 'ISENTO' — essa
--                                    informação vive só na coluna abaixo.
--   situacao_inscricao_estadual   -- ex.: CONTRIBUINTE, ISENTO,
--                                    NAO_CONTRIBUINTE. Mesma disciplina de
--                                    sessoes.autenticado_via (013) e
--                                    login_tentativas.motivo (015): CHECK
--                                    só de FORMATO ([A-Z_]{1,30}), nunca
--                                    IN (...) de valores fechados — um
--                                    rótulo novo não exige nova migration.
--   numero, complemento, bairro   -- completam o endereço já existente
--                                    (endereco/cidade/uf/cep).
--   representante_nome/cargo/email/telefone
--                                  -- REPRESENTANTE da empresa. Uso
--                                    futuro em comunicações
--                                    administrativas e documentos — NUNCA
--                                    se torna login MASTER
--                                    automaticamente (o primeiro MASTER só
--                                    nasce pelo fluxo de convite,
--                                    convites_master, migration 033).
--   financeiro_nome/email/telefone -- CONTATO FINANCEIRO. Uso futuro em
--                                    cobrança/contratação/faturamento da
--                                    plataforma — finalidade distinta do
--                                    representante e do contato
--                                    institucional, por isso armazenado
--                                    em colunas próprias, nunca reaproveita
--                                    dpo_nome/dpo_email/dpo_tel (que são
--                                    do encarregado de proteção de dados,
--                                    finalidade LGPD, já existente).
--
-- Mesmo padrão já usado por dpo_nome/dpo_email/dpo_tel (001): campos de
-- contato adicionais entram como colunas prefixadas na PRÓPRIA tabela
-- `empresas`, nunca uma segunda tabela de "dados da empresa" — é
-- exatamente o padrão que este pacote foi instruído a preservar ("não
-- criar uma segunda tabela contendo os mesmos dados empresariais").
ALTER TABLE empresas
  ADD COLUMN nome_fantasia               VARCHAR(150),
  ADD COLUMN inscricao_estadual          VARCHAR(20),
  ADD COLUMN situacao_inscricao_estadual VARCHAR(30),
  ADD COLUMN numero                      VARCHAR(20),
  ADD COLUMN complemento                 VARCHAR(100),
  ADD COLUMN bairro                      VARCHAR(100),
  ADD COLUMN representante_nome          VARCHAR(150),
  ADD COLUMN representante_cargo         VARCHAR(100),
  ADD COLUMN representante_email         VARCHAR(150),
  ADD COLUMN representante_telefone      VARCHAR(20),
  ADD COLUMN financeiro_nome             VARCHAR(150),
  ADD COLUMN financeiro_email            VARCHAR(150),
  ADD COLUMN financeiro_telefone         VARCHAR(20);

ALTER TABLE empresas
  ADD CONSTRAINT chk_empresas_situacao_ie_formato
    CHECK (situacao_inscricao_estadual IS NULL OR situacao_inscricao_estadual ~ '^[A-Z_]{1,30}$');
