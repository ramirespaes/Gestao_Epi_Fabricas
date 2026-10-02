'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const util = require('node:util');
const { assertSemSensiveis } = require('../helpers/sensiveis');
const { exigirModulo } = require('../helpers/exigir-modulo');

/**
 * Configuração da entrega de e-mail (Bloco 11C e 11H). Fora de production a
 * entrega fica desativada, grava em arquivo (fora do repositório) ou usa SMTP;
 * em production só o SMTP com TLS verdadeiro serve, e o processo não sobe sem
 * ele. Tudo testado com ambiente artificial; nenhum teste altera process.env.
 */

const config = () => exigirModulo('src/config/email');
const RAIZ_REPOSITORIO = path.join(__dirname, '..', '..', '..');
const FORA_DO_REPOSITORIO = path.join(os.tmpdir(), 'gepi-emails-de-teste');

const SENHA_SMTP = 'senhaSmtpFicticiaParaTeste42';
const SMTP_VALIDO = Object.freeze({
  EMAIL_MODO: 'smtp',
  SMTP_HOST: 'smtp.exemplo-provedor.test',
  SMTP_USUARIO: 'usuarioSmtpFicticio',
  SMTP_SENHA: SENHA_SMTP,
});
const PRODUCAO_VALIDA = Object.freeze({ NODE_ENV: 'production', ...SMTP_VALIDO });

const REMETENTE_PADRAO = Object.freeze({ nome: 'SafeWork Engenharia', endereco: 'no-reply@safeworkengenharia.com.br' });
const SUPORTE_PADRAO = 'suporte@safeworkengenharia.com.br';

const erroDe = (env) => {
  const { carregarConfigEmail } = config();
  try {
    carregarConfigEmail(env);
    return null;
  } catch (erro) {
    return erro.message;
  }
};

describe('carregarConfigEmail: modos desativado e arquivo', () => {
  test('sem nenhuma variável, fora de production, a entrega fica desativada, com o remetente e o suporte aprovados', () => {
    for (const env of [{}, { NODE_ENV: 'development' }, { NODE_ENV: 'test' }]) {
      assert.deepEqual(
        config().carregarConfigEmail(env),
        { modo: 'desativado', arquivo: null, smtp: null, remetente: REMETENTE_PADRAO, suporte: SUPORTE_PADRAO },
        JSON.stringify(env),
      );
    }
  });

  test('modo arquivo: exige diretório absoluto e fora do repositório', () => {
    const carregada = config().carregarConfigEmail({ EMAIL_MODO: 'arquivo', EMAIL_ARQUIVO_DIRETORIO: FORA_DO_REPOSITORIO });
    assert.equal(carregada.modo, 'arquivo');
    assert.deepEqual(carregada.arquivo, { diretorio: FORA_DO_REPOSITORIO });
    assert.equal(carregada.smtp, null);
    assert.match(erroDe({ EMAIL_MODO: 'arquivo' }), /EMAIL_ARQUIVO_DIRETORIO: obrigatória no modo arquivo/);
    assert.match(erroDe({ EMAIL_MODO: 'arquivo', EMAIL_ARQUIVO_DIRETORIO: 'emails-dev' }), /EMAIL_ARQUIVO_DIRETORIO: deve ser um caminho absoluto/);
    assert.match(erroDe({ EMAIL_MODO: 'arquivo', EMAIL_ARQUIVO_DIRETORIO: './emails-dev' }), /EMAIL_ARQUIVO_DIRETORIO: deve ser um caminho absoluto/);
  });

  test('diretório dentro do repositório é recusado, inclusive por caminho com ".."', () => {
    const dentro = [
      RAIZ_REPOSITORIO,
      path.join(RAIZ_REPOSITORIO, 'backend', 'emails-dev'),
      path.join(RAIZ_REPOSITORIO, 'frontend'),
      `${RAIZ_REPOSITORIO}${path.sep}backend${path.sep}..${path.sep}frontend`,
    ];
    for (const diretorio of dentro) {
      assert.equal(path.resolve(diretorio).startsWith(RAIZ_REPOSITORIO), true, 'caso de teste mal montado');
      assert.match(
        erroDe({ EMAIL_MODO: 'arquivo', EMAIL_ARQUIVO_DIRETORIO: diretorio }),
        /EMAIL_ARQUIVO_DIRETORIO: não pode ficar dentro do repositório/,
      );
    }
    const vizinho = `${RAIZ_REPOSITORIO}${path.sep}..${path.sep}gepi-emails-vizinho`;
    assert.equal(
      config().carregarConfigEmail({ EMAIL_MODO: 'arquivo', EMAIL_ARQUIVO_DIRETORIO: vizinho }).arquivo.diretorio,
      path.resolve(vizinho),
    );
  });

  test('modo desconhecido é recusado, a lista de modos inclui smtp e a mensagem não traz o valor recebido', () => {
    assert.match(erroDe({ EMAIL_MODO: 'modoEstranho123' }), /EMAIL_MODO: deve ser um de: desativado, arquivo, smtp/);
    assertSemSensiveis(erroDe({ EMAIL_MODO: 'modoEstranho123' }), ['modoEstranho123'], 'erro do modo');
    assertSemSensiveis(
      erroDe({ EMAIL_MODO: 'arquivo', EMAIL_ARQUIVO_DIRETORIO: 'caminhoRelativoSecreto' }), ['caminhoRelativoSecreto'], 'erro do diretório',
    );
  });

  test('variáveis de SMTP são ignoradas fora do modo smtp e nunca entram na configuração', () => {
    const carregada = config().carregarConfigEmail({ ...SMTP_VALIDO, EMAIL_MODO: 'desativado' });
    assert.equal(carregada.smtp, null);
    assertSemSensiveis(JSON.stringify(carregada), [SENHA_SMTP, 'usuarioSmtpFicticio', 'smtp.exemplo-provedor.test'], 'configuração');
  });
});

describe('carregarConfigEmail: modo smtp', () => {
  test('padrões aprovados: porta 587, STARTTLS e timeout de 10 000 ms; o usuário e o host vêm do ambiente', () => {
    const carregada = config().carregarConfigEmail(SMTP_VALIDO);
    assert.equal(carregada.modo, 'smtp');
    assert.equal(carregada.arquivo, null);
    assert.deepEqual(
      { ...carregada.smtp },
      { host: 'smtp.exemplo-provedor.test', porta: 587, seguranca: 'starttls', usuario: 'usuarioSmtpFicticio', timeoutMs: 10000 },
    );
    assert.deepEqual({ ...carregada.remetente }, REMETENTE_PADRAO);
    assert.equal(carregada.suporte, SUPORTE_PADRAO);
  });

  test('a senha existe para o transporte, mas não aparece em JSON, inspeção nem em cópia da configuração', () => {
    const { smtp } = config().carregarConfigEmail(SMTP_VALIDO);
    assert.equal(smtp.senha, SENHA_SMTP);
    assert.equal(Object.keys(smtp).includes('senha'), false);
    assertSemSensiveis(JSON.stringify(smtp), [SENHA_SMTP], 'JSON');
    assertSemSensiveis(util.inspect(smtp, { depth: 5, showHidden: false }), [SENHA_SMTP], 'util.inspect');
    assertSemSensiveis(JSON.stringify({ ...smtp }), [SENHA_SMTP], 'cópia');
  });

  test('configuração congelada em todos os níveis', () => {
    const carregada = config().carregarConfigEmail(SMTP_VALIDO);
    for (const objeto of [carregada, carregada.smtp, carregada.remetente]) assert.equal(Object.isFrozen(objeto), true);
  });

  test('porta e timeout: decimal canônico dentro da faixa; fora dela é recusado', () => {
    const { carregarConfigEmail } = config();
    assert.equal(carregarConfigEmail({ ...SMTP_VALIDO, SMTP_PORTA: '465', SMTP_SEGURANCA: 'tls' }).smtp.porta, 465);
    assert.equal(carregarConfigEmail({ ...SMTP_VALIDO, SMTP_TIMEOUT_MS: '30000' }).smtp.timeoutMs, 30000);
    assert.equal(carregarConfigEmail({ ...SMTP_VALIDO, SMTP_TIMEOUT_MS: '1000' }).smtp.timeoutMs, 1000);
    for (const porta of ['0', '65536', '587.0', '0587', 'abc', '-1']) {
      assert.match(erroDe({ ...SMTP_VALIDO, SMTP_PORTA: porta }), /SMTP_PORTA:/, porta);
    }
    for (const timeout of ['999', '30001', '10s', '1e4']) {
      assert.match(erroDe({ ...SMTP_VALIDO, SMTP_TIMEOUT_MS: timeout }), /SMTP_TIMEOUT_MS:/, timeout);
    }
  });

  test('host obrigatório e só hostname: sem esquema, porta, caminho, espaço ou quebra de linha', () => {
    assert.match(erroDe({ EMAIL_MODO: 'smtp' }), /SMTP_HOST: obrigatória no modo smtp/);
    for (const host of ['smtp://host.test', 'host.test:587', 'host.test/caminho', 'host .test', 'host.test\r\nBcc: x@y.test']) {
      assert.match(erroDe({ ...SMTP_VALIDO, SMTP_HOST: host }), /SMTP_HOST: deve ser um hostname válido/, JSON.stringify(host));
    }
  });

  test('segurança: starttls, tls ou nenhuma; qualquer outro valor é recusado sem ecoar o valor', () => {
    const { carregarConfigEmail } = config();
    for (const seguranca of ['starttls', 'tls', 'nenhuma']) {
      assert.equal(carregarConfigEmail({ ...SMTP_VALIDO, SMTP_SEGURANCA: seguranca }).smtp.seguranca, seguranca);
    }
    assert.match(erroDe({ ...SMTP_VALIDO, SMTP_SEGURANCA: 'oportunista' }), /SMTP_SEGURANCA: deve ser um de: starttls, tls, nenhuma/);
    assertSemSensiveis(erroDe({ ...SMTP_VALIDO, SMTP_SEGURANCA: 'oportunista' }), ['oportunista'], 'erro da segurança');
  });

  test('usuário e senha vêm juntos; fora de production podem faltar os dois (captador local sem autenticação)', () => {
    const { carregarConfigEmail } = config();
    const semAuth = carregarConfigEmail({ EMAIL_MODO: 'smtp', SMTP_HOST: '127.0.0.1', SMTP_PORTA: '1025', SMTP_SEGURANCA: 'nenhuma' });
    assert.equal(semAuth.smtp.usuario, null);
    assert.equal(semAuth.smtp.senha, undefined);
    assert.match(erroDe({ EMAIL_MODO: 'smtp', SMTP_HOST: 'h.test', SMTP_USUARIO: 'so-usuario' }), /SMTP_SENHA: obrigatória quando há SMTP_USUARIO/);
    assert.match(erroDe({ EMAIL_MODO: 'smtp', SMTP_HOST: 'h.test', SMTP_SENHA: 'so-senha-12345' }), /SMTP_USUARIO: obrigatória quando há SMTP_SENHA/);
    assert.match(erroDe({ ...SMTP_VALIDO, SMTP_USUARIO: 'usuario\r\nBcc: x@y.test' }), /SMTP_USUARIO: não pode conter quebra de linha/);
  });
});

describe('carregarConfigEmail: production', () => {
  test('só o modo smtp é aceito: desativado, arquivo ou ausente falham fechados', () => {
    const esperado = /EMAIL_MODO: em production só o modo smtp é aceito/;
    assert.match(erroDe({ NODE_ENV: 'production' }), esperado);
    assert.match(erroDe({ NODE_ENV: 'production', EMAIL_MODO: 'desativado' }), esperado);
    assert.match(erroDe({ NODE_ENV: 'production', EMAIL_MODO: 'arquivo', EMAIL_ARQUIVO_DIRETORIO: FORA_DO_REPOSITORIO }), esperado);
  });

  test('smtp válido em production: STARTTLS ou TLS, com host, usuário e senha', () => {
    const { carregarConfigEmail } = config();
    assert.equal(carregarConfigEmail(PRODUCAO_VALIDA).smtp.seguranca, 'starttls');
    assert.equal(carregarConfigEmail({ ...PRODUCAO_VALIDA, SMTP_PORTA: '465', SMTP_SEGURANCA: 'tls' }).smtp.seguranca, 'tls');
  });

  test('sem TLS é recusado em production, e não existe variável alguma para afrouxar a validação do certificado', () => {
    assert.match(erroDe({ ...PRODUCAO_VALIDA, SMTP_SEGURANCA: 'nenhuma' }), /SMTP_SEGURANCA: em production exige starttls ou tls/);
    const afrouxadas = { SMTP_TLS_REJEITAR_NAO_AUTORIZADO: 'false', SMTP_REJECT_UNAUTHORIZED: 'false', NODE_TLS_REJECT_UNAUTHORIZED: '0', SMTP_IGNORAR_CERTIFICADO: 'true' };
    const carregada = config().carregarConfigEmail({ ...PRODUCAO_VALIDA, ...afrouxadas });
    assert.deepEqual(Object.keys(carregada.smtp).sort(), ['host', 'porta', 'seguranca', 'timeoutMs', 'usuario']);
    assertSemSensiveis(JSON.stringify(carregada), ['rejeitar', 'unauthorized', 'certificado'], 'configuração');
  });

  test('host, usuário e senha são obrigatórios em production', () => {
    assert.match(erroDe({ NODE_ENV: 'production', EMAIL_MODO: 'smtp' }), /SMTP_HOST: obrigatória no modo smtp/);
    assert.match(erroDe({ NODE_ENV: 'production', EMAIL_MODO: 'smtp', SMTP_HOST: 'h.test' }), /SMTP_USUARIO: obrigatória em production/);
    assert.match(erroDe({ NODE_ENV: 'production', EMAIL_MODO: 'smtp', SMTP_HOST: 'h.test', SMTP_USUARIO: 'u' }), /SMTP_SENHA: obrigatória/);
  });

  test('as mensagens de erro nunca trazem host, usuário nem senha recebidos', () => {
    const textos = [
      erroDe({ ...PRODUCAO_VALIDA, SMTP_SEGURANCA: 'nenhuma' }),
      erroDe({ ...PRODUCAO_VALIDA, SMTP_PORTA: '99999' }),
      erroDe({ ...PRODUCAO_VALIDA, SMTP_HOST: 'host invalido.test' }),
      erroDe({ NODE_ENV: 'production', ...SMTP_VALIDO, EMAIL_MODO: 'arquivo' }),
    ];
    for (const texto of textos) {
      assertSemSensiveis(texto, [SENHA_SMTP, 'usuarioSmtpFicticio', 'smtp.exemplo-provedor.test', 'host invalido'], 'erro de configuração');
    }
  });
});

describe('carregarConfigEmail: remetente e suporte', () => {
  test('o remetente e o suporte podem ser trocados por ambiente (homologação), mas sempre válidos', () => {
    const carregada = config().carregarConfigEmail({
      EMAIL_REMETENTE_NOME: 'SafeWork Homologação',
      EMAIL_REMETENTE_ENDERECO: 'no-reply@homolog.exemplo.test',
      EMAIL_SUPORTE_ENDERECO: 'suporte@homolog.exemplo.test',
    });
    assert.deepEqual({ ...carregada.remetente }, { nome: 'SafeWork Homologação', endereco: 'no-reply@homolog.exemplo.test' });
    assert.equal(carregada.suporte, 'suporte@homolog.exemplo.test');
  });

  test('sem quebra de linha, sem sinais de endereço e sem formato inválido nos campos do remetente', () => {
    for (const nome of ['Nome\r\nBcc: x@y.test', 'Nome <x@y.test>', 'Nome "aspas"', 'Nome, outro', 'Nome;outro', 'x'.repeat(81)]) {
      assert.match(erroDe({ EMAIL_REMETENTE_NOME: nome }), /EMAIL_REMETENTE_NOME: /, JSON.stringify(nome));
    }
    for (const endereco of ['sem-arroba', 'a@b', 'A@B.COM', 'dois@enderecos.test,outro@x.test', 'x@y.test\r\nBcc: z@y.test', 'acentuado@éxemplo.test']) {
      assert.match(erroDe({ EMAIL_REMETENTE_ENDERECO: endereco }), /EMAIL_REMETENTE_ENDERECO: /, JSON.stringify(endereco));
      assert.match(erroDe({ EMAIL_SUPORTE_ENDERECO: endereco }), /EMAIL_SUPORTE_ENDERECO: /, JSON.stringify(endereco));
    }
  });

  test('a configuração carregada do ambiente de teste é a desativada, com os valores aprovados', () => {
    const { emailConfig } = config();
    assert.equal(emailConfig.modo, 'desativado');
    assert.equal(emailConfig.smtp, null);
    assert.deepEqual({ ...emailConfig.remetente }, REMETENTE_PADRAO);
    assert.equal(emailConfig.suporte, SUPORTE_PADRAO);
  });
});
