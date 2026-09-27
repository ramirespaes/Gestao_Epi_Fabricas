-- Estoque por lote e histórico de operações.
--
-- Cada entrada física vira um lote com seu próprio CA e sua validade. Toda
-- movimentação fica em estoque_operacoes, que só aceita INSERT. O saldo do
-- lote é derivado (entrada − baixada − entregue): os contadores só mudam pelo
-- trigger que aplica a operação, e eu recuso qualquer atualização do lote que
-- não bata com a soma do histórico.
--
-- materiais.ca_numero e materiais.ca_validade ficam como estão, mas esta
-- estrutura não os usa. estoque_tamanhos não é alterada.

-- Material sem CA (uniforme, ferramenta) precisa ser explícito. O padrão é
-- exigir, inclusive nas linhas que já existem.
ALTER TABLE materiais
  ADD COLUMN exige_ca BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE estoque_lotes (
  id                   INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  empresa_id           INTEGER NOT NULL,
  material_id          INTEGER NOT NULL,
  tamanho              VARCHAR(20) NOT NULL,
  ca_numero            VARCHAR(20),
  ca_validade          DATE,
  -- SALDO_INICIAL é o saldo que veio de estoque_tamanhos; ENTRADA é a entrada operacional.
  origem               VARCHAR(20) NOT NULL,
  quantidade_entrada   INTEGER NOT NULL,
  quantidade_baixada   INTEGER NOT NULL DEFAULT 0,
  -- Reservado para a entrega ao funcionário; por enquanto nenhuma operação o altera.
  quantidade_entregue  INTEGER NOT NULL DEFAULT 0,
  saldo                INTEGER GENERATED ALWAYS AS (quantidade_entrada - quantidade_baixada - quantidade_entregue) STORED,
  criado_em            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_estoque_lotes_empresa_id UNIQUE (empresa_id, id),
  CONSTRAINT fk_estoque_lotes_material_mesma_empresa
    FOREIGN KEY (empresa_id, material_id)
    REFERENCES materiais (empresa_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT chk_estoque_lotes_tamanho
    CHECK (btrim(tamanho) = tamanho AND char_length(tamanho) > 0),
  CONSTRAINT chk_estoque_lotes_ca_numero
    CHECK (ca_numero IS NULL OR (btrim(ca_numero) = ca_numero AND char_length(ca_numero) > 0)),
  CONSTRAINT chk_estoque_lotes_ca_completo
    CHECK ((ca_numero IS NULL) = (ca_validade IS NULL)),
  CONSTRAINT chk_estoque_lotes_origem
    CHECK (origem IN ('SALDO_INICIAL', 'ENTRADA')),
  CONSTRAINT chk_estoque_lotes_quantidade_entrada
    CHECK (quantidade_entrada > 0),
  -- Escrito como subtração para não estourar INTEGER somando as duas saídas.
  CONSTRAINT chk_estoque_lotes_quantidades
    CHECK (quantidade_baixada >= 0 AND quantidade_entregue >= 0
           AND quantidade_baixada <= quantidade_entrada - quantidade_entregue)
);

-- Grade, saldos por material e tamanho, e busca da FK composta.
CREATE INDEX idx_estoque_lotes_material_tamanho ON estoque_lotes (empresa_id, material_id, tamanho);
-- Validade só interessa para lote com saldo.
CREATE INDEX idx_estoque_lotes_validade_com_saldo ON estoque_lotes (empresa_id, ca_validade) WHERE saldo > 0;

CREATE TABLE estoque_operacoes (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  empresa_id          INTEGER NOT NULL,
  lote_id             INTEGER NOT NULL,
  tipo                VARCHAR(20) NOT NULL,
  quantidade          INTEGER NOT NULL,
  motivo              VARCHAR(30),
  justificativa       TEXT,
  usuario_id          INTEGER,
  chave_idempotencia  UUID,
  requisicao_hash     CHAR(64),
  criado_em           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fk_estoque_operacoes_lote_mesma_empresa
    FOREIGN KEY (empresa_id, lote_id)
    REFERENCES estoque_lotes (empresa_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_estoque_operacoes_usuario_mesma_empresa
    FOREIGN KEY (empresa_id, usuario_id)
    REFERENCES usuarios (empresa_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT chk_estoque_operacoes_tipo
    CHECK (tipo IN ('SALDO_INICIAL', 'ENTRADA', 'BAIXA')),
  CONSTRAINT chk_estoque_operacoes_quantidade
    CHECK (quantidade > 0),
  CONSTRAINT chk_estoque_operacoes_motivo
    CHECK (motivo IS NULL OR motivo IN (
      'CA_VENCIDO', 'AVARIA', 'DESCARTE', 'PERDA', 'AJUSTE_INVENTARIO', 'DEVOLUCAO_FORNECEDOR', 'OUTRO')),
  CONSTRAINT chk_estoque_operacoes_motivo_da_baixa
    CHECK ((tipo = 'BAIXA') = (motivo IS NOT NULL)),
  CONSTRAINT chk_estoque_operacoes_justificativa
    CHECK (justificativa IS NULL
           OR (motivo IS NOT NULL AND btrim(justificativa) = justificativa AND char_length(justificativa) BETWEEN 1 AND 500)),
  CONSTRAINT chk_estoque_operacoes_outro_justificado
    CHECK (motivo IS DISTINCT FROM 'OUTRO' OR justificativa IS NOT NULL),
  -- Só o saldo migrado nasce sem usuário responsável.
  CONSTRAINT chk_estoque_operacoes_responsavel
    CHECK (tipo = 'SALDO_INICIAL' OR usuario_id IS NOT NULL),
  -- Toda operação feita pela API carrega a chave do cliente e o hash da requisição.
  CONSTRAINT chk_estoque_operacoes_idempotencia
    CHECK ((chave_idempotencia IS NULL) = (requisicao_hash IS NULL)
           AND (tipo = 'SALDO_INICIAL' OR chave_idempotencia IS NOT NULL)),
  CONSTRAINT chk_estoque_operacoes_requisicao_hash
    CHECK (requisicao_hash IS NULL OR requisicao_hash ~ '^[0-9a-f]{64}$')
);

-- A mesma chave vale uma única vez por empresa. O saldo migrado não tem chave.
CREATE UNIQUE INDEX uq_estoque_operacoes_idempotencia
  ON estoque_operacoes (empresa_id, chave_idempotencia)
  WHERE chave_idempotencia IS NOT NULL;
-- Cada lote tem exatamente uma operação de entrada.
CREATE UNIQUE INDEX uq_estoque_operacoes_entrada_do_lote
  ON estoque_operacoes (lote_id)
  WHERE tipo IN ('SALDO_INICIAL', 'ENTRADA');
-- Listagem de operações da empresa, das mais recentes para as mais antigas.
CREATE INDEX idx_estoque_operacoes_empresa_criado_em ON estoque_operacoes (empresa_id, criado_em DESC, id DESC);
-- Histórico do lote e soma usada na conferência dos contadores.
CREATE INDEX idx_estoque_operacoes_lote ON estoque_operacoes (empresa_id, lote_id);

-- Lote novo nasce zerado de saídas. Entrada operacional de material que exige
-- CA precisa de CA; a validade já vencida é regra do serviço, não do banco.
CREATE FUNCTION validar_novo_estoque_lote() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.quantidade_baixada <> 0 OR NEW.quantidade_entregue <> 0 THEN
    RAISE EXCEPTION 'lote novo não pode nascer com baixa ou entrega: elas vêm de estoque_operacoes';
  END IF;
  IF NEW.origem = 'ENTRADA' AND NEW.ca_numero IS NULL AND EXISTS (
    SELECT 1 FROM materiais WHERE empresa_id = NEW.empresa_id AND id = NEW.material_id AND exige_ca
  ) THEN
    RAISE EXCEPTION 'entrada de material que exige CA precisa de CA e validade';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_estoque_lotes_validar_insercao
  BEFORE INSERT ON estoque_lotes
  FOR EACH ROW EXECUTE FUNCTION validar_novo_estoque_lote();

-- A identidade e a entrada do lote não mudam. Os contadores só podem mudar
-- para o valor que a soma de estoque_operacoes justifica.
CREATE FUNCTION proteger_estoque_lote() RETURNS TRIGGER AS $$
DECLARE
  baixada BIGINT;
  entregue BIGINT;
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'estoque_lotes não aceita %: o lote faz parte do histórico', TG_OP;
  END IF;
  IF (NEW.id, NEW.empresa_id, NEW.material_id, NEW.tamanho, NEW.ca_numero, NEW.ca_validade,
      NEW.origem, NEW.quantidade_entrada, NEW.criado_em)
     IS DISTINCT FROM
     (OLD.id, OLD.empresa_id, OLD.material_id, OLD.tamanho, OLD.ca_numero, OLD.ca_validade,
      OLD.origem, OLD.quantidade_entrada, OLD.criado_em) THEN
    RAISE EXCEPTION 'a identidade e a entrada do lote % não podem ser alteradas', OLD.id;
  END IF;
  SELECT COALESCE(sum(quantidade) FILTER (WHERE tipo = 'BAIXA'), 0),
         COALESCE(sum(quantidade) FILTER (WHERE tipo = 'ENTREGA'), 0)
    INTO baixada, entregue
    FROM estoque_operacoes
   WHERE empresa_id = NEW.empresa_id AND lote_id = NEW.id;
  IF NEW.quantidade_baixada <> baixada OR NEW.quantidade_entregue <> entregue THEN
    RAISE EXCEPTION 'os contadores do lote % só mudam por operação registrada em estoque_operacoes', NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_estoque_lotes_proteger_update
  BEFORE UPDATE ON estoque_lotes
  FOR EACH ROW EXECUTE FUNCTION proteger_estoque_lote();

CREATE TRIGGER trg_estoque_lotes_bloquear_delete
  BEFORE DELETE ON estoque_lotes
  FOR EACH ROW EXECUTE FUNCTION proteger_estoque_lote();

CREATE TRIGGER trg_estoque_lotes_bloquear_truncate
  BEFORE TRUNCATE ON estoque_lotes
  FOR EACH STATEMENT EXECUTE FUNCTION proteger_estoque_lote();

-- Confiro no commit: lote sem a sua operação de entrada não existe.
CREATE FUNCTION exigir_operacao_de_entrada_do_lote() RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM estoque_operacoes
     WHERE empresa_id = NEW.empresa_id AND lote_id = NEW.id AND tipo = NEW.origem
  ) THEN
    RAISE EXCEPTION 'o lote % precisa da sua operação de entrada na mesma transação', NEW.id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_estoque_lotes_exigir_entrada
  AFTER INSERT ON estoque_lotes
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION exigir_operacao_de_entrada_do_lote();

-- Aplico a operação no lote. A trava do lote serializa operações simultâneas;
-- baixa acima do saldo cai em chk_estoque_lotes_quantidades.
CREATE FUNCTION aplicar_estoque_operacao() RETURNS TRIGGER AS $$
DECLARE
  lote estoque_lotes%ROWTYPE;
BEGIN
  SELECT * INTO lote FROM estoque_lotes
   WHERE empresa_id = NEW.empresa_id AND id = NEW.lote_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote % não encontrado nesta empresa', NEW.lote_id;
  END IF;

  IF NEW.tipo IN ('SALDO_INICIAL', 'ENTRADA') THEN
    IF lote.origem <> NEW.tipo OR lote.quantidade_entrada <> NEW.quantidade THEN
      RAISE EXCEPTION 'a operação de entrada precisa ter o tipo e a quantidade do lote %', NEW.lote_id;
    END IF;
  ELSIF NEW.tipo = 'BAIXA' THEN
    UPDATE estoque_lotes
       SET quantidade_baixada = quantidade_baixada + NEW.quantidade
     WHERE empresa_id = NEW.empresa_id AND id = NEW.lote_id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_estoque_operacoes_aplicar
  AFTER INSERT ON estoque_operacoes
  FOR EACH ROW EXECUTE FUNCTION aplicar_estoque_operacao();

CREATE FUNCTION bloquear_alteracao_estoque_operacoes() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'estoque_operacoes é append-only: operação % não é permitida', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_estoque_operacoes_bloquear_update
  BEFORE UPDATE ON estoque_operacoes
  FOR EACH ROW EXECUTE FUNCTION bloquear_alteracao_estoque_operacoes();

CREATE TRIGGER trg_estoque_operacoes_bloquear_delete
  BEFORE DELETE ON estoque_operacoes
  FOR EACH ROW EXECUTE FUNCTION bloquear_alteracao_estoque_operacoes();

CREATE TRIGGER trg_estoque_operacoes_bloquear_truncate
  BEFORE TRUNCATE ON estoque_operacoes
  FOR EACH STATEMENT EXECUTE FUNCTION bloquear_alteracao_estoque_operacoes();
