-- Biblioteca de Imagens de produto (Unidade 2): biblioteca padrão SafeWork, biblioteca privada por empresa, sugestões
-- imagem × NOME de tipo e vínculo opcional de UMA imagem em materiais.
--
-- ESTRITAMENTE ADITIVA. Nenhum INSERT, UPDATE, DELETE, TRUNCATE ou DROP: nenhum cadastro existente é movido ou alterado,
-- nenhum material ganha imagem (NULL = "sem imagem", e o pictograma atual continua), e as três tabelas nascem VAZIAS.
-- Históricos, estoque, entregas, solicitações, GHEs, funcionários e snapshots não são tocados. A importação das imagens
-- padrão e as sugestões aprovadas são etapas próprias, com autorização.
--
-- 1) imagens_padrao — biblioteca GLOBAL da SafeWork (sem empresa_id), somente leitura para as empresas clientes (a escrita é
--    do operador, por importação autorizada). Guarda a rastreabilidade do arquivo (nome de origem, SHA-256 do PNG padronizado
--    e da miniatura, hash do original só como referência e do pacote de origem). Lado de 256 a 4096 px. `ilustrativa`
--    alimenta a marca discreta de "imagem ilustrativa". A derivada de exibição (640) é prevista e pode ser gerada depois:
--    sha256_exibicao e bytes_exibicao são anuláveis. Imagem inativa (ativo = false) não recebe novas associações.
--
-- 2) imagens_empresa — biblioteca PRIVADA de cada empresa. ISOLAMENTO MULTIEMPRESA NO BANCO: UNIQUE (empresa_id, id) sustenta
--    a chave estrangeira composta de materiais, de modo que um material da empresa A nunca aponta para imagem da empresa B,
--    nem por SQL direto; o criador também é conferido por (empresa_id, criado_por). Deduplicação por (empresa_id, sha256),
--    inclusive da imagem inativa (reaproveita-se reativando). Lado de 320 a 4096 px. Registra o SHA-256 dos três arquivos
--    (mestre, exibição e miniatura). Imutável, exceto nome, estado, versão, inativada_em e atualizado_em. ON DELETE RESTRICT
--    para a empresa: empresas são inativadas, nunca apagadas, e imagem não some por cascata.
--
-- 3) imagens_padrao_tipos — sugestões visuais imagem × NOME do tipo (nunca identificador: o catálogo de tipos é por empresa).
--    Só recebe sugestão APROVADA: aprovado_por e aprovado_em são obrigatórios. O nível PRINCIPAL ou ALTERNATIVA só ordena o
--    destaque; várias imagens podem ser sugeridas para o mesmo tipo e nenhuma é escolhida pelo banco. ON DELETE CASCADE vale
--    SÓ aqui (sugestão depende da imagem padrão).
--
-- 4) materiais.imagem_padrao_id e materiais.imagem_empresa_id — no máximo UMA (CHECK), ambas anuláveis, sem valor padrão e
--    sem gatilho que escolha imagem. ON DELETE RESTRICT: imagem referenciada por material não é apagada. Várias linhas podem
--    compartilhar a mesma imagem. O gatilho trg_materiais_validar_imagem recusa associar imagem INATIVA (check_violation); só
--    confere quando a imagem MUDA, então o material mantém uma imagem que depois foi inativada. A leitura da imagem usa
--    FOR SHARE, na ordem global de travas (materiais antes de imagens), e se serializa com a inativação da imagem.
--
--    O banco NÃO impede inativar uma imagem em uso: o bloqueio (409 IMAGEM_EM_USO) é regra do serviço. Alteração direta no
--    banco que inative imagem em uso é risco registrado; o vínculo existente permanece íntegro.
--
--    Índices (parciais, só linhas com imagem): atendem a verificação do RESTRICT ao apagar imagem e a consulta "imagem em
--    uso". idx_imagens_padrao_tipos_nome atende a busca das candidatas por nome de tipo.
--
-- Erros dos gatilhos: check_violation (23514), com CONSTRAINT = nome do gatilho e TABLE = tabela.

CREATE TABLE imagens_padrao (
  id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nome                 VARCHAR(100) NOT NULL,
  arquivo_origem       VARCHAR(255) NOT NULL,
  sha256               CHAR(64) NOT NULL,
  sha256_miniatura     CHAR(64) NOT NULL,
  sha256_exibicao      CHAR(64),
  sha256_original_ref  CHAR(64),
  pacote_origem        VARCHAR(255),
  pacote_sha256        CHAR(64),
  formato              VARCHAR(5) NOT NULL,
  largura              INTEGER NOT NULL,
  altura               INTEGER NOT NULL,
  bytes_mestre         INTEGER NOT NULL,
  bytes_miniatura      INTEGER NOT NULL,
  bytes_exibicao       INTEGER,
  versao               INTEGER NOT NULL DEFAULT 1,
  ativo                BOOLEAN NOT NULL DEFAULT true,
  ilustrativa          BOOLEAN NOT NULL DEFAULT true,
  criado_em            TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_imagens_padrao_sha256 UNIQUE (sha256),
  CONSTRAINT chk_imagens_padrao_nome CHECK (btrim(nome) <> ''),
  CONSTRAINT chk_imagens_padrao_arquivo_origem CHECK (btrim(arquivo_origem) <> ''),
  CONSTRAINT chk_imagens_padrao_formato CHECK (formato IN ('PNG', 'JPEG', 'WEBP')),
  CONSTRAINT chk_imagens_padrao_medidas CHECK (largura BETWEEN 256 AND 4096 AND altura BETWEEN 256 AND 4096),
  CONSTRAINT chk_imagens_padrao_bytes CHECK (bytes_mestre > 0 AND bytes_miniatura > 0 AND (bytes_exibicao IS NULL OR bytes_exibicao > 0)),
  CONSTRAINT chk_imagens_padrao_versao CHECK (versao >= 1),
  CONSTRAINT chk_imagens_padrao_hashes CHECK (
    sha256 ~ '^[0-9a-f]{64}$'
    AND sha256_miniatura ~ '^[0-9a-f]{64}$'
    AND (sha256_exibicao IS NULL OR sha256_exibicao ~ '^[0-9a-f]{64}$')
    AND (sha256_original_ref IS NULL OR sha256_original_ref ~ '^[0-9a-f]{64}$')
    AND (pacote_sha256 IS NULL OR pacote_sha256 ~ '^[0-9a-f]{64}$'))
);

CREATE TRIGGER trg_imagens_padrao_atualizado_em
  BEFORE UPDATE ON imagens_padrao
  FOR EACH ROW EXECUTE FUNCTION set_atualizado_em();

CREATE TABLE imagens_empresa (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  empresa_id        INTEGER NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  nome              VARCHAR(100) NOT NULL,
  sha256            CHAR(64) NOT NULL,
  sha256_mestre     CHAR(64) NOT NULL,
  sha256_exibicao   CHAR(64) NOT NULL,
  sha256_miniatura  CHAR(64) NOT NULL,
  formato           VARCHAR(5) NOT NULL,
  largura           INTEGER NOT NULL,
  altura            INTEGER NOT NULL,
  bytes_mestre      INTEGER NOT NULL,
  bytes_exibicao    INTEGER NOT NULL,
  bytes_miniatura   INTEGER NOT NULL,
  versao            INTEGER NOT NULL DEFAULT 1,
  estado            VARCHAR(8) NOT NULL DEFAULT 'ATIVA',
  criado_por        INTEGER NOT NULL,
  criado_em         TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em     TIMESTAMPTZ NOT NULL DEFAULT now(),
  inativada_em      TIMESTAMPTZ,
  CONSTRAINT uq_imagens_empresa_id UNIQUE (empresa_id, id),
  CONSTRAINT uq_imagens_empresa_sha UNIQUE (empresa_id, sha256),
  CONSTRAINT chk_imagens_empresa_nome CHECK (btrim(nome) <> ''),
  CONSTRAINT chk_imagens_empresa_formato CHECK (formato IN ('PNG', 'JPEG', 'WEBP')),
  CONSTRAINT chk_imagens_empresa_medidas CHECK (largura BETWEEN 320 AND 4096 AND altura BETWEEN 320 AND 4096),
  CONSTRAINT chk_imagens_empresa_bytes CHECK (bytes_mestre > 0 AND bytes_exibicao > 0 AND bytes_miniatura > 0),
  CONSTRAINT chk_imagens_empresa_versao CHECK (versao >= 1),
  CONSTRAINT chk_imagens_empresa_estado CHECK (estado IN ('ATIVA', 'INATIVA')),
  CONSTRAINT chk_imagens_empresa_hashes CHECK (
    sha256 ~ '^[0-9a-f]{64}$'
    AND sha256_mestre ~ '^[0-9a-f]{64}$'
    AND sha256_exibicao ~ '^[0-9a-f]{64}$'
    AND sha256_miniatura ~ '^[0-9a-f]{64}$'),
  CONSTRAINT fk_imagens_empresa_criador_mesma_empresa
    FOREIGN KEY (empresa_id, criado_por) REFERENCES usuarios (empresa_id, id) ON DELETE RESTRICT
);

CREATE TRIGGER trg_imagens_empresa_atualizado_em
  BEFORE UPDATE ON imagens_empresa
  FOR EACH ROW EXECUTE FUNCTION set_atualizado_em();

CREATE FUNCTION imagens_empresa_imutavel() RETURNS trigger AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.empresa_id IS DISTINCT FROM OLD.empresa_id
     OR NEW.sha256 IS DISTINCT FROM OLD.sha256
     OR NEW.sha256_mestre IS DISTINCT FROM OLD.sha256_mestre
     OR NEW.sha256_exibicao IS DISTINCT FROM OLD.sha256_exibicao
     OR NEW.sha256_miniatura IS DISTINCT FROM OLD.sha256_miniatura
     OR NEW.formato IS DISTINCT FROM OLD.formato
     OR NEW.largura IS DISTINCT FROM OLD.largura
     OR NEW.altura IS DISTINCT FROM OLD.altura
     OR NEW.bytes_mestre IS DISTINCT FROM OLD.bytes_mestre
     OR NEW.bytes_exibicao IS DISTINCT FROM OLD.bytes_exibicao
     OR NEW.bytes_miniatura IS DISTINCT FROM OLD.bytes_miniatura
     OR NEW.criado_por IS DISTINCT FROM OLD.criado_por
     OR NEW.criado_em IS DISTINCT FROM OLD.criado_em THEN
    RAISE EXCEPTION 'imagens_empresa: só nome, estado, versão, inativada_em e atualizado_em podem mudar'
      USING ERRCODE = 'check_violation', CONSTRAINT = TG_NAME, TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_imagens_empresa_imutavel
  BEFORE UPDATE ON imagens_empresa
  FOR EACH ROW EXECUTE FUNCTION imagens_empresa_imutavel();

CREATE TABLE imagens_padrao_tipos (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  imagem_padrao_id  BIGINT NOT NULL REFERENCES imagens_padrao(id) ON DELETE CASCADE,
  tipo_nome         VARCHAR(100) NOT NULL,
  nivel             VARCHAR(12) NOT NULL,
  aprovado_por      VARCHAR(100) NOT NULL,
  aprovado_em       DATE NOT NULL,
  criado_em         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_imagens_padrao_tipos UNIQUE (imagem_padrao_id, tipo_nome),
  CONSTRAINT chk_imagens_padrao_tipos_nome CHECK (tipo_nome = btrim(tipo_nome) AND char_length(tipo_nome) >= 1 AND tipo_nome !~ '[[:cntrl:]]'),
  CONSTRAINT chk_imagens_padrao_tipos_nivel CHECK (nivel IN ('PRINCIPAL', 'ALTERNATIVA')),
  CONSTRAINT chk_imagens_padrao_tipos_aprovado_por CHECK (btrim(aprovado_por) <> '')
);

CREATE INDEX idx_imagens_padrao_tipos_nome ON imagens_padrao_tipos (tipo_nome);

ALTER TABLE materiais
  ADD COLUMN imagem_padrao_id  BIGINT,
  ADD COLUMN imagem_empresa_id BIGINT;

ALTER TABLE materiais
  ADD CONSTRAINT fk_materiais_imagem_padrao
    FOREIGN KEY (imagem_padrao_id) REFERENCES imagens_padrao(id) ON DELETE RESTRICT,
  ADD CONSTRAINT fk_materiais_imagem_empresa
    FOREIGN KEY (empresa_id, imagem_empresa_id) REFERENCES imagens_empresa (empresa_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT chk_materiais_uma_imagem CHECK (imagem_padrao_id IS NULL OR imagem_empresa_id IS NULL);

CREATE INDEX idx_materiais_imagem_padrao ON materiais (imagem_padrao_id) WHERE imagem_padrao_id IS NOT NULL;
CREATE INDEX idx_materiais_imagem_empresa ON materiais (empresa_id, imagem_empresa_id) WHERE imagem_empresa_id IS NOT NULL;

CREATE FUNCTION materiais_validar_imagem() RETURNS trigger AS $$
DECLARE
  imagem_ativa BOOLEAN;
BEGIN
  IF NEW.imagem_empresa_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.imagem_empresa_id IS DISTINCT FROM OLD.imagem_empresa_id) THEN
    -- Imagem inexistente ou de outra empresa não é achada aqui: quem a recusa é a chave estrangeira composta.
    SELECT (estado = 'ATIVA') INTO imagem_ativa FROM imagens_empresa
      WHERE empresa_id = NEW.empresa_id AND id = NEW.imagem_empresa_id FOR SHARE;
    IF imagem_ativa IS NOT NULL AND NOT imagem_ativa THEN
      RAISE EXCEPTION 'materiais: a imagem da empresa precisa estar ATIVA para ser associada'
        USING ERRCODE = 'check_violation', CONSTRAINT = TG_NAME, TABLE = TG_TABLE_NAME;
    END IF;
  END IF;
  IF NEW.imagem_padrao_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.imagem_padrao_id IS DISTINCT FROM OLD.imagem_padrao_id) THEN
    SELECT ativo INTO imagem_ativa FROM imagens_padrao WHERE id = NEW.imagem_padrao_id FOR SHARE;
    IF imagem_ativa IS NOT NULL AND NOT imagem_ativa THEN
      RAISE EXCEPTION 'materiais: a imagem padrão precisa estar ativa para ser associada'
        USING ERRCODE = 'check_violation', CONSTRAINT = TG_NAME, TABLE = TG_TABLE_NAME;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_materiais_validar_imagem
  BEFORE INSERT OR UPDATE OF imagem_padrao_id, imagem_empresa_id ON materiais
  FOR EACH ROW EXECUTE FUNCTION materiais_validar_imagem();
