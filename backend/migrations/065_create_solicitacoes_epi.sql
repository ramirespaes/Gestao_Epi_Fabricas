-- Solicitação de EPI.
--
-- Cabeçalho (solicitacoes_epi), itens (solicitacoes_epi_itens) e contador da
-- numeração por empresa. Aprovar uma solicitação cria um compromisso, não
-- uma saída: a reserva de estoque é lógica e derivada por empresa, material e
-- tamanho, a partir da quantidade aprovada. Nenhuma alocação, contador de
-- reserva ou quantidade entregue é gravado aqui, e o lote só é baixado na
-- entrega (058 e 059).
--
-- O cabeçalho tem ciclo de vida controlado: PENDENTE vai para APROVADA,
-- APROVADA_PARCIAL, REPROVADA ou CANCELADA; APROVADA e APROVADA_PARCIAL vão
-- para ENTREGUE, estado que só a integração com a entrega vai usar. A decisão
-- é por item, gravada uma vez, e o cabeçalho precisa bater com os itens no
-- COMMIT: não existe decisão em duas chamadas. O pedido de cada item e a
-- identidade do cabeçalho não mudam depois da criação, e o conjunto de itens
-- fica selado em quantidade_itens. O limite de 20 itens, quem pode decidir e
-- quem pode cancelar são regras do serviço.
--
-- origem_solicitacao separa o usuário interno do autoatendimento, que não tem
-- usuário solicitante. Só USUARIO_INTERNO é usado por enquanto.

-- Contador por empresa, no mesmo padrão da ficha (058): o serviço avança com
-- INSERT ... ON CONFLICT (empresa_id) DO UPDATE SET ultimo_numero = ultimo_numero + 1
-- dentro da transação da solicitação, e o ROLLBACK desfaz o incremento.
CREATE TABLE solicitacoes_epi_numeracao (
  empresa_id     INTEGER PRIMARY KEY REFERENCES empresas(id) ON DELETE RESTRICT,
  ultimo_numero  INTEGER NOT NULL,
  CONSTRAINT chk_solicitacoes_epi_numeracao_ultimo_numero CHECK (ultimo_numero > 0)
);

CREATE FUNCTION proteger_solicitacoes_epi_numeracao() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.ultimo_numero <> 1 THEN
      RAISE EXCEPTION 'solicitacoes_epi_numeracao nasce em 1 (empresa %: recebeu %)', NEW.empresa_id, NEW.ultimo_numero;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'solicitacoes_epi_numeracao não aceita %: o contador da empresa não pode sumir', TG_OP;
  END IF;
  IF NEW.empresa_id <> OLD.empresa_id OR NEW.ultimo_numero <> OLD.ultimo_numero + 1 THEN
    RAISE EXCEPTION 'solicitacoes_epi_numeracao só avança de um em um (empresa %: % para %)',
      OLD.empresa_id, OLD.ultimo_numero, NEW.ultimo_numero;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_solicitacoes_epi_numeracao_iniciar_em_um
  BEFORE INSERT ON solicitacoes_epi_numeracao
  FOR EACH ROW EXECUTE FUNCTION proteger_solicitacoes_epi_numeracao();

CREATE TRIGGER trg_solicitacoes_epi_numeracao_proteger_update
  BEFORE UPDATE ON solicitacoes_epi_numeracao
  FOR EACH ROW EXECUTE FUNCTION proteger_solicitacoes_epi_numeracao();

CREATE TRIGGER trg_solicitacoes_epi_numeracao_bloquear_delete
  BEFORE DELETE ON solicitacoes_epi_numeracao
  FOR EACH ROW EXECUTE FUNCTION proteger_solicitacoes_epi_numeracao();

CREATE TRIGGER trg_solicitacoes_epi_numeracao_bloquear_truncate
  BEFORE TRUNCATE ON solicitacoes_epi_numeracao
  FOR EACH STATEMENT EXECUTE FUNCTION proteger_solicitacoes_epi_numeracao();

CREATE TABLE solicitacoes_epi (
  id                          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  empresa_id                  INTEGER NOT NULL,
  numero                      INTEGER NOT NULL,
  funcionario_id              INTEGER NOT NULL,
  -- GHE do trabalhador na criação; informativo, não é cópia congelada do documento.
  ghe_id                      INTEGER,
  origem_solicitacao          VARCHAR(20) NOT NULL,
  solicitante_usuario_id      INTEGER,
  status                      VARCHAR(20) NOT NULL DEFAULT 'PENDENTE',
  -- Itens selados na criação: o COMMIT confere que existem exatamente estes.
  quantidade_itens            INTEGER NOT NULL,
  observacao                  TEXT,
  chave_idempotencia          UUID NOT NULL,
  requisicao_hash             CHAR(64) NOT NULL,
  criada_em                   TIMESTAMPTZ NOT NULL DEFAULT now(),
  decidida_por                INTEGER,
  decidida_em                 TIMESTAMPTZ,
  cancelada_por               INTEGER,
  cancelada_em                TIMESTAMPTZ,
  justificativa_cancelamento  TEXT,
  entregue_em                 TIMESTAMPTZ,
  CONSTRAINT uq_solicitacoes_epi_empresa_id UNIQUE (empresa_id, id),
  CONSTRAINT uq_solicitacoes_epi_empresa_numero UNIQUE (empresa_id, numero),
  CONSTRAINT uq_solicitacoes_epi_idempotencia UNIQUE (empresa_id, chave_idempotencia),
  CONSTRAINT fk_solicitacoes_epi_funcionario_mesma_empresa
    FOREIGN KEY (empresa_id, funcionario_id)
    REFERENCES funcionarios (empresa_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_solicitacoes_epi_ghe_mesma_empresa
    FOREIGN KEY (empresa_id, ghe_id)
    REFERENCES grupos_homogeneos_exposicao (empresa_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_solicitacoes_epi_solicitante_mesma_empresa
    FOREIGN KEY (empresa_id, solicitante_usuario_id)
    REFERENCES usuarios (empresa_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_solicitacoes_epi_decisor_mesma_empresa
    FOREIGN KEY (empresa_id, decidida_por)
    REFERENCES usuarios (empresa_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_solicitacoes_epi_cancelador_mesma_empresa
    FOREIGN KEY (empresa_id, cancelada_por)
    REFERENCES usuarios (empresa_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT chk_solicitacoes_epi_numero CHECK (numero > 0),
  CONSTRAINT chk_solicitacoes_epi_origem CHECK (origem_solicitacao IN ('USUARIO_INTERNO', 'AUTOATENDIMENTO')),
  -- Só o usuário interno tem solicitante; o autoatendimento não usa a coluna.
  CONSTRAINT chk_solicitacoes_epi_origem_solicitante
    CHECK ((origem_solicitacao = 'USUARIO_INTERNO') = (solicitante_usuario_id IS NOT NULL)),
  CONSTRAINT chk_solicitacoes_epi_status
    CHECK (status IN ('PENDENTE', 'APROVADA', 'APROVADA_PARCIAL', 'REPROVADA', 'CANCELADA', 'ENTREGUE')),
  CONSTRAINT chk_solicitacoes_epi_quantidade_itens CHECK (quantidade_itens > 0),
  CONSTRAINT chk_solicitacoes_epi_requisicao_hash CHECK (requisicao_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_solicitacoes_epi_observacao
    CHECK (observacao IS NULL OR (btrim(observacao) = observacao AND char_length(observacao) BETWEEN 1 AND 500)),
  CONSTRAINT chk_solicitacoes_epi_decisao CHECK (
    (decidida_por IS NULL) = (decidida_em IS NULL)
    AND (status IN ('APROVADA', 'APROVADA_PARCIAL', 'REPROVADA', 'ENTREGUE')) = (decidida_em IS NOT NULL)),
  CONSTRAINT chk_solicitacoes_epi_cancelamento CHECK (
    (cancelada_por IS NULL) = (cancelada_em IS NULL)
    AND (status = 'CANCELADA') = (cancelada_em IS NOT NULL)
    AND (justificativa_cancelamento IS NULL
         OR (status = 'CANCELADA' AND btrim(justificativa_cancelamento) = justificativa_cancelamento
             AND char_length(justificativa_cancelamento) BETWEEN 1 AND 500))),
  CONSTRAINT chk_solicitacoes_epi_entrega CHECK ((status = 'ENTREGUE') = (entregue_em IS NOT NULL)),
  -- Quem pediu não decide o próprio pedido. A mesma regra está no serviço, que
  -- responde antes; esta é a última barreira.
  CONSTRAINT chk_solicitacoes_epi_decisor_diferente_do_solicitante
    CHECK (solicitante_usuario_id IS NULL OR decidida_por IS NULL OR decidida_por <> solicitante_usuario_id),
  -- Os carimbos de decisão, cancelamento e entrega são do relógio do banco
  -- (clock_timestamp), então a ordem vale mesmo quando uma transação espera pela outra.
  CONSTRAINT chk_solicitacoes_epi_ordem_dos_carimbos CHECK (
    (decidida_em IS NULL OR decidida_em >= criada_em)
    AND (cancelada_em IS NULL OR cancelada_em >= criada_em)
    AND (entregue_em IS NULL OR decidida_em IS NULL OR entregue_em >= decidida_em))
);

-- Fila de análise da Segurança do Trabalho (mais antigas primeiro).
CREATE INDEX idx_solicitacoes_epi_pendentes ON solicitacoes_epi (empresa_id, criada_em, id) WHERE status = 'PENDENTE';
-- Fila virtual do estoque: aprovadas ainda não entregues, em ordem de aprovação.
CREATE INDEX idx_solicitacoes_epi_aprovadas ON solicitacoes_epi (empresa_id, decidida_em, id)
  WHERE status IN ('APROVADA', 'APROVADA_PARCIAL');
-- Solicitações do trabalhador, das mais recentes para as antigas.
CREATE INDEX idx_solicitacoes_epi_funcionario ON solicitacoes_epi (empresa_id, funcionario_id, criada_em DESC, id DESC);

CREATE TABLE solicitacoes_epi_itens (
  id                     INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  empresa_id             INTEGER NOT NULL,
  solicitacao_id         INTEGER NOT NULL,
  material_id            INTEGER NOT NULL,
  -- Nulo quando o material não usa tamanho, como no lote; o estoque é por material e tamanho.
  tamanho                VARCHAR(20),
  quantidade             INTEGER NOT NULL,
  motivo                 VARCHAR(30) NOT NULL,
  justificativa          TEXT,
  -- false = fora da matriz do GHE do trabalhador na criação; a aprovação exige justificativa.
  previsto_no_ghe        BOOLEAN NOT NULL,
  decisao                VARCHAR(10),
  quantidade_aprovada    INTEGER,
  justificativa_decisao  TEXT,
  -- Lado referenciado da FK composta que a entrega por solicitação vai usar.
  CONSTRAINT uq_solicitacoes_epi_itens_empresa_id UNIQUE (empresa_id, id),
  CONSTRAINT fk_solicitacoes_epi_itens_solicitacao_mesma_empresa
    FOREIGN KEY (empresa_id, solicitacao_id)
    REFERENCES solicitacoes_epi (empresa_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_solicitacoes_epi_itens_material_mesma_empresa
    FOREIGN KEY (empresa_id, material_id)
    REFERENCES materiais (empresa_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT chk_solicitacoes_epi_itens_quantidade CHECK (quantidade > 0),
  CONSTRAINT chk_solicitacoes_epi_itens_tamanho
    CHECK (tamanho IS NULL OR (btrim(tamanho) = tamanho AND char_length(tamanho) > 0)),
  CONSTRAINT chk_solicitacoes_epi_itens_motivo
    CHECK (motivo IN ('ADMISSAO', 'SUBSTITUICAO_PRAZO', 'DESGASTE_DANO', 'PERDA_EXTRAVIO', 'OUTRO')),
  CONSTRAINT chk_solicitacoes_epi_itens_justificativa
    CHECK (justificativa IS NULL OR (btrim(justificativa) = justificativa AND char_length(justificativa) BETWEEN 1 AND 500)),
  CONSTRAINT chk_solicitacoes_epi_itens_outro_justificado
    CHECK (motivo <> 'OUTRO' OR justificativa IS NOT NULL),
  CONSTRAINT chk_solicitacoes_epi_itens_decisao CHECK (decisao IS NULL OR decisao IN ('APROVADO', 'REPROVADO')),
  -- Decisão e quantidade aprovada andam juntas; a justificativa só existe com decisão.
  CONSTRAINT chk_solicitacoes_epi_itens_decisao_completa CHECK (
    (decisao IS NULL) = (quantidade_aprovada IS NULL)
    AND (decisao IS NOT NULL OR justificativa_decisao IS NULL)),
  -- Aprovado: de 1 até o pedido. Reprovado: zero.
  CONSTRAINT chk_solicitacoes_epi_itens_quantidade_aprovada CHECK (
    (decisao IS DISTINCT FROM 'APROVADO' OR quantidade_aprovada BETWEEN 1 AND quantidade)
    AND (decisao IS DISTINCT FROM 'REPROVADO' OR quantidade_aprovada = 0)),
  CONSTRAINT chk_solicitacoes_epi_itens_justificativa_decisao CHECK (
    justificativa_decisao IS NULL
    OR (btrim(justificativa_decisao) = justificativa_decisao AND char_length(justificativa_decisao) BETWEEN 1 AND 500)),
  CONSTRAINT chk_solicitacoes_epi_itens_reprovado_justificado
    CHECK (decisao IS DISTINCT FROM 'REPROVADO' OR justificativa_decisao IS NOT NULL),
  CONSTRAINT chk_solicitacoes_epi_itens_reducao_justificada
    CHECK (decisao IS DISTINCT FROM 'APROVADO' OR quantidade_aprovada = quantidade OR justificativa_decisao IS NOT NULL),
  CONSTRAINT chk_solicitacoes_epi_itens_fora_do_ghe_justificado
    CHECK (decisao IS DISTINCT FROM 'APROVADO' OR previsto_no_ghe OR justificativa_decisao IS NOT NULL)
);

-- Um material e tamanho por solicitação; tamanho ausente conta como um valor só.
-- Índice por expressão: UNIQUE constraint não aceita COALESCE.
CREATE UNIQUE INDEX uq_solicitacoes_epi_itens_material_tamanho
  ON solicitacoes_epi_itens (solicitacao_id, material_id, COALESCE(tamanho, ''));

-- Demanda aprovada de um par (empresa, material, tamanho): a consulta que
-- soma o compromisso e monta a fila FIFO. O COALESCE é a forma canônica do
-- tamanho ausente, a mesma da trava do par e da comparação com os lotes;
-- como o CHECK recusa tamanho vazio, não colide com tamanho real.
CREATE INDEX idx_solicitacoes_epi_itens_demanda_par
  ON solicitacoes_epi_itens (empresa_id, material_id, COALESCE(tamanho, ''))
  WHERE decisao = 'APROVADO';

-- Cabeçalho: identidade imutável e transições legais. Nasce PENDENTE; DELETE
-- e TRUNCATE não existem. Os campos de decisão e cancelamento, uma vez
-- gravados, não mudam.
CREATE FUNCTION proteger_solicitacao_epi() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'PENDENTE' THEN
      RAISE EXCEPTION 'solicitacoes_epi nasce PENDENTE (recebeu %)', NEW.status;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'solicitacoes_epi não aceita %: a solicitação é histórico', TG_OP;
  END IF;
  IF (NEW.id, NEW.empresa_id, NEW.numero, NEW.funcionario_id, NEW.ghe_id, NEW.origem_solicitacao,
      NEW.solicitante_usuario_id, NEW.quantidade_itens, NEW.observacao, NEW.chave_idempotencia,
      NEW.requisicao_hash, NEW.criada_em)
     IS DISTINCT FROM
     (OLD.id, OLD.empresa_id, OLD.numero, OLD.funcionario_id, OLD.ghe_id, OLD.origem_solicitacao,
      OLD.solicitante_usuario_id, OLD.quantidade_itens, OLD.observacao, OLD.chave_idempotencia,
      OLD.requisicao_hash, OLD.criada_em) THEN
    RAISE EXCEPTION 'solicitacoes_epi: a identidade da solicitação % não pode ser alterada', OLD.id;
  END IF;
  IF NOT ((OLD.status = 'PENDENTE' AND NEW.status IN ('APROVADA', 'APROVADA_PARCIAL', 'REPROVADA', 'CANCELADA'))
          OR (OLD.status IN ('APROVADA', 'APROVADA_PARCIAL') AND NEW.status = 'ENTREGUE')) THEN
    RAISE EXCEPTION 'solicitacoes_epi: transição de % para % não é permitida (solicitação %)', OLD.status, NEW.status, OLD.id;
  END IF;
  IF OLD.status <> 'PENDENTE'
     AND (NEW.decidida_por, NEW.decidida_em, NEW.cancelada_por, NEW.cancelada_em, NEW.justificativa_cancelamento)
         IS DISTINCT FROM
         (OLD.decidida_por, OLD.decidida_em, OLD.cancelada_por, OLD.cancelada_em, OLD.justificativa_cancelamento) THEN
    RAISE EXCEPTION 'solicitacoes_epi: a decisão e o cancelamento já gravados da solicitação % não podem ser alterados', OLD.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_solicitacoes_epi_proteger
  BEFORE INSERT OR UPDATE OR DELETE ON solicitacoes_epi
  FOR EACH ROW EXECUTE FUNCTION proteger_solicitacao_epi();

CREATE TRIGGER trg_solicitacoes_epi_bloquear_truncate
  BEFORE TRUNCATE ON solicitacoes_epi
  FOR EACH STATEMENT EXECUTE FUNCTION proteger_solicitacao_epi();

-- Item: o pedido não muda; a decisão entra por UPDATE, uma única vez.
CREATE FUNCTION proteger_solicitacao_epi_item() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.decisao IS NOT NULL OR NEW.quantidade_aprovada IS NOT NULL OR NEW.justificativa_decisao IS NOT NULL THEN
      RAISE EXCEPTION 'solicitacoes_epi_itens nasce sem decisão: ela vem por UPDATE';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'solicitacoes_epi_itens não aceita %: o item é histórico', TG_OP;
  END IF;
  IF (NEW.id, NEW.empresa_id, NEW.solicitacao_id, NEW.material_id, NEW.tamanho, NEW.quantidade,
      NEW.motivo, NEW.justificativa, NEW.previsto_no_ghe)
     IS DISTINCT FROM
     (OLD.id, OLD.empresa_id, OLD.solicitacao_id, OLD.material_id, OLD.tamanho, OLD.quantidade,
      OLD.motivo, OLD.justificativa, OLD.previsto_no_ghe) THEN
    RAISE EXCEPTION 'solicitacoes_epi_itens: o pedido do item % não pode ser alterado', OLD.id;
  END IF;
  IF OLD.decisao IS NOT NULL THEN
    RAISE EXCEPTION 'solicitacoes_epi_itens: a decisão do item % é definitiva', OLD.id;
  END IF;
  IF NEW.decisao IS NULL THEN
    RAISE EXCEPTION 'solicitacoes_epi_itens: o UPDATE só registra a decisão do item %', OLD.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_solicitacoes_epi_itens_proteger
  BEFORE INSERT OR UPDATE OR DELETE ON solicitacoes_epi_itens
  FOR EACH ROW EXECUTE FUNCTION proteger_solicitacao_epi_item();

CREATE TRIGGER trg_solicitacoes_epi_itens_bloquear_truncate
  BEFORE TRUNCATE ON solicitacoes_epi_itens
  FOR EACH STATEMENT EXECUTE FUNCTION proteger_solicitacao_epi_item();

-- Conferências do COMMIT. Os dois gatilhos de cada regra, um no cabeçalho e
-- outro no item, chamam a mesma função; o erro leva o nome da regra, venha de
-- onde vier, como na 058.
CREATE FUNCTION exigir_itens_selados_da_solicitacao_epi() RETURNS TRIGGER AS $$
DECLARE
  v_solicitacao_id INTEGER;
  v_esperado INTEGER;
  v_existentes INTEGER;
BEGIN
  IF TG_TABLE_NAME = 'solicitacoes_epi' THEN
    v_solicitacao_id := NEW.id;
  ELSE
    v_solicitacao_id := NEW.solicitacao_id;
  END IF;
  SELECT quantidade_itens INTO v_esperado
    FROM solicitacoes_epi
   WHERE empresa_id = NEW.empresa_id AND id = v_solicitacao_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT count(*) INTO v_existentes
    FROM solicitacoes_epi_itens
   WHERE empresa_id = NEW.empresa_id AND solicitacao_id = v_solicitacao_id;
  IF v_existentes <> v_esperado THEN
    RAISE EXCEPTION 'a solicitação % declara % itens e tem %: os itens são gravados com o cabeçalho e não mudam depois',
        v_solicitacao_id, v_esperado, v_existentes
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'trg_solicitacoes_epi_exigir_item',
            TABLE = 'solicitacoes_epi';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_solicitacoes_epi_exigir_item
  AFTER INSERT ON solicitacoes_epi
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION exigir_itens_selados_da_solicitacao_epi();

CREATE CONSTRAINT TRIGGER trg_solicitacoes_epi_itens_exigir_item
  AFTER INSERT ON solicitacoes_epi_itens
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION exigir_itens_selados_da_solicitacao_epi();

-- O estado do cabeçalho bate com as decisões dos itens:
--   PENDENTE e CANCELADA: nenhum item decidido;
--   APROVADA: todos aprovados na quantidade pedida;
--   APROVADA_PARCIAL: todos decididos, ao menos um aprovado e ao menos um
--     reprovado ou com quantidade reduzida;
--   REPROVADA: todos reprovados;
--   ENTREGUE: todos decididos e ao menos um aprovado.
CREATE FUNCTION exigir_decisao_coerente_da_solicitacao_epi() RETURNS TRIGGER AS $$
DECLARE
  v_solicitacao_id INTEGER;
  v_status VARCHAR(20);
  v_total INTEGER;
  v_pendentes INTEGER;
  v_aprovados INTEGER;
  v_reprovados INTEGER;
  v_integrais INTEGER;
BEGIN
  IF TG_TABLE_NAME = 'solicitacoes_epi' THEN
    v_solicitacao_id := NEW.id;
  ELSE
    v_solicitacao_id := NEW.solicitacao_id;
  END IF;
  SELECT status INTO v_status
    FROM solicitacoes_epi
   WHERE empresa_id = NEW.empresa_id AND id = v_solicitacao_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT count(*),
         count(*) FILTER (WHERE decisao IS NULL),
         count(*) FILTER (WHERE decisao = 'APROVADO'),
         count(*) FILTER (WHERE decisao = 'REPROVADO'),
         count(*) FILTER (WHERE decisao = 'APROVADO' AND quantidade_aprovada = quantidade)
    INTO v_total, v_pendentes, v_aprovados, v_reprovados, v_integrais
    FROM solicitacoes_epi_itens
   WHERE empresa_id = NEW.empresa_id AND solicitacao_id = v_solicitacao_id;
  IF NOT (CASE v_status
            WHEN 'PENDENTE' THEN v_pendentes = v_total
            WHEN 'CANCELADA' THEN v_pendentes = v_total
            WHEN 'APROVADA' THEN v_integrais = v_total
            WHEN 'APROVADA_PARCIAL' THEN v_pendentes = 0 AND v_aprovados >= 1 AND v_integrais < v_total
            WHEN 'REPROVADA' THEN v_reprovados = v_total
            WHEN 'ENTREGUE' THEN v_pendentes = 0 AND v_aprovados >= 1
            ELSE false
          END) THEN
    RAISE EXCEPTION 'a solicitação % está % e as decisões dos itens não correspondem a esse estado', v_solicitacao_id, v_status
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'trg_solicitacoes_epi_coerencia_decisao',
            TABLE = 'solicitacoes_epi';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_solicitacoes_epi_coerencia_decisao
  AFTER UPDATE ON solicitacoes_epi
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION exigir_decisao_coerente_da_solicitacao_epi();

CREATE CONSTRAINT TRIGGER trg_solicitacoes_epi_itens_coerencia_decisao
  AFTER UPDATE ON solicitacoes_epi_itens
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION exigir_decisao_coerente_da_solicitacao_epi();
