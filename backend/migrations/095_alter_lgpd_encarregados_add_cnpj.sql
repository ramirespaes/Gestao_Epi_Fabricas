-- 095: Privacidade e LGPD — CNPJ do encarregado pessoa jurídica (decisão de 28/10/2026, homologação do LGPD-1).
--
-- Estritamente aditiva sobre a 094 (que não muda): uma coluna, dois CHECKs e a função do gatilho de histórico recriada com a
-- coluna nova na lista de dados imutáveis. Nenhuma linha é alterada: as designações PJ anteriores a esta migration ficam com
-- cnpj NULL (legado previsto). A obrigatoriedade do CNPJ para designação PJ NOVA é regra da aplicação (schema + serviço),
-- não do banco, exatamente para o legado continuar válido. Pessoa física nunca tem CNPJ (CHECK).
--
-- Formato: o canônico do SafeWork (14 posições, 12 alfanuméricas maiúsculas + 2 dígitos), o mesmo de empresas.cnpj (016);
-- os dígitos verificadores são conferidos pela aplicação, como lá. Sem unicidade: a mesma empresa de DPO pode atender várias
-- empresas e as duas funções.
--
-- Legado PJ sem CNPJ recebe o número por "Corrigir contato" (nova versão por CORRECAO, regra do serviço); trocar um CNPJ já
-- gravado por outro não é correção: é outra pessoa jurídica, logo Substituição. O gatilho continua impedindo UPDATE direto.

ALTER TABLE lgpd_encarregados
  ADD COLUMN cnpj CHAR(14);

ALTER TABLE lgpd_encarregados
  ADD CONSTRAINT chk_lgpd_encarregados_cnpj_formato CHECK (cnpj IS NULL OR cnpj ~ '^[0-9A-Z]{12}[0-9]{2}$'),
  ADD CONSTRAINT chk_lgpd_encarregados_cnpj_pf CHECK (tipo_pessoa = 'PJ' OR cnpj IS NULL);

-- Mesma função da 094, com `cnpj` entre os dados imutáveis da designação (o gatilho trg_lgpd_encarregados_proteger_historico
-- continua apontando para ela; nada mais muda).
CREATE OR REPLACE FUNCTION lgpd_encarregados_proteger_historico() RETURNS trigger
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
     OR NEW.cnpj IS DISTINCT FROM OLD.cnpj
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
