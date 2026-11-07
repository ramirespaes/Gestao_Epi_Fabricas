'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { criarLancadorDeRestauracaoComSpawn } = require('../../src/services/imagem-backup-restauracao-lancador.service');

/** D-F7 (opt-in) no lançador da restauração: o par PGSSLMODE/PGSSLROOTCERT é aceito inteiro ou nunca; spawn é falso e lança para encerrar o teste sem processo. */

let pasta;
let cert;
before(() => {
  pasta = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'rest-tls-'));
  cert = path.join(pasta, 'ca.pem');
  fs.writeFileSync(cert, 'sintetico', { mode: 0o600 });
});
after(() => fs.rmSync(pasta, { recursive: true, force: true }));

const HOST = 'db.interno.exemplo';
const politica = { prefixoDoBanco: 'restore_teste_', hostsAutorizados: [HOST], bancosProtegidos: ['safework'] };
const base = { PGPASSFILE: '/etc/safework/pgpass', PGHOST: HOST, PGPORT: '5432', PGUSER: 'usuario_x' };
const specCom = (ambiente) => ({
  executavel: '/usr/lib/postgresql/16/bin/pg_restore',
  argumentos: ['--exit-on-error', '--no-owner', '--no-privileges', '--single-transaction', '--dbname=restore_teste_abc'],
  ambiente, opcoes: { shell: false, detached: true, stdio: [7, 'ignore', 'ignore'] },
});
async function lancar(ambiente) {
  const chamadas = [];
  const l = criarLancadorDeRestauracaoComSpawn({ spawn: (...a) => { chamadas.push(a); throw Object.assign(new Error('x'), { code: 'EACCES' }); }, politicaDeDestino: politica });
  const e = await l.lancar(specCom(ambiente)).then(() => null, (x) => x);
  return { chamadas, codigo: e && e.code };
}

describe('[REST-TLS] lançador da restauração', () => {
  test('RTLS-01 — sem TLS: ambiente de quatro chaves segue válido e o spawn recebe quatro chaves', async () => {
    const r = await lancar(base);
    assert.equal(r.codigo, 'NAO_INICIADO');
    assert.deepEqual(Object.keys(r.chamadas[0][2].env), ['PGPASSFILE', 'PGHOST', 'PGPORT', 'PGUSER']);
  });

  test('RTLS-02 — com o par TLS válido: spawn recebe seis chaves com os mesmos valores', async () => {
    const r = await lancar({ ...base, PGSSLMODE: 'verify-full', PGSSLROOTCERT: cert });
    assert.equal(r.codigo, 'NAO_INICIADO');
    assert.deepEqual(r.chamadas[0][2].env, { ...base, PGSSLMODE: 'verify-full', PGSSLROOTCERT: cert });
  });

  test('RTLS-03 — par incompleto, modo fraco, certificado inseguro ou inexistente: SPEC_INVALIDO e nenhum spawn', async () => {
    const frouxo = path.join(pasta, 'frouxo.pem');
    fs.writeFileSync(frouxo, 'x', { mode: 0o666 }); fs.chmodSync(frouxo, 0o666);
    for (const amb of [
      { ...base, PGSSLMODE: 'verify-full' },
      { ...base, PGSSLROOTCERT: cert },
      { ...base, PGSSLMODE: 'require', PGSSLROOTCERT: cert },
      { ...base, PGSSLMODE: 'verify-full', PGSSLROOTCERT: frouxo },
      { ...base, PGSSLMODE: 'verify-full', PGSSLROOTCERT: path.join(pasta, 'nao.pem') },
      { ...base, PGSSLMODE: 'verify-full', PGSSLROOTCERT: cert, PGSSLCERT: '/x' },
    ]) {
      const r = await lancar(amb);
      assert.equal(r.codigo, 'SPEC_INVALIDO');
      assert.equal(r.chamadas.length, 0);
    }
  });
});
