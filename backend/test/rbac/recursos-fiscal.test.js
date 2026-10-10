'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const recursos = require('../../src/rbac/recursos');
const toggles = require('../../src/rbac/toggles');

/**
 * 12K-D6: reportsFiscal é um recurso próprio (operação única: visualizar, que cobre ver, pré-visualizar, gerar e baixar).
 * D1–D4 NÃO são consolidados nesta etapa: reportsStock/Upcoming/Expired/Delivered não existem ainda.
 */
describe('recurso reportsFiscal', () => {
  test('é conhecido, tem rótulo, entra no escopo do MASTER e só tem a operação visualizar', () => {
    assert.ok(recursos.RECURSOS_CONHECIDOS.includes('reportsFiscal'));
    assert.equal(recursos.ROTULOS_RECURSOS.reportsFiscal, 'Relatório — Fiscalização');
    const escopo = recursos.ESCOPO_PROVISIONAMENTO_MASTER.recursos.find((r) => r.recurso === 'reportsFiscal');
    assert.deepEqual(escopo?.operacoes, ['visualizar']);
    const efeito = recursos.RECURSOS_COM_EFEITO.find((r) => r.recurso === 'reportsFiscal');
    assert.deepEqual(efeito?.operacoes, ['visualizar']);
  });

  test('o toggle "Relatório — Fiscalização" existe no catálogo, ligado à regra reportsFiscal.visualizar', () => {
    const t = toggles.TOGGLES.find((x) => x.id === 'reportsFiscal');
    assert.ok(t, 'toggle reportsFiscal ausente');
    assert.equal(t.rotulo, 'Relatório — Fiscalização');
    assert.equal(t.grupo, 'GERAL');
  });

  test('D1–D4 não foram consolidados: nenhum dos quatro recursos futuros existe nesta etapa', () => {
    for (const r of ['reportsStock', 'reportsUpcoming', 'reportsExpired', 'reportsDelivered']) {
      assert.equal(recursos.RECURSOS_CONHECIDOS.includes(r), false, r);
    }
    assert.ok(recursos.RECURSOS_CONHECIDOS.includes('reportsAudit'), 'a Auditoria segue intacta');
  });
});
