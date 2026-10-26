-- 091: Dados da Empresa (F1) — e-mails de SST e Almoxarifado e controle de versão do cadastro.
--
-- Estritamente aditiva: nenhuma coluna existente muda, nenhum dado é reescrito (as linhas existentes ficam
-- com e-mails nulos e versao = 1). Migrations anteriores (001, 016, 032) permanecem intocadas.
--
--  * email_sst / email_almoxarifado: um endereço de cada, anuláveis, VARCHAR(150) como os demais e-mails da empresa.
--    Formato e normalização são da aplicação (utils/normalizacao.normalizarEmail); o banco só limita o tamanho
--    e recusa vazio (mesma disciplina do restante do cadastro: ausência é NULL).
--  * versao: contador inteiro do cadastro, base da comparação-e-troca atômica (UPDATE ... WHERE versao = esperada).
--    Não usa atualizado_em: o gatilho set_atualizado_em muda o carimbo em QUALQUER UPDATE e o driver JS entrega
--    timestamptz com precisão de milissegundos contra microssegundos do banco.
--
-- Quem incrementa é o banco, nos DOIS fluxos (Portal e Painel Privado) e em qualquer escrita futura: o gatilho
-- BEFORE UPDATE avança a versão somente quando alguma coluna cadastral realmente mudou (compara as linhas sem
-- `versao` e `atualizado_em`). Um UPDATE sem mudança de valor mantém a versão; o cliente nunca consegue defini-la
-- (o valor enviado é sempre sobrescrito pelo gatilho).

ALTER TABLE empresas
  ADD COLUMN email_sst VARCHAR(150),
  ADD COLUMN email_almoxarifado VARCHAR(150),
  ADD COLUMN versao INTEGER NOT NULL DEFAULT 1;

ALTER TABLE empresas
  ADD CONSTRAINT chk_empresas_email_sst CHECK (email_sst IS NULL OR length(email_sst) BETWEEN 1 AND 150),
  ADD CONSTRAINT chk_empresas_email_almoxarifado CHECK (email_almoxarifado IS NULL OR length(email_almoxarifado) BETWEEN 1 AND 150),
  ADD CONSTRAINT chk_empresas_versao CHECK (versao >= 1);

CREATE FUNCTION empresas_controlar_versao() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (to_jsonb(NEW) - 'versao' - 'atualizado_em') IS DISTINCT FROM (to_jsonb(OLD) - 'versao' - 'atualizado_em') THEN
    NEW.versao := OLD.versao + 1;
  ELSE
    NEW.versao := OLD.versao;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_empresas_controlar_versao
  BEFORE UPDATE ON empresas
  FOR EACH ROW EXECUTE FUNCTION empresas_controlar_versao();
