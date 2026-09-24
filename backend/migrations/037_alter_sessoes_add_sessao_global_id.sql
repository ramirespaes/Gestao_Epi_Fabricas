-- sessoes.sessao_global_id: de qual sessão global (035) nasceu esta sessão
-- empresarial (Autenticação Global — Pacote 4). ALTER ADITIVO sobre a
-- tabela histórica 013 — a migration 013 permanece intocada (CLAUDE.md
-- §12); coluna NULÁVEL, sem backfill: toda sessão já existente, e qualquer
-- sessão ainda criada pelo login legado por CNPJ (login.service.js), fica
-- com NULL, exatamente como antes.
--
-- PARA QUE SERVE (rastreabilidade e revogação exata, adendo v2.1 §4.2 e/f):
--   - "Trocar de empresa": a sessão empresarial anterior é revogada
--     (TROCA_EMPRESA) e a nova nasce apontando para a MESMA sessão global;
--   - "Sair completamente": revoga a sessão global E, por esta coluna,
--     exatamente as sessões empresariais que nasceram dela (LOGOUT_GLOBAL)
--     — nunca as de outro dispositivo/login da mesma pessoa, que têm sua
--     própria sessão global;
--   - auditoria: uma sessão empresarial passa a dizer de que login global
--     veio, sem que nenhuma consulta de validade dependa disso.
--
-- A VALIDADE da sessão empresarial NÃO passa a depender da global: o
-- contrato de sessao.repository.buscarValidaPorHash (revogada_em,
-- expira_em, ultimo_uso_em, usuarios.ativo, empresas.ativo e, desde o
-- Pacote 4, identidades.ativo) é o único critério. Revogações são
-- explícitas, gravadas com motivo — nunca inferidas por esta coluna.
--
-- ON DELETE SET NULL, e não RESTRICT: FK de UMA coluna (o problema de
-- "SET NULL zera todas as colunas" da migration 006 só existe em FK
-- composta), e a rotina de purga de sessoes_globais antigas não pode
-- ficar bloqueada por linhas de sessoes retidas pela sua própria política
-- de retenção — a sessão empresarial preserva seu histórico (revogada_em,
-- motivo) e apenas perde o ponteiro para uma sessão global já purgada.
ALTER TABLE sessoes
  ADD COLUMN sessao_global_id BIGINT REFERENCES sessoes_globais(id) ON DELETE SET NULL;

-- "Revogar as sessões empresariais ainda ativas nascidas da sessão global X"
-- (troca de empresa, logout completo): parcial, só as linhas que podem ser
-- alvo dessa operação.
CREATE INDEX idx_sessoes_sessao_global_id_nao_revogadas
  ON sessoes (sessao_global_id)
  WHERE sessao_global_id IS NOT NULL AND revogada_em IS NULL;
