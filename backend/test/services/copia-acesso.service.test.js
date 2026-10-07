'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const copia = require('../../src/services/copia-acesso.service');

/** O adaptador que deixa concederDireta/revogar rodarem DENTRO da transação de quem chama, e a recusa para não MASTER. */
describe('copia-acesso', () => {
  test('poolSobre entrega sempre a mesma conexão e transforma BEGIN, COMMIT e ROLLBACK em no-ops; o resto passa adiante', async () => {
    const chamadas = [];
    const client = { query: async (t, p) => { chamadas.push([t, p]); return { rows: [{ ok: 1 }], rowCount: 1 }; } };
    const pool = copia.poolSobre(client);
    const c = await pool.connect();
    for (const cmd of ['BEGIN', 'COMMIT', 'ROLLBACK', ' begin ']) assert.deepEqual(await c.query(cmd), { rows: [], rowCount: 0 });
    assert.deepEqual((await c.query('SELECT 1', [1])).rows, [{ ok: 1 }]);
    assert.deepEqual(chamadas, [['SELECT 1', [1]]]);
    c.release();
  });

  test('ator que não é MASTER e destino MASTER não copiam camada individual e não tocam o banco', async () => {
    let tocou = false;
    const client = { query: async () => { tocou = true; return { rows: [], rowCount: 0 }; } };
    const naoMaster = await copia.copiarAcessoIndividual(client, { empresaId: 1, ator: { id: 2, perfil: 'ADMINISTRADOR' }, origemId: 3, destinoId: 4, destinoPerfil: 'USUARIO' });
    assert.deepEqual([naoMaster.executado, naoMaster.motivo], [false, 'SOMENTE_MASTER']);
    const destinoMaster = await copia.copiarAcessoIndividual(client, { empresaId: 1, ator: { id: 2, perfil: 'MASTER' }, origemId: 3, destinoId: 4, destinoPerfil: 'MASTER' });
    assert.deepEqual([destinoMaster.executado, destinoMaster.motivo], [false, 'DESTINO_MASTER']);
    assert.equal(tocou, false);
  });
});
