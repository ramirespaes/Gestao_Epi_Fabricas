'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Router } = require('express');

const { montar } = require('./helpers/gestao-usuarios-app');
const { criarEstoqueRoutes } = require('../../src/routes/estoque.routes');
const { criarFuncionarioRoutes } = require('../../src/routes/funcionario.routes');
const { criarMaterialRoutes } = require('../../src/routes/material.routes');

/**
 * Gestão de Estoque (Cadastrar Produto, Entrada por Lote, Registrar Baixa / Saída) e Importação de Funcionários:
 * acessos independentes, com as ROTAS REAIS de produção montadas (autorização antes da validação e do controller).
 */
const BASE = '/api/administracao/usuarios';
// Controller de mentira: se a autorização deixar passar, a rota responde 200 sem tocar o domínio.
const controllerLiberado = new Proxy({}, { get: () => (req, res) => res.status(200).json({ ok: true }) });

describe('Gestão de Estoque e Importação — acessos independentes (PostgreSQL real)', () => {
  let g;
  let master;
  before(async () => {
    g = await montar({ extras: ({ pool, exigirEmpresarial }) => {
      const deps = { controller: controllerLiberado, exigirSessao: exigirEmpresarial, pool };
      return [criarEstoqueRoutes(deps), criarFuncionarioRoutes(deps), criarMaterialRoutes(deps)];
    } });
    master = await g.contaDaEmpresa(g.empresas.A);
  });
  after(async () => { if (g) await g.encerrar(); });

  const ligar = (c, id, toggle, ligado) => g.request(g.app).put(`${BASE}/${id}/acessos/${toggle}`).set('Cookie', g.cookie(c)).send({ ligado });
  const lista = (c, id) => g.request(g.app).get(`${BASE}/${id}/acessos`).set('Cookie', g.cookie(c));
  const como = async (u) => g.deCookies(g.cookiesDe(await g.login(u.email, g.SENHA_PROVISORIA)));
  const estado = async (id, toggle) => (await lista(master, id)).body.acessos.toggles.find((t) => t.id === toggle).ligado;
  const efetivas = async (u) => (await g.request(g.app).get('/api/auth/permissoes').set('Cookie', await como(u))).body;
  // 403 = a autorização negou; qualquer outro status = a autorização deixou passar.
  const nega = async (u, metodo, caminho) => (await g.request(g.app)[metodo](`/api${caminho}`).set('Cookie', await como(u)).send({})).status === 403;
  const ACOES = {
    produto: ['post', '/materiais'],
    entrada: ['post', '/materiais/1/estoque/entradas'],
    baixa: ['post', '/estoque/lotes/1/baixas'],
    importar: ['post', '/funcionarios/importacao'],
  };
  const permissoesDasRotas = async (u) => {
    const r = {};
    for (const [nome, [metodo, caminho]] of Object.entries(ACOES)) r[nome] = !(await nega(u, metodo, caminho));
    return r;
  };

  test('cada um dos três ON isoladamente libera só a própria operação (API direta); os outros dois seguem negados', async () => {
    const casos = [
      ['cadastrarProduto', { produto: true, entrada: false, baixa: false, importar: false }],
      ['entradaLote', { produto: false, entrada: true, baixa: false, importar: false }],
      ['registrarBaixa', { produto: false, entrada: false, baixa: true, importar: false }],
    ];
    for (const [toggle, esperado] of casos) {
      const u = await g.usuarioPronto(master);
      assert.deepEqual(await permissoesDasRotas(u), { produto: false, entrada: false, baixa: false, importar: false }, 'tudo negado no início');
      assert.equal((await ligar(master, u.id, toggle, true)).body.acesso.ligado, true);
      assert.deepEqual(await permissoesDasRotas(u), esperado, toggle);
    }
  });

  test('OFF volta a negar no servidor, uma ação não concede as outras e o estado persiste', async () => {
    const u = await g.usuarioPronto(master);
    for (const t of ['cadastrarProduto', 'entradaLote', 'registrarBaixa']) await ligar(master, u.id, t, true);
    assert.deepEqual(await permissoesDasRotas(u), { produto: true, entrada: true, baixa: true, importar: false });
    await ligar(master, u.id, 'entradaLote', false);
    assert.deepEqual(await permissoesDasRotas(u), { produto: true, entrada: false, baixa: true, importar: false });
    assert.deepEqual([await estado(u.id, 'cadastrarProduto'), await estado(u.id, 'entradaLote'), await estado(u.id, 'registrarBaixa')], [true, false, true], 'persiste numa nova leitura');
    await ligar(master, u.id, 'registrarBaixa', false);
    assert.deepEqual(await permissoesDasRotas(u), { produto: true, entrada: false, baixa: false, importar: false });
  });

  test('desligar um não derruba a leitura de materiais de que os outros dependem; ligar garante a leitura (menu e página)', async () => {
    const u = await g.usuarioPronto(master);
    await ligar(master, u.id, 'entradaLote', true);
    await ligar(master, u.id, 'registrarBaixa', true);
    let p = await efetivas(u);
    assert.equal(p.recursos.materials.visualizar, true, 'a página lista materiais e lotes');
    assert.equal(p.recursos.materials.criar, false, 'entrada e baixa não dão Cadastrar Produto');
    await ligar(master, u.id, 'cadastrarProduto', true);
    await ligar(master, u.id, 'cadastrarProduto', false);
    p = await efetivas(u);
    assert.deepEqual([p.recursos.materials.visualizar, p.recursos.materials.criar], [true, false]);
    assert.deepEqual([p.acoes.ENTRADA_ESTOQUE, p.acoes.BAIXA_ESTOQUE], [true, true]);
  });

  test('regra da página: aparece com pelo menos um ligado e some com os três OFF (menu e URL pela mesma regra do frontend)', async () => {
    // eslint-disable-next-line global-require
    const EpiPermissoes = require('../../../frontend/js/permissoes-efetivas');
    const u = await g.usuarioPronto(master);
    const abre = async () => EpiPermissoes.podeAbrir(await efetivas(u), 'materials');
    assert.equal(await abre(), false, 'os três OFF');
    for (const t of ['cadastrarProduto', 'entradaLote', 'registrarBaixa']) {
      await ligar(master, u.id, t, true);
      assert.equal(await abre(), true, `${t} ON`);
      await ligar(master, u.id, t, false);
      assert.equal(await abre(), false, `${t} OFF de novo`);
    }
    await ligar(master, u.id, 'entradaLote', true);
    await ligar(master, u.id, 'registrarBaixa', true);
    await ligar(master, u.id, 'entradaLote', false);
    assert.equal(await abre(), true, 'um dos dois ainda ligado');
    await ligar(master, u.id, 'registrarBaixa', false);
    assert.equal(await abre(), false, 'os três OFF: fechada, mesmo com a leitura de materiais ainda concedida');
  });

  test('Importação de Funcionários é permissão própria (ação IMPORTAR_FUNCIONARIOS): não depende de employeeHistory.criar e o Histórico não depende dela', async () => {
    // Histórico (incl. criar funcionário) ON não importa.
    const u = await g.usuarioPronto(master);
    await g.pool.query("INSERT INTO usuario_permissoes_recurso (empresa_id, usuario_id, recurso, pode_visualizar, pode_criar, concedido_por) VALUES ($1, $2, 'employeeHistory', true, true, $3)", [g.empresas.A, u.id, master.usuarioId]);
    const p = await efetivas(u);
    assert.deepEqual([p.recursos.employeeHistory.visualizar, p.recursos.employeeHistory.criar], [true, true]);
    assert.equal(await nega(u, 'post', '/funcionarios/importacao'), true, 'employeeHistory.criar não é importar');
    assert.equal(await estado(u.id, 'historicoFuncionarios'), true);

    // Importação ON sem nenhum acesso ao Histórico (Histórico OFF + Importação ON).
    const s = await g.usuarioPronto(master);
    assert.equal(await estado(s.id, 'importacaoFuncionarios'), false);
    assert.equal(await nega(s, 'post', '/funcionarios/importacao'), true, 'OFF de partida');
    assert.equal((await ligar(master, s.id, 'importacaoFuncionarios', true)).body.acesso.ligado, true, 'o toggle liga (concessão individual)');
    const ps = await efetivas(s);
    assert.equal(ps.acoes.IMPORTAR_FUNCIONARIOS, true);
    assert.equal(ps.recursos.employeeHistory?.visualizar ?? false, false, 'importar não abre o Histórico');
    assert.equal(await estado(s.id, 'historicoFuncionarios'), false);
    assert.equal(await nega(s, 'post', '/funcionarios/importacao'), false, 'ON libera a função real (API direta)');
    assert.equal(await estado(s.id, 'importacaoFuncionarios'), true, 'persiste');
    // Histórico ON + Importação OFF: o desligar bloqueia no servidor mesmo com o Histórico ligado.
    await ligar(master, s.id, 'historicoFuncionarios', true);
    assert.equal((await ligar(master, s.id, 'importacaoFuncionarios', false)).body.acesso.ligado, false);
    assert.equal(await nega(s, 'post', '/funcionarios/importacao'), true, 'OFF bloqueia a chamada direta');
    assert.equal(await estado(s.id, 'historicoFuncionarios'), true);
    assert.equal(await estado(s.id, 'importacaoFuncionarios'), false);
    assert.equal((await g.todos("SELECT 1 FROM usuario_autorizacoes WHERE usuario_id = $1 AND acao_codigo = 'IMPORTAR_FUNCIONARIOS'", [s.id])).length, 0, 'voltou ao herdado: sem exceção redundante');
  });

  test('Importação herdada do perfil: desligar usa bloqueio individual e religar remove a exceção', async () => {
    await g.pool.query("INSERT INTO permissoes_acao (empresa_id, perfil, acao_codigo, permitido) VALUES ($1, 'SUPERVISOR', 'IMPORTAR_FUNCIONARIOS', true) ON CONFLICT DO NOTHING", [g.empresas.A]);
    const s = await g.usuarioPronto(master, { tipoConta: 'SUPERVISOR' });
    assert.equal(await estado(s.id, 'importacaoFuncionarios'), true, 'herdado');
    await ligar(master, s.id, 'importacaoFuncionarios', false);
    assert.equal(await nega(s, 'post', '/funcionarios/importacao'), true);
    assert.equal((await g.todos("SELECT 1 FROM usuario_bloqueios WHERE usuario_id = $1 AND acao_codigo = 'IMPORTAR_FUNCIONARIOS'", [s.id])).length, 1);
    await ligar(master, s.id, 'importacaoFuncionarios', true);
    assert.equal(await nega(s, 'post', '/funcionarios/importacao'), false);
    assert.equal((await g.todos("SELECT 1 FROM usuario_bloqueios WHERE usuario_id = $1 AND acao_codigo = 'IMPORTAR_FUNCIONARIOS'", [s.id])).length, 0);
  });

  test('multitenancy, MASTER e autoridade: outra empresa não alcança, MASTER é fixo, só o MASTER grava', async () => {
    const u = await g.usuarioPronto(master);
    assert.equal((await ligar(await g.contaDaEmpresa(g.empresas.B), u.id, 'entradaLote', true)).status, 404);
    const adm = await g.administradorAutorizado(g.empresas.A, master);
    assert.equal((await ligar(adm, u.id, 'registrarBaixa', true)).body.codigo, 'PERMISSOES_INDIVIDUAIS_SOMENTE_MASTER');
    assert.equal((await ligar(master, master.usuarioId, 'entradaLote', false)).body.codigo, 'USUARIO_MASTER_PERMISSOES_FIXAS');
    const visao = await lista(master, master.usuarioId);
    assert.equal((await ligar(await g.contaDaEmpresa(g.empresas.B), u.id, 'importacaoFuncionarios', true)).status, 404);
    assert.equal((await ligar(master, master.usuarioId, 'importacaoFuncionarios', false)).body.codigo, 'USUARIO_MASTER_PERMISSOES_FIXAS');
    for (const id of ['cadastrarProduto', 'entradaLote', 'registrarBaixa', 'importacaoFuncionarios']) {
      assert.equal(visao.body.acessos.toggles.find((t) => t.id === id).fixo, true, id);
    }
    // O usuário de outra empresa nunca ganha o acesso da empresa A.
    assert.equal(await estado(u.id, 'entradaLote'), false);
  });

  test('uma concessão antiga de MOVIMENTAR_ESTOQUE não autoriza mais nenhuma rota (sem ponte escondida)', async () => {
    const u = await g.usuarioPronto(master);
    await g.pool.query("INSERT INTO usuario_autorizacoes (empresa_id, usuario_id, acao_codigo, autorizado_por) VALUES ($1, $2, 'MOVIMENTAR_ESTOQUE', $3)", [g.empresas.A, u.id, master.usuarioId]);
    assert.deepEqual(await permissoesDasRotas(u), { produto: false, entrada: false, baixa: false, importar: false });
  });
});
