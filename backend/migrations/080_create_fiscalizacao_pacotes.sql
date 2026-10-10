-- fiscalizacao_pacotes: histórico imutável dos pacotes de documentação gerados em Relatórios > Fiscalização (12K-D6).
--
-- O ZIP NÃO fica no banco: o arquivo mora no armazenamento (hoje disco local, amanhã S3) e aqui ficam só os metadados, o
-- SHA-256 do ZIP completo e a chave de armazenamento, que o servidor gera (nunca o cliente).
--
-- CICLO: GERANDO -> CONCLUIDO | FALHA. CONCLUIDO e FALHA são finais e imutáveis: nenhuma coluna muda, DELETE e TRUNCATE são
-- bloqueados. Refazer um pacote é criar OUTRO (nova chave de idempotência), nunca regravar o anterior. Enquanto GERANDO, só
-- heartbeat_em pode mudar (a geração ativa o renova; a recuperação de geração abandonada usa a idade dele, não criado_em)
-- e a linha pode passar a CONCLUIDO ou FALHA. A identidade do pedido (empresa, período, finalidade, observação, escopos,
-- usuário, perfil, chave e hash da requisição, versão do formato) nunca muda.
--
-- IDEMPOTÊNCIA: UNIQUE (empresa_id, chave_idempotencia) identifica UMA tentativa por empresa; requisicao_hash é o hash
-- canônico do pedido e diz se a repetição da chave é o mesmo pedido (devolve a tentativa existente, em qualquer estado) ou
-- outro (409). Uma tentativa FALHA nunca é reiniciada com a mesma chave.
--
-- CONCORRÊNCIA: o índice único parcial admite uma única linha GERANDO por empresa; empresas diferentes geram em paralelo.
--
-- ESCOPOS: lista JSONB de códigos dos módulos escolhidos. A estrutura é conferida (lista de 1 a 20 códigos distintos, cada
-- um no formato de código composto em maiúsculas), sem listar aqui os módulos atuais: um módulo novo não exige migration. A
-- lista permitida é do serviço, e o pacote antigo preserva exatamente os módulos do momento em que foi gerado.
--
-- SEM FK para perfis: perfil_ator é o perfil que o usuário tinha ao gerar (snapshot), no mesmo desenho da 079.

CREATE FUNCTION fiscalizacao_escopos_validos(escopos JSONB) RETURNS BOOLEAN AS $$
  SELECT jsonb_typeof(escopos) = 'array'
     AND jsonb_array_length(escopos) BETWEEN 1 AND 20
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(escopos) AS e(valor)
        WHERE jsonb_typeof(e.valor) <> 'string'
           OR (e.valor #>> '{}') !~ '^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$'
           OR char_length(e.valor #>> '{}') > 60
     )
     AND (SELECT count(DISTINCT e.valor) FROM jsonb_array_elements(escopos) AS e(valor)) = jsonb_array_length(escopos);
$$ LANGUAGE sql IMMUTABLE;

CREATE TABLE fiscalizacao_pacotes (
  id                   INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  empresa_id           INTEGER NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  periodo_inicio       DATE NOT NULL,
  periodo_fim          DATE NOT NULL,
  finalidade           VARCHAR(40) NOT NULL,
  observacao           VARCHAR(500),
  escopos              JSONB NOT NULL,
  versao_formato       SMALLINT NOT NULL,
  usuario_id           INTEGER NOT NULL,
  perfil_ator          VARCHAR(20) NOT NULL,
  criado_em            TIMESTAMPTZ NOT NULL DEFAULT now(),
  status               VARCHAR(10) NOT NULL,
  heartbeat_em         TIMESTAMPTZ NOT NULL DEFAULT now(),
  concluido_em         TIMESTAMPTZ,
  erro_codigo          VARCHAR(60),
  contagens            JSONB,
  nome_logico          VARCHAR(120),
  tamanho_bytes        BIGINT,
  sha256               CHAR(64),
  chave_armazenamento  VARCHAR(80),
  chave_idempotencia   VARCHAR(128) NOT NULL,
  requisicao_hash      CHAR(64) NOT NULL,
  CONSTRAINT uq_fiscalizacao_pacotes_empresa_chave UNIQUE (empresa_id, chave_idempotencia),
  CONSTRAINT fk_fiscalizacao_pacotes_usuario_mesma_empresa
    FOREIGN KEY (empresa_id, usuario_id) REFERENCES usuarios (empresa_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_fiscalizacao_pacotes_periodo CHECK (periodo_fim >= periodo_inicio AND periodo_fim - periodo_inicio <= 365),
  CONSTRAINT chk_fiscalizacao_pacotes_finalidade
    CHECK (finalidade IN ('FISCALIZACAO_TRABALHO', 'AUDITORIA_CLIENTE', 'AUDITORIA_INTERNA', 'SOLICITACAO_JURIDICA_DOCUMENTAL', 'OUTRA')),
  CONSTRAINT chk_fiscalizacao_pacotes_observacao
    CHECK ((observacao IS NULL OR btrim(observacao) <> '') AND (finalidade <> 'OUTRA' OR observacao IS NOT NULL)),
  CONSTRAINT chk_fiscalizacao_pacotes_escopos CHECK (fiscalizacao_escopos_validos(escopos)),
  CONSTRAINT chk_fiscalizacao_pacotes_versao CHECK (versao_formato >= 1),
  CONSTRAINT chk_fiscalizacao_pacotes_perfil CHECK (perfil_ator ~ '^[A-Z][A-Z0-9_]{0,19}$'),
  CONSTRAINT chk_fiscalizacao_pacotes_chave CHECK (chave_idempotencia ~ '^[A-Za-z0-9_-]{8,128}$'),
  CONSTRAINT chk_fiscalizacao_pacotes_hash_requisicao CHECK (requisicao_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_fiscalizacao_pacotes_status CHECK (status IN ('GERANDO', 'CONCLUIDO', 'FALHA')),
  CONSTRAINT chk_fiscalizacao_pacotes_erro_codigo CHECK (erro_codigo IS NULL OR erro_codigo ~ '^[A-Z][A-Z0-9_]{0,59}$'),
  CONSTRAINT chk_fiscalizacao_pacotes_sha256 CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_fiscalizacao_pacotes_chave_armazenamento
    CHECK (chave_armazenamento IS NULL OR chave_armazenamento ~ '^[1-9][0-9]{0,14}/pacote-[1-9][0-9]{0,14}\.zip$'),
  CONSTRAINT chk_fiscalizacao_pacotes_nome_logico CHECK (nome_logico IS NULL OR nome_logico ~ '^[A-Za-z0-9._-]{1,120}$'),
  CONSTRAINT chk_fiscalizacao_pacotes_estado CHECK (
    CASE status
      WHEN 'GERANDO' THEN concluido_em IS NULL AND erro_codigo IS NULL AND contagens IS NULL AND nome_logico IS NULL
                          AND tamanho_bytes IS NULL AND sha256 IS NULL AND chave_armazenamento IS NULL
      WHEN 'CONCLUIDO' THEN concluido_em IS NOT NULL AND erro_codigo IS NULL AND contagens IS NOT NULL AND nome_logico IS NOT NULL
                            AND tamanho_bytes IS NOT NULL
                            AND tamanho_bytes > 0
                            AND sha256 IS NOT NULL AND chave_armazenamento IS NOT NULL
      WHEN 'FALHA' THEN concluido_em IS NOT NULL AND erro_codigo IS NOT NULL AND contagens IS NULL AND nome_logico IS NULL
                        AND tamanho_bytes IS NULL AND sha256 IS NULL AND chave_armazenamento IS NULL
    END)
);

-- Uma geração em andamento por empresa; empresas diferentes geram em paralelo. FALHA e CONCLUIDO convivem sem limite.
CREATE UNIQUE INDEX uq_fiscalizacao_pacotes_gerando_por_empresa ON fiscalizacao_pacotes (empresa_id) WHERE status = 'GERANDO';

-- Histórico da empresa, do mais recente ao mais antigo.
CREATE INDEX idx_fiscalizacao_pacotes_empresa_criado_em ON fiscalizacao_pacotes (empresa_id, criado_em DESC, id DESC);

-- Recuperação de geração abandonada: só as linhas GERANDO, pela idade do heartbeat.
CREATE INDEX idx_fiscalizacao_pacotes_gerando_heartbeat ON fiscalizacao_pacotes (heartbeat_em) WHERE status = 'GERANDO';

CREATE FUNCTION proteger_fiscalizacao_pacotes() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'pacote de fiscalização é imutável: exclusão não permitida';
  END IF;
  IF OLD.status <> 'GERANDO' THEN
    RAISE EXCEPTION 'pacote de fiscalização em estado final é imutável: alteração não permitida';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.empresa_id IS DISTINCT FROM OLD.empresa_id
     OR NEW.periodo_inicio IS DISTINCT FROM OLD.periodo_inicio
     OR NEW.periodo_fim IS DISTINCT FROM OLD.periodo_fim
     OR NEW.finalidade IS DISTINCT FROM OLD.finalidade
     OR NEW.observacao IS DISTINCT FROM OLD.observacao
     OR NEW.escopos IS DISTINCT FROM OLD.escopos
     OR NEW.versao_formato IS DISTINCT FROM OLD.versao_formato
     OR NEW.usuario_id IS DISTINCT FROM OLD.usuario_id
     OR NEW.perfil_ator IS DISTINCT FROM OLD.perfil_ator
     OR NEW.criado_em IS DISTINCT FROM OLD.criado_em
     OR NEW.chave_idempotencia IS DISTINCT FROM OLD.chave_idempotencia
     OR NEW.requisicao_hash IS DISTINCT FROM OLD.requisicao_hash THEN
    RAISE EXCEPTION 'pacote de fiscalização: a identidade do pedido não pode ser alterada';
  END IF;
  IF NEW.status = 'GERANDO' THEN
    IF NEW.concluido_em IS NOT NULL OR NEW.erro_codigo IS NOT NULL OR NEW.contagens IS NOT NULL OR NEW.nome_logico IS NOT NULL
       OR NEW.tamanho_bytes IS NOT NULL OR NEW.sha256 IS NOT NULL OR NEW.chave_armazenamento IS NOT NULL THEN
      RAISE EXCEPTION 'pacote de fiscalização em geração: só o heartbeat pode ser alterado';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION bloquear_truncate_fiscalizacao_pacotes() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'pacote de fiscalização é imutável: TRUNCATE não permitido';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_fiscalizacao_pacotes_proteger_update
  BEFORE UPDATE ON fiscalizacao_pacotes FOR EACH ROW EXECUTE FUNCTION proteger_fiscalizacao_pacotes();
CREATE TRIGGER trg_fiscalizacao_pacotes_bloquear_delete
  BEFORE DELETE ON fiscalizacao_pacotes FOR EACH ROW EXECUTE FUNCTION proteger_fiscalizacao_pacotes();
CREATE TRIGGER trg_fiscalizacao_pacotes_bloquear_truncate
  BEFORE TRUNCATE ON fiscalizacao_pacotes FOR EACH STATEMENT EXECUTE FUNCTION bloquear_truncate_fiscalizacao_pacotes();

COMMENT ON TABLE fiscalizacao_pacotes IS
  'Pacotes de fiscalização (12K-D6). Estados finais imutáveis; o ZIP fica no armazenamento, aqui só metadados, SHA-256 e a chave gerada pelo servidor.';
