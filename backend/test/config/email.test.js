'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { assertSemSensiveis } = require('../helpers/sensiveis');
const { exigirModulo } = require('../helpers/exigir-modulo');

/**
 * Configuração da entrega de e-mail (Bloco 11C). Ainda não existe provedor
 * real: fora de production a entrega fica desativada ou grava em arquivo,
 * num diretório fora do repositório; em production a configuração é
 * recusada, para o backend não subir sem ter como entregar o link.
 * Tudo testado com ambiente artificial; nenhum teste altera process.env.
 */

const config = () => exigirModulo('src/config/email');
const RAIZ_REPOSITORIO = path.join(__dirname, '..', '..', '..');
const FORA_DO_REPOSITORIO = path.join(os.tmpdir(), 'gepi-emails-de-teste');

const erroDe = (env) => {
  const { carregarConfigEmail } = config();
  try {
    carregarConfigEmail(env);
    return null;
  } catch (erro) {
    return erro.message;
  }
};

describe('carregarConfigEmail', () => {
  test('sem nenhuma variável, fora de production, a entrega fica desativada', () => {
    for (const env of [{}, { NODE_ENV: 'development' }, { NODE_ENV: 'test' }]) {
      assert.deepEqual(config().carregarConfigEmail(env), { modo: 'desativado', arquivo: null }, JSON.stringify(env));
    }
  });

  test('modo arquivo: exige diretório absoluto e fora do repositório', () => {
    assert.deepEqual(
      config().carregarConfigEmail({ EMAIL_MODO: 'arquivo', EMAIL_ARQUIVO_DIRETORIO: FORA_DO_REPOSITORIO }),
      { modo: 'arquivo', arquivo: { diretorio: FORA_DO_REPOSITORIO } },
    );
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
      `${FORA_DO_REPOSITORIO}${path.sep}..${path.sep}..${path.sep}..${path.sep}..${path.sep}..${path.sep}..${path.sep}..${path.sep}..${RAIZ_REPOSITORIO}${path.sep}backend`,
    ];
    for (const diretorio of dentro) {
      assert.equal(path.resolve(diretorio).startsWith(RAIZ_REPOSITORIO), true, 'caso de teste mal montado');
      assert.match(
        erroDe({ EMAIL_MODO: 'arquivo', EMAIL_ARQUIVO_DIRETORIO: diretorio }),
        /EMAIL_ARQUIVO_DIRETORIO: não pode ficar dentro do repositório/,
      );
    }
    // Passar pelo repositório e sair dele com ".." resolve para fora: aceito, já normalizado.
    const vizinho = `${RAIZ_REPOSITORIO}${path.sep}..${path.sep}gepi-emails-vizinho`;
    assert.equal(
      config().carregarConfigEmail({ EMAIL_MODO: 'arquivo', EMAIL_ARQUIVO_DIRETORIO: vizinho }).arquivo.diretorio,
      path.resolve(vizinho),
    );
  });

  test('modo desconhecido é recusado e a mensagem não traz o valor recebido', () => {
    assert.match(erroDe({ EMAIL_MODO: 'smtp' }), /EMAIL_MODO: deve ser um de: desativado, arquivo/);
    assertSemSensiveis(erroDe({ EMAIL_MODO: 'modoEstranho123' }), ['modoEstranho123'], 'erro do modo');
    assertSemSensiveis(
      erroDe({ EMAIL_MODO: 'arquivo', EMAIL_ARQUIVO_DIRETORIO: 'caminhoRelativoSecreto' }), ['caminhoRelativoSecreto'], 'erro do diretório',
    );
  });

  test('production: sem provedor real a configuração falha fechada, com qualquer modo', () => {
    const esperado = /EMAIL_MODO: nenhum provedor de e-mail disponível para production/;
    assert.match(erroDe({ NODE_ENV: 'production' }), esperado);
    assert.match(erroDe({ NODE_ENV: 'production', EMAIL_MODO: 'desativado' }), esperado);
    assert.match(erroDe({ NODE_ENV: 'production', EMAIL_MODO: 'arquivo', EMAIL_ARQUIVO_DIRETORIO: FORA_DO_REPOSITORIO }), esperado);
  });

  test('configuração congelada; a carregada do ambiente de teste é a desativada', () => {
    const carregada = config().carregarConfigEmail({ EMAIL_MODO: 'arquivo', EMAIL_ARQUIVO_DIRETORIO: FORA_DO_REPOSITORIO });
    assert.equal(Object.isFrozen(carregada), true);
    assert.equal(Object.isFrozen(carregada.arquivo), true);
    assert.deepEqual(config().emailConfig, { modo: 'desativado', arquivo: null });
  });
});
