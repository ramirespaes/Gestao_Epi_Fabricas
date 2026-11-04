'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const D = require('../../src/services/backup-fontes-dr.service');

/** D-ORF-6, P12 — plano, avaliação e evidência do ensaio de DR (puro). */

const T = (s) => `2026-11-03T10:${s}Z`;
const plano = () => D.planejarEnsaioDeDR({ ultimoBackupEm: '2026-11-03T04:00:00Z', agora: '2026-11-03T10:00:00Z', alvos: { rpoMs: 24 * 3600 * 1000, rtoMs: 2 * 3600 * 1000 } });
const passos = (ate = D.PASSOS.length, falhoEm = null) => D.PASSOS.slice(0, ate).map((p, i) => ({ id: p.id, ok: p.id !== falhoEm, inicioEm: T(`0${i}:00`), fimEm: T(`0${i}:30`) }));
const integra = () => ({ ok: true, veredito: { classe: 'INTEGRO' }, recuperavelEmProducao: false });

describe('[DR] plano e avaliação do ensaio', () => {
  test('DR-01 — plano: RPO medido = idade do último backup; 7 passos fixos em ordem; limites declarados; entradas inválidas recusadas', () => {
    const p = plano();
    assert.equal(p.rpoMedidoMs, 6 * 3600 * 1000);
    assert.equal(p.rpoAtendido, true);
    assert.deepEqual(p.passos.map((x) => x.id), ['DECIFRAR', 'VERIFICACOES_8_7', 'BANCO', 'ESQUEMA', 'ARQUIVOS_POR_FONTE', 'CONCILIACAO', 'VEREDITO']);
    assert.ok(p.limites.some((l) => l.startsWith('PRODUCAO_PROIBIDA')) && Object.isFrozen(p));
    assert.throws(() => D.planejarEnsaioDeDR({ ultimoBackupEm: '2026-11-03T10:00:00Z', agora: '2026-11-03T09:00:00Z', alvos: { rpoMs: 1, rtoMs: 1 } }), (e) => e.motivo === 'INSTANTES');
    assert.throws(() => D.planejarEnsaioDeDR({ ultimoBackupEm: '2026-11-03T10:00:00Z', agora: '2026-11-03T10:00:00Z', alvos: { rpoMs: 0, rtoMs: 1 } }), (e) => e.motivo === 'ALVOS');
    assert.throws(() => D.planejarEnsaioDeDR({ ultimoBackupEm: 'ontem', agora: '2026-11-03T10:00:00Z', alvos: { rpoMs: 1, rtoMs: 1 } }), (e) => e.motivo === 'INSTANTES');
  });

  test('DR-02 — classes: RECUPERADO, RECUPERADO_FORA_DO_ALVO (RPO ou RTO), PARCIAL (veredito não íntegro ou falha depois do banco), FALHOU (falha antes do banco ou passo faltante); nunca promove produção', () => {
    const ok = D.avaliarEnsaioDeDR({ plano: plano(), passos: passos(), restauracao: integra() });
    assert.deepEqual([ok.classe, ok.rtoMedidoMs, ok.rtoAtendido, ok.motivos, ok.recuperavelEmProducao, ok.restauracaoReal, ok.passos.length], ['RECUPERADO', 6 * 60 * 1000 + 30 * 1000, true, [], false, false, 7]);
    const rtoCurto = D.planejarEnsaioDeDR({ ultimoBackupEm: '2026-11-03T04:00:00Z', agora: '2026-11-03T10:00:00Z', alvos: { rpoMs: 24 * 3600 * 1000, rtoMs: 60 * 1000 } });
    assert.deepEqual([D.avaliarEnsaioDeDR({ plano: rtoCurto, passos: passos(), restauracao: integra() }).classe, D.avaliarEnsaioDeDR({ plano: rtoCurto, passos: passos(), restauracao: integra() }).motivos], ['RECUPERADO_FORA_DO_ALVO', ['RTO_FORA_DO_ALVO']]);
    const rpoCurto = D.planejarEnsaioDeDR({ ultimoBackupEm: '2026-11-03T04:00:00Z', agora: '2026-11-03T10:00:00Z', alvos: { rpoMs: 1000, rtoMs: 2 * 3600 * 1000 } });
    assert.equal(D.avaliarEnsaioDeDR({ plano: rpoCurto, passos: passos(), restauracao: integra() }).classe, 'RECUPERADO_FORA_DO_ALVO');
    const inconsistente = D.avaliarEnsaioDeDR({ plano: plano(), passos: passos(), restauracao: { ok: false, veredito: { classe: 'INCONSISTENTE' }, recuperavelEmProducao: false } });
    assert.deepEqual([inconsistente.classe, inconsistente.motivos], ['PARCIAL', ['RESTAURACAO_INCONSISTENTE']]);
    assert.equal(D.avaliarEnsaioDeDR({ plano: plano(), passos: passos(), restauracao: { ok: true, veredito: { classe: 'INTEGRO' }, recuperavelEmProducao: true } }).classe, 'PARCIAL', 'uma restauração que se diz produtiva não é aceita');
    const falhaTarde = D.avaliarEnsaioDeDR({ plano: plano(), passos: passos(6, 'CONCILIACAO'), restauracao: { ok: false, veredito: { classe: 'INCOMPLETO' } } });
    assert.deepEqual([falhaTarde.classe, falhaTarde.falhouEm, falhaTarde.passos.length], ['PARCIAL', 'CONCILIACAO', 6]);
    const falhaCedo = D.avaliarEnsaioDeDR({ plano: plano(), passos: passos(2, 'VERIFICACOES_8_7'), restauracao: {} });
    assert.deepEqual([falhaCedo.classe, falhaCedo.falhouEm, falhaCedo.motivos], ['FALHOU', 'VERIFICACOES_8_7', ['PASSO_FALHOU:VERIFICACOES_8_7', 'RESTAURACAO_SEM_VEREDITO']]);
    const faltante = D.avaliarEnsaioDeDR({ plano: plano(), passos: passos(5), restauracao: integra() });
    assert.deepEqual([faltante.classe, faltante.motivos[0]], ['FALHOU', 'PASSO_FALTANTE_OU_FORA_DE_ORDEM:CONCILIACAO']);
    const foraDeOrdem = passos(); [foraDeOrdem[2], foraDeOrdem[3]] = [foraDeOrdem[3], foraDeOrdem[2]];
    assert.equal(D.avaliarEnsaioDeDR({ plano: plano(), passos: foraDeOrdem, restauracao: integra() }).classe, 'FALHOU');
    const sobreposto = passos(); sobreposto[1].inicioEm = T('00:10');
    assert.deepEqual(D.avaliarEnsaioDeDR({ plano: plano(), passos: sobreposto, restauracao: integra() }).motivos[0], 'PASSO_INVALIDO:VERIFICACOES_8_7');
    assert.throws(() => D.avaliarEnsaioDeDR({ plano: { versao: 2 }, passos: [], restauracao: {} }), (e) => e.code === 'ENTRADA_INVALIDA');
  });

  test('DR-03 — linha de evidência: NDJSON canônica com SHA-256 próprio, sem caminhos/segredos; PRODUCAO proibida; contexto estrito', () => {
    const r = D.avaliarEnsaioDeDR({ plano: plano(), passos: passos(), restauracao: integra() });
    const ctx = { conjuntoId: 'conjunto-p12', sha256Manifesto: 'f'.repeat(64), ensaioEm: '2026-11-03T10:30:00Z', ambiente: 'ENSAIO_CI' };
    const ev = D.linhaDeEvidencia(r, ctx);
    assert.ok(ev.linha.endsWith('\n') && !ev.linha.slice(0, -1).includes('\n'));
    const obj = JSON.parse(ev.linha);
    assert.equal(obj.sha256, ev.sha256);
    const { sha256, ...corpo } = obj;
    const ordenar = (v) => (Array.isArray(v) ? v.map(ordenar) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, ordenar(v[k])])) : v);
    assert.equal(crypto.createHash('sha256').update(JSON.stringify(ordenar(corpo))).digest('hex'), sha256);
    assert.deepEqual(Object.keys(obj), [...Object.keys(obj)].sort());
    assert.deepEqual(Object.keys(obj.passos[0]), ['duracaoMs', 'id', 'ok'], 'objetos aninhados preservam as chaves');
    assert.deepEqual([obj.tipo, obj.versao, obj.classe, obj.ambiente, obj.recuperavelEmProducao, obj.passos.length], ['ENSAIO_DR', 1, 'RECUPERADO', 'ENSAIO_CI', false, 7]);
    assert.equal(D.linhaDeEvidencia(r, ctx).sha256, ev.sha256, 'determinística');
    assert.throws(() => D.linhaDeEvidencia(r, { ...ctx, ambiente: 'PRODUCAO' }), (e) => e.motivo === 'PRODUCAO_PROIBIDA');
    assert.throws(() => D.linhaDeEvidencia(r, { ...ctx, caminho: '/x' }), (e) => e.motivo === 'CONTEXTO');
    assert.throws(() => D.linhaDeEvidencia(r, { ...ctx, sha256Manifesto: 'zz' }), (e) => e.motivo === 'CONTEXTO');
    assert.throws(() => D.linhaDeEvidencia({ classe: 'OUTRA' }, ctx), (e) => e.motivo === 'RESULTADO');
  });
});
