-- sessoes_plataforma: registro de que a sessão nasceu depois do segundo
-- fator. Evolução aditiva, compatível com o código atual: as duas colunas
-- são nulas e sem default, as sessões existentes ficam como estão (nenhuma
-- linha é reescrita) e quem ainda não as preenche continua criando sessão.
--
-- mfa_metodo diz como o segundo fator foi comprovado:
--   TOTP            login normal
--   CADASTRO        primeiro cadastro, via liberação
--   RECADASTRO      novo fator depois de um recovery code
--   SUBSTITUICAO    troca do fator com a sessão anterior
--   REAUTENTICACAO  rotação após alteração sensível (senha + TOTP na hora)
-- mfa_verificado_em nunca é posterior à criação da sessão.
--
-- Aqui NÃO entra a exigência de MFA em toda sessão não revogada: essa
-- constraint só vem numa migration posterior, quando nenhum backend antigo
-- puder mais emitir sessão só com senha.
ALTER TABLE sessoes_plataforma
  ADD COLUMN mfa_verificado_em TIMESTAMPTZ,
  ADD COLUMN mfa_metodo VARCHAR(20),
  ADD CONSTRAINT chk_sessoes_plataforma_mfa_metodo
    CHECK (mfa_metodo IS NULL OR mfa_metodo IN ('TOTP', 'CADASTRO', 'RECADASTRO', 'SUBSTITUICAO', 'REAUTENTICACAO')),
  ADD CONSTRAINT chk_sessoes_plataforma_mfa_coerente
    CHECK ((mfa_verificado_em IS NULL) = (mfa_metodo IS NULL)),
  ADD CONSTRAINT chk_sessoes_plataforma_mfa_antes_da_criacao
    CHECK (mfa_verificado_em IS NULL OR mfa_verificado_em <= criado_em);
