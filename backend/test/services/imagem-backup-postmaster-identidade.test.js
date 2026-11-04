'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { exigirModulo } = require('../helpers/exigir-modulo');

/**
 * BACKUP PERMANENTE da Biblioteca de Imagens (D-ORF-6): IDENTIDADE DO POSTMASTER efêmero, função pura (sem processo, sem disco). Decide se o processo observado é COMPROVADAMENTE o postmaster que a sentinela lançou
 * e, à parte, se o ISOLAMENTO está comprovado (a condição extra exigida para o SIGQUIT de emergência). Qualquer ausência é falha; nunca presunção.
 */

const MODULO = 'src/services/imagem-backup-postmaster-identidade.service';
const m = () => exigirModulo(MODULO);
const PGDATA = '/Users/x/area/pgdata';
const SOCK = '/Users/x/area/s';

const esperado = () => ({ pid: 4100, pgdata: PGDATA, porta: 55433, socket: SOCK, uid: 501, ppid: 4000, inicio: 'Wed Oct 28 10:00:00 2026', executavel: 'postgres' });
const observadoOk = () => ({
  filho: { pid: 4100, exitCode: null, signalCode: null },
  pidArquivo: { pid: 4100, pgdata: PGDATA, porta: 55433, socket: SOCK, listen: '' },
  ps: { uid: 501, ppid: 4000, inicio: 'Wed Oct 28 10:00:00 2026', comando: `/Applications/Postgres.app/bin/postgres -D ${PGDATA} -c listen_addresses= -c port=55433` },
});

describe('[PMI] identidade do postmaster', () => {
  test('PMI-01 — tudo confere: identidade E isolamento comprovados', () => {
    const r = m().avaliarIdentidadeDoPostmaster({ esperado: esperado(), observado: observadoOk() });
    assert.deepEqual({ ...r, falhas: [...r.falhas] }, { comprovada: true, isolamento: true, falhas: [] });
  });

  for (const [nome, ajuste, falha] of [
    ['filho com outro pid', (o) => { o.filho.pid = 4101; }, 'FILHO_DIVERGENTE'],
    ['filho já terminado', (o) => { o.filho.exitCode = 0; }, 'FILHO_JA_TERMINOU'],
    ['postmaster.pid ausente', (o) => { o.pidArquivo = null; }, 'POSTMASTER_PID_AUSENTE'],
    ['postmaster.pid com outro pid (processo externo)', (o) => { o.pidArquivo.pid = 9999; }, 'POSTMASTER_PID_DIVERGENTE'],
    ['postmaster.pid com outro PGDATA (PostgreSQL persistente)', (o) => { o.pidArquivo.pgdata = '/Users/x/persistente/pgdata'; }, 'POSTMASTER_PGDATA_DIVERGENTE'],
    ['ps ausente', (o) => { o.ps = null; }, 'PS_AUSENTE'],
    ['dono diferente', (o) => { o.ps.uid = 0; }, 'DONO_DIVERGENTE'],
    ['pai diferente (não é a sentinela)', (o) => { o.ps.ppid = 1; }, 'PAI_DIVERGENTE'],
    ['início diferente (pid reutilizado)', (o) => { o.ps.inicio = 'Wed Oct 28 11:00:00 2026'; }, 'INICIO_DIVERGENTE'],
    ['executável diferente', (o) => { o.ps.comando = `/usr/bin/outro -D ${PGDATA}`; }, 'COMANDO_DIVERGENTE'],
    ['mesmo executável com outro PGDATA', (o) => { o.ps.comando = '/Applications/Postgres.app/bin/postgres -D /Users/x/outro/pgdata'; }, 'COMANDO_DIVERGENTE'],
  ]) {
    test(`PMI-02 — ${nome}: identidade NÃO comprovada (${falha})`, () => {
      const o = observadoOk();
      ajuste(o);
      const r = m().avaliarIdentidadeDoPostmaster({ esperado: esperado(), observado: o });
      assert.equal(r.comprovada, false);
      assert.ok(r.falhas.includes(falha), JSON.stringify(r.falhas));
    });
  }

  for (const [nome, ajuste, falha] of [
    ['porta diferente', (o) => { o.pidArquivo.porta = 5432; }, 'ISOLAMENTO_PORTA_DIVERGENTE'],
    ['socket diferente', (o) => { o.pidArquivo.socket = '/tmp'; }, 'ISOLAMENTO_SOCKET_DIVERGENTE'],
    ['listener TCP presente', (o) => { o.pidArquivo.listen = '*'; }, 'ISOLAMENTO_LISTEN_NAO_VAZIO'],
  ]) {
    test(`PMI-03 — ${nome}: identidade pode conferir, mas o ISOLAMENTO não (${falha}) e o SIGQUIT não é permitido`, () => {
      const o = observadoOk();
      ajuste(o);
      const r = m().avaliarIdentidadeDoPostmaster({ esperado: esperado(), observado: o });
      assert.equal(r.comprovada, true, 'a identidade do filho segue comprovada');
      assert.equal(r.isolamento, false);
      assert.ok(r.falhas.includes(falha));
    });
  }

  test('PMI-04 — esperado ausente ou incompleto: nunca comprovado', () => {
    for (const e of [null, undefined, {}, { ...esperado(), pid: 1 }, { ...esperado(), inicio: '' }, { ...esperado(), executavel: '' }, { ...esperado(), porta: 'x' }]) {
      const r = m().avaliarIdentidadeDoPostmaster({ esperado: e, observado: observadoOk() });
      assert.equal(r.comprovada, false);
      assert.equal(r.isolamento, false);
      assert.deepEqual([...r.falhas], ['IDENTIDADE_NAO_REGISTRADA']);
    }
  });

  test('PMI-05 — interpretarLinhaDoPs: forma exata ou null', () => {
    const ok = m().interpretarLinhaDoPs('  501  4000 Wed Oct 28 10:00:00 2026 /bin/postgres -D /x');
    assert.deepEqual({ ...ok }, { uid: 501, ppid: 4000, inicio: 'Wed Oct 28 10:00:00 2026', comando: '/bin/postgres -D /x' });
    for (const ruim of ['', 'x', null, undefined, '501 4000 Wed Oct 28 10:00 2026 cmd', 'a b Wed Oct 28 10:00:00 2026 cmd']) assert.equal(m().interpretarLinhaDoPs(ruim), null);
  });

  test('PMI-06 — interpretarPostmasterPid: pid, diretório de dados, porta, socket e listen; qualquer outra forma é null', () => {
    const texto = `4100\n${PGDATA}\n1761640000\n55433\n${SOCK}\n\n  123 456\nready\n`;
    assert.deepEqual({ ...m().interpretarPostmasterPid(texto) }, { pid: 4100, pgdata: PGDATA, porta: 55433, socket: SOCK, listen: '' });
    for (const ruim of ['', 'abc', null, '4100\n', `x\n${PGDATA}\n1\n55433\n${SOCK}\n\n`, `4100\nrelativo\n1\n55433\n${SOCK}\n\n`]) assert.equal(m().interpretarPostmasterPid(ruim), null);
  });

  test('PMI-07 — o módulo é puro: não importa processo, sistema de arquivos nem rede', () => {
    const fonte = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../src/services/imagem-backup-postmaster-identidade.service.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.equal(/child_process|node:fs|node:net|process\.kill|\.kill\(/.test(fonte), false);
  });
});
