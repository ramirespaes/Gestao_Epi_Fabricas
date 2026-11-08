-- PENDENCIA-SEG-TRG04 (D-ORF-6, L1 Bloco B; tratada na Rodada A, R2): a função
-- logs_auditoria_chave_json_e_sensivel (migration 014, compartilhada pelos
-- gatilhos de INSERT das três trilhas: logs_auditoria, logs_auditoria_plataforma
-- e logs_auditoria_identidade) reconhece nomes sensíveis por SEGMENTOS (camelCase
-- e separadores não alfanuméricos). Nomes compostos SEM separador e sem fronteira
-- camelCase viram um segmento único e passavam: PGPASSWORD, DBPASSWORD,
-- ACCESSTOKEN e CLIENTSECRET foram confirmados aceitos em PostgreSQL real
-- (06/11/2026).
--
-- Esta migration é ADITIVA: a 014 é histórica e não muda; aqui a função é
-- redefinida (CREATE OR REPLACE) com as regras anteriores PRESERVADAS e três
-- regras novas, todas sobre o segmento já normalizado (minúsculas, [a-z0-9]+):
--   1. palavras compostas conhecidas, sem separador (accesskey, privatekey,
--      secretkey, senhahash, passwordhash, chaveprivada, chavesecreta, chaveapi,
--      chaveacesso);
--   2. SUFIXO sensível com prefixo não vazio (pgpassword, dbpassword, accesstoken,
--      clientsecret, dbsenha, appsegredo, usercredential, sessioncookie, ...);
--   3. PREFIXO sensível com sufixo não vazio, só para as palavras que não iniciam
--      identificadores legítimos (senhahash, passwordhash, tokenid, segredoatual,
--      credencialexterna, cookiesessao, apikeyid, ...). 'secret' NÃO entra como
--      prefixo: 'secretaria_id' continua legítimo.
-- Continuam legítimos: 'secretaria_id', 'hashtag', os nomes de hash já usados,
-- 'chave_primaria', 'key' e 'chave' sozinhos, e todas as 15 chaves do contexto do
-- executor de backup.
-- Os gatilhos e as demais funções da 014 não são tocados: por chamarem esta função
-- pelo nome, passam a usar a regra nova nas três trilhas ao mesmo tempo.
--
-- Primeira barreira na aplicação: src/utils/chave-json-sensivel.js espelha estas
-- listas (um teste estático exige que as listas sejam idênticas) e é chamado pelos
-- três repositórios de auditoria antes do INSERT.

CREATE OR REPLACE FUNCTION logs_auditoria_chave_json_e_sensivel(chave TEXT)
RETURNS BOOLEAN AS $$
DECLARE
  segmentos TEXT[];
  segmento TEXT;
  palavra TEXT;
  n INTEGER;
  i INTEGER;
  -- regra da 014: um segmento inteiro igual a uma destas palavras
  palavras_inteiras CONSTANT TEXT[] := ARRAY[
    'senha', 'senhas', 'password', 'passwords', 'passwd', 'pwd', 'passphrase',
    'token', 'tokens', 'jwt', 'bearer',
    'cookie', 'cookies',
    'secret', 'secrets', 'segredo', 'segredos',
    'credencial', 'credenciais', 'credential', 'credentials',
    'authorization', 'apikey', 'otp', 'totp'
  ];
  -- regra 1 (nova): compostos conhecidos sem separador
  compostos CONSTANT TEXT[] := ARRAY[
    'accesskey', 'privatekey', 'secretkey', 'senhahash', 'passwordhash',
    'chaveprivada', 'chavesecreta', 'chaveapi', 'chaveacesso'
  ];
  -- regra 2 (nova): sufixos sensíveis (o segmento termina com a palavra e tem prefixo)
  sufixos CONSTANT TEXT[] := ARRAY[
    'senha', 'password', 'passwd', 'passphrase',
    'token', 'secret', 'segredo',
    'credencial', 'credential', 'credentials',
    'cookie', 'apikey', 'authorization'
  ];
  -- regra 3 (nova): prefixos sensíveis (o segmento começa com a palavra e tem sufixo)
  prefixos CONSTANT TEXT[] := ARRAY[
    'senha', 'password', 'passwd', 'passphrase',
    'token', 'segredo',
    'credencial', 'credential',
    'cookie', 'apikey'
  ];
BEGIN
  IF chave IS NULL THEN
    RETURN false;
  END IF;

  -- camelCase -> snake_case, tudo minúsculo, quebra em [a-z0-9]+ (idêntico à 014).
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

  -- 014: um único segmento igual a uma palavra sensível já bloqueia.
  IF segmentos && palavras_inteiras THEN
    RETURN true;
  END IF;

  -- 014: pares adjacentes ('key' e 'chave' sozinhos são legítimos; combinados, não).
  FOR i IN 1 .. n - 1 LOOP
    IF (segmentos[i], segmentos[i + 1]) IN (
      ('api', 'key'), ('private', 'key'), ('secret', 'key'), ('access', 'key'),
      ('chave', 'privada'), ('chave', 'secreta'), ('chave', 'api'), ('chave', 'acesso')
    ) THEN
      RETURN true;
    END IF;
  END LOOP;

  -- 097: compostos sem separador, sufixos e prefixos, por segmento.
  FOREACH segmento IN ARRAY segmentos LOOP
    IF segmento = ANY (compostos) THEN
      RETURN true;
    END IF;
    FOREACH palavra IN ARRAY sufixos LOOP
      IF length(segmento) > length(palavra) AND right(segmento, length(palavra)) = palavra THEN
        RETURN true;
      END IF;
    END LOOP;
    FOREACH palavra IN ARRAY prefixos LOOP
      IF length(segmento) > length(palavra) AND left(segmento, length(palavra)) = palavra THEN
        RETURN true;
      END IF;
    END LOOP;
  END LOOP;

  RETURN false;
END;
$$ LANGUAGE plpgsql IMMUTABLE;
