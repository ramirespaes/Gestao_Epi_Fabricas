'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const A = require('../../src/services/backup-executor-auditoria.service');
const Ev = require('../../src/services/backup-executor-evidencia.service');

/** D-ORF-6, L1 (Bloco A), D-F13: um evento de auditoria por execução, derivado da linha de evidência; sem banco real. */

const OP = 'a'.repeat(32);
function linha(estado = 'FALHOU') {
  let t = 1_800_000_000_000;
  const ev = Ev.criarEvidencia({ modo: 'ENSAIO', acao: 'VERIFICACAO_DESTINO', ambiente: 'HOMOLOGACAO', destinoId: 'hml-s3-principal', relogio: () => (t += 10), operacaoId: OP });
  if (estado === 'CONCLUIDO') { ev.etapa('VERIFICAR_DESTINO', true); return ev.encerrar({ estado: 'CONCLUIDO', verificacaoIndependente: 'CONFORME', origemDeChaves: 'TESTE_CONTROLADO', origemDoDestino: 'TESTE_CONTROLADO' }).linha; }
  ev.etapa('VERIFICAR_DESTINO', false, 'DESTINO_INDISPONIVEL');
  return ev.encerrar({ estado: 'FALHOU', codigo: 'DESTINO_INDISPONIVEL', falhouEm: 'VERIFICAR_DESTINO' }).linha;
}
const executor = { query: async () => ({ rows: [] }) };
const codigo = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };

describe('[AUD] auditoria do executor', () => {
  test('AUD-01 — grava um evento SISTEMA com ação, referência e contexto não sensível', async () => {
    const chamadas = [];
    const a = A.criarAuditoriaDoExecutor({ executorDeBanco: executor, registrarEventoSistema: async (ex, ev) => { chamadas.push({ ex, ev }); return { id: '7' }; } });
    const r = await a.registrar({ linha: linha('CONCLUIDO') });
    assert.deepEqual({ ...r }, { gravado: true, id: '7' });
    assert.equal(chamadas.length, 1);
    assert.equal(chamadas[0].ex, executor);
    const { ev } = chamadas[0];
    assert.equal(ev.acao, 'BACKUP_EXECUTOR_VERIFICACAO_DESTINO_CONCLUIDO');
    assert.ok(ev.acao.length <= 60);
    assert.equal(ev.referencia, OP);
    assert.ok(Object.keys(ev.contexto).every((k) => A.CAMPOS_DO_CONTEXTO.includes(k)));
    assert.equal(ev.contexto.estado, 'CONCLUIDO');
    assert.equal(ev.contexto.destinoId, 'hml-s3-principal');
    assert.match(ev.contexto.sha256, /^[0-9a-f]{64}$/);
    assert.ok(!Object.values(ev.contexto).some((v) => v === null || v === undefined));
    assert.deepEqual(Object.keys(ev).sort(), ['acao', 'contexto', 'descricao', 'referencia']);
  });

  test('AUD-02 — falha no banco não lança nem vaza a causa', async () => {
    const a = A.criarAuditoriaDoExecutor({ executorDeBanco: executor, registrarEventoSistema: async () => { throw new Error('SENHA-DO-BANCO'); } });
    const r = await a.registrar({ linha: linha() });
    assert.deepEqual({ ...r }, { gravado: false, codigo: 'AUDITORIA_NAO_GRAVADA' });
    assert.ok(!JSON.stringify(r).includes('SENHA'));
  });

  test('AUD-03 — linha adulterada, truncada ou entrada fora da forma: nada é gravado', async () => {
    let n = 0;
    const a = A.criarAuditoriaDoExecutor({ executorDeBanco: executor, registrarEventoSistema: async () => { n += 1; return { id: '1' }; } });
    const boa = linha();
    for (const ruim of [boa.replace('hml-s3-principal', 'hml-s3-outro'), boa.trim(), 'lixo\n', 42, undefined]) assert.equal((await a.registrar({ linha: ruim })).codigo, 'AUDITORIA_EVIDENCIA_INVALIDA');
    assert.equal((await a.registrar({ linha: boa, extra: 1 })).codigo, 'AUDITORIA_ENTRADA_INVALIDA');
    assert.equal((await a.registrar(null)).codigo, 'AUDITORIA_ENTRADA_INVALIDA');
    assert.equal(n, 0);
  });

  test('AUD-04 — configuração estrita', () => {
    const ok = { executorDeBanco: executor, registrarEventoSistema: async () => ({}) };
    assert.equal(codigo(() => A.criarAuditoriaDoExecutor({ ...ok, extra: 1 })), 'AUDITORIA_CONFIGURACAO_INVALIDA');
    assert.equal(codigo(() => A.criarAuditoriaDoExecutor({ ...ok, executorDeBanco: {} })), 'AUDITORIA_CONFIGURACAO_INVALIDA');
    assert.equal(codigo(() => A.criarAuditoriaDoExecutor({ executorDeBanco: executor })), 'AUDITORIA_CONFIGURACAO_INVALIDA');
    assert.equal(codigo(() => A.criarAuditoriaDoExecutor(undefined)), 'AUDITORIA_CONFIGURACAO_INVALIDA');
  });
});
