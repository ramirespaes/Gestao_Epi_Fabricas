'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Router } = require('express');

const { montar } = require('./helpers/gestao-usuarios-app');
const { criarExigirPermissaoRecurso, criarExigirPermissaoAcao } = require('../../src/middleware/autorizacao');
const EpiPermissoes = require('../../../frontend/js/permissoes-efetivas');

/**
 * Configurar permissões tem EFEITO REAL: o que a tela grava muda o que o middleware de produção decide numa rota
 * protegida (URL direta), o que o backend devolve em /auth/permissoes (de onde o menu é montado) e persiste.
 */
const BASE = '/api/administracao/usuarios';

describe('Configurar permissões — efeito real (PostgreSQL real)', () => {
  let g;
  let master;
  before(async () => {
    g = await montar({ extras: ({ pool, exigirEmpresarial }) => {
      const r = Router();
      r.get('/teste/dashboard', exigirEmpresarial, criarExigirPermissaoRecurso({ pool }, 'dashboard', 'visualizar'), (req, res) => res.json({ ok: true }));
      r.get('/teste/estoque', exigirEmpresarial, criarExigirPermissaoAcao({ pool }, 'ENTRADA_ESTOQUE'), (req, res) => res.json({ ok: true }));
      r.get('/teste/aprovar', exigirEmpresarial, criarExigirPermissaoAcao({ pool }, 'APROVAR_SOLICITACAO'), (req, res) => res.json({ ok: true }));
      return [r];
    } });
    master = await g.contaDaEmpresa(g.empresas.A);
  });
  after(async () => { if (g) await g.encerrar(); });

  const recurso = (c, id, rec, corpo) => g.request(g.app).patch(`${BASE}/${id}/permissoes/recursos/${rec}`).set('Cookie', g.cookie(c)).send(corpo);
  const acao = (c, id, cod, estado) => g.request(g.app).put(`${BASE}/${id}/permissoes/acoes/${cod}`).set('Cookie', g.cookie(c)).send({ estado });
  const detalhe = (c, id) => g.request(g.app).get(`${BASE}/${id}/permissoes`).set('Cookie', g.cookie(c));
  const como = async (u) => g.deCookies(g.cookiesDe(await g.login(u.email, g.SENHA_PROVISORIA)));
  const rota = async (u, caminho) => (await g.request(g.app).get(`/api${caminho}`).set('Cookie', await como(u))).status;

  test('URL direta e menu: conceder, negar e herdar mudam o que a rota protegida decide e o que /auth/permissoes entrega ao menu; persiste; outra empresa não consegue', async () => {
    const u = await g.usuarioPronto(master);
    assert.equal(await rota(u, '/teste/dashboard'), 403);
    const menu = async () => EpiPermissoes.podeAbrir((await g.request(g.app).get('/api/auth/permissoes').set('Cookie', await como(u))).body, 'dashboard');
    assert.equal(await menu(), false);

    await recurso(master, u.id, 'dashboard', { visualizar: true });
    assert.equal(await rota(u, '/teste/dashboard'), 200, 'URL direta liberada');
    assert.equal(await menu(), true, 'o menu acompanha');
    assert.equal((await detalhe(master, u.id)).body.permissoes.recursos.find((r) => r.recurso === 'dashboard').operacoes.visualizar.individual, true, 'persistido');

    await recurso(master, u.id, 'dashboard', { visualizar: false });
    assert.equal(await rota(u, '/teste/dashboard'), 403);
    assert.equal(await menu(), false);
    await recurso(master, u.id, 'dashboard', { visualizar: null });
    assert.equal(await rota(u, '/teste/dashboard'), 403, 'herdar volta ao perfil');

    const masterB = await g.contaDaEmpresa(g.empresas.B);
    assert.equal((await recurso(masterB, u.id, 'dashboard', { visualizar: true })).status, 404);
    assert.equal(await rota(u, '/teste/dashboard'), 403, 'nada mudou');
  });

  test('ações: CONCEDIDA libera, BLOQUEADA nega mesmo com perfil/grupo, PADRAO volta; a regra de SST não é contornada por toggle', async () => {
    const u = await g.usuarioPronto(master);
    assert.equal(await rota(u, '/teste/estoque'), 403);
    await acao(master, u.id, 'ENTRADA_ESTOQUE', 'CONCEDIDA');
    assert.equal(await rota(u, '/teste/estoque'), 200);
    await acao(master, u.id, 'ENTRADA_ESTOQUE', 'BLOQUEADA');
    assert.equal(await rota(u, '/teste/estoque'), 403);
    await acao(master, u.id, 'ENTRADA_ESTOQUE', 'PADRAO');
    assert.equal(await rota(u, '/teste/estoque'), 403);

    const c = await acao(master, u.id, 'APROVAR_SOLICITACAO', 'CONCEDIDA');
    assert.equal(c.status, 200, JSON.stringify(c.body));
    assert.deepEqual([c.body.acao.estado, c.body.acao.efetivo, c.body.acao.motivoNegado, c.body.acao.regras], ['CONCEDIDA', false, 'SEM_VINCULO_SST', ['SST', 'AUTODECISAO_PROIBIDA']]);
    assert.equal(await rota(u, '/teste/aprovar'), 403, 'sem vínculo SST a concessão não vale');
    await g.pool.query('INSERT INTO vinculo_sst (usuario_id, empresa_id, concedido_por) VALUES ($1, $2, $3)', [u.id, g.empresas.A, master.usuarioId]);
    assert.equal(await rota(u, '/teste/aprovar'), 200, 'com o vínculo (decisão do MASTER, fora do toggle) passa');
    assert.equal((await detalhe(master, u.id)).body.permissoes.acoes.find((a) => a.codigo === 'APROVAR_SOLICITACAO').efetivo, true);
  });
});
