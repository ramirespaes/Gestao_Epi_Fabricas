-- logs_auditoria: acrescenta três campos JSONB para contexto estruturado.
-- Esta migration NÃO modifica a 012 — apenas estende a tabela criada lá.
-- A proteção append-only (triggers de UPDATE/DELETE/TRUNCATE) continua
-- intacta; esta migration só acrescenta uma trigger de INSERT.
--
--   contexto         : metadados da ação (ex.: {"rota":"PATCH /api/usuarios/7/inativar",
--                      "motivo":"USUARIO_INATIVO"}). Nunca o payload bruto do cliente.
--   dados_anteriores : estado relevante ANTES da alteração (subconjunto de
--                      campos escolhido pelo serviço, nunca a linha inteira).
--   dados_novos      : estado relevante DEPOIS da alteração, mesma regra.
--
-- Regra de ouro: senha, senha_hash, token, access/refresh token, cookie,
-- secret, authorization, API key, credencial externa ou chave privada JAMAIS
-- entram aqui. A PRIMEIRA barreira é a função central de redação da
-- aplicação (auditoria.service), que também impõe limite de tamanho. A
-- trigger abaixo é a SEGUNDA barreira, no próprio banco: rejeita o INSERT se
-- qualquer chave, em qualquer nível de aninhamento, tiver nome sensível.

ALTER TABLE logs_auditoria
  ADD COLUMN contexto         JSONB,
  ADD COLUMN dados_anteriores JSONB,
  ADD COLUMN dados_novos      JSONB;

-- Só objetos JSON (ou NULL) e no máximo 16 KiB (bytes, via octet_length) por coluna.
-- O limite de tamanho é defensivo: o serviço deve impor um teto menor
-- (AUDITORIA_JSON_MAX_BYTES) antes de chegar aqui.
ALTER TABLE logs_auditoria
  ADD CONSTRAINT chk_logs_auditoria_contexto_objeto
    CHECK (contexto IS NULL OR jsonb_typeof(contexto) = 'object'),
  ADD CONSTRAINT chk_logs_auditoria_dados_anteriores_objeto
    CHECK (dados_anteriores IS NULL OR jsonb_typeof(dados_anteriores) = 'object'),
  ADD CONSTRAINT chk_logs_auditoria_dados_novos_objeto
    CHECK (dados_novos IS NULL OR jsonb_typeof(dados_novos) = 'object'),
  ADD CONSTRAINT chk_logs_auditoria_contexto_tamanho
    CHECK (contexto IS NULL OR octet_length(contexto::text) <= 16384),
  ADD CONSTRAINT chk_logs_auditoria_dados_anteriores_tamanho
    CHECK (dados_anteriores IS NULL OR octet_length(dados_anteriores::text) <= 16384),
  ADD CONSTRAINT chk_logs_auditoria_dados_novos_tamanho
    CHECK (dados_novos IS NULL OR octet_length(dados_novos::text) <= 16384);

-- Decide se o NOME de uma chave JSON é sensível. Compara por SEGMENTOS do
-- nome (camelCase e kebab-case normalizados para snake_case), não por
-- substring: 'secretaria_id', 'hash_arquivo' ou 'hashtag' são legítimos e
-- passam; 'senha', 'senhaHash', 'refresh_token', 'api-key', 'chave_privada'
-- são bloqueados. Consequência deliberada: 'senha_alterada_em' também é
-- bloqueado — o serviço deve gravar esse instante como 'alterada_em' dentro
-- do contexto da ação SENHA_ALTERADA, sem repetir a palavra 'senha' na chave.
CREATE OR REPLACE FUNCTION logs_auditoria_chave_json_e_sensivel(chave TEXT)
RETURNS BOOLEAN AS $$
DECLARE
  segmentos TEXT[];
  n INTEGER;
  i INTEGER;
BEGIN
  IF chave IS NULL THEN
    RETURN false;
  END IF;

  -- camelCase -> snake_case, tudo minúsculo, quebra em [a-z0-9]+.
  segmentos := array_remove(
    regexp_split_to_array(
      lower(regexp_replace(chave, '([a-z0-9])([A-Z])', '\1_\2', 'g')),
      '[^a-z0-9]+'
    ),
    ''
  );
  n := coalesce(array_length(segmentos, 1), 0);
  IF n = 0 THEN
    RETURN false;
  END IF;

  -- Um único segmento já é suficiente para bloquear.
  IF segmentos && ARRAY[
    'senha', 'senhas', 'password', 'passwords', 'passwd', 'pwd', 'passphrase',
    'token', 'tokens', 'jwt', 'bearer',
    'cookie', 'cookies',
    'secret', 'secrets', 'segredo', 'segredos',
    'credencial', 'credenciais', 'credential', 'credentials',
    'authorization', 'apikey', 'otp', 'totp'
  ] THEN
    RETURN true;
  END IF;

  -- Pares adjacentes: 'key' e 'chave' sozinhos são legítimos
  -- (chave_primaria, key de configuração); combinados, não.
  FOR i IN 1 .. n - 1 LOOP
    IF (segmentos[i], segmentos[i + 1]) IN (
      ('api', 'key'), ('private', 'key'), ('secret', 'key'), ('access', 'key'),
      ('chave', 'privada'), ('chave', 'secreta'), ('chave', 'api'), ('chave', 'acesso')
    ) THEN
      RETURN true;
    END IF;
  END LOOP;

  RETURN false;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Percorre recursivamente objetos e arrays procurando nomes de chave
-- sensíveis. Retorna true se encontrar qualquer um.
CREATE OR REPLACE FUNCTION logs_auditoria_jsonb_possui_chave_sensivel(dado JSONB)
RETURNS BOOLEAN AS $$
DECLARE
  k TEXT;
  v JSONB;
BEGIN
  IF dado IS NULL THEN
    RETURN false;
  END IF;

  IF jsonb_typeof(dado) = 'object' THEN
    FOR k, v IN SELECT * FROM jsonb_each(dado) LOOP
      IF logs_auditoria_chave_json_e_sensivel(k) THEN
        RETURN true;
      END IF;
      IF logs_auditoria_jsonb_possui_chave_sensivel(v) THEN
        RETURN true;
      END IF;
    END LOOP;
  ELSIF jsonb_typeof(dado) = 'array' THEN
    FOR v IN SELECT * FROM jsonb_array_elements(dado) LOOP
      IF logs_auditoria_jsonb_possui_chave_sensivel(v) THEN
        RETURN true;
      END IF;
    END LOOP;
  END IF;

  RETURN false;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION logs_auditoria_bloquear_dado_sensivel()
RETURNS TRIGGER AS $$
BEGIN
  IF logs_auditoria_jsonb_possui_chave_sensivel(NEW.contexto)
     OR logs_auditoria_jsonb_possui_chave_sensivel(NEW.dados_anteriores)
     OR logs_auditoria_jsonb_possui_chave_sensivel(NEW.dados_novos) THEN
    RAISE EXCEPTION 'logs_auditoria: campo JSONB contém chave sensível (senha/hash de senha/token/cookie/secret/authorization/api key/credencial/chave privada)';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_logs_auditoria_bloquear_dado_sensivel
  BEFORE INSERT ON logs_auditoria
  FOR EACH ROW EXECUTE FUNCTION logs_auditoria_bloquear_dado_sensivel();
