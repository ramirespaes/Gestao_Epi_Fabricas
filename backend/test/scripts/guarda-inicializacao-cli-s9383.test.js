'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

/**
 * Sonar S9383 (lote 04) — CLI da guarda de inicialização (encadeado em `npm start`). Uma rejeição inesperada de executar() sai com 1
 * (erro técnico, pelo contrato do CLI) e uma linha de código fixo no stderr: nunca a mensagem nem a pilha da falha, que podem conter
 * configuração do banco. O preload troca só o módulo da guarda, em processo próprio; nenhuma conexão é aberta.
 */

const CLI = path.join(__dirname, '..', '..', 'scripts', 'guarda-inicializacao.js');
const SENSIVEL = 'postgres://usuario:SENHA-SINTETICA@host-sintetico/banco';

function rodarComExecutarQueRejeita() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guarda-s9383-'));
  try {
    const preload = path.join(dir, 'preload.js');
    const alvo = path.join(__dirname, '..', '..', 'src', 'db', 'guarda-inicializacao.js');
    fs.writeFileSync(preload, [
      "'use strict';",
      "const Module = require('node:module');",
      `const ALVO = ${JSON.stringify(alvo)};`,
      'const carregar = Module._load;',
      'Module._load = function (pedido, pai, ...resto) {',
      "  if (pai && Module._resolveFilename(pedido, pai) === ALVO) return { executar: () => Promise.reject(new Error(" + JSON.stringify(SENSIVEL) + ')) };',
      '  return carregar.call(this, pedido, pai, ...resto);',
      '};',
    ].join('\n'));
    return spawnSync(process.execPath, ['--require', preload, CLI], { encoding: 'utf8', timeout: 20000, env: { PATH: process.env.PATH } });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('S9383 (lote 04) — CLI da guarda de inicialização', () => {
  test('S9383-B01 — executar() rejeita: sai com 1, código fixo no stderr, sem a mensagem nem a pilha da falha', () => {
    const r = rodarComExecutarQueRejeita();
    assert.equal(r.status, 1, `saída ${r.status}; stderr: ${r.stderr}`);
    assert.equal(r.stderr.includes('SENHA-SINTETICA'), false, 'a mensagem da falha não vai ao stderr');
    assert.doesNotMatch(r.stderr, /\n\s+at /, 'sem pilha no stderr');
    assert.match(r.stderr, /\[guarda\] GUARDA_FALHA_INESPERADA/);
    assert.equal(r.stdout, '');
  });
});
