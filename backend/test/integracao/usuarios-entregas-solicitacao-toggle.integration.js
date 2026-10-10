'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Router } = require('express');

const { montar } = require('./helpers/gestao-usuarios-app');
const { criarExigirPermissaoAcao } = require('../../src/middleware/autorizacao');
const EpiPermissoes = require('../../../frontend/js/permissoes-efetivas');

/**
 * "Entregas por solicitação" no catálogo binário: reutiliza a ação existente REALIZAR_ENTREGA (a mesma que abre a
 * página stockRequests e autoriza a entrega), independente do vínculo SST e de Aprovar/Reprovar.
 */
const BASE = '/api/administracao/usuarios';

describe('Configurar permissões — Entregas por solicitação (REALIZAR_ENTREGA) (PostgreSQL real)', () => {
  let g;
  let master;
  let admin;
  before(async () => {
    g = await montar({ extras: ({ pool, exigirEmpresarial }) => {
      const r = Router();
      // A mesma proteção da lista de entregáveis e da entrega por solicitação.
      r.get('/teste/entregaveis', exigirEmpresarial, criarExigirPermissaoAcao({ pool }, 'REALIZAR_ENTREGA'), (req, res) => res.json({ ok: true }));
      return [r];
    } });
    master = await g.contaDaEmpresa(g.empresas.A);
    admin = await g.administradorAutorizado(g.empresas.A, master);
  });
  after(async () => { if (g) await g.encerrar(); });

  const lista = (c, id) => g.request(g.app).get(`${BASE}/${id}/acessos`).set('Cookie', g.cookie(c));
  const ligar = (c, id, toggle, ligado) => g.request(g.app).put(`${BASE}/${id}/acessos/${toggle}`).set('Cookie', g.cookie(c)).send({ ligado });
  const como = async (u) => g.deCookies(g.cookiesDe(await g.login(u.email, g.SENHA_PROVISORIA)));
  const rota = async (u) => (await g.request(g.app).get('/api/teste/entregaveis').set('Cookie', await como(u))).status;
  const permissoes = async (u) => (await g.request(g.app).get('/api/auth/permissoes').set('Cookie', await como(u))).body;
  const toggle = async (id) => (await lista(master, id)).body.acessos.toggles.find((t) => t.id === 'entregasSolicitacao');
  const concessao = (id) => g.todos("SELECT 1 FROM usuario_autorizacoes WHERE usuario_id = $1 AND acao_codigo = 'REALIZAR_ENTREGA' AND origem_id IS NULL", [id]);
  const bloqueio = (id) => g.todos("SELECT 1 FROM usuario_bloqueios WHERE usuario_id = $1 AND acao_codigo = 'REALIZAR_ENTREGA'", [id]);

  test('aparece no catálogo (grupo EPIs), desligado para quem não tem a autoridade, sem o aviso de vínculo SST (a ação não exige SST)', async () => {
    const u = await g.usuarioPronto(master);
    const t = await toggle(u.id);
    assert.deepEqual([t.id, t.rotulo, t.grupo, t.ligado, t.fixo], ['entregasSolicitacao', 'Entregas por solicitação', 'EPIS', false, false]);
    assert.equal('exigeVinculoSst' in t, false);
    assert.equal(await rota(u), 403, 'sem a autoridade continua sem acesso');
  });

  test('ON concede REALIZAR_ENTREGA (concessão individual), libera a rota e abre a página stockRequests; OFF remove a concessão e fecha', async () => {
    const u = await g.usuarioPronto(master);
    const on = await ligar(master, u.id, 'entregasSolicitacao', true);
    assert.equal(on.status, 200, JSON.stringify(on.body));
    assert.equal(on.body.acesso.ligado, true);
    assert.equal((await concessao(u.id)).length, 1);
    assert.equal(await rota(u), 200, 'o backend reconhece a autoridade');
    const p = await permissoes(u);
    assert.equal(p.acoes.REALIZAR_ENTREGA, true);
    assert.equal(EpiPermissoes.podeAbrir(p, 'stockRequests'), true, 'Entregas por solicitação abre (menu e URL)');
    const off = await ligar(master, u.id, 'entregasSolicitacao', false);
    assert.equal(off.body.acesso.ligado, false);
    assert.equal((await concessao(u.id)).length, 0, 'a concessão foi removida');
    assert.equal((await bloqueio(u.id)).length, 0, 'sem bloqueio inventado');
    assert.equal(await rota(u), 403);
    assert.equal(EpiPermissoes.podeAbrir(await permissoes(u), 'stockRequests'), false);
  });

  test('autoridade vinda de outra camada (perfil) não ganha bloqueio ao desligar: o toggle mostra o efeito real e OFF só remove a concessão individual', async () => {
    await g.pool.query("INSERT INTO permissoes_acao (empresa_id, perfil, acao_codigo, permitido) VALUES ($1, 'SUPERVISOR', 'REALIZAR_ENTREGA', true) ON CONFLICT DO NOTHING", [g.empresas.A]);
    const s = await g.usuarioPronto(master, { tipoConta: 'SUPERVISOR' });
    assert.equal((await toggle(s.id)).ligado, true, 'efetivo pelo perfil');
    assert.equal(await rota(s), 200);
    await ligar(master, s.id, 'entregasSolicitacao', true);
    assert.equal((await concessao(s.id)).length, 0, 'já vale pelo perfil: nenhuma concessão redundante');
    const off = await ligar(master, s.id, 'entregasSolicitacao', false);
    assert.equal(off.status, 200);
    assert.equal((await bloqueio(s.id)).length, 0, 'não inventa bloqueio sobre a autoridade do perfil');
    assert.equal(await rota(s), 200, 'a autoridade do perfil continua valendo');
    assert.equal((await toggle(s.id)).ligado, true);
  });

  test('capacidades independentes: o vínculo SST, Aprovar e Reprovar não concedem a entrega, e a entrega não cria vínculo nem aprova', async () => {
    const u = await g.usuarioPronto(master, { vinculoSst: true });
    await ligar(master, u.id, 'aprovarSolicitacoes', true);
    await ligar(master, u.id, 'reprovarSolicitacoes', true);
    assert.equal(await rota(u), 403, 'SST + aprovar + reprovar não são entregar');
    assert.equal((await toggle(u.id)).ligado, false);
    const so = await g.usuarioPronto(master);
    await ligar(master, so.id, 'entregasSolicitacao', true);
    assert.equal((await g.todos('SELECT 1 FROM vinculo_sst WHERE usuario_id = $1', [so.id])).length, 0, 'entregar não cria o vínculo SST');
    const t = (await lista(master, so.id)).body.acessos.toggles;
    assert.deepEqual(['aprovarSolicitacoes', 'reprovarSolicitacoes'].map((id) => t.find((x) => x.id === id).ligado), [false, false]);
    // O mesmo usuário pode ter as duas funções (cenário de validação).
    const ambos = await g.usuarioPronto(master, { vinculoSst: true });
    await ligar(master, ambos.id, 'aprovarSolicitacoes', true);
    await ligar(master, ambos.id, 'entregasSolicitacao', true);
    assert.equal(await rota(ambos), 200);
  });

  test('autoridade e isolamento: só o MASTER grava; o MASTER é fixo; outra empresa não alcança o usuário nem herda a concessão', async () => {
    const u = await g.usuarioPronto(master);
    assert.equal((await ligar(admin, u.id, 'entregasSolicitacao', true)).body.codigo, 'PERMISSOES_INDIVIDUAIS_SOMENTE_MASTER');
    assert.equal((await concessao(u.id)).length, 0);
    const doMaster = await ligar(master, master.usuarioId, 'entregasSolicitacao', true);
    assert.deepEqual([doMaster.status, doMaster.body.codigo], [409, 'USUARIO_MASTER_PERMISSOES_FIXAS']);
    const masterB = await g.contaDaEmpresa(g.empresas.B);
    assert.equal((await ligar(masterB, u.id, 'entregasSolicitacao', true)).status, 404);
    await ligar(master, u.id, 'entregasSolicitacao', true);
    const deB = await g.usuarioPronto(masterB);
    assert.equal((await lista(masterB, deB.id)).body.acessos.toggles.find((t) => t.id === 'entregasSolicitacao').ligado, false, 'a concessão da A não vaza para a B');
    assert.equal(await rota(deB), 403);
  });
});
