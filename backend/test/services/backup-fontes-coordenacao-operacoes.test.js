'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const K = require('../../src/services/backup-fontes-coordenacao-operacoes.service');

/** D-ORF-6, P10 — coordenação de operações incompatíveis por advisory lock (executor SIMULADO; nenhuma conexão) e alerta de janela obsoleta (D4). */

function executorFalso({ ocupados = [], falharEm = null } = {}) {
  const sqls = [];
  const tomados = new Set();
  return {
    sqls, tomados,
    async query(sql) {
      sqls.push(sql);
      const m = /^SELECT pg_(try_advisory_lock|advisory_unlock)\((\d+)\) AS/.exec(sql);
      if (!m) throw new Error('SQL inesperado');
      const chave = m[2];
      if (falharEm === chave) throw new Error('falha de banco');
      if (m[1] === 'try_advisory_lock') { if (ocupados.includes(chave) || tomados.has(chave)) return { rows: [{ tomado: false }] }; tomados.add(chave); return { rows: [{ tomado: true }] }; }
      const tinha = tomados.delete(chave);
      return { rows: [{ liberado: tinha }] };
    },
  };
}
const MIG = String(K.PG_MIGRATE_LOCK_ID);

describe('[CO] matriz e cadeados', () => {
  test('CO-01 — matriz fechada e simétrica; backup toma o próprio cadeado, o de migração e o de limpeza; restauração toma o próprio e o de migração; compativeis() reflete a matriz', () => {
    assert.deepEqual(K.OPERACOES, ['BACKUP', 'RESTAURACAO', 'MIGRACAO', 'LIMPEZA']);
    for (const a of K.OPERACOES) for (const b of K.OPERACOES) assert.equal(K.INCOMPATIBILIDADES[a][b], K.INCOMPATIBILIDADES[b][a], `${a}×${b} simétrica`);
    for (const a of K.OPERACOES) assert.equal(K.INCOMPATIBILIDADES[a][a], true, `${a} consigo mesma`);
    assert.deepEqual(K.cadeadosDe('BACKUP').map(String), [MIG, String(K.CHAVE_DORF6.BACKUP), String(K.CHAVE_DORF6.LIMPEZA)]);
    assert.deepEqual(K.cadeadosDe('RESTAURACAO').map(String), [MIG, String(K.CHAVE_DORF6.RESTAURACAO)]);
    assert.equal(K.compativeis('BACKUP', 'RESTAURACAO'), true);
    assert.equal(K.compativeis('BACKUP', 'MIGRACAO'), false);
    assert.equal(K.compativeis('LIMPEZA', 'RESTAURACAO'), true);
    assert.throws(() => K.cadeadosDe('DEPLOY'), (e) => e.code === 'ENTRADA_INVALIDA');
    assert.equal(K.PG_MIGRATE_LOCK_ID, 7241865325823964n, 'mesmo id do node-pg-migrate (conferido na CI de integração)');
    assert.ok(Object.isFrozen(K.INCOMPATIBILIDADES) && Object.isFrozen(K.CHAVE_DORF6));
  });

  test('CO-02 — adquirirExclusao: toma todos os cadeados por try (sem espera), devolve liberar() idempotente; cadeado ocupado = EM_USO e tudo já tomado é liberado; migração em curso = MIGRACAO_EM_CURSO; falha de banco = CONSULTA_FALHOU sem vazar cadeado', async () => {
    const ex = executorFalso();
    const r = await K.adquirirExclusao(ex, { operacao: 'BACKUP' });
    assert.equal(r.ok, true);
    assert.deepEqual(r.cadeados, [MIG, String(K.CHAVE_DORF6.BACKUP), String(K.CHAVE_DORF6.LIMPEZA)]);
    assert.equal(ex.tomados.size, 3);
    assert.ok(ex.sqls.every((s) => /^SELECT pg_try_advisory_lock\(\d+\) AS tomado$/.test(s)), 'só try: nunca pg_advisory_lock bloqueante');
    // segunda operação incompatível no mesmo executor: recusa e não deixa cadeado para trás
    const segunda = await K.adquirirExclusao(ex, { operacao: 'LIMPEZA' });
    assert.deepEqual([segunda.ok, segunda.motivo], [false, 'MIGRACAO_EM_CURSO'], 'a primeira chave tentada é a de migração, já tomada pelo backup');
    assert.equal(ex.tomados.size, 3, 'nada a mais ficou tomado');
    assert.deepEqual(await r.liberar(), { liberados: 3 });
    assert.deepEqual(await r.liberar(), { liberados: 0 });
    assert.equal(ex.tomados.size, 0);
    const ocupado = executorFalso({ ocupados: [String(K.CHAVE_DORF6.LIMPEZA)] });
    const emUso = await K.adquirirExclusao(ocupado, { operacao: 'BACKUP' });
    assert.deepEqual([emUso.ok, emUso.motivo, emUso.chave], [false, 'EM_USO', String(K.CHAVE_DORF6.LIMPEZA)]);
    assert.equal(ocupado.tomados.size, 0, 'os cadeados tomados antes da recusa foram liberados');
    const migrando = executorFalso({ ocupados: [MIG] });
    assert.equal((await K.adquirirExclusao(migrando, { operacao: 'RESTAURACAO' })).motivo, 'MIGRACAO_EM_CURSO');
    const quebra = executorFalso({ falharEm: String(K.CHAVE_DORF6.BACKUP) });
    const falhou = await K.adquirirExclusao(quebra, { operacao: 'BACKUP' });
    assert.deepEqual([falhou.ok, falhou.motivo], [false, 'CONSULTA_FALHOU']);
    assert.equal(quebra.tomados.size, 0);
    await assert.rejects(K.adquirirExclusao({}, { operacao: 'BACKUP' }), (e) => e.code === 'ENTRADA_INVALIDA');
    await assert.rejects(K.adquirirExclusao(executorFalso(), { operacao: 'DEPLOY' }), (e) => e.code === 'ENTRADA_INVALIDA');
    await assert.rejects(K.adquirirExclusao(executorFalso(), { operacao: 'BACKUP', extra: 1 }), (e) => e.code === 'ENTRADA_INVALIDA');
    const malformado = { async query() { return { rows: [{ tomado: 'sim' }] }; } };
    assert.equal((await K.adquirirExclusao(malformado, { operacao: 'BACKUP' })).motivo, 'CONSULTA_FALHOU');
  });

  test('CO-03 — compatíveis coexistem: backup e restauração tomam conjuntos disjuntos (só a chave de migração é comum: a restauração também a toma, então na prática ficam serializadas pelo cadeado de migração — declarado)', async () => {
    const ex = executorFalso();
    const backup = await K.adquirirExclusao(ex, { operacao: 'BACKUP' });
    const rest = await K.adquirirExclusao(ex, { operacao: 'RESTAURACAO' });
    assert.equal(backup.ok, true);
    assert.deepEqual([rest.ok, rest.motivo], [false, 'MIGRACAO_EM_CURSO'], 'ambas protegem o banco contra migração: a serialização pelo cadeado de migração é intencional e documentada');
    await backup.liberar();
    assert.equal((await K.adquirirExclusao(ex, { operacao: 'RESTAURACAO' })).ok, true);
  });
});

describe('[JA] alerta de janela obsoleta (D4)', () => {
  const agora = new Date('2026-11-03T12:00:00.000Z');
  test('JA-01 — ausente, recente, obsoleta (limiar padrão 6 h e limiar informado), inválida e futura; nunca ação automática', () => {
    assert.deepEqual(K.avaliarIdadeDaJanela({ janela: null, agora }), { classe: 'AUSENTE', idadeMs: null, alerta: false, acao: 'NENHUMA' });
    const recente = K.avaliarIdadeDaJanela({ janela: { tipo: 'BACKUP', iniciadoEm: '2026-11-03T11:00:00.000Z' }, agora });
    assert.deepEqual([recente.classe, recente.alerta, recente.acao, recente.idadeMs], ['RECENTE', false, 'NENHUMA', 3600000]);
    const velha = K.avaliarIdadeDaJanela({ janela: { tipo: 'LIMPEZA', iniciadoEm: '2026-11-03T05:00:00.000Z' }, agora });
    assert.deepEqual([velha.classe, velha.alerta, velha.acao, velha.tipo], ['OBSOLETA', true, 'DECISAO_HUMANA', 'LIMPEZA']);
    assert.equal(K.avaliarIdadeDaJanela({ janela: { tipo: 'BACKUP', iniciadoEm: '2026-11-03T11:00:00.000Z' }, agora, limiarMs: 1000 }).classe, 'OBSOLETA');
    assert.equal(K.avaliarIdadeDaJanela({ janela: { tipo: 'BACKUP', iniciadoEm: 'ontem' }, agora }).classe, 'INVALIDA');
    assert.equal(K.avaliarIdadeDaJanela({ janela: { tipo: 'BACKUP', iniciadoEm: '2026-11-03T13:00:00.000Z' }, agora }).classe, 'INVALIDA', 'início no futuro');
    assert.throws(() => K.avaliarIdadeDaJanela({ janela: null, agora: 'hoje' }), (e) => e.code === 'ENTRADA_INVALIDA');
    assert.throws(() => K.avaliarIdadeDaJanela({ janela: null, agora, limiarMs: 0 }), (e) => e.code === 'ENTRADA_INVALIDA');
    assert.equal(K.JANELA_POLITICA.limiarPadraoMs, 6 * 60 * 60 * 1000);
  });
});
