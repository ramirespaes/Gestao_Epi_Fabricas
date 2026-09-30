-- Ficha de EPI e entrega.
--
-- A ficha é o registro cumulativo do trabalhador: uma por funcionário na
-- empresa, numerada em sequência por empresa. A entrega é um evento dentro
-- da ficha: N itens, cada um ligado a um lote, e uma confirmação de
-- recebimento (060). O documento impresso precisa refletir a época, então a
-- entrega guarda cópias dos dados da empresa, do trabalhador, do GHE e do
-- responsável, e o item guarda cópias do material. CPF não é copiado: fica
-- no cadastro e sai mascarado. Tamanho, CA e validade vêm do lote, que é
-- imutável (042).
--
-- Ficha, entrega e itens só aceitam INSERT. fichas_epi_numeracao é o
-- contador da numeração: aceita UPDATE, mas só o incremento de um em um.
-- O limite de 20 itens por entrega é regra do serviço, não do banco.

CREATE TABLE fichas_epi (
  id              INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  empresa_id      INTEGER NOT NULL,
  numero          INTEGER NOT NULL,
  funcionario_id  INTEGER NOT NULL,
  criada_em       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_fichas_epi_empresa_id UNIQUE (empresa_id, id),
  CONSTRAINT uq_fichas_epi_empresa_numero UNIQUE (empresa_id, numero),
  CONSTRAINT uq_fichas_epi_empresa_funcionario UNIQUE (empresa_id, funcionario_id),
  CONSTRAINT fk_fichas_epi_funcionario_mesma_empresa
    FOREIGN KEY (empresa_id, funcionario_id)
    REFERENCES funcionarios (empresa_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT chk_fichas_epi_numero CHECK (numero > 0)
);

-- Contador por empresa. O serviço avança com
-- INSERT ... ON CONFLICT (empresa_id) DO UPDATE SET ultimo_numero = ultimo_numero + 1
-- dentro da transação da ficha: a linha fica travada até o COMMIT e o
-- ROLLBACK desfaz o incremento, sem lacuna.
CREATE TABLE fichas_epi_numeracao (
  empresa_id     INTEGER PRIMARY KEY REFERENCES empresas(id) ON DELETE RESTRICT,
  ultimo_numero  INTEGER NOT NULL,
  CONSTRAINT chk_fichas_epi_numeracao_ultimo_numero CHECK (ultimo_numero > 0)
);

-- O contador nasce em 1 e só avança de um em um, na mesma empresa. Não
-- começa adiantado, não volta, não salta, não some.
CREATE FUNCTION proteger_fichas_epi_numeracao() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.ultimo_numero <> 1 THEN
      RAISE EXCEPTION 'fichas_epi_numeracao nasce em 1 (empresa %: recebeu %)', NEW.empresa_id, NEW.ultimo_numero;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'fichas_epi_numeracao não aceita %: o contador da empresa não pode sumir', TG_OP;
  END IF;
  IF NEW.empresa_id <> OLD.empresa_id OR NEW.ultimo_numero <> OLD.ultimo_numero + 1 THEN
    RAISE EXCEPTION 'fichas_epi_numeracao só avança de um em um (empresa %: % para %)',
      OLD.empresa_id, OLD.ultimo_numero, NEW.ultimo_numero;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_fichas_epi_numeracao_iniciar_em_um
  BEFORE INSERT ON fichas_epi_numeracao
  FOR EACH ROW EXECUTE FUNCTION proteger_fichas_epi_numeracao();

CREATE TRIGGER trg_fichas_epi_numeracao_proteger_update
  BEFORE UPDATE ON fichas_epi_numeracao
  FOR EACH ROW EXECUTE FUNCTION proteger_fichas_epi_numeracao();

CREATE TRIGGER trg_fichas_epi_numeracao_bloquear_delete
  BEFORE DELETE ON fichas_epi_numeracao
  FOR EACH ROW EXECUTE FUNCTION proteger_fichas_epi_numeracao();

CREATE TRIGGER trg_fichas_epi_numeracao_bloquear_truncate
  BEFORE TRUNCATE ON fichas_epi_numeracao
  FOR EACH STATEMENT EXECUTE FUNCTION proteger_fichas_epi_numeracao();

CREATE TABLE entregas_epi (
  id                     INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  empresa_id             INTEGER NOT NULL,
  ficha_id               INTEGER NOT NULL,
  responsavel_id         INTEGER NOT NULL,
  ghe_id                 INTEGER,
  -- Só DIRETA nesta versão; a origem por solicitação é etapa futura.
  origem                 VARCHAR(20) NOT NULL,
  entregue_em            TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Dia da entrega no fuso da operação; a validade de uso conta a partir dele.
  data_operacional       DATE NOT NULL DEFAULT (now() AT TIME ZONE 'America/Sao_Paulo')::date,
  -- Idempotência da requisição fica no cabeçalho; as operações dos itens não têm chave própria.
  chave_idempotencia     UUID NOT NULL,
  requisicao_hash        CHAR(64) NOT NULL,
  -- Cópias congeladas do documento.
  empresa_nome           VARCHAR(150) NOT NULL,
  empresa_cnpj           VARCHAR(14) NOT NULL,
  empresa_endereco       VARCHAR(500),
  empresa_cidade         VARCHAR(100),
  empresa_uf             CHAR(2),
  trabalhador_nome       VARCHAR(150) NOT NULL,
  trabalhador_matricula  VARCHAR(30) NOT NULL,
  trabalhador_funcao     VARCHAR(100),
  trabalhador_setor      VARCHAR(100),
  ghe_nome               VARCHAR(150),
  responsavel_nome       VARCHAR(150) NOT NULL,
  CONSTRAINT uq_entregas_epi_empresa_id UNIQUE (empresa_id, id),
  CONSTRAINT uq_entregas_epi_idempotencia UNIQUE (empresa_id, chave_idempotencia),
  CONSTRAINT fk_entregas_epi_ficha_mesma_empresa
    FOREIGN KEY (empresa_id, ficha_id)
    REFERENCES fichas_epi (empresa_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_entregas_epi_responsavel_mesma_empresa
    FOREIGN KEY (empresa_id, responsavel_id)
    REFERENCES usuarios (empresa_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_entregas_epi_ghe_mesma_empresa
    FOREIGN KEY (empresa_id, ghe_id)
    REFERENCES grupos_homogeneos_exposicao (empresa_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT chk_entregas_epi_origem CHECK (origem IN ('DIRETA')),
  CONSTRAINT chk_entregas_epi_requisicao_hash CHECK (requisicao_hash ~ '^[0-9a-f]{64}$'),
  -- Mesmo formato canônico da 016.
  CONSTRAINT chk_entregas_epi_empresa_cnpj CHECK (empresa_cnpj ~ '^[0-9A-Z]{12}[0-9]{2}$'),
  CONSTRAINT chk_entregas_epi_empresa_uf CHECK (empresa_uf IS NULL OR empresa_uf ~ '^[A-Z]{2}$'),
  CONSTRAINT chk_entregas_epi_ghe_nome CHECK ((ghe_id IS NULL) = (ghe_nome IS NULL)),
  CONSTRAINT chk_entregas_epi_snapshots_aparados CHECK (
    btrim(empresa_nome) = empresa_nome AND char_length(empresa_nome) > 0
    AND btrim(trabalhador_nome) = trabalhador_nome AND char_length(trabalhador_nome) > 0
    AND btrim(trabalhador_matricula) = trabalhador_matricula AND char_length(trabalhador_matricula) > 0
    AND btrim(responsavel_nome) = responsavel_nome AND char_length(responsavel_nome) > 0
    AND (empresa_endereco IS NULL OR (btrim(empresa_endereco) = empresa_endereco AND char_length(empresa_endereco) > 0))
    AND (empresa_cidade IS NULL OR (btrim(empresa_cidade) = empresa_cidade AND char_length(empresa_cidade) > 0))
    AND (trabalhador_funcao IS NULL OR (btrim(trabalhador_funcao) = trabalhador_funcao AND char_length(trabalhador_funcao) > 0))
    AND (trabalhador_setor IS NULL OR (btrim(trabalhador_setor) = trabalhador_setor AND char_length(trabalhador_setor) > 0))
    AND (ghe_nome IS NULL OR (btrim(ghe_nome) = ghe_nome AND char_length(ghe_nome) > 0))),
  -- Coerência entre os dois campos: o dia operacional é o dia de entregue_em
  -- em São Paulo. Que entregue_em venha do relógio do servidor, e não do
  -- cliente, é regra do serviço (10D/10E), não desta constraint.
  CONSTRAINT chk_entregas_epi_data_operacional
    CHECK (data_operacional = (entregue_em AT TIME ZONE 'America/Sao_Paulo')::date)
);

-- Ficha do trabalhador (entregas da ficha, das mais recentes para as antigas).
CREATE INDEX idx_entregas_epi_ficha ON entregas_epi (empresa_id, ficha_id, entregue_em DESC);
-- Listas da empresa (EPIs entregues, linha do tempo), das mais recentes para as antigas.
CREATE INDEX idx_entregas_epi_empresa_entregue_em ON entregas_epi (empresa_id, entregue_em DESC, id DESC);

CREATE TABLE entregas_epi_itens (
  id                        INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  empresa_id                INTEGER NOT NULL,
  entrega_id                INTEGER NOT NULL,
  material_id               INTEGER NOT NULL,
  lote_id                   INTEGER NOT NULL,
  quantidade                INTEGER NOT NULL,
  motivo                    VARCHAR(30) NOT NULL,
  justificativa             TEXT,
  -- false = EPI fora da matriz do GHE do trabalhador; exige justificativa própria.
  previsto_no_ghe           BOOLEAN NOT NULL,
  justificativa_fora_ghe    TEXT,
  -- Cópias congeladas do material.
  material_nome             VARCHAR(150) NOT NULL,
  material_tipo             VARCHAR(100),
  material_codigo_interno   VARCHAR(30),
  material_unidade          VARCHAR(20) NOT NULL,
  material_prazo_uso_dias   INTEGER NOT NULL,
  material_oculos_com_grau  BOOLEAN,
  material_exige_ca         BOOLEAN NOT NULL,
  -- Lado referenciado da FK da operação ENTREGA (059): mesma empresa, mesmo lote, mesma quantidade.
  CONSTRAINT uq_entregas_epi_itens_vinculo_operacao UNIQUE (empresa_id, id, lote_id, quantidade),
  CONSTRAINT uq_entregas_epi_itens_entrega_lote UNIQUE (entrega_id, lote_id),
  CONSTRAINT fk_entregas_epi_itens_entrega_mesma_empresa
    FOREIGN KEY (empresa_id, entrega_id)
    REFERENCES entregas_epi (empresa_id, id)
    ON DELETE RESTRICT,
  -- O lote é do material e da empresa declarados (chave criada na 057).
  CONSTRAINT fk_entregas_epi_itens_lote_do_material
    FOREIGN KEY (empresa_id, lote_id, material_id)
    REFERENCES estoque_lotes (empresa_id, id, material_id)
    ON DELETE RESTRICT,
  CONSTRAINT chk_entregas_epi_itens_quantidade CHECK (quantidade > 0),
  CONSTRAINT chk_entregas_epi_itens_motivo
    CHECK (motivo IN ('ADMISSAO', 'SUBSTITUICAO_PRAZO', 'DESGASTE_DANO', 'PERDA_EXTRAVIO', 'OUTRO')),
  CONSTRAINT chk_entregas_epi_itens_justificativa
    CHECK (justificativa IS NULL OR (btrim(justificativa) = justificativa AND char_length(justificativa) BETWEEN 1 AND 500)),
  CONSTRAINT chk_entregas_epi_itens_outro_justificado
    CHECK (motivo <> 'OUTRO' OR justificativa IS NOT NULL),
  CONSTRAINT chk_entregas_epi_itens_justificativa_fora_ghe
    CHECK (justificativa_fora_ghe IS NULL
           OR (btrim(justificativa_fora_ghe) = justificativa_fora_ghe AND char_length(justificativa_fora_ghe) BETWEEN 1 AND 500)),
  CONSTRAINT chk_entregas_epi_itens_fora_do_ghe CHECK (previsto_no_ghe = (justificativa_fora_ghe IS NULL)),
  -- Material sem prazo não é entregue (regra do serviço); a cópia é sempre positiva.
  CONSTRAINT chk_entregas_epi_itens_material_prazo CHECK (material_prazo_uso_dias > 0),
  -- Mesma regra da 045.
  CONSTRAINT chk_entregas_epi_itens_material_oculos
    CHECK (material_oculos_com_grau IS NULL OR (material_tipo IS NOT NULL AND material_tipo = 'Óculos de proteção')),
  CONSTRAINT chk_entregas_epi_itens_snapshots_aparados CHECK (
    btrim(material_nome) = material_nome AND char_length(material_nome) > 0
    AND btrim(material_unidade) = material_unidade AND char_length(material_unidade) > 0
    AND (material_tipo IS NULL OR (btrim(material_tipo) = material_tipo AND char_length(material_tipo) > 0))
    AND (material_codigo_interno IS NULL OR (btrim(material_codigo_interno) = material_codigo_interno AND char_length(material_codigo_interno) > 0)))
);

-- EPIs entregues por material (a busca por entrega usa uq_entregas_epi_itens_entrega_lote).
CREATE INDEX idx_entregas_epi_itens_material ON entregas_epi_itens (empresa_id, material_id);

-- Histórico: ficha, entrega e itens não mudam nem somem.
CREATE FUNCTION bloquear_alteracao_historico_entrega_epi() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION '% é histórico da entrega de EPI e só aceita INSERT: % não é permitido', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_fichas_epi_bloquear_update
  BEFORE UPDATE ON fichas_epi
  FOR EACH ROW EXECUTE FUNCTION bloquear_alteracao_historico_entrega_epi();

CREATE TRIGGER trg_fichas_epi_bloquear_delete
  BEFORE DELETE ON fichas_epi
  FOR EACH ROW EXECUTE FUNCTION bloquear_alteracao_historico_entrega_epi();

CREATE TRIGGER trg_fichas_epi_bloquear_truncate
  BEFORE TRUNCATE ON fichas_epi
  FOR EACH STATEMENT EXECUTE FUNCTION bloquear_alteracao_historico_entrega_epi();

CREATE TRIGGER trg_entregas_epi_bloquear_update
  BEFORE UPDATE ON entregas_epi
  FOR EACH ROW EXECUTE FUNCTION bloquear_alteracao_historico_entrega_epi();

CREATE TRIGGER trg_entregas_epi_bloquear_delete
  BEFORE DELETE ON entregas_epi
  FOR EACH ROW EXECUTE FUNCTION bloquear_alteracao_historico_entrega_epi();

CREATE TRIGGER trg_entregas_epi_bloquear_truncate
  BEFORE TRUNCATE ON entregas_epi
  FOR EACH STATEMENT EXECUTE FUNCTION bloquear_alteracao_historico_entrega_epi();

CREATE TRIGGER trg_entregas_epi_itens_bloquear_update
  BEFORE UPDATE ON entregas_epi_itens
  FOR EACH ROW EXECUTE FUNCTION bloquear_alteracao_historico_entrega_epi();

CREATE TRIGGER trg_entregas_epi_itens_bloquear_delete
  BEFORE DELETE ON entregas_epi_itens
  FOR EACH ROW EXECUTE FUNCTION bloquear_alteracao_historico_entrega_epi();

CREATE TRIGGER trg_entregas_epi_itens_bloquear_truncate
  BEFORE TRUNCATE ON entregas_epi_itens
  FOR EACH STATEMENT EXECUTE FUNCTION bloquear_alteracao_historico_entrega_epi();

-- Confiro no COMMIT: entrega sem item não existe. O erro sai como violação
-- de constraint com o nome do gatilho, como na 055.
CREATE FUNCTION exigir_item_da_entrega_epi() RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM entregas_epi_itens WHERE empresa_id = NEW.empresa_id AND entrega_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'a entrega % precisa de ao menos um item na mesma transação', NEW.id
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'trg_entregas_epi_exigir_item',
            TABLE = 'entregas_epi';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_entregas_epi_exigir_item
  AFTER INSERT ON entregas_epi
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION exigir_item_da_entrega_epi();
