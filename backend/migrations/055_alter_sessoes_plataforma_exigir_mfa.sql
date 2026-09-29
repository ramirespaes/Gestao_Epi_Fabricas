-- sessoes_plataforma: MFA obrigatório em toda sessão não revogada do Painel
-- Privado. A sessão só vale se nasceu de um desafio de MFA concluído, e o
-- banco confere isso no COMMIT, não só a aplicação.
--
-- O que comprova a sessão é o que o fluxo real grava, na mesma transação:
-- o desafio concluído que a criou (desafios_mfa_plataforma.sessao_criada_id).
--   mfa_metodo   tipo do desafio   fluxo
--   TOTP         VERIFICACAO       login com TOTP
--   CADASTRO     CADASTRO          primeiro cadastro
--   RECADASTRO   RECUPERACAO       novo fator depois de um recovery code
-- O instante do MFA fica dentro da vida do desafio:
--   desafio.criado_em <= mfa_verificado_em <= desafio.encerrado_em
--
-- SUBSTITUICAO e REAUTENTICACAO continuam no CHECK da 054 só por causa das
-- linhas já revogadas: nenhum fluxo cria sessão com eles.
--
-- Sessões anteriores que não comprovam o MFA são revogadas aqui, com motivo
-- MFA_OBRIGATORIO. Nenhuma recebe instante, método ou desafio que não tinha.

-- Um desafio comprova uma sessão só. Também atende à leitura da sessão, que
-- procura o desafio pelo vínculo a cada requisição autenticada.
CREATE UNIQUE INDEX uq_desafios_mfa_plataforma_sessao_criada
  ON desafios_mfa_plataforma (sessao_criada_id) WHERE sessao_criada_id IS NOT NULL;

UPDATE sessoes_plataforma s
   SET revogada_em = clock_timestamp(), motivo_revogacao = 'MFA_OBRIGATORIO'
 WHERE s.revogada_em IS NULL
   AND (
     s.mfa_verificado_em IS NOT NULL
     AND s.mfa_metodo IN ('TOTP', 'CADASTRO', 'RECADASTRO')
     AND EXISTS (
       SELECT 1
         FROM desafios_mfa_plataforma d
        WHERE d.sessao_criada_id = s.id
          AND d.administrador_id = s.administrador_id
          AND d.motivo_encerramento = 'CONCLUIDO'
          AND d.tipo = CASE s.mfa_metodo WHEN 'TOTP' THEN 'VERIFICACAO' WHEN 'CADASTRO' THEN 'CADASTRO' WHEN 'RECADASTRO' THEN 'RECUPERACAO' END
          AND d.criado_em <= s.mfa_verificado_em
          AND s.mfa_verificado_em <= d.encerrado_em
     )
   ) IS NOT TRUE;

ALTER TABLE sessoes_plataforma
  ADD CONSTRAINT chk_sessoes_plataforma_mfa_obrigatorio
    CHECK (revogada_em IS NOT NULL OR (mfa_verificado_em IS NOT NULL AND mfa_metodo IN ('TOTP', 'CADASTRO', 'RECADASTRO')));

-- Lê a linha como está no COMMIT: a sessão e o vínculo com o desafio nascem
-- na mesma transação, em comandos separados.
CREATE FUNCTION exigir_desafio_concluido_da_sessao_plataforma()
RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM sessoes_plataforma s
     WHERE s.id = NEW.id
       AND s.revogada_em IS NULL
       AND NOT EXISTS (
         SELECT 1
           FROM desafios_mfa_plataforma d
          WHERE d.sessao_criada_id = s.id
            AND d.administrador_id = s.administrador_id
            AND d.motivo_encerramento = 'CONCLUIDO'
            AND d.tipo = CASE s.mfa_metodo WHEN 'TOTP' THEN 'VERIFICACAO' WHEN 'CADASTRO' THEN 'CADASTRO' WHEN 'RECADASTRO' THEN 'RECUPERACAO' END
            AND d.criado_em <= s.mfa_verificado_em
            AND s.mfa_verificado_em <= d.encerrado_em
       )
  ) THEN
    RAISE EXCEPTION 'sessoes_plataforma: sessão sem desafio de MFA concluído que a comprove'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'trg_sessoes_plataforma_desafio_concluido',
            TABLE = 'sessoes_plataforma';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Só as colunas que mudam a validade: renovar ultimo_uso_em não dispara.
CREATE CONSTRAINT TRIGGER trg_sessoes_plataforma_desafio_concluido
  AFTER INSERT OR UPDATE OF administrador_id, revogada_em, mfa_verificado_em, mfa_metodo ON sessoes_plataforma
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION exigir_desafio_concluido_da_sessao_plataforma();
