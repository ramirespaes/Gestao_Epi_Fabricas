'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { montar } = require('./helpers/gestao-usuarios-app');
const provisionamento = require('../../src/services/provisionamento-permissoes.service');
const { avaliar } = require('../../src/services/exportacao-historico-autorizacao.service');

/**
 * Pacote J (GREEN, complemento): o MASTER recebe EXPORTAR_HISTORICO_FUNCIONARIOS só pelo provisionamento (a 085 não
 * concede nada). Antes do provisionamento ele não exporta; depois, exporta (com a leitura, que o mesmo escopo dá); o
 * provisionamento de uma empresa não toca outra e reaplicar não duplica.
 */
const CODIGO = 'EXPORTAR_HISTORICO_FUNCIONARIOS';

describe('J — MASTER antes e depois do provisionamento (PostgreSQL real)', () => {
  let g;
  let masterA;
  let masterB;
  before(async () => {
    g = await montar();
    masterA = await g.contaDaEmpresa(g.empresas.A);
    masterB = await g.contaDaEmpresa(g.empresas.B);
  });
  after(async () => { if (g) await g.encerrar(); });

  const exportar = async (c) => (await g.request(g.app).get('/api/auth/permissoes').set('Cookie', g.cookie(c))).body.acoes[CODIGO];
  const linhas = (empresaId) => g.um("SELECT count(*)::int AS n FROM permissoes_acao WHERE empresa_id = $1 AND perfil = 'MASTER' AND acao_codigo = $2 AND permitido", [empresaId, CODIGO]);

  test('JP1 antes do provisionamento: a ação existe, mas o MASTER não exporta (a migration não concede)', async () => {
    assert.equal(await exportar(masterA), false);
    assert.deepEqual(await avaliar(g.pool, { empresaId: g.empresas.A, usuarioId: masterA.usuarioId, perfil: 'MASTER' }), { visualizar: false, exportar: false, permitido: false });
    assert.equal((await linhas(g.empresas.A)).n, 0);
  });

  test('JP2 depois do provisionamento da empresa A: o MASTER de A exporta; o de B continua sem; reaplicar não duplica', async () => {
    await provisionamento.provisionar(g.pool, { empresaId: g.empresas.A, dryRun: false });
    assert.equal(await exportar(masterA), true);
    assert.deepEqual(await avaliar(g.pool, { empresaId: g.empresas.A, usuarioId: masterA.usuarioId, perfil: 'MASTER' }), { visualizar: true, exportar: true, permitido: true });
    assert.equal(await exportar(masterB), false);
    assert.equal((await linhas(g.empresas.B)).n, 0);
    const segunda = await provisionamento.provisionar(g.pool, { empresaId: g.empresas.A, dryRun: false });
    assert.equal(segunda.inseridos.acoes.length, 0, JSON.stringify(segunda.inseridos));
    assert.equal((await linhas(g.empresas.A)).n, 1);
  });
});
