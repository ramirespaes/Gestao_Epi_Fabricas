'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { exigirModulo } = require('../helpers/exigir-modulo');

/** Controller da listagem HTTP dos vínculos SST (12F-1): empresa e ator só da sessão; a autoridade é do serviço. */

const servico = require('../../src/services/vinculo-sst.service');

const controller = () => exigirModulo('src/controllers/vinculo-sst.controller').criarVinculoSstController({ pool: { marca: 'pool' } });
const respostaFalsa = () => ({ statusCode: 0, corpo: null, status(c) { this.statusCode = c; return this; }, json(b) { this.corpo = b; return this; } });

describe('vinculo-sst.controller', () => {
  test('listar: empresa e ator da sessão e a paginação validada; 200 com o resultado do serviço', async (t) => {
    const chamadas = [];
    const resultado = { vinculos: [], total: 0, pagina: 1, limite: 20 };
    t.mock.method(servico, 'listarVinculos', async (pool, dados) => { chamadas.push([pool, dados]); return resultado; });
    const res = respostaFalsa();
    await controller().listar({
      empresa: { id: 3 }, usuario: { id: 9, perfil: 'MASTER' }, query: { empresaId: '999' }, validado: { query: { pagina: 1, limite: 20 } },
    }, res);
    assert.deepEqual(chamadas, [[{ marca: 'pool' }, {
      empresaId: 3, atorId: 9, pagina: 1, limite: 20,
    }]]);
    assert.deepEqual([res.statusCode, res.corpo], [200, { status: 'ok', ...resultado }]);
  });

  // 12F-2: corpo e caminho brutos trazem valores estranhos que nunca podem ser lidos.
  const escrita = (validado) => ({
    empresa: { id: 3 }, usuario: { id: 9, perfil: 'MASTER' }, ip: '203.0.113.7', headers: { 'user-agent': 'Navegador de teste' },
    body: { empresaId: 999, concedidoPor: 998 }, params: { usuarioId: '997' }, validado,
  });

  test('conceder: empresa e ator da sessão, alvo e motivo validados (null sem motivo), IP e dispositivo; 201 com o vínculo', async (t) => {
    const chamadas = [];
    const vinculo = { usuarioId: 7, concedidoPor: 9, concedidoEm: 'x', motivo: null };
    t.mock.method(servico, 'concederVinculo', async (pool, dados) => { chamadas.push([pool, dados]); return vinculo; });
    const res = respostaFalsa();
    await controller().conceder(escrita({ body: { usuarioId: 7 } }), res);
    assert.deepEqual(chamadas, [[{ marca: 'pool' }, {
      empresaId: 3, atorId: 9, usuarioId: 7, motivo: null, ip: '203.0.113.7', dispositivo: 'Navegador de teste',
    }]]);
    assert.deepEqual([res.statusCode, res.corpo], [201, { status: 'ok', vinculo }]);
  });

  test('remover: empresa e ator da sessão, alvo do caminho validado; 200 com o usuário', async (t) => {
    const chamadas = [];
    t.mock.method(servico, 'removerVinculo', async (_pool, dados) => { chamadas.push(dados); return { usuarioId: 7 }; });
    const res = respostaFalsa();
    await controller().remover(escrita({ params: { usuarioId: 7 } }), res);
    assert.deepEqual(chamadas, [{ empresaId: 3, atorId: 9, usuarioId: 7, ip: '203.0.113.7', dispositivo: 'Navegador de teste' }]);
    assert.deepEqual([res.statusCode, res.corpo], [200, { status: 'ok', usuarioId: 7 }]);
  });
});
