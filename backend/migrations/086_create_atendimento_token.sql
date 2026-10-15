-- 086 — Atendimento Token (Etapa A): tablet compartilhado de autoatendimento de EPI.
--
-- Só estrutura nova. Nenhuma tabela existente muda: solicitacoes_epi e solicitacoes_epi_itens ficam idênticas e o pedido
-- do tablet usa a origem AUTOATENDIMENTO já prevista na 065.
--
--   token_dispositivos           tablet da empresa. A situação administrativa é DERIVADA dos carimbos (pendente: sem
--                                ativado_em; ativo: ativado e não revogado; revogado: revogado_em), sem coluna de status.
--                                Número de série é inventário, nunca autenticação. A credencial existe só como SHA-256
--                                hexadecimal (o token em claro nunca chega ao banco), só depois da ativação e nunca depois
--                                da revogação; o hash anterior permite detectar o reuso de uma credencial já rotacionada.
--   token_ativacoes              código do QR: só o SHA-256, uso único, validade de no máximo 10 minutos, um pendente por
--                                tablet (a situação também é derivada: pendente, usado, cancelado, expirado).
--   token_atendimentos           sessão curta do trabalhador no tablet; um aberto por tablet.
--   token_redes_autorizadas      redes da empresa (IP fixo ou sub-rede de túnel). Uma sub-rede de túnel ativa nunca se
--                                sobrepõe a outra, então a rede de origem identifica UMA empresa; IP fixo pode coincidir
--                                entre empresas (quem decide a empresa é o tablet). Sem rede, o serviço recusa o tablet.
--   token_dispositivo_eventos    histórico append-only (o heartbeat não grava um evento por batida).
--   solicitacoes_autoatendimento tabela lateral 1:1 da solicitação AUTOATENDIMENTO: tablet, atendimento e a cópia da
--                                localização do tablet na data do pedido; imutável.
--
-- Isolamento: toda referência é FK COMPOSTA (empresa_id, ...); nada aponta só por id para outra empresa.

CREATE TABLE token_dispositivos (
  id                        INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  empresa_id                INTEGER NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  identificador             UUID NOT NULL DEFAULT gen_random_uuid(),
  nome                      VARCHAR(100) NOT NULL,
  unidade                   VARCHAR(100),
  setor                     VARCHAR(100),
  local_instalacao          VARCHAR(150),
  fabricante                VARCHAR(100),
  modelo                    VARCHAR(100),
  numero_serie              VARCHAR(100),
  credencial_hash           CHAR(64),
  credencial_anterior_hash  CHAR(64),
  credencial_emitida_em     TIMESTAMPTZ,
  ativado_em                TIMESTAMPTZ,
  revogado_em               TIMESTAMPTZ,
  revogado_por              INTEGER,
  ultimo_contato_em         TIMESTAMPTZ,
  comunicacao_registrada    VARCHAR(10),
  criado_por                INTEGER NOT NULL,
  criado_em                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_token_dispositivos_empresa_id UNIQUE (empresa_id, id),
  CONSTRAINT uq_token_dispositivos_identificador UNIQUE (identificador),
  CONSTRAINT uq_token_dispositivos_credencial UNIQUE (credencial_hash),
  CONSTRAINT uq_token_dispositivos_empresa_numero_serie UNIQUE (empresa_id, numero_serie),
  CONSTRAINT fk_token_dispositivos_criador_mesma_empresa
    FOREIGN KEY (empresa_id, criado_por) REFERENCES usuarios (empresa_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_token_dispositivos_revogador_mesma_empresa
    FOREIGN KEY (empresa_id, revogado_por) REFERENCES usuarios (empresa_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_token_dispositivos_nome
    CHECK (btrim(nome) = nome AND char_length(nome) BETWEEN 1 AND 100 AND nome !~ '[[:cntrl:]]'),
  CONSTRAINT chk_token_dispositivos_textos CHECK (
    (unidade IS NULL OR (btrim(unidade) = unidade AND char_length(unidade) > 0))
    AND (setor IS NULL OR (btrim(setor) = setor AND char_length(setor) > 0))
    AND (local_instalacao IS NULL OR (btrim(local_instalacao) = local_instalacao AND char_length(local_instalacao) > 0))
    AND (fabricante IS NULL OR (btrim(fabricante) = fabricante AND char_length(fabricante) > 0))
    AND (modelo IS NULL OR (btrim(modelo) = modelo AND char_length(modelo) > 0))
    AND (numero_serie IS NULL OR (btrim(numero_serie) = numero_serie AND char_length(numero_serie) > 0))),
  CONSTRAINT chk_token_dispositivos_credencial_formato CHECK (
    (credencial_hash IS NULL OR credencial_hash ~ '^[0-9a-f]{64}$')
    AND (credencial_anterior_hash IS NULL OR credencial_anterior_hash ~ '^[0-9a-f]{64}$')),
  -- Credencial só existe com o tablet ativado (e com o instante da emissão).
  CONSTRAINT chk_token_dispositivos_credencial_ativado
    CHECK (credencial_hash IS NULL OR (ativado_em IS NOT NULL AND credencial_emitida_em IS NOT NULL)),
  CONSTRAINT chk_token_dispositivos_revogacao CHECK ((revogado_em IS NULL) = (revogado_por IS NULL)),
  -- Revogado não tem credencial válida: a revogação apaga o hash na mesma escrita.
  CONSTRAINT chk_token_dispositivos_revogado_sem_credencial CHECK (revogado_em IS NULL OR credencial_hash IS NULL),
  CONSTRAINT chk_token_dispositivos_comunicacao
    CHECK (comunicacao_registrada IS NULL OR comunicacao_registrada IN ('ONLINE', 'OFFLINE')),
  CONSTRAINT chk_token_dispositivos_ordem CHECK (
    (ativado_em IS NULL OR ativado_em >= criado_em) AND (revogado_em IS NULL OR revogado_em >= criado_em))
);

CREATE UNIQUE INDEX uq_token_dispositivos_empresa_nome ON token_dispositivos (empresa_id, lower(nome));

CREATE TRIGGER trg_token_dispositivos_atualizado_em
  BEFORE UPDATE ON token_dispositivos
  FOR EACH ROW EXECUTE FUNCTION set_atualizado_em();

CREATE TABLE token_ativacoes (
  id              INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  empresa_id      INTEGER NOT NULL,
  dispositivo_id  INTEGER NOT NULL,
  codigo_hash     CHAR(64) NOT NULL,
  criado_por      INTEGER NOT NULL,
  criado_em       TIMESTAMPTZ NOT NULL DEFAULT now(),
  expira_em       TIMESTAMPTZ NOT NULL,
  usado_em        TIMESTAMPTZ,
  cancelado_em    TIMESTAMPTZ,
  CONSTRAINT uq_token_ativacoes_codigo UNIQUE (codigo_hash),
  CONSTRAINT fk_token_ativacoes_dispositivo_mesma_empresa
    FOREIGN KEY (empresa_id, dispositivo_id) REFERENCES token_dispositivos (empresa_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_token_ativacoes_criador_mesma_empresa
    FOREIGN KEY (empresa_id, criado_por) REFERENCES usuarios (empresa_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_token_ativacoes_codigo_formato CHECK (codigo_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_token_ativacoes_validade
    CHECK (expira_em > criado_em AND expira_em <= criado_em + interval '10 minutes'),
  CONSTRAINT chk_token_ativacoes_uso_unico CHECK (usado_em IS NULL OR cancelado_em IS NULL),
  CONSTRAINT chk_token_ativacoes_ordem CHECK (
    (usado_em IS NULL OR usado_em >= criado_em) AND (cancelado_em IS NULL OR cancelado_em >= criado_em))
);

CREATE UNIQUE INDEX uq_token_ativacoes_pendente_por_dispositivo
  ON token_ativacoes (empresa_id, dispositivo_id) WHERE usado_em IS NULL AND cancelado_em IS NULL;

CREATE TABLE token_atendimentos (
  id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  empresa_id           INTEGER NOT NULL,
  dispositivo_id       INTEGER NOT NULL,
  funcionario_id       INTEGER NOT NULL,
  token_hash           CHAR(64) NOT NULL,
  iniciado_em          TIMESTAMPTZ NOT NULL DEFAULT now(),
  expira_em            TIMESTAMPTZ NOT NULL,
  encerrado_em         TIMESTAMPTZ,
  motivo_encerramento  VARCHAR(30),
  CONSTRAINT uq_token_atendimentos_token UNIQUE (token_hash),
  CONSTRAINT uq_token_atendimentos_empresa_id UNIQUE (empresa_id, id),
  -- Alvo da FK da tabela lateral: o atendimento citado é do MESMO tablet.
  CONSTRAINT uq_token_atendimentos_empresa_id_dispositivo UNIQUE (empresa_id, id, dispositivo_id),
  CONSTRAINT fk_token_atendimentos_dispositivo_mesma_empresa
    FOREIGN KEY (empresa_id, dispositivo_id) REFERENCES token_dispositivos (empresa_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_token_atendimentos_funcionario_mesma_empresa
    FOREIGN KEY (empresa_id, funcionario_id) REFERENCES funcionarios (empresa_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_token_atendimentos_token_formato CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_token_atendimentos_validade CHECK (expira_em > iniciado_em),
  CONSTRAINT chk_token_atendimentos_encerramento CHECK (
    (encerrado_em IS NULL) = (motivo_encerramento IS NULL)
    AND (motivo_encerramento IS NULL
         OR motivo_encerramento IN ('PEDIDO_ENVIADO', 'SAIDA', 'INATIVIDADE', 'SUBSTITUIDO', 'DISPOSITIVO_REVOGADO'))
    AND (encerrado_em IS NULL OR encerrado_em >= iniciado_em))
);

CREATE UNIQUE INDEX uq_token_atendimentos_aberto_por_dispositivo
  ON token_atendimentos (empresa_id, dispositivo_id) WHERE encerrado_em IS NULL;

CREATE TABLE token_redes_autorizadas (
  id              INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  empresa_id      INTEGER NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  tipo            VARCHAR(10) NOT NULL,
  rede            CIDR NOT NULL,
  descricao       VARCHAR(150),
  criado_por      INTEGER NOT NULL,
  criado_em       TIMESTAMPTZ NOT NULL DEFAULT now(),
  desativada_em   TIMESTAMPTZ,
  desativada_por  INTEGER,
  CONSTRAINT fk_token_redes_criador_mesma_empresa
    FOREIGN KEY (empresa_id, criado_por) REFERENCES usuarios (empresa_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_token_redes_desativador_mesma_empresa
    FOREIGN KEY (empresa_id, desativada_por) REFERENCES usuarios (empresa_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_token_redes_tipo CHECK (tipo IN ('IP_FIXO', 'TUNEL')),
  CONSTRAINT chk_token_redes_descricao
    CHECK (descricao IS NULL OR (btrim(descricao) = descricao AND char_length(descricao) > 0)),
  CONSTRAINT chk_token_redes_desativacao CHECK ((desativada_em IS NULL) = (desativada_por IS NULL)),
  -- Cada sub-rede de túnel ativa pertence a uma empresa só: a origem identifica a empresa sem ambiguidade.
  CONSTRAINT ex_token_redes_tunel_sem_sobreposicao
    EXCLUDE USING gist (rede inet_ops WITH &&) WHERE (tipo = 'TUNEL' AND desativada_em IS NULL)
);

CREATE UNIQUE INDEX uq_token_redes_empresa_rede_ativa
  ON token_redes_autorizadas (empresa_id, rede) WHERE desativada_em IS NULL;

CREATE TABLE token_dispositivo_eventos (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  empresa_id        INTEGER NOT NULL,
  dispositivo_id    INTEGER NOT NULL,
  tipo              VARCHAR(30) NOT NULL,
  ocorrido_em       TIMESTAMPTZ NOT NULL DEFAULT now(),
  usuario_id        INTEGER,
  duracao_segundos  INTEGER,
  CONSTRAINT fk_token_eventos_dispositivo_mesma_empresa
    FOREIGN KEY (empresa_id, dispositivo_id) REFERENCES token_dispositivos (empresa_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_token_eventos_usuario_mesma_empresa
    FOREIGN KEY (empresa_id, usuario_id) REFERENCES usuarios (empresa_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_token_eventos_tipo CHECK (tipo IN (
    'CADASTRO', 'ALTERACAO', 'ATIVACAO_GERADA', 'ATIVACAO', 'REVOGACAO', 'CREDENCIAL_RENOVADA', 'REUSO_CREDENCIAL',
    'REDE_RECUSADA', 'QUEDA', 'RESTABELECIMENTO')),
  -- A duração da indisponibilidade acompanha o restabelecimento, e só ele.
  CONSTRAINT chk_token_eventos_duracao CHECK (
    (tipo = 'RESTABELECIMENTO') = (duracao_segundos IS NOT NULL) AND (duracao_segundos IS NULL OR duracao_segundos >= 0))
);

CREATE INDEX ix_token_eventos_dispositivo_ocorrido
  ON token_dispositivo_eventos (empresa_id, dispositivo_id, ocorrido_em DESC);

CREATE FUNCTION proteger_token_dispositivo_eventos() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'token_dispositivo_eventos é append-only: o histórico não é alterado nem apagado';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_token_eventos_append_only
  BEFORE UPDATE OR DELETE ON token_dispositivo_eventos
  FOR EACH ROW EXECUTE FUNCTION proteger_token_dispositivo_eventos();

CREATE TRIGGER trg_token_eventos_bloquear_truncate
  BEFORE TRUNCATE ON token_dispositivo_eventos
  FOR EACH STATEMENT EXECUTE FUNCTION proteger_token_dispositivo_eventos();

CREATE TABLE solicitacoes_autoatendimento (
  solicitacao_id    INTEGER PRIMARY KEY,
  empresa_id        INTEGER NOT NULL,
  dispositivo_id    INTEGER NOT NULL,
  atendimento_id    BIGINT NOT NULL,
  -- Cópia da localização do tablet na data do pedido: não acompanha mudanças posteriores do cadastro.
  unidade           VARCHAR(100),
  setor             VARCHAR(100),
  local_instalacao  VARCHAR(150),
  criado_em         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fk_solicitacoes_autoatendimento_solicitacao_mesma_empresa
    FOREIGN KEY (empresa_id, solicitacao_id) REFERENCES solicitacoes_epi (empresa_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_solicitacoes_autoatendimento_dispositivo_mesma_empresa
    FOREIGN KEY (empresa_id, dispositivo_id) REFERENCES token_dispositivos (empresa_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_solicitacoes_autoatendimento_atendimento_do_dispositivo
    FOREIGN KEY (empresa_id, atendimento_id, dispositivo_id) REFERENCES token_atendimentos (empresa_id, id, dispositivo_id) ON DELETE RESTRICT
);

-- Só a solicitação AUTOATENDIMENTO tem esta linha, e o atendimento é do mesmo funcionário do pedido. Pedido ou
-- atendimento inexistente fica para as FKs.
CREATE FUNCTION validar_solicitacao_autoatendimento() RETURNS TRIGGER AS $$
DECLARE
  v_origem       VARCHAR(20);
  v_funcionario  INTEGER;
  v_atendido     INTEGER;
BEGIN
  SELECT origem_solicitacao, funcionario_id INTO v_origem, v_funcionario
    FROM solicitacoes_epi WHERE empresa_id = NEW.empresa_id AND id = NEW.solicitacao_id;
  IF FOUND AND v_origem <> 'AUTOATENDIMENTO' THEN
    RAISE EXCEPTION 'só a solicitação de origem AUTOATENDIMENTO tem registro de autoatendimento';
  END IF;
  SELECT funcionario_id INTO v_atendido FROM token_atendimentos WHERE empresa_id = NEW.empresa_id AND id = NEW.atendimento_id;
  IF FOUND AND v_funcionario IS NOT NULL AND v_atendido <> v_funcionario THEN
    RAISE EXCEPTION 'o atendimento é de outro funcionário: não corresponde ao trabalhador da solicitação';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_solicitacoes_autoatendimento_validar
  BEFORE INSERT ON solicitacoes_autoatendimento
  FOR EACH ROW EXECUTE FUNCTION validar_solicitacao_autoatendimento();

CREATE FUNCTION proteger_solicitacoes_autoatendimento() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'solicitacoes_autoatendimento é imutável: a origem do pedido não é alterada nem apagada';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_solicitacoes_autoatendimento_imutavel
  BEFORE UPDATE OR DELETE ON solicitacoes_autoatendimento
  FOR EACH ROW EXECUTE FUNCTION proteger_solicitacoes_autoatendimento();

CREATE TRIGGER trg_solicitacoes_autoatendimento_bloquear_truncate
  BEFORE TRUNCATE ON solicitacoes_autoatendimento
  FOR EACH STATEMENT EXECUTE FUNCTION proteger_solicitacoes_autoatendimento();
