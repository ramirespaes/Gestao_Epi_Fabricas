-- Revogação RASTREÁVEL de sessões empresariais ao inativar um vínculo
-- (usuarios.ativo) ou uma empresa (empresas.ativo) — Autenticação Global,
-- Pacote 4 (adendo v2.1 §4.2, cenários a, b e f).
--
-- A consulta de validade (sessao.repository.buscarValidaPorHash) JÁ deixa
-- de encontrar essas sessões no instante da inativação (usuarios.ativo e
-- empresas.ativo entram no filtro desde a 013). O que faltava era a
-- garantia (f): "reativar um vínculo não pode restaurar automaticamente
-- uma sessão" — sem estes triggers, uma sessão ainda não expirada voltaria
-- a validar quando o vínculo (ou a empresa) fosse reativado, porque nada a
-- teria marcado como revogada. Com eles, a inativação REVOGA (revogada_em +
-- motivo), por qualquer caminho — serviço, script administrativo ou SQL
-- direto — e a reativação exige nova seleção de empresa a partir de uma
-- sessão global válida (ou novo login).
--
-- Mesma técnica da migration 031 (administradores_plataforma) e da 035
-- (identidades). ALTER-free: nenhuma coluna muda; só triggers AFTER UPDATE
-- condicionados à transição true -> false. Nenhum efeito sobre linhas
-- existentes. As sessões GLOBAIS não são tocadas aqui: inativar um vínculo
-- ou uma empresa não é inativar a pessoa (v2 §4.2) — ela continua podendo
-- selecionar suas outras empresas.
CREATE OR REPLACE FUNCTION revogar_sessoes_usuario_inativado()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE sessoes
     SET revogada_em = now(),
         motivo_revogacao = 'USUARIO_INATIVADO'
   WHERE empresa_id = NEW.empresa_id
     AND usuario_id = NEW.id
     AND revogada_em IS NULL;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_usuarios_revogar_sessoes_ao_inativar
  AFTER UPDATE ON usuarios
  FOR EACH ROW
  WHEN (OLD.ativo = true AND NEW.ativo = false)
  EXECUTE FUNCTION revogar_sessoes_usuario_inativado();

CREATE OR REPLACE FUNCTION revogar_sessoes_empresa_inativada()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE sessoes
     SET revogada_em = now(),
         motivo_revogacao = 'EMPRESA_INATIVADA'
   WHERE empresa_id = NEW.id
     AND revogada_em IS NULL;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_empresas_revogar_sessoes_ao_inativar
  AFTER UPDATE ON empresas
  FOR EACH ROW
  WHEN (OLD.ativo = true AND NEW.ativo = false)
  EXECUTE FUNCTION revogar_sessoes_empresa_inativada();
