'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Router } = require('express');

const { montar } = require('./helpers/gestao-usuarios-app');
const { criarExigirPermissaoAcao } = require('../../src/middleware/autorizacao');

/**
 * Vínculo SST na Gestão de Usuários (Novo e Alterar usuário) e as permissões de decisão (Aprovar e Reprovar
 * solicitações) no catálogo binário. O vínculo ("atua na SST?") e a permissão ("o que pode fazer?") são dimensões
 * distintas: o acesso à Aprovação exige as duas, decididas pelo servidor.
 */
const BASE = '/api/administracao/usuarios';

describe('Gestão de Usuários — vínculo SST e permissões de decisão (PostgreSQL real)', () => {
  let g;
  let master;
  let admin;
  before(async () => {
    g = await montar({ extras: ({ pool, exigirEmpresarial }) => {
      const r = Router();
      // A mesma proteção da fila da Aprovação da Segurança do Trabalho (APROVAR_SOLICITACAO, exigindo vínculo SST).
      r.get('/teste/fila-aprovacao', exigirEmpresarial, criarExigirPermissaoAcao({ pool }, 'APROVAR_SOLICITACAO'), (req, res) => res.json({ ok: true }));
      r.get('/teste/reprovar', exigirEmpresarial, criarExigirPermissaoAcao({ pool }, 'REPROVAR_SOLICITACAO'), (req, res) => res.json({ ok: true }));
      return [r];
    } });
    master = await g.contaDaEmpresa(g.empresas.A);
    admin = await g.administradorAutorizado(g.empresas.A, master);
  });
  after(async () => { if (g) await g.encerrar(); });

  const edicao = (c, id) => g.request(g.app).get(`${BASE}/${id}/edicao`).set('Cookie', g.cookie(c));
  const alterar = (c, id, corpo) => g.request(g.app).patch(`${BASE}/${id}`).set('Cookie', g.cookie(c)).send(corpo);
  const ligar = (c, id, toggle, ligado) => g.request(g.app).put(`${BASE}/${id}/acessos/${toggle}`).set('Cookie', g.cookie(c)).send({ ligado });
  const lista = (c, id) => g.request(g.app).get(`${BASE}/${id}/acessos`).set('Cookie', g.cookie(c));
  const como = async (u) => g.deCookies(g.cookiesDe(await g.login(u.email, g.SENHA_PROVISORIA)));
  const rota = async (u, caminho) => (await g.request(g.app).get(`/api${caminho}`).set('Cookie', await como(u))).status;
  const vinculos = (empresaId) => g.todos('SELECT usuario_id FROM vinculo_sst WHERE empresa_id = $1 ORDER BY usuario_id', [empresaId]);
  const temVinculo = async (id) => (await g.todos('SELECT 1 FROM vinculo_sst WHERE usuario_id = $1', [id])).length === 1;
  const estadoSst = async (c, id) => (await edicao(c, id)).body.usuario.vinculoSst;

  test('Novo Usuário: SST desligado por padrão (nenhum perfil vira SST sozinho) e ligado quando pedido, com auditoria', async () => {
    for (const tipoConta of ['USUARIO', 'SUPERVISOR', 'ADMINISTRADOR']) {
      const r = await g.criar(master, g.corpoBase({ tipoConta }));
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.administrativo.vinculoSst, false, tipoConta);
      assert.equal(await temVinculo(r.body.usuario.id), false, `${tipoConta} não nasce SST pelo perfil`);
    }
    const explicitoOff = await g.criar(master, g.corpoBase({ vinculoSst: false }));
    assert.equal(await temVinculo(explicitoOff.body.usuario.id), false);
    const on = await g.criar(master, g.corpoBase({ vinculoSst: true }));
    assert.equal(on.status, 201, JSON.stringify(on.body));
    assert.equal(on.body.administrativo.vinculoSst, true);
    assert.equal(await temVinculo(on.body.usuario.id), true);
    const aud = await g.todos("SELECT dados_novos FROM logs_auditoria WHERE acao = 'VINCULO_SST_ADICIONADO' AND referencia = $1", [String(on.body.usuario.id)]);
    assert.equal(aud.length, 1);
    assert.equal(await estadoSst(master, on.body.usuario.id), true, 'o estado real aparece ao editar');
  });

  test('Alterar usuário: OFF → ON → OFF pelo estado real; repetir o mesmo valor não muda nem audita', async () => {
    const u = await g.usuarioPronto(master);
    assert.equal(await estadoSst(master, u.id), false);
    const ligado = await alterar(master, u.id, { vinculoSst: true });
    assert.equal(ligado.status, 200, JSON.stringify(ligado.body));
    assert.equal(ligado.body.alterado, true);
    assert.equal(await estadoSst(master, u.id), true);
    const repetido = await alterar(master, u.id, { vinculoSst: true });
    assert.equal(repetido.status, 200);
    assert.equal(repetido.body.alterado, false);
    const desligado = await alterar(master, u.id, { vinculoSst: false });
    assert.equal(desligado.body.alterado, true);
    assert.equal(await temVinculo(u.id), false);
    assert.equal(await estadoSst(master, u.id), false);
    const aud = await g.todos("SELECT acao FROM logs_auditoria WHERE referencia = $1 AND acao LIKE 'VINCULO_SST_%' ORDER BY id", [String(u.id)]);
    assert.deepEqual(aud.map((a) => a.acao), ['VINCULO_SST_ADICIONADO', 'VINCULO_SST_REMOVIDO']);
    assert.equal((await alterar(master, u.id, { vinculoSst: 'sim' })).status, 400);
  });

  test('só o MASTER ativo liga ou desliga o vínculo: o administrador recebe 403 e a criação inteira é desfeita', async () => {
    const antes = (await g.todos('SELECT id FROM usuarios WHERE empresa_id = $1', [g.empresas.A])).length;
    const negadoNovo = await g.criar(admin, g.corpoBase({ vinculoSst: true }));
    assert.deepEqual([negadoNovo.status, negadoNovo.body.codigo], [403, 'SEM_AUTORIDADE_VINCULO_SST']);
    assert.equal((await g.todos('SELECT id FROM usuarios WHERE empresa_id = $1', [g.empresas.A])).length, antes, 'nenhum usuário nasceu');
    const semSst = await g.criar(admin, g.corpoBase());
    assert.equal(semSst.status, 201, 'sem pedir SST o administrador cria normalmente');
    const alvo = semSst.body.usuario.id;
    const negadoAlterar = await alterar(admin, alvo, { vinculoSst: true });
    assert.deepEqual([negadoAlterar.status, negadoAlterar.body.codigo], [403, 'SEM_AUTORIDADE_VINCULO_SST']);
    assert.equal(await temVinculo(alvo), false);
    assert.equal((await alterar(admin, alvo, { vinculoSst: false })).status, 200, 'pedir o estado que já é verdade não exige autoridade do vínculo');
    await alterar(master, alvo, { vinculoSst: true });
    const negadoRemover = await alterar(admin, alvo, { vinculoSst: false });
    assert.equal(negadoRemover.status, 403);
    assert.equal(await temVinculo(alvo), true, 'o administrador não removeu');
  });

  test('regras do vínculo preservadas: o MASTER não é alvo, usuário inativo não recebe, outra empresa não alcança e o vínculo de uma empresa não vale na outra', async () => {
    const noMaster = await alterar(master, master.usuarioId, { vinculoSst: true });
    assert.deepEqual([noMaster.status, noMaster.body.codigo], [409, 'VINCULO_SST_NAO_SE_APLICA_AO_MASTER']);
    const inativo = await g.usuarioPronto(master);
    await g.request(g.app).post(`${BASE}/${inativo.id}/inativar`).set('Cookie', g.cookie(master)).send({});
    const recusado = await alterar(master, inativo.id, { vinculoSst: true });
    assert.deepEqual([recusado.status, recusado.body.codigo], [409, 'USUARIO_INATIVO']);
    const daA = await g.usuarioPronto(master, { vinculoSst: true });
    const masterB = await g.contaDaEmpresa(g.empresas.B);
    assert.equal((await alterar(masterB, daA.id, { vinculoSst: false })).status, 404, 'outra empresa não enxerga o usuário');
    assert.equal((await edicao(masterB, daA.id)).status, 404);
    assert.equal(await temVinculo(daA.id), true);
    const daB = await g.usuarioPronto(masterB, { vinculoSst: true });
    assert.ok((await vinculos(g.empresas.A)).some((v) => v.usuario_id === daA.id));
    assert.equal((await vinculos(g.empresas.A)).some((v) => v.usuario_id === daB.id), false, 'o vínculo da B não aparece na A');
    assert.equal((await vinculos(g.empresas.B)).some((v) => v.usuario_id === daA.id), false);
  });

  test('Aprovar e Reprovar solicitações aparecem no catálogo binário como concessão: ON/OFF reais, sem criar o vínculo e sem depender dele para ligar', async () => {
    const u = await g.usuarioPronto(master);
    const r = await lista(master, u.id);
    for (const id of ['aprovarSolicitacoes', 'reprovarSolicitacoes']) {
      const t = r.body.acessos.toggles.find((x) => x.id === id);
      assert.deepEqual([t.ligado, t.exigeVinculoSst, t.vinculoSst], [false, true, false], id);
    }
    const on = await ligar(master, u.id, 'aprovarSolicitacoes', true);
    assert.equal(on.status, 200, JSON.stringify(on.body));
    assert.deepEqual([on.body.acesso.ligado, on.body.acesso.vinculoSst], [true, false], 'liga a concessão mesmo sem vínculo; a tela avisa que falta o vínculo');
    assert.equal(await temVinculo(u.id), false, 'a permissão não cria o vínculo');
    assert.equal((await g.todos("SELECT 1 FROM usuario_autorizacoes WHERE usuario_id = $1 AND acao_codigo = 'APROVAR_SOLICITACAO' AND origem_id IS NULL", [u.id])).length, 1);
    assert.equal((await lista(master, u.id)).body.acessos.toggles.find((x) => x.id === 'reprovarSolicitacoes').ligado, false, 'uma ação não concede a outra');
    const off = await ligar(master, u.id, 'aprovarSolicitacoes', false);
    assert.equal(off.body.acesso.ligado, false);
    assert.equal((await g.todos("SELECT 1 FROM usuario_autorizacoes WHERE usuario_id = $1 AND acao_codigo = 'APROVAR_SOLICITACAO'", [u.id])).length, 0);
    const adminNegado = await ligar(admin, u.id, 'aprovarSolicitacoes', true);
    assert.equal(adminNegado.body.codigo, 'PERMISSOES_INDIVIDUAIS_SOMENTE_MASTER');
  });

  test('acesso à Aprovação: só com o vínculo SST E a permissão; um sem o outro continua impedido; o vínculo não concede a permissão', async () => {
    const soVinculo = await g.usuarioPronto(master, { vinculoSst: true });
    assert.equal(await rota(soVinculo, '/teste/fila-aprovacao'), 403, 'vínculo sem permissão');
    const soPermissao = await g.usuarioPronto(master);
    await ligar(master, soPermissao.id, 'aprovarSolicitacoes', true);
    assert.equal(await rota(soPermissao, '/teste/fila-aprovacao'), 403, 'permissão sem vínculo');
    const ambos = await g.usuarioPronto(master, { vinculoSst: true });
    await ligar(master, ambos.id, 'aprovarSolicitacoes', true);
    assert.equal(await rota(ambos, '/teste/fila-aprovacao'), 200, 'vínculo e permissão');
    assert.equal(await rota(ambos, '/teste/reprovar'), 403, 'aprovar não concede reprovar');
    await ligar(master, ambos.id, 'reprovarSolicitacoes', true);
    assert.equal(await rota(ambos, '/teste/reprovar'), 200);
    await alterar(master, ambos.id, { vinculoSst: false });
    assert.equal(await rota(ambos, '/teste/fila-aprovacao'), 403, 'tirar o vínculo tira o acesso');
    await alterar(master, ambos.id, { vinculoSst: true });
    await ligar(master, ambos.id, 'aprovarSolicitacoes', false);
    assert.equal(await rota(ambos, '/teste/fila-aprovacao'), 403, 'tirar a permissão tira o acesso');
  });

  test('AUTODECISAO_PROIBIDA continua declarada nas ações de decisão; o MASTER não vira operador da SST nem tem os toggles configuráveis', async () => {
    const u = await g.usuarioPronto(master, { vinculoSst: true });
    const d = await g.request(g.app).get(`${BASE}/${u.id}/permissoes`).set('Cookie', g.cookie(master));
    const acao = (codigo) => d.body.permissoes.acoes.find((a) => a.codigo === codigo);
    for (const codigo of ['APROVAR_SOLICITACAO', 'REPROVAR_SOLICITACAO']) {
      assert.ok(acao(codigo).regras.includes('AUTODECISAO_PROIBIDA'), codigo);
      assert.ok(acao(codigo).regras.includes('SST'), codigo);
    }
    const doMaster = await ligar(master, master.usuarioId, 'aprovarSolicitacoes', true);
    assert.deepEqual([doMaster.status, doMaster.body.codigo], [409, 'USUARIO_MASTER_PERMISSOES_FIXAS']);
    assert.equal(await temVinculo(master.usuarioId), false, 'o MASTER não ganhou vínculo');
  });
});
