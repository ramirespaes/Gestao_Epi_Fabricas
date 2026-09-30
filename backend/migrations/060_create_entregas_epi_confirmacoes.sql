-- Confirmação de recebimento da entrega de EPI.
--
-- Exatamente uma por entrega (a PK é o id da entrega). Dois modos: DESENHO,
-- com os traços da assinatura em JSON, e ACEITE_PRESENCIAL, confirmação na
-- presença do responsável, sem traços. Não existe biometria.
--
-- A confirmação fecha a composição da entrega: só entra depois do primeiro
-- item, nenhum item entra depois dela, e a entrega sem confirmação não passa
-- do COMMIT. Com as tabelas só aceitando INSERT, uma entrega gravada está
-- fechada para sempre.
--
-- declaracao_versao identifica a declaração apresentada; declaracao_texto
-- guarda o texto exato que o trabalhador confirmou, para o documento
-- histórico continuar demonstrável mesmo que o texto padrão mude depois.
--
-- hash_conteudo é um checksum SHA-256 do conteúdo da entrega (inclusive
-- declaracao_texto), calculado pela aplicação sobre um JSON canônico que
-- exclui este próprio campo. Detecta
-- corrupção acidental e alteração fora do fluxo; não é assinatura
-- criptográfica e não protege contra quem pode reescrever o banco. As
-- proteções reais continuam sendo o histórico só com INSERT, as FKs
-- compostas, a conferência no COMMIT, a autorização e a auditoria.

CREATE TABLE entregas_epi_confirmacoes (
  entrega_id         INTEGER PRIMARY KEY,
  empresa_id         INTEGER NOT NULL,
  modo               VARCHAR(20) NOT NULL,
  tracos             JSONB,
  declaracao_versao  VARCHAR(30) NOT NULL,
  declaracao_texto   TEXT NOT NULL,
  confirmada_em      TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip                 VARCHAR(45),
  dispositivo        VARCHAR(150),
  hash_conteudo      CHAR(64) NOT NULL,
  CONSTRAINT fk_entregas_epi_confirmacoes_entrega_mesma_empresa
    FOREIGN KEY (empresa_id, entrega_id)
    REFERENCES entregas_epi (empresa_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT chk_entregas_epi_confirmacoes_modo CHECK (modo IN ('DESENHO', 'ACEITE_PRESENCIAL')),
  CONSTRAINT chk_entregas_epi_confirmacoes_tracos_por_modo CHECK ((modo = 'DESENHO') = (tracos IS NOT NULL)),
  -- Lista de traços, não vazia, dentro de um limite que cabe no corpo de 32 KiB da API.
  CONSTRAINT chk_entregas_epi_confirmacoes_tracos_formato
    CHECK (tracos IS NULL
           OR (jsonb_typeof(tracos) = 'array' AND jsonb_array_length(tracos) > 0 AND octet_length(tracos::text) <= 24576)),
  CONSTRAINT chk_entregas_epi_confirmacoes_declaracao_versao CHECK (declaracao_versao ~ '^[A-Z0-9][A-Z0-9._-]{0,29}$'),
  -- Aparado de espaço, tabulação e quebra de linha nas pontas; quebras internas são texto.
  CONSTRAINT chk_entregas_epi_confirmacoes_declaracao_texto
    CHECK (btrim(declaracao_texto, E' \t\r\n') = declaracao_texto AND char_length(declaracao_texto) BETWEEN 1 AND 4000),
  CONSTRAINT chk_entregas_epi_confirmacoes_hash_conteudo CHECK (hash_conteudo ~ '^[0-9a-f]{64}$')
);

COMMENT ON COLUMN entregas_epi_confirmacoes.declaracao_texto IS
  'Texto exato da declaração apresentada e confirmada pelo trabalhador; cópia histórica imutável.';
COMMENT ON COLUMN entregas_epi_confirmacoes.hash_conteudo IS
  'Checksum SHA-256 do conteúdo da entrega (inclusive declaracao_texto), calculado pela aplicação sobre um JSON canônico que exclui este campo. Não é assinatura criptográfica.';

CREATE TRIGGER trg_entregas_epi_confirmacoes_bloquear_update
  BEFORE UPDATE ON entregas_epi_confirmacoes
  FOR EACH ROW EXECUTE FUNCTION bloquear_alteracao_historico_entrega_epi();

CREATE TRIGGER trg_entregas_epi_confirmacoes_bloquear_delete
  BEFORE DELETE ON entregas_epi_confirmacoes
  FOR EACH ROW EXECUTE FUNCTION bloquear_alteracao_historico_entrega_epi();

CREATE TRIGGER trg_entregas_epi_confirmacoes_bloquear_truncate
  BEFORE TRUNCATE ON entregas_epi_confirmacoes
  FOR EACH STATEMENT EXECUTE FUNCTION bloquear_alteracao_historico_entrega_epi();

-- A confirmação só entra depois do primeiro item.
CREATE FUNCTION exigir_item_antes_da_confirmacao_entrega_epi() RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM entregas_epi_itens WHERE empresa_id = NEW.empresa_id AND entrega_id = NEW.entrega_id
  ) THEN
    RAISE EXCEPTION 'a entrega % ainda não tem item: a confirmação fecha a composição', NEW.entrega_id
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'trg_entregas_epi_confirmacoes_exigir_item',
            TABLE = 'entregas_epi_confirmacoes';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_entregas_epi_confirmacoes_exigir_item
  BEFORE INSERT ON entregas_epi_confirmacoes
  FOR EACH ROW EXECUTE FUNCTION exigir_item_antes_da_confirmacao_entrega_epi();

-- Nenhum item entra depois da confirmação, nem na mesma transação.
CREATE FUNCTION bloquear_item_apos_confirmacao_entrega_epi() RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM entregas_epi_confirmacoes WHERE empresa_id = NEW.empresa_id AND entrega_id = NEW.entrega_id
  ) THEN
    RAISE EXCEPTION 'a entrega % já foi confirmada: não aceita novos itens', NEW.entrega_id
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'trg_entregas_epi_itens_bloquear_apos_confirmacao',
            TABLE = 'entregas_epi_itens';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_entregas_epi_itens_bloquear_apos_confirmacao
  BEFORE INSERT ON entregas_epi_itens
  FOR EACH ROW EXECUTE FUNCTION bloquear_item_apos_confirmacao_entrega_epi();

-- Confiro no COMMIT: entrega sem confirmação não existe. O nome vem depois
-- de trg_entregas_epi_exigir_item na ordem alfabética de propósito: os
-- gatilhos adiados da mesma linha disparam nessa ordem, então a falta de
-- item é apontada antes da falta de confirmação.
CREATE FUNCTION exigir_confirmacao_da_entrega_epi() RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM entregas_epi_confirmacoes WHERE empresa_id = NEW.empresa_id AND entrega_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'a entrega % precisa da confirmação de recebimento na mesma transação', NEW.id
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'trg_entregas_epi_fechar_com_confirmacao',
            TABLE = 'entregas_epi';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_entregas_epi_fechar_com_confirmacao
  AFTER INSERT ON entregas_epi
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION exigir_confirmacao_da_entrega_epi();
