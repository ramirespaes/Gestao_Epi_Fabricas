'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { montarAmbiente12f } = require('./helpers/ambiente-http-12f');
const vinculoSst = require('../../src/services/vinculo-sst.service');

/**
 * GET /api/vinculos-sst (12F-1) contra PostgreSQL real. A regra é a do serviço,
 * sem nada novo: só o MASTER ativo da própria empresa lista; qualquer outro
 * recebe o mesmo 403. A empresa vem da sessão: o MASTER de uma empresa nunca vê
 * os vínculos da outra, nem informando outra empresa na query.
 */

describe('GET /api/vinculos-sst (PostgreSQL real)', () => {
  let env;
  let d;
  let como;
  const u = {};

  before(async () => {
    env = await montarAmbiente12f();
    ({ d, como } = env);
    u.sst = await env.usuarioCom(d.empresaA, { perfil: 'ADMINISTRADOR', acoes: ['APROVAR_SOLICITACAO'], sst: true });
    u.comum = await env.usuarioCom(d.empresaA);
    const conceder = (empresaId, atorId, usuarioId) => vinculoSst.concederVinculo(env.pool, { empresaId, atorId, usuarioId, motivo: 'Técnico de segurança' });
    await conceder(d.empresaA, d.master, d.sst1);
    await conceder(d.empresaA, d.master, d.sst2);
    await conceder(d.empresaB, d.masterB, d.sstB);
  });

  after(async () => { if (env) await env.encerrar(); });

  test('MASTER ativo: 200 com os vínculos da própria empresa, paginados, sem e-mail, hash, CPF nem empresa', async () => {
    const r = await como(d.master).get('/api/vinculos-sst');
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.status, r.body.total, r.body.pagina, r.body.limite], ['ok', 3, 1, 20]);
    assert.deepEqual(r.body.vinculos.map((v) => v.usuarioId).sort((a, b) => a - b), [u.sst, d.sst1, d.sst2].sort((a, b) => a - b));
    for (const v of r.body.vinculos) {
      assert.deepEqual(Object.keys(v).sort(), ['concedidoEm', 'concedidoPor', 'motivo', 'usuario', 'usuarioId']);
      assert.deepEqual(Object.keys(v.usuario).sort(), ['ativo', 'nome', 'perfil']);
    }
    const texto = JSON.stringify(r.body);
    for (const proibido of ['"email"', 'hash-de-teste', 'senha', 'cpf', 'empresaId']) assert.equal(texto.includes(proibido), false, proibido);
    const p2 = await como(d.master).get('/api/vinculos-sst?pagina=2&limite=2');
    assert.deepEqual([p2.body.vinculos.length, p2.body.total, p2.body.limite], [1, 3, 2]);
  });

  test('não MASTER (SST, administrador, usuário comum) e MASTER inativo: o mesmo 403 SEM_AUTORIDADE_VINCULO_SST', async () => {
    const respostas = [];
    for (const usuario of [u.sst, d.sst1, u.comum]) {
      const r = await como(usuario).get('/api/vinculos-sst');
      respostas.push({ status: r.status, corpo: r.body });
    }
    assert.deepEqual([respostas[0].status, respostas[0].corpo.codigo], [403, 'SEM_AUTORIDADE_VINCULO_SST']);
    for (const r of respostas) assert.deepEqual(r, respostas[0]);
    const inativo = await como(d.masterInativo).get('/api/vinculos-sst');
    assert.equal(inativo.status, 401, 'o inativo nem tem sessão');
  });

  test('isolamento: o MASTER da outra empresa vê só os vínculos dela; informar empresa na query é 400 e não muda a empresa', async () => {
    const daB = await como(d.masterB).get('/api/vinculos-sst');
    assert.deepEqual([daB.status, daB.body.vinculos.map((v) => v.usuarioId), daB.body.total], [200, [d.sstB], 1]);
    for (const consulta of [`empresaId=${d.empresaA}`, `usuarioId=${d.master}`]) {
      const r = await como(d.masterB).get(`/api/vinculos-sst?${consulta}`);
      assert.deepEqual([r.status, r.body.codigo, 'vinculos' in r.body], [400, 'VALIDACAO', false], consulta);
    }
  });

  test('paginação inválida é 400; sem sessão é 401', async () => {
    for (const consulta of ['limite=0', 'limite=101', 'pagina=0']) {
      const r = await como(d.master).get(`/api/vinculos-sst?${consulta}`);
      assert.deepEqual([r.status, r.body.codigo], [400, 'VALIDACAO'], consulta);
    }
    assert.equal((await env.anonimo.get('/api/vinculos-sst')).status, 401);
  });
});
