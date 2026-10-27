-- 092: Suporte do Portal Empresarial — chamados para a SafeWork e registro dos contatos com o Almoxarifado e a SST.
--
-- Estritamente aditiva: só tabelas, sequência e gatilhos novos; nenhuma tabela existente muda e nenhum dado é reescrito.
--
--  * suporte_chamados: chamado de suporte do sistema. Empresa e usuário vêm SEMPRE da sessão (FK composta com `usuarios`,
--    que impede associar o chamado a um usuário de outra empresa). Nome e e-mail do solicitante ficam como instantâneo
--    (o cadastro pode mudar; o chamado mostra quem abriu). Protocolo único gerado pelo banco (SUP-AAAA-NNNNNN, ano pelo fuso
--    de São Paulo, sequência global: o número não revela quantos chamados a empresa tem). A chave de idempotência do
--    cliente com o hash do pedido (UNIQUE por empresa + usuário) impede o chamado duplicado do duplo clique ou do reenvio.
--    A situação é ABERTO | EM_ATENDIMENTO | RESPONDIDO | ENCERRADO; ENCERRADO é final e carimba encerrado_em.
--  * suporte_chamado_respostas: respostas da plataforma (administrador), append-only.
--  * suporte_chamado_situacoes: histórico das mudanças de situação (de, para, quem), append-only.
--  * suporte_contatos: registro do contato com o Almoxarifado (emailAlmoxarifado) ou a SST (emailSst) da PRÓPRIA empresa.
--    O destinatário NÃO é gravado (é dado pessoal e vem sempre do cadastro da empresa da sessão na hora do envio). A
--    situação distingue o que realmente aconteceu: REGISTRADA (só gravada), ENVIO_CONFIRMADO (o transporte confirmou),
--    GRAVADO_EM_ARQUIVO (transporte de desenvolvimento, não é entrega), NAO_ENVIADO (sem provedor configurado) e FALHA
--    (só um código técnico, nunca o texto do provedor).
--
-- Texto livre (descrição, resposta, mensagem) fica só nestas tabelas; auditoria e logs recebem ids, canal e situação.

CREATE SEQUENCE suporte_chamados_protocolo_seq;

CREATE TABLE suporte_chamados (
  id                  BIGSERIAL PRIMARY KEY,
  empresa_id          INTEGER      NOT NULL,
  usuario_id          INTEGER      NOT NULL,
  protocolo           VARCHAR(20)  NOT NULL
    DEFAULT ('SUP-' || to_char(now() AT TIME ZONE 'America/Sao_Paulo', 'YYYY') || '-' || lpad(nextval('suporte_chamados_protocolo_seq')::text, 6, '0')),
  assunto             VARCHAR(150) NOT NULL,
  categoria           VARCHAR(20)  NOT NULL,
  descricao           TEXT         NOT NULL,
  situacao            VARCHAR(15)  NOT NULL DEFAULT 'ABERTO',
  solicitante_nome    VARCHAR(150) NOT NULL,
  solicitante_email   VARCHAR(150) NOT NULL,
  chave_idempotencia  VARCHAR(64)  NOT NULL,
  requisicao_hash     CHAR(64)     NOT NULL,
  criado_em           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  atualizado_em       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  encerrado_em        TIMESTAMPTZ,
  CONSTRAINT uq_suporte_chamados_protocolo UNIQUE (protocolo),
  CONSTRAINT uq_suporte_chamados_chave UNIQUE (empresa_id, usuario_id, chave_idempotencia),
  CONSTRAINT fk_suporte_chamados_empresa FOREIGN KEY (empresa_id) REFERENCES empresas (id),
  CONSTRAINT fk_suporte_chamados_usuario_mesma_empresa FOREIGN KEY (empresa_id, usuario_id) REFERENCES usuarios (empresa_id, id),
  CONSTRAINT chk_suporte_chamados_assunto CHECK (char_length(btrim(assunto)) BETWEEN 1 AND 150),
  CONSTRAINT chk_suporte_chamados_categoria CHECK (categoria IN ('ERRO', 'LENTIDAO', 'ACESSO', 'DUVIDA', 'SUGESTAO', 'OUTRO')),
  CONSTRAINT chk_suporte_chamados_descricao CHECK (char_length(btrim(descricao)) BETWEEN 1 AND 4000),
  CONSTRAINT chk_suporte_chamados_situacao CHECK (situacao IN ('ABERTO', 'EM_ATENDIMENTO', 'RESPONDIDO', 'ENCERRADO')),
  CONSTRAINT chk_suporte_chamados_encerramento CHECK ((situacao = 'ENCERRADO') = (encerrado_em IS NOT NULL))
);

-- Meus chamados (empresa + usuário, mais recentes primeiro) e fila do Painel Privado (situação, mais recentes primeiro).
CREATE INDEX idx_suporte_chamados_usuario ON suporte_chamados (empresa_id, usuario_id, criado_em DESC, id DESC);
CREATE INDEX idx_suporte_chamados_situacao ON suporte_chamados (situacao, criado_em DESC, id DESC);

CREATE TRIGGER trg_suporte_chamados_atualizado_em
  BEFORE UPDATE ON suporte_chamados
  FOR EACH ROW EXECUTE FUNCTION set_atualizado_em();

CREATE TABLE suporte_chamado_respostas (
  id                BIGSERIAL PRIMARY KEY,
  chamado_id        BIGINT      NOT NULL,
  administrador_id  INTEGER     NOT NULL,
  texto             TEXT        NOT NULL,
  criado_em         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fk_suporte_respostas_chamado FOREIGN KEY (chamado_id) REFERENCES suporte_chamados (id),
  CONSTRAINT fk_suporte_respostas_administrador FOREIGN KEY (administrador_id) REFERENCES administradores_plataforma (id),
  CONSTRAINT chk_suporte_respostas_texto CHECK (char_length(btrim(texto)) BETWEEN 1 AND 4000)
);
CREATE INDEX idx_suporte_respostas_chamado ON suporte_chamado_respostas (chamado_id, id);

CREATE TABLE suporte_chamado_situacoes (
  id                BIGSERIAL PRIMARY KEY,
  chamado_id        BIGINT      NOT NULL,
  situacao_anterior VARCHAR(15),
  situacao_nova     VARCHAR(15) NOT NULL,
  administrador_id  INTEGER,
  criado_em         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fk_suporte_situacoes_chamado FOREIGN KEY (chamado_id) REFERENCES suporte_chamados (id),
  CONSTRAINT fk_suporte_situacoes_administrador FOREIGN KEY (administrador_id) REFERENCES administradores_plataforma (id),
  CONSTRAINT chk_suporte_situacoes_anterior CHECK (situacao_anterior IS NULL OR situacao_anterior IN ('ABERTO', 'EM_ATENDIMENTO', 'RESPONDIDO', 'ENCERRADO')),
  CONSTRAINT chk_suporte_situacoes_nova CHECK (situacao_nova IN ('ABERTO', 'EM_ATENDIMENTO', 'RESPONDIDO', 'ENCERRADO')),
  CONSTRAINT chk_suporte_situacoes_diferente CHECK (situacao_anterior IS DISTINCT FROM situacao_nova)
);
CREATE INDEX idx_suporte_situacoes_chamado ON suporte_chamado_situacoes (chamado_id, id);

-- Respostas e histórico nunca são reescritos nem apagados: a trilha do atendimento é imutável.
CREATE FUNCTION suporte_bloquear_alteracao() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'registro de suporte é imutável' USING ERRCODE = 'P0001';
END;
$$;

CREATE TRIGGER trg_suporte_respostas_imutavel BEFORE UPDATE OR DELETE ON suporte_chamado_respostas
  FOR EACH ROW EXECUTE FUNCTION suporte_bloquear_alteracao();
CREATE TRIGGER trg_suporte_respostas_sem_truncate BEFORE TRUNCATE ON suporte_chamado_respostas
  FOR EACH STATEMENT EXECUTE FUNCTION suporte_bloquear_alteracao();
CREATE TRIGGER trg_suporte_situacoes_imutavel BEFORE UPDATE OR DELETE ON suporte_chamado_situacoes
  FOR EACH ROW EXECUTE FUNCTION suporte_bloquear_alteracao();
CREATE TRIGGER trg_suporte_situacoes_sem_truncate BEFORE TRUNCATE ON suporte_chamado_situacoes
  FOR EACH STATEMENT EXECUTE FUNCTION suporte_bloquear_alteracao();

CREATE TABLE suporte_contatos (
  id                  BIGSERIAL PRIMARY KEY,
  empresa_id          INTEGER      NOT NULL,
  usuario_id          INTEGER      NOT NULL,
  canal               VARCHAR(15)  NOT NULL,
  assunto             VARCHAR(150) NOT NULL,
  mensagem            TEXT         NOT NULL,
  situacao_envio      VARCHAR(20)  NOT NULL DEFAULT 'REGISTRADA',
  codigo_falha        VARCHAR(40),
  tentativas          SMALLINT     NOT NULL DEFAULT 0,
  chave_idempotencia  VARCHAR(64)  NOT NULL,
  requisicao_hash     CHAR(64)     NOT NULL,
  criado_em           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  atualizado_em       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT uq_suporte_contatos_chave UNIQUE (empresa_id, usuario_id, chave_idempotencia),
  CONSTRAINT fk_suporte_contatos_empresa FOREIGN KEY (empresa_id) REFERENCES empresas (id),
  CONSTRAINT fk_suporte_contatos_usuario_mesma_empresa FOREIGN KEY (empresa_id, usuario_id) REFERENCES usuarios (empresa_id, id),
  CONSTRAINT chk_suporte_contatos_canal CHECK (canal IN ('ALMOXARIFADO', 'SST')),
  CONSTRAINT chk_suporte_contatos_assunto CHECK (char_length(btrim(assunto)) BETWEEN 1 AND 150),
  CONSTRAINT chk_suporte_contatos_mensagem CHECK (char_length(btrim(mensagem)) BETWEEN 1 AND 4000),
  CONSTRAINT chk_suporte_contatos_situacao CHECK (situacao_envio IN ('REGISTRADA', 'ENVIO_CONFIRMADO', 'GRAVADO_EM_ARQUIVO', 'NAO_ENVIADO', 'FALHA')),
  CONSTRAINT chk_suporte_contatos_falha CHECK ((situacao_envio = 'FALHA') = (codigo_falha IS NOT NULL)),
  CONSTRAINT chk_suporte_contatos_tentativas CHECK (tentativas BETWEEN 0 AND 20)
);
CREATE INDEX idx_suporte_contatos_usuario ON suporte_contatos (empresa_id, usuario_id, criado_em DESC, id DESC);

CREATE TRIGGER trg_suporte_contatos_atualizado_em
  BEFORE UPDATE ON suporte_contatos
  FOR EACH ROW EXECUTE FUNCTION set_atualizado_em();
