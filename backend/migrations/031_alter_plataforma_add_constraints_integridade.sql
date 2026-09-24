-- Correção final do Pacote 2 — Autenticação Global (23/09/2026), itens 3 e
-- 4 da auditoria independente. Migration ADITIVA: 027, 028 e 029
-- permanecem exatamente como foram registradas no manifesto de checksums —
-- nada aqui as ALTERA, só ACRESCENTA constraints, índice e um trigger
-- novos às tabelas que elas criaram.
--
-- ITEM 4 — INTEGRIDADE DO BANCO: comparação com as tabelas empresariais
-- correspondentes (`sessoes`, migration 013; `logs_auditoria`, migrations
-- 012/014) identificou três proteções presentes lá e ausentes em
-- `sessoes_plataforma`/`logs_auditoria_plataforma`:
--
--   1. sessoes: chk_sessoes_expira_apos_criacao (expira_em > criado_em).
--      Ausente em sessoes_plataforma. Adicionada abaixo com o mesmo nome
--      de padrão, sufixado _plataforma.
--   2. sessoes: chk_sessoes_revogacao_coerente (revogada_em e
--      motivo_revogacao só existem OU não existem juntos). Ausente em
--      sessoes_plataforma. Adicionada abaixo.
--   3. logs_auditoria: seis CHECKs de 014 (contexto/dados_anteriores/
--      dados_novos, cada um com uma checagem de tipo JSONB-objeto e uma de
--      tamanho máximo de 16 KiB). Nenhuma delas existia em
--      logs_auditoria_plataforma. Adicionadas abaixo, nomes e limites
--      idênticos aos de 014 (mesma disciplina: o limite de 16 KiB é
--      defensivo — o serviço/repositório deve impor um teto menor antes de
--      chegar aqui, exatamente como já documentado para logs_auditoria).
--   4. sessoes: idx_sessoes_expira_em (rotina de purga). Ausente em
--      sessoes_plataforma. Adicionado abaixo.
--
-- ITEM 3 — REVOGAÇÃO PERMANENTE DE SESSÕES: o desenho original decidia
-- "sessão de administrador inativo é inválida" dinamicamente, LENDO
-- administradores_plataforma.ativo a cada consulta
-- (sessao-plataforma.repository.buscarValidaPorHash). Isso tem uma falha:
-- REATIVAR o administrador (ativo=false -> true) faz as sessões antigas
-- voltarem a passar na mesma consulta, porque revogada_em nunca foi
-- gravado — nada persiste a inativação além do próprio booleano, que é
-- reversível por definição. Corrigido com um trigger: toda vez que
-- administradores_plataforma.ativo transiciona de true para false, TODAS
-- as sessões não revogadas daquele administrador são revogadas de verdade
-- (revogada_em preenchido, motivo_revogacao = 'ADMINISTRADOR_INATIVADO').
-- Como revogada_em é IMUTÁVEL na prática (nenhum caminho de código o limpa
-- depois de gravado — sessao-plataforma.repository.js não tem, e nunca
-- teve, uma operação de "desrevogar"), reativar o administrador NÃO
-- restaura cookies nem sessões: a condição `revogada_em IS NULL` de
-- buscarValidaPorHash continua recusando essas linhas para sempre,
-- independentemente do valor atual de `ativo`. A checagem de
-- `a.ativo` na consulta É MANTIDA como defesa em profundidade (ela também
-- barra imediatamente qualquer sessão criada DEPOIS de uma reativação, se
-- alguma disciplina de aplicação um dia permitir login durante uma janela
-- de inativação transitória) — o trigger é o que torna a revogação
-- PERMANENTE, não um substituto dessa checagem.

ALTER TABLE sessoes_plataforma
  ADD CONSTRAINT chk_sessoes_plataforma_expira_apos_criacao
    CHECK (expira_em > criado_em),
  ADD CONSTRAINT chk_sessoes_plataforma_revogacao_coerente
    CHECK (
      (revogada_em IS NULL AND motivo_revogacao IS NULL)
      OR (revogada_em IS NOT NULL AND motivo_revogacao IS NOT NULL)
    );

CREATE INDEX idx_sessoes_plataforma_expira_em ON sessoes_plataforma (expira_em);

ALTER TABLE logs_auditoria_plataforma
  ADD CONSTRAINT chk_logs_auditoria_plataforma_contexto_objeto
    CHECK (contexto IS NULL OR jsonb_typeof(contexto) = 'object'),
  ADD CONSTRAINT chk_logs_auditoria_plataforma_dados_anteriores_objeto
    CHECK (dados_anteriores IS NULL OR jsonb_typeof(dados_anteriores) = 'object'),
  ADD CONSTRAINT chk_logs_auditoria_plataforma_dados_novos_objeto
    CHECK (dados_novos IS NULL OR jsonb_typeof(dados_novos) = 'object'),
  ADD CONSTRAINT chk_logs_auditoria_plataforma_contexto_tamanho
    CHECK (contexto IS NULL OR octet_length(contexto::text) <= 16384),
  ADD CONSTRAINT chk_logs_auditoria_plataforma_dados_anteriores_tamanho
    CHECK (dados_anteriores IS NULL OR octet_length(dados_anteriores::text) <= 16384),
  ADD CONSTRAINT chk_logs_auditoria_plataforma_dados_novos_tamanho
    CHECK (dados_novos IS NULL OR octet_length(dados_novos::text) <= 16384);

-- Revoga PERMANENTEMENTE as sessões de um administrador quando ele é
-- inativado. Só dispara na transição true -> false (WHEN abaixo): não faz
-- nada numa reativação (false -> true), nem em qualquer UPDATE que não
-- mude `ativo`. Idempotente por natureza: "AND revogada_em IS NULL" evita
-- sobrescrever o motivo/instante de uma sessão já revogada por outra razão
-- (ex.: logout do próprio administrador momentos antes).
CREATE OR REPLACE FUNCTION revogar_sessoes_administrador_inativado()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE sessoes_plataforma
     SET revogada_em = now(),
         motivo_revogacao = 'ADMINISTRADOR_INATIVADO'
   WHERE administrador_id = NEW.id
     AND revogada_em IS NULL;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_administradores_plataforma_revogar_sessoes_ao_inativar
  AFTER UPDATE ON administradores_plataforma
  FOR EACH ROW
  WHEN (OLD.ativo = true AND NEW.ativo = false)
  EXECUTE FUNCTION revogar_sessoes_administrador_inativado();
