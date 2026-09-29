-- Inativar um administrador encerra, de forma permanente, o que ainda
-- poderia ser usado para autenticar: desafios de MFA abertos, fatores
-- PENDENTE e liberações de cadastro abertas. Antes, a inativação só os
-- escondia da leitura, e reativar dentro do prazo os fazia voltar a valer.
--
-- As sessões continuam com o gatilho da 031. Fator ATIVO, lotes e códigos de
-- recuperação não são tocados: depois da reativação, o login novo com senha
-- e TOTP funciona.
--
-- Instantes pelo relógio real (clock_timestamp), não pelo início da
-- transação. Linha já encerrada ou revogada mantém motivo e instante.

CREATE FUNCTION invalidar_artefatos_mfa_do_administrador(p_administrador_id INTEGER)
RETURNS void AS $$
BEGIN
  UPDATE desafios_mfa_plataforma
     SET encerrado_em = clock_timestamp(),
         motivo_encerramento = 'ADMINISTRADOR_INATIVADO'
   WHERE administrador_id = p_administrador_id
     AND encerrado_em IS NULL;

  -- Mesmo contrato da revogação feita pela aplicação: o segredo cifrado é apagado.
  UPDATE fatores_mfa_plataforma
     SET estado = 'REVOGADO',
         revogado_em = clock_timestamp(),
         motivo_revogacao = 'ADMINISTRADOR_INATIVADO',
         totp_nonce = NULL,
         totp_segredo_cifrado = NULL
   WHERE administrador_id = p_administrador_id
     AND estado = 'PENDENTE';

  UPDATE liberacoes_cadastro_mfa_plataforma
     SET revogada_em = clock_timestamp(),
         motivo_revogacao = 'ADMINISTRADOR_INATIVADO'
   WHERE administrador_id = p_administrador_id
     AND consumida_em IS NULL
     AND revogada_em IS NULL;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION invalidar_artefatos_mfa_administrador_inativado()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM invalidar_artefatos_mfa_do_administrador(NEW.id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Só na transição para inativo: reativar e qualquer outro UPDATE não disparam.
CREATE TRIGGER trg_administradores_plataforma_invalidar_mfa_ao_inativar
  AFTER UPDATE ON administradores_plataforma
  FOR EACH ROW
  WHEN (OLD.ativo = true AND NEW.ativo = false)
  EXECUTE FUNCTION invalidar_artefatos_mfa_administrador_inativado();

-- Administradores que já estavam inativos: a mesma regra, uma vez.
SELECT invalidar_artefatos_mfa_do_administrador(id)
  FROM administradores_plataforma
 WHERE NOT ativo;
