'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Router } = require('express');

const { montar } = require('./helpers/gestao-usuarios-app');
const { criarExigirPermissaoRecurso, criarExigirPermissaoAcao } = require('../../src/middleware/autorizacao');
const EpiPermissoes = require('../../../frontend/js/permissoes-efetivas');

/** Copiar permissões com EFEITO REAL: o destino passa a ter, na rota protegida e no menu, o acesso efetivo da origem. */
const BASE = '/api/administracao/usuarios';

describe('Copiar permissões — efeito real (PostgreSQL real)', () => {
  let g;
  let master;
  let grupo;
  before(async () => {
    g = await montar({ extras: ({ pool, exigirEmpresarial }) => {
      const r = Router();
      r.get('/teste/dashboard', exigirEmpresarial, criarExigirPermissaoRecurso({ pool }, 'dashboard', 'visualizar'), (req, res) => res.json({ ok: true }));
      r.get('/teste/estoque', exigirEmpresarial, criarExigirPermissaoAcao({ pool }, 'ENTRADA_ESTOQUE'), (req, res) => res.json({ ok: true }));
      r.get('/teste/entrega', exigirEmpresarial, criarExigirPermissaoAcao({ pool }, 'REALIZAR_ENTREGA'), (req, res) => res.json({ ok: true }));
      return [r];
    } });
    master = await g.contaDaEmpresa(g.empresas.A);
    grupo = (await g.um("INSERT INTO grupos_acesso (empresa_id, nome, criado_por) VALUES ($1, 'Almoxarifado', $2) RETURNING id", [g.empresas.A, master.usuarioId])).id;
  });
  after(async () => { if (g) await g.encerrar(); });

  const como = async (u) => g.deCookies(g.cookiesDe(await g.login(u.email, g.SENHA_PROVISORIA)));
  const rota = async (u, caminho) => (await g.request(g.app).get(`/api${caminho}`).set('Cookie', await como(u))).status;
  const put = (id, cod, estado) => g.request(g.app).put(`${BASE}/${id}/permissoes/acoes/${cod}`).set('Cookie', g.cookie(master)).send({ estado });
  const patch = (id, rec, corpo) => g.request(g.app).patch(`${BASE}/${id}/permissoes/recursos/${rec}`).set('Cookie', g.cookie(master)).send(corpo);
  const detalhe = async (id) => (await g.request(g.app).get(`${BASE}/${id}/permissoes`).set('Cookie', g.cookie(master))).body.permissoes;
  const efetivo = (d) => ({
    recursos: d.recursos.map((r) => [r.recurso, Object.entries(r.operacoes).map(([o, c]) => [o, c.efetivo, c.individual])]),
    acoes: d.acoes.map((a) => [a.codigo, a.estado, a.efetivo]),
  });

  test('depois da cópia o destino tem o MESMO acesso efetivo e as MESMAS camadas individuais da origem (detalhe, URL direta e menu); o que o destino tinha de individual sai; o perfil fica', async () => {
    const origem = await g.usuarioPronto(master, { tipoConta: 'SUPERVISOR', grupoAcessoId: grupo });
    const destino = await g.usuarioPronto(master, { tipoConta: 'SUPERVISOR' });
    await patch(origem.id, 'dashboard', { visualizar: true });
    await put(origem.id, 'ENTRADA_ESTOQUE', 'CONCEDIDA');
    await put(origem.id, 'REALIZAR_ENTREGA', 'BLOQUEADA');
    await put(destino.id, 'REALIZAR_ENTREGA', 'CONCEDIDA');
    assert.deepEqual([await rota(destino, '/teste/dashboard'), await rota(destino, '/teste/estoque'), await rota(destino, '/teste/entrega')], [403, 403, 200], 'antes: o destino só entrega');

    const r = await g.request(g.app).post(`${BASE}/${destino.id}/permissoes/copiar`).set('Cookie', g.cookie(master)).send({ origemId: origem.id });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([await rota(destino, '/teste/dashboard'), await rota(destino, '/teste/estoque'), await rota(destino, '/teste/entrega')], [200, 200, 403], 'depois: igual à origem (entrega bloqueada)');
    assert.deepEqual([await rota(origem, '/teste/dashboard'), await rota(origem, '/teste/estoque'), await rota(origem, '/teste/entrega')], [200, 200, 403]);
    assert.deepEqual(efetivo(await detalhe(destino.id)), efetivo(await detalhe(origem.id)), 'mesmo acesso efetivo e mesmas camadas');
    const menu = async (u) => EpiPermissoes.podeAbrir((await g.request(g.app).get('/api/auth/permissoes').set('Cookie', await como(u))).body, 'dashboard');
    assert.deepEqual([await menu(destino), await menu(origem)], [true, true], 'o menu acompanha');
    const d = await detalhe(destino.id);
    assert.deepEqual([d.usuario.perfil, d.grupo], ['SUPERVISOR', { nome: 'Almoxarifado', ativo: true }]);
    const aud = await g.um("SELECT dados_novos FROM logs_auditoria WHERE acao = 'USUARIO_PERMISSOES_COPIADAS' AND referencia = $1", [String(destino.id)]);
    assert.deepEqual([aud.dados_novos.origemId, aud.dados_novos.grupoCopiado, aud.dados_novos.recursos, aud.dados_novos.bloqueios, aud.dados_novos.autorizacoes], [origem.id, true, 1, 1, 1]);
  });

  test('copiar é idempotente e não toca em quem não participa: um terceiro e a origem seguem iguais; repetir dá o mesmo resultado', async () => {
    const origem = await g.usuarioPronto(master, { tipoConta: 'USUARIO', grupoAcessoId: grupo });
    const destino = await g.usuarioPronto(master, { tipoConta: 'USUARIO' });
    const terceiro = await g.usuarioPronto(master, { tipoConta: 'USUARIO' });
    await patch(origem.id, 'dashboard', { visualizar: true });
    await patch(terceiro.id, 'dashboard', { visualizar: false });
    const antesTerceiro = efetivo(await detalhe(terceiro.id));
    const antesOrigem = efetivo(await detalhe(origem.id));
    const copiar = () => g.request(g.app).post(`${BASE}/${destino.id}/permissoes/copiar`).set('Cookie', g.cookie(master)).send({ origemId: origem.id });
    assert.equal((await copiar()).status, 200);
    const primeira = efetivo(await detalhe(destino.id));
    assert.equal((await copiar()).status, 200);
    assert.deepEqual(efetivo(await detalhe(destino.id)), primeira);
    assert.deepEqual(efetivo(await detalhe(terceiro.id)), antesTerceiro);
    assert.deepEqual(efetivo(await detalhe(origem.id)), antesOrigem);
  });
});
