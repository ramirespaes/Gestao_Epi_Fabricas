'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { montar } = require('./helpers/gestao-usuarios-app');
const autorizacao = require('../../src/middleware/autorizacao');
const { RECURSOS_COM_EFEITO, ACOES_COM_EFEITO } = require('../../src/rbac/recursos');

/** ETAPA F — Configurar permissões: catálogo dinâmico, camadas (perfil/grupo/individual), efetivo = o do middleware; escrita só do MASTER. */
const BASE = '/api/administracao/usuarios';

describe('Gestão de Usuários — Configurar permissões (PostgreSQL real)', () => {
  let g;
  let master;
  let grupo;
  let alternativa;
  let nenhuma;
  before(async () => {
    g = await montar();
    master = await g.contaDaEmpresa(g.empresas.A);
    grupo = (await g.um("INSERT INTO grupos_acesso (empresa_id, nome, criado_por) VALUES ($1, 'Almoxarifado', $2) RETURNING id", [g.empresas.A, master.usuarioId])).id;
    await g.pool.query("INSERT INTO permissoes_recurso (empresa_id, perfil, recurso, pode_visualizar, pode_criar) VALUES ($1, 'USUARIO', 'materials', true, false)", [g.empresas.A]);
    await g.pool.query("INSERT INTO grupo_permissoes_recurso (empresa_id, grupo_acesso_id, recurso, pode_criar) VALUES ($1, $2, 'materials', true)", [g.empresas.A, grupo]);
    alternativa = (await g.um("SELECT codigo FROM acoes WHERE ativo AND NOT exige_sst AND modo_autorizacao_individual = 'ALTERNATIVA' AND codigo = ANY($1) ORDER BY codigo LIMIT 1", [ACOES_COM_EFEITO])).codigo;
    nenhuma = (await g.um("SELECT codigo FROM acoes WHERE ativo AND modo_autorizacao_individual = 'NENHUMA' AND codigo = ANY($1) ORDER BY codigo LIMIT 1", [ACOES_COM_EFEITO]))?.codigo;
  });
  after(async () => { if (g) await g.encerrar(); });

  const detalhe = (c, id) => g.request(g.app).get(`${BASE}/${id}/permissoes`).set('Cookie', g.cookie(c));
  const recurso = (c, id, rec, corpo) => g.request(g.app).patch(`${BASE}/${id}/permissoes/recursos/${rec}`).set('Cookie', g.cookie(c)).send(corpo);
  const acao = (c, id, cod, estado) => g.request(g.app).put(`${BASE}/${id}/permissoes/acoes/${cod}`).set('Cookie', g.cookie(c)).send({ estado });
  const efetivasDe = async (email) => g.request(g.app).get('/api/auth/permissoes').set('Cookie', g.deCookies(g.cookiesDe(await g.login(email, g.SENHA_PROVISORIA))));

  test('catálogo vem do backend: só recursos/operações com efeito real e todas as ações do catálogo; cada célula traz perfil, grupo, individual, efetivo e origem; o efetivo é o do middleware', async () => {
    const u = await g.usuarioPronto(master, { grupoAcessoId: grupo });
    await g.pool.query("INSERT INTO usuario_permissoes_recurso (empresa_id, usuario_id, recurso, pode_visualizar, concedido_por) VALUES ($1, $2, 'materials', false, $3)", [g.empresas.A, u.id, master.usuarioId]);
    const r = await detalhe(master, u.id);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const d = r.body.permissoes;
    assert.deepEqual(d.recursos.map((x) => [x.recurso, x.rotulo, Object.keys(x.operacoes)]), RECURSOS_COM_EFEITO.map((x) => [x.recurso, x.rotulo, [...x.operacoes]]));
    const doCatalogo = (await g.todos('SELECT codigo FROM acoes ORDER BY codigo')).map((a) => a.codigo);
    assert.deepEqual(d.acoes.map((a) => a.codigo), doCatalogo.filter((c) => ACOES_COM_EFEITO.includes(c)), 'só as ações do catálogo que o backend aplica; nenhuma inventada');
    const semEfeito = doCatalogo.filter((c) => !ACOES_COM_EFEITO.includes(c));
    assert.ok(semEfeito.length > 0 && semEfeito.every((c) => !d.acoes.some((a) => a.codigo === c)), `ações sem uso no backend não aparecem: ${semEfeito}`);
    assert.equal((await acao(master, u.id, semEfeito[0], 'BLOQUEADA')).status, 404, 'nem se aceita configurá-las');
    const mat = d.recursos.find((x) => x.recurso === 'materials').operacoes;
    assert.deepEqual([mat.visualizar.perfil, mat.visualizar.grupo, mat.visualizar.individual, mat.visualizar.efetivo, mat.visualizar.origem], [true, null, false, false, 'INDIVIDUAL']);
    assert.deepEqual([mat.criar.perfil, mat.criar.grupo, mat.criar.individual, mat.criar.efetivo, mat.criar.origem], [false, true, null, true, 'GRUPO']);
    assert.deepEqual([mat.editar.efetivo, mat.editar.origem], [false, 'PERFIL']);
    const ctx = { empresaId: g.empresas.A, usuarioId: u.id, perfil: 'USUARIO' };
    for (const rec of d.recursos) {
      const esperado = await autorizacao.avaliarPermissaoRecurso(g.pool, ctx, rec.recurso);
      for (const [op, c] of Object.entries(rec.operacoes)) assert.equal(c.efetivo, esperado[op], `${rec.recurso}.${op}`);
    }
    for (const a of d.acoes) assert.equal(a.efetivo, await autorizacao.avaliarPermissaoAcao(g.pool, ctx, a.codigo), a.codigo);
    assert.deepEqual([d.usuario.perfil, d.grupo, d.podeAlterar], ['USUARIO', { nome: 'Almoxarifado', ativo: true }, true]);
    assert.equal(JSON.stringify(d).includes(u.corpo.cpf), false);
  });

  test('recurso individual: o PATCH concede/nega/limpa, vale no /auth/permissoes do alvo, valida recurso e operação com efeito, e só o MASTER escreve', async () => {
    const u = await g.usuarioPronto(master);
    assert.equal((await efetivasDe(u.email)).body.recursos.dashboard?.visualizar ?? false, false);
    const ok = await recurso(master, u.id, 'dashboard', { visualizar: true });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.recurso.operacoes.visualizar.efetivo, true);
    assert.equal((await efetivasDe(u.email)).body.recursos.dashboard.visualizar, true, 'o backend reflete a mudança');
    assert.equal((await recurso(master, u.id, 'dashboard', { visualizar: false })).body.recurso.operacoes.visualizar.efetivo, false);
    await recurso(master, u.id, 'dashboard', { visualizar: null });
    assert.equal((await g.todos('SELECT 1 FROM usuario_permissoes_recurso WHERE usuario_id = $1', [u.id])).length, 0, 'tudo null apaga a linha');
    assert.equal((await recurso(master, u.id, 'recursoInexistente', { visualizar: true })).status, 404);
    assert.equal((await recurso(master, u.id, 'dashboard', { criar: true })).status, 400, 'operação sem rota que a exija não tem efeito');
    assert.equal((await recurso(master, u.id, 'dashboard', {})).status, 400);
    assert.equal((await recurso(master, u.id, 'dashboard', { visualizar: 'sim' })).status, 400);
    const adm = await g.administradorAutorizado(g.empresas.A, master);
    const negado = await recurso(adm, u.id, 'dashboard', { visualizar: true });
    assert.deepEqual([negado.status, negado.body.codigo], [403, 'PERMISSOES_INDIVIDUAIS_SOMENTE_MASTER']);
    assert.equal((await recurso(master, master.usuarioId, 'dashboard', { visualizar: false })).body.codigo, 'USUARIO_MASTER_PERMISSOES_FIXAS');
    assert.equal((await recurso(await g.contaDaEmpresa(g.empresas.B), u.id, 'dashboard', { visualizar: true })).status, 404);
    const aud = await g.todos("SELECT dados_novos FROM logs_auditoria WHERE acao = 'USUARIO_PERMISSAO_RECURSO_ALTERADA' AND referencia = $1", [String(u.id)]);
    assert.ok(aud.length >= 3);
    assert.equal(/senha|token|hash/i.test(JSON.stringify(aud)), false);
  });

  test('ação individual: CONCEDIDA, BLOQUEADA e PADRAO (transacionais); bloqueio prevalece; ação em modo NENHUMA não é concedível; efetivo recalculado; só o MASTER escreve', async () => {
    const u = await g.usuarioPronto(master);
    const ctx = { empresaId: g.empresas.A, usuarioId: u.id, perfil: 'USUARIO' };
    const linhas = async () => ({
      aut: (await g.todos('SELECT origem_id FROM usuario_autorizacoes WHERE usuario_id = $1 AND acao_codigo = $2', [u.id, alternativa])).length,
      blq: (await g.todos('SELECT 1 FROM usuario_bloqueios WHERE usuario_id = $1 AND acao_codigo = $2', [u.id, alternativa])).length,
    });
    const conceder = await acao(master, u.id, alternativa, 'CONCEDIDA');
    assert.equal(conceder.status, 200, JSON.stringify(conceder.body));
    assert.deepEqual([await linhas(), conceder.body.acao.estado, conceder.body.acao.efetivo, await autorizacao.avaliarPermissaoAcao(g.pool, ctx, alternativa)], [{ aut: 1, blq: 0 }, 'CONCEDIDA', true, true]);
    assert.equal((await efetivasDe(u.email)).body.acoes[alternativa], true);
    const bloquear = await acao(master, u.id, alternativa, 'BLOQUEADA');
    assert.deepEqual([await linhas(), bloquear.body.acao.estado, bloquear.body.acao.efetivo], [{ aut: 0, blq: 1 }, 'BLOQUEADA', false]);
    assert.equal(bloquear.body.acao.motivoNegado, 'BLOQUEIO_INDIVIDUAL');
    const padrao = await acao(master, u.id, alternativa, 'PADRAO');
    assert.deepEqual([await linhas(), padrao.body.acao.estado], [{ aut: 0, blq: 0 }, 'PADRAO']);
    if (nenhuma) {
      const naoConcede = await acao(master, u.id, nenhuma, 'CONCEDIDA');
      assert.deepEqual([naoConcede.status, naoConcede.body.codigo], [409, 'ACAO_NAO_CONCEDIVEL']);
      assert.equal((await acao(master, u.id, nenhuma, 'BLOQUEADA')).status, 200, 'bloquear segue possível');
    }
    assert.equal((await acao(master, u.id, 'ACAO_QUE_NAO_EXISTE', 'PADRAO')).status, 404);
    assert.equal((await acao(master, u.id, alternativa, 'TALVEZ')).status, 400);
    const adm = await g.administradorAutorizado(g.empresas.A, master);
    assert.equal((await acao(adm, u.id, alternativa, 'CONCEDIDA')).body.codigo, 'PERMISSOES_INDIVIDUAIS_SOMENTE_MASTER');
    assert.equal((await acao(master, master.usuarioId, alternativa, 'BLOQUEADA')).body.codigo, 'USUARIO_MASTER_PERMISSOES_FIXAS');
    assert.equal((await acao(await g.contaDaEmpresa(g.empresas.B), u.id, alternativa, 'CONCEDIDA')).status, 404);
  });

  test('leitura: autoridade de administrar usuários e perfil gerenciável; ADMINISTRADOR vê mas não altera; MASTER como alvo aparece fixo; outra empresa 404; sem autoridade 403', async () => {
    const u = await g.usuarioPronto(master);
    const adm = await g.administradorAutorizado(g.empresas.A, master);
    const r = await detalhe(adm, u.id);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.permissoes.podeAlterar, r.body.permissoes.motivoSomenteLeitura], [false, 'SOMENTE_MASTER']);
    assert.equal((await detalhe(await g.contaDaEmpresa(g.empresas.A, 'SUPERVISOR'), u.id)).status, 403);
    assert.equal((await detalhe(await g.contaDaEmpresa(g.empresas.B), u.id)).status, 404);
    const m = await detalhe(master, master.usuarioId);
    assert.equal(m.status, 200);
    assert.deepEqual([m.body.permissoes.podeAlterar, m.body.permissoes.motivoSomenteLeitura, m.body.permissoes.grupo], [false, 'USUARIO_MASTER', null]);
    assert.ok(m.body.permissoes.acoes.every((a) => a.estadosPermitidos.length === 0), 'MASTER: tudo fixo');
    const aoMaster = await detalhe(adm, master.usuarioId);
    assert.deepEqual([aoMaster.status, aoMaster.body.codigo], [403, 'USUARIO_PERFIL_NAO_PERMITIDO'], 'ADMINISTRADOR só gerencia SUPERVISOR e USUARIO (D3)');
  });

  test('regras estruturais aparecem como tal: ações com vínculo SST e a autodecisão; resumo individual', async () => {
    const u = await g.usuarioPronto(master);
    const d = (await detalhe(master, u.id)).body.permissoes;
    const aprovar = d.acoes.find((a) => a.codigo === 'APROVAR_SOLICITACAO');
    assert.ok(aprovar, 'APROVAR_SOLICITACAO existe no catálogo');
    assert.deepEqual([aprovar.exigeSst, aprovar.regras.includes('SST'), aprovar.regras.includes('AUTODECISAO_PROIBIDA')], [true, true, true]);
    assert.equal(aprovar.efetivo, false);
    assert.equal(aprovar.motivoNegado === 'SEM_VINCULO_SST' || aprovar.motivoNegado === 'NAO_CONCEDIDA', true);
    await acao(master, u.id, alternativa, 'CONCEDIDA');
    await recurso(master, u.id, 'dashboard', { visualizar: true });
    const r = (await detalhe(master, u.id)).body.permissoes.resumoIndividual;
    assert.deepEqual(r, { recursos: 1, autorizacoes: 1, bloqueios: 0 });
  });
});
