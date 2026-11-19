'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const LIB = path.join(__dirname, '..', 'lib');

// Pré-carga: a primeira escrita cujo texto contém o marcador lança, o que faz principal() rejeitar.
const PRECARGA = `
const alvo = process.env.TESTE_STREAM === 'stdout' ? process.stdout : process.stderr;
const original = alvo.write.bind(alvo);
let disparou = false;
alvo.write = (texto, ...resto) => {
  if (!disparou && String(texto).includes(process.env.TESTE_MARCADOR)) { disparou = true; throw new Error('falha injetada'); }
  return original(texto, ...resto);
};
`;

function executar(modulo, argumentos, stream, marcador) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-cli-rej-'));
  try {
    const precarga = path.join(dir, 'precarga.js');
    fs.writeFileSync(precarga, PRECARGA);
    return spawnSync(process.execPath, ['-r', precarga, path.join(LIB, modulo), ...argumentos.map((a) => a.replace('@DIR@', dir))], {
      encoding: 'utf8', timeout: 10000, env: { PATH: process.env.PATH, TESTE_STREAM: stream, TESTE_MARCADOR: marcador },
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const CASOS = [
  { nome: 'arquivos.js', modulo: 'arquivos.js', argumentos: ['copiar', '@DIR@'], stream: 'stderr', marcador: 'ERRO E_CONFIG', saidaNormal: 2 },
  { nome: 'manifesto.js', modulo: 'manifesto.js', argumentos: ['verificar', '@DIR@'], stream: 'stdout', marcador: '"ok"', saidaNormal: 1 },
  { nome: 'referencias.js', modulo: 'referencias.js', argumentos: ['gerar', '@DIR@', '--opcao-invalida'], stream: 'stderr', marcador: 'ERRO E_CONFIG', saidaNormal: 2 },
];

for (const c of CASOS) {
  test(`${c.nome}: rejeição assíncrona do ponto de entrada vira ERRO E_INESPERADO e código 5, sem crash não tratado`, () => {
    const r = executar(c.modulo, c.argumentos, c.stream, c.marcador);
    assert.equal(r.status, 5, r.stderr);
    assert.match(r.stderr, /^ERRO E_INESPERADO\n$/);
    assert.doesNotMatch(r.stderr, /falha injetada|at |UnhandledPromiseRejection/);
  });

  test(`${c.nome}: sem falha injetada, o código de saída e a mensagem existentes são preservados`, () => {
    const r = executar(c.modulo, c.argumentos, c.stream, 'MARCADOR_QUE_NAO_OCORRE');
    assert.equal(r.status, c.saidaNormal, r.stderr);
    assert.doesNotMatch(r.stderr, /E_INESPERADO/);
  });
}
