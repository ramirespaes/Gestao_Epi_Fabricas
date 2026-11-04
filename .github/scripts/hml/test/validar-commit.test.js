'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { validarCommit, ciVerdeNaMain, rotuloDe, CI_CAMINHO } = require('../validar-commit');

const SCRIPT = path.join(__dirname, '..', 'validar-commit.js');
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const AGORA = Date.parse('2026-11-03T21:15:30.000Z');

const execucaoVerde = (sha, extra = {}) => ({ head_sha: sha, path: CI_CAMINHO, event: 'push', head_branch: 'main', status: 'completed', conclusion: 'success', ...extra });
const fatosBons = (extra = {}) => ({ commit: A, cabecaMain: A, ancestral: true, execucoesCi: [execucaoVerde(A)], permitirAnterior: false, agora: AGORA, ...extra });

function recusa(fatos, codigo) {
  assert.throws(() => validarCommit(fatos), (erro) => {
    assert.equal(erro.codigo, codigo, `esperado ${codigo}, veio ${erro.codigo}: ${erro.message}`);
    return true;
  });
}

describe('validar-commit — commit da main, CI verde e posição atual', () => {
  test('aceita a cabeça atual da main com CI verde no push e rotula a release', () => {
    const r = validarCommit(fatosBons());
    assert.deepEqual(r, { ok: true, commit: A, atual: true, rotulo: `hml-20261103T211530-${A.slice(0, 7)}`, cabecaMain: A });
  });

  test('commit anterior à main só passa com permitir_commit_anterior e sai rotulado como retroativo', () => {
    recusa(fatosBons({ cabecaMain: B }), 'COMMIT_ANTERIOR');
    recusa(fatosBons({ cabecaMain: B, permitirAnterior: 'true' }), 'COMMIT_ANTERIOR');
    const r = validarCommit(fatosBons({ cabecaMain: B, permitirAnterior: true }));
    assert.equal(r.atual, false);
    assert.equal(r.rotulo, `hml-20261103T211530-${A.slice(0, 7)}-retroativo`);
  });

  test('SHA abreviado, maiúsculo, vazio, com espaço ou de outro tipo é recusado antes de qualquer outro fato', () => {
    for (const commit of [A.slice(0, 7), A.toUpperCase(), '', ` ${A}`, `${A}\n`, 42, null, undefined, 'main', 'HEAD']) {
      recusa(fatosBons({ commit, ancestral: undefined, execucoesCi: undefined }), 'COMMIT_INVALIDO');
    }
  });

  test('commit fora da história da main é recusado, mesmo com CI verde', () => {
    recusa(fatosBons({ ancestral: false }), 'FORA_DA_MAIN');
    recusa(fatosBons({ ancestral: 'true' }), 'FORA_DA_MAIN');
    recusa(fatosBons({ ancestral: undefined }), 'FORA_DA_MAIN');
  });

  test('CI precisa ter execução concluída com sucesso, do workflow ci.yml, no push da main, para o mesmo SHA', () => {
    recusa(fatosBons({ execucoesCi: [] }), 'CI_NAO_VERDE');
    recusa(fatosBons({ execucoesCi: undefined }), 'CI_NAO_VERDE');
    recusa(fatosBons({ execucoesCi: 'success' }), 'CI_NAO_VERDE');
    recusa(fatosBons({ execucoesCi: [execucaoVerde(B)] }), 'CI_NAO_VERDE');
    recusa(fatosBons({ execucoesCi: [execucaoVerde(A, { conclusion: 'failure' })] }), 'CI_NAO_VERDE');
    recusa(fatosBons({ execucoesCi: [execucaoVerde(A, { status: 'in_progress', conclusion: null })] }), 'CI_NAO_VERDE');
    recusa(fatosBons({ execucoesCi: [execucaoVerde(A, { event: 'pull_request' })] }), 'CI_NAO_VERDE');
    recusa(fatosBons({ execucoesCi: [execucaoVerde(A, { head_branch: 'feature/x' })] }), 'CI_NAO_VERDE');
    recusa(fatosBons({ execucoesCi: [execucaoVerde(A, { path: '.github/workflows/deploy-hml.yml' })] }), 'CI_NAO_VERDE');
    recusa(fatosBons({ execucoesCi: [execucaoVerde(A, { conclusion: 'skipped' })] }), 'CI_NAO_VERDE');
    assert.equal(ciVerdeNaMain([execucaoVerde(A, { path: `${CI_CAMINHO}@refs/heads/main` })], A), true, 'a API pode anexar a referência ao caminho');
    recusa(fatosBons({ execucoesCi: [execucaoVerde(A, { path: `.github/workflows/outro.yml@${CI_CAMINHO}` })] }), 'CI_NAO_VERDE');
    recusa(fatosBons({ execucoesCi: [execucaoVerde(A, { path: undefined })] }), 'CI_NAO_VERDE');
    assert.equal(ciVerdeNaMain([execucaoVerde(A, { conclusion: 'failure' }), execucaoVerde(A)], A), true, 'uma execução verde entre falhas anteriores basta');
    assert.equal(ciVerdeNaMain([null, 1, 'x'], A), false);
  });

  test('fatos malformados são recusados', () => {
    recusa(undefined, 'FATO_INVALIDO');
    recusa(fatosBons({ cabecaMain: 'main' }), 'FATO_INVALIDO');
    recusa(fatosBons({ agora: 'ontem' }), 'FATO_INVALIDO');
  });

  test('o rótulo é determinístico, ordenável por data e carrega os 7 primeiros caracteres do SHA', () => {
    assert.equal(rotuloDe(A, true, AGORA), 'hml-20261103T211530-aaaaaaa');
    assert.equal(rotuloDe(B, false, AGORA + 1000), 'hml-20261103T211531-bbbbbbb-retroativo');
    assert.ok(rotuloDe(A, true, AGORA) < rotuloDe(A, true, AGORA + 60000));
  });

  test('linha de comando: sai 0 e grava rotulo/atual/commit em GITHUB_OUTPUT; sai 1 na recusa sem gravar', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hml-validar-'));
    try {
      const fatos = path.join(dir, 'fatos.json');
      const saidas = path.join(dir, 'saidas.txt');
      fs.writeFileSync(fatos, JSON.stringify(fatosBons()));
      const ok = spawnSync(process.execPath, [SCRIPT, '--fatos', fatos], { encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: saidas } });
      assert.equal(ok.status, 0, ok.stderr);
      assert.equal(fs.readFileSync(saidas, 'utf8'), `rotulo=hml-20261103T211530-${A.slice(0, 7)}\natual=true\ncommit=${A}\n`);

      fs.writeFileSync(fatos, JSON.stringify(fatosBons({ cabecaMain: B })));
      const saidasRecusa = path.join(dir, 'saidas-recusa.txt');
      const recusada = spawnSync(process.execPath, [SCRIPT, '--fatos', fatos], { encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: saidasRecusa } });
      assert.equal(recusada.status, 1);
      assert.match(recusada.stderr, /COMMIT_ANTERIOR/);
      assert.equal(fs.existsSync(saidasRecusa), false);

      const semArgumento = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
      assert.equal(semArgumento.status, 1);
      fs.writeFileSync(fatos, '{ não é json');
      assert.equal(spawnSync(process.execPath, [SCRIPT, '--fatos', fatos], { encoding: 'utf8' }).status, 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
