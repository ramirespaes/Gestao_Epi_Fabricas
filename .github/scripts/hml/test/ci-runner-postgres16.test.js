'use strict';
// Regressão: o job de integração depende de pg_dump/pg_restore 16 do runner (P4b, P7 e P12 os procuram em
// /usr/lib/postgresql/16/bin). `ubuntu-latest` é um rótulo flutuante: em 19/11/2026 passou de ubuntu-24.04 (PostgreSQL 16)
// para ubuntu-26.04 (PostgreSQL 18) e os três testes passaram a falhar com PG_BINARIOS_16_INDISPONIVEIS.
// Este teste exige que esse job declare um runner EXPLÍCITO e fixo. Ele não confere versões de pacotes pré-instalados.
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CAMINHO = path.resolve(__dirname, '../../../../.github/workflows/ci.yml');
const yaml = fs.readFileSync(CAMINHO, 'utf8');
const JOB = 'integracao-postgresql';

function blocoDoJob(nome) {
  const ini = yaml.indexOf(`\n  ${nome}:\n`);
  if (ini < 0) return '';
  const resto = yaml.slice(ini + 1);
  const primeiraLinha = resto.indexOf('\n') + 1;
  const prox = resto.slice(primeiraLinha).search(/\n  [A-Za-z0-9_-]+:\n/);
  return prox < 0 ? resto : resto.slice(0, primeiraLinha + prox);
}
const runnerDe = (bloco) => {
  const m = /^    runs-on: (\S+)\s*(?:#.*)?$/m.exec(bloco);
  return m ? m[1] : null;
};

describe('ci.yml: runner explícito para o job que usa os binários do PostgreSQL 16', () => {
  test('o job de integração existe', () => {
    assert.ok(blocoDoJob(JOB).length > 0, `job ${JOB} ausente`);
  });
  test('declara um runner explícito e fixo (ubuntu-AA.MM), nunca um rótulo flutuante como ubuntu-latest', () => {
    const runner = runnerDe(blocoDoJob(JOB));
    assert.notEqual(runner, null, 'runs-on não encontrado no job');
    assert.doesNotMatch(runner, /latest/i, `runner flutuante: ${runner}`);
    assert.match(runner, /^ubuntu-\d{2}\.\d{2}$/, `o runner precisa ser um rótulo fixo, veio ${runner}`);
  });
  test('o runner fixo é o ubuntu-24.04, imagem em que o PostgreSQL 16 do runner é o esperado pelos testes', () => {
    assert.equal(runnerDe(blocoDoJob(JOB)), 'ubuntu-24.04');
  });
  test('o serviço de banco do mesmo job continua sendo o PostgreSQL 16', () => {
    assert.match(blocoDoJob(JOB), /services:\n\s+postgres:\n\s+image: postgres:16\n/);
  });
  test('o job continua executando a suíte de integração e a marcação da instância efêmera', () => {
    const b = blocoDoJob(JOB);
    assert.match(b, /run: npm run test:integracao/);
    assert.match(b, /GEPI_CI_EFEMERO/);
  });
  test('o parser YAML do Ruby (presente nos runners do GitHub) confirma o runner do job e a integridade do arquivo', (t) => {
    const r = spawnSync('ruby', ['-ryaml', '-rjson', '-e', 'puts JSON.generate(YAML.safe_load(File.read(ARGV[0]), aliases: false))', CAMINHO], { encoding: 'utf8' });
    if (r.error && r.error.code === 'ENOENT') { t.diagnostic('ruby ausente: só a verificação textual foi feita'); return; }
    assert.equal(r.status, 0, `YAML inválido: ${r.stderr}`);
    const y = JSON.parse(r.stdout);
    assert.equal(y.jobs[JOB]['runs-on'], 'ubuntu-24.04');
    assert.deepEqual(Object.keys(y.jobs), ['verificacoes-sem-banco', JOB]);
  });
});
