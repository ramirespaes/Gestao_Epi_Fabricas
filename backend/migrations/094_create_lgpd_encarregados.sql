-- 094: Privacidade e LGPD — cadastro do encarregado pelo tratamento de dados pessoais (DPO), principal e substituto, por
-- empresa, com histórico (Pacote LGPD-1, decisões A, B e C de 27/10/2026).
--
-- Estritamente aditiva: uma tabela nova, índices e gatilhos próprios. Nenhuma tabela existente muda. As colunas legadas
-- `empresas.dpo_nome`, `dpo_email` e `dpo_tel` (001) ficam exatamente como estão: não são lidas, migradas nem apagadas; a
-- fonte de verdade do encarregado passa a ser SÓ esta tabela (compatibilidade documentada no serviço).
--
--  * Uma designação por linha. `funcao` PRINCIPAL ou SUBSTITUTO; `tipo_pessoa` PF ou PJ (em PJ, `razao_social` é a pessoa
--    jurídica e `nome` é a pessoa natural responsável por ela; em PF, `razao_social` é nulo). Só dados profissionais de
--    contato: nenhum CPF, endereço residencial ou documento (decisão B). `ato_referencia`/`ato_data` são a referência ao ato
--    formal de designação: registro declaratório da empresa, não comprovação jurídica.
--  * Vigência: `fim_em IS NULL` ⇔ `situacao = 'VIGENTE'`. No máximo UMA vigente por (empresa, função): índice único parcial.
--  * Histórico imutável: a linha nunca é apagada e, depois de encerrada, nunca muda. Enquanto vigente, só o encerramento
--    (fim_em, motivo, encerrado_por, substituida_por_id, versao, atualizado_em) pode ser gravado; os dados da designação são
--    imutáveis — alterar contato é ENCERRAR por CORRECAO e INSERIR a linha nova, que aponta a anterior (`substitui_id`).
--  * `versao` é o controle de concorrência do serviço (a escrita leva WHERE versao = esperada).
--  * Isolamento: toda referência a usuário é FK composta com a empresa (nunca um ator de outra empresa).

CREATE TABLE lgpd_encarregados (
  id                        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  empresa_id                INTEGER      NOT NULL,
  funcao                    VARCHAR(12)  NOT NULL,
  tipo_pessoa               CHAR(2)      NOT NULL,
  nome                      VARCHAR(150) NOT NULL,
  razao_social              VARCHAR(150),
  vinculo                   VARCHAR(8)   NOT NULL,
  cargo                     VARCHAR(100),
  email                     VARCHAR(150) NOT NULL,
  telefone                  VARCHAR(20),
  inicio_em                 DATE         NOT NULL,
  fim_em                    DATE,
  situacao                  VARCHAR(10)  NOT NULL DEFAULT 'VIGENTE',
  ato_referencia            VARCHAR(200),
  ato_data                  DATE,
  conflito_interesses       VARCHAR(24)  NOT NULL DEFAULT 'NAO_AVALIADO',
  conflito_nota             VARCHAR(500),
  motivo_encerramento       VARCHAR(12),
  substitui_id              BIGINT,
  substituida_por_id        BIGINT,
  versao                    INTEGER      NOT NULL DEFAULT 1,
  designado_por             INTEGER      NOT NULL,
  encerrado_por             INTEGER,
  criado_em                 TIMESTAMPTZ  NOT NULL DEFAULT now(),
  atualizado_em             TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT uq_lgpd_encarregados_empresa_id UNIQUE (empresa_id, id),
  CONSTRAINT fk_lgpd_encarregados_empresa FOREIGN KEY (empresa_id) REFERENCES empresas (id) ON DELETE RESTRICT,
  CONSTRAINT fk_lgpd_encarregados_designado_por FOREIGN KEY (empresa_id, designado_por) REFERENCES usuarios (empresa_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_lgpd_encarregados_encerrado_por FOREIGN KEY (empresa_id, encerrado_por) REFERENCES usuarios (empresa_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_lgpd_encarregados_substitui FOREIGN KEY (empresa_id, substitui_id) REFERENCES lgpd_encarregados (empresa_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_lgpd_encarregados_substituida_por FOREIGN KEY (empresa_id, substituida_por_id) REFERENCES lgpd_encarregados (empresa_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_lgpd_encarregados_funcao CHECK (funcao IN ('PRINCIPAL', 'SUBSTITUTO')),
  CONSTRAINT chk_lgpd_encarregados_tipo_pessoa CHECK (tipo_pessoa IN ('PF', 'PJ')),
  CONSTRAINT chk_lgpd_encarregados_razao_social CHECK ((tipo_pessoa = 'PJ') = (razao_social IS NOT NULL)),
  CONSTRAINT chk_lgpd_encarregados_vinculo CHECK (vinculo IN ('INTERNO', 'EXTERNO')),
  CONSTRAINT chk_lgpd_encarregados_nome CHECK (char_length(btrim(nome)) BETWEEN 1 AND 150),
  CONSTRAINT chk_lgpd_encarregados_razao_social_texto CHECK (razao_social IS NULL OR char_length(btrim(razao_social)) BETWEEN 1 AND 150),
  CONSTRAINT chk_lgpd_encarregados_email CHECK (char_length(btrim(email)) BETWEEN 3 AND 150),
  CONSTRAINT chk_lgpd_encarregados_situacao CHECK (situacao IN ('VIGENTE', 'ENCERRADA')),
  CONSTRAINT chk_lgpd_encarregados_vigencia CHECK ((situacao = 'VIGENTE') = (fim_em IS NULL)),
  CONSTRAINT chk_lgpd_encarregados_periodo CHECK (fim_em IS NULL OR fim_em >= inicio_em),
  CONSTRAINT chk_lgpd_encarregados_conflito CHECK (conflito_interesses IN ('NAO_AVALIADO', 'SEM_CONFLITO', 'COM_CONFLITO_MITIGADO')),
  CONSTRAINT chk_lgpd_encarregados_motivo CHECK (motivo_encerramento IS NULL OR motivo_encerramento IN ('SUBSTITUICAO', 'ENCERRAMENTO', 'CORRECAO')),
  CONSTRAINT chk_lgpd_encarregados_encerramento CHECK (
    (situacao = 'VIGENTE' AND motivo_encerramento IS NULL AND encerrado_por IS NULL AND substituida_por_id IS NULL)
    OR (situacao = 'ENCERRADA' AND motivo_encerramento IS NOT NULL AND encerrado_por IS NOT NULL)
  ),
  CONSTRAINT chk_lgpd_encarregados_substituida CHECK (motivo_encerramento IN ('SUBSTITUICAO', 'CORRECAO') OR substituida_por_id IS NULL),
  CONSTRAINT chk_lgpd_encarregados_versao CHECK (versao >= 1)
);

-- Uma designação VIGENTE por função em cada empresa.
CREATE UNIQUE INDEX uq_lgpd_encarregados_vigente
  ON lgpd_encarregados (empresa_id, funcao) WHERE fim_em IS NULL;

CREATE INDEX idx_lgpd_encarregados_historico
  ON lgpd_encarregados (empresa_id, inicio_em DESC, id DESC);

CREATE TRIGGER trg_lgpd_encarregados_atualizado_em
  BEFORE UPDATE ON lgpd_encarregados
  FOR EACH ROW EXECUTE FUNCTION set_atualizado_em();

-- Histórico imutável: nada é apagado; a linha encerrada não muda; a vigente só aceita o próprio encerramento. Única exceção na
-- encerrada: receber UMA vez o vínculo com a sucessora (substituida_por_id, de NULL para um id), porque a sucessora só pode ser
-- inserida depois do encerramento (índice único de vigência) e, portanto, só então tem id.
CREATE FUNCTION lgpd_encarregados_proteger_historico() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'lgpd_encarregados: registro de designação não pode ser apagado (histórico imutável)';
  END IF;
  IF OLD.situacao = 'ENCERRADA' THEN
    IF OLD.substituida_por_id IS NULL AND NEW.substituida_por_id IS NOT NULL
       AND (to_jsonb(NEW) - 'substituida_por_id' - 'atualizado_em') = (to_jsonb(OLD) - 'substituida_por_id' - 'atualizado_em') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'lgpd_encarregados: designação encerrada é imutável';
  END IF;
  IF NEW.empresa_id IS DISTINCT FROM OLD.empresa_id
     OR NEW.funcao IS DISTINCT FROM OLD.funcao
     OR NEW.tipo_pessoa IS DISTINCT FROM OLD.tipo_pessoa
     OR NEW.nome IS DISTINCT FROM OLD.nome
     OR NEW.razao_social IS DISTINCT FROM OLD.razao_social
     OR NEW.vinculo IS DISTINCT FROM OLD.vinculo
     OR NEW.cargo IS DISTINCT FROM OLD.cargo
     OR NEW.email IS DISTINCT FROM OLD.email
     OR NEW.telefone IS DISTINCT FROM OLD.telefone
     OR NEW.inicio_em IS DISTINCT FROM OLD.inicio_em
     OR NEW.ato_referencia IS DISTINCT FROM OLD.ato_referencia
     OR NEW.ato_data IS DISTINCT FROM OLD.ato_data
     OR NEW.conflito_interesses IS DISTINCT FROM OLD.conflito_interesses
     OR NEW.conflito_nota IS DISTINCT FROM OLD.conflito_nota
     OR NEW.substitui_id IS DISTINCT FROM OLD.substitui_id
     OR NEW.designado_por IS DISTINCT FROM OLD.designado_por
     OR NEW.criado_em IS DISTINCT FROM OLD.criado_em THEN
    RAISE EXCEPTION 'lgpd_encarregados: os dados da designação são imutáveis; corrija por nova designação (CORRECAO)';
  END IF;
  IF NEW.situacao = 'VIGENTE' THEN
    RAISE EXCEPTION 'lgpd_encarregados: uma designação vigente só pode ser alterada pelo seu encerramento';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_lgpd_encarregados_proteger_historico
  BEFORE UPDATE OR DELETE ON lgpd_encarregados
  FOR EACH ROW EXECUTE FUNCTION lgpd_encarregados_proteger_historico();
