'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * A única dependência nova do Bloco 11H, o nodemailer, fica fixada na versão
 * aprovada, sem faixa, sem dependências transitivas e sem scripts de
 * instalação. Uma atualização silenciosa ou uma mudança no pacote reprova aqui.
 */

const RAIZ = path.join(__dirname, '..', '..');
const VERSAO = '10.0.13';
const INTEGRIDADE = 'sha512-SzG86OlvcW/NNhUFC6uROMwRTL4n7MswfQqC/T8mhkmnY1YVa23zUEMYi4ijSeXSl9GLz9ZeTJDUatEDuY5FeQ==';
const lerJson = (...partes) => JSON.parse(fs.readFileSync(path.join(RAIZ, ...partes), 'utf8'));

describe('dependência nodemailer', () => {
  test('package.json fixa a versão exata, sem ^ nem ~, em dependencies', () => {
    const pacote = lerJson('package.json');
    assert.equal(pacote.dependencies.nodemailer, VERSAO);
    assert.equal(pacote.devDependencies?.nodemailer, undefined);
    assert.match(pacote.dependencies.nodemailer, /^\d+\.\d+\.\d+$/);
  });

  test('o lock registra a mesma versão e a integridade esperada, sem dependências e sem script de instalação', () => {
    const lock = lerJson('package-lock.json');
    const entrada = lock.packages['node_modules/nodemailer'];
    assert.equal(entrada.version, VERSAO);
    assert.equal(entrada.integrity, INTEGRIDADE);
    assert.equal(entrada.resolved, `https://registry.npmjs.org/nodemailer/-/nodemailer-${VERSAO}.tgz`);
    assert.equal(entrada.dependencies, undefined);
    assert.equal(entrada.optionalDependencies, undefined);
    assert.equal(entrada.hasInstallScript, undefined);
    assert.equal(lock.packages[''].dependencies.nodemailer, VERSAO);
    const outrosQueAPuxam = Object.entries(lock.packages).filter(([nome, p]) => nome !== '' && p.dependencies && 'nodemailer' in p.dependencies);
    assert.deepEqual(outrosQueAPuxam, []);
  });

  test('o pacote instalado confere: mesma versão, MIT-0, Node compatível com o projeto, sem scripts de instalação nem dependências', () => {
    const instalado = lerJson('node_modules', 'nodemailer', 'package.json');
    assert.equal(instalado.version, VERSAO);
    assert.equal(instalado.license, 'MIT-0');
    assert.equal(instalado.dependencies, undefined);
    for (const gancho of ['preinstall', 'install', 'postinstall']) assert.equal(instalado.scripts?.[gancho], undefined, gancho);
    const minimoDoPacote = Number(instalado.engines.node.match(/>=\s*(\d+)/)[1]);
    const minimoDoProjeto = Number(lerJson('package.json').engines.node.match(/>=\s*(\d+)/)[1]);
    assert.ok(minimoDoPacote <= minimoDoProjeto, `${minimoDoPacote} > ${minimoDoProjeto}`);
  });

  test('carrega por require (CommonJS) no Node em uso', () => {
    // eslint-disable-next-line global-require
    const nodemailer = require('nodemailer');
    assert.equal(typeof nodemailer.createTransport, 'function');
  });
});
