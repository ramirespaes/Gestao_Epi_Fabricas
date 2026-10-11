'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { montar } = require('./helpers/gestao-usuarios-app');
const { criarGrupoPermissaoController } = require('../../src/controllers/grupo-permissao.controller');
const { criarGrupoPermissaoRoutes } = require('../../src/routes/grupo-permissao.routes');

/**
 * Gestão de Usuários — complemento RED: aviso FUNCIONARIOS_SEM_VISUALIZAR nas permissões do GRUPO (PostgreSQL real).
 *
 * No grupo, `ligado` é a CONFIGURAÇÃO do grupo (o grupo concede), não o efeito nos integrantes: OFF retira a opinião
 * (null), nunca grava false, e o perfil e as exceções individuais continuam valendo. Mesma regra de detecção dos usuários,
 * sobre essa configuração: o grupo concede criar e/ou editar de Funcionários e NÃO concede o Histórico (visualizar) →
 * `avisos: [{ codigo: 'FUNCIONARIOS_SEM_VISUALIZAR' }]` no GET /grupos-acesso/:id/acessos e na resposta do PUT
 * (lista vazia sem inconsistência). Nada é revogado nem impedido; o catálogo do grupo não muda.
 */
const AVISO = 'FUNCIONARIOS_SEM_VISUALIZAR';

describe('Gestão de Usuários — aviso de Funcionários nas permissões do grupo (PostgreSQL real)', () => {
  let g;
  let master;
  before(async () => {
    g = await montar({ extras: ({ pool, exigirEmpresarial }) => [
      criarGrupoPermissaoRoutes({ controller: criarGrupoPermissaoController({ pool }), exigirSessao: exigirEmpresarial }),
    ] });
    master = await g.contaDaEmpresa(g.empresas.A);
  });
  after(async () => { if (g) await g.encerrar(); });

  let n = 0;
  const novoGrupo = async () => {
    n += 1;
    return (await g.um('INSERT INTO grupos_acesso (empresa_id, nome, criado_por) VALUES ($1, $2, $3) RETURNING id', [g.empresas.A, `Grupo aviso ${n}`, master.usuarioId])).id;
  };
  const lista = (id) => g.request(g.app).get(`/api/grupos-acesso/${id}/acessos`).set('Cookie', g.cookie(master));
  const ligar = async (id, toggle, ligado) => {
    const r = await g.request(g.app).put(`/api/grupos-acesso/${id}/acessos/${toggle}`).set('Cookie', g.cookie(master)).send({ ligado });
    assert.equal(r.status, 200, `${toggle}=${ligado}: ${JSON.stringify(r.body)}`);
    return r.body;
  };
  const acessos = async (id) => {
    const r = await lista(id);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.acessos;
  };
  const codigos = (corpo) => (Array.isArray(corpo.avisos) ? corpo.avisos.map((a) => a.codigo) : corpo.avisos);
  const linha = (grupo) => g.um("SELECT pode_visualizar, pode_criar, pode_editar FROM grupo_permissoes_recurso WHERE grupo_acesso_id = $1 AND recurso = 'employeeHistory'", [grupo]);
  const efetivas = async (u) => (await g.request(g.app).get('/api/auth/permissoes').set('Cookie', g.deCookies(g.cookiesDe(await g.login(u.email, g.SENHA_PROVISORIA))))).body;

  test('GA1 grupo sem inconsistência: novo (tudo OFF) e com o Histórico concedido — lista de avisos vazia', async () => {
    const grupo = await novoGrupo();
    assert.deepEqual(codigos(await acessos(grupo)), []);
    await ligar(grupo, 'historicoFuncionarios', true);
    assert.deepEqual(codigos(await acessos(grupo)), []);
    await ligar(grupo, 'editarFuncionario', true);
    assert.deepEqual(codigos(await acessos(grupo)), [], 'editar com o Histórico concedido não é inconsistência');
  });

  test('GA2 grupo com editar e sem o Histórico: aviso no PUT e no GET; a configuração fica como foi salva (sem revogar)', async () => {
    const grupo = await novoGrupo();
    await ligar(grupo, 'editarFuncionario', true); // liga também o Histórico (dependência)
    const off = await ligar(grupo, 'historicoFuncionarios', false);
    assert.equal(off.acesso.ligado, false);
    assert.deepEqual(codigos(off), [AVISO]);
    assert.deepEqual(codigos(await acessos(grupo)), [AVISO]);
    const l = await linha(grupo);
    assert.deepEqual([l.pode_visualizar, l.pode_editar], [null, true], 'visualizar só deixou de ser concedido (null); editar continua');
  });

  test('GA3 grupo com criar e sem o Histórico: aviso', async () => {
    const grupo = await novoGrupo();
    await ligar(grupo, 'cadastrarFuncionario', true);
    assert.deepEqual(codigos(await ligar(grupo, 'historicoFuncionarios', false)), [AVISO]);
    assert.equal((await linha(grupo)).pode_criar, true);
  });

  test('GA4 grupo com criar e editar e sem o Histórico: UM aviso só; religar o Histórico tira o aviso', async () => {
    const grupo = await novoGrupo();
    await ligar(grupo, 'cadastrarFuncionario', true);
    await ligar(grupo, 'editarFuncionario', true);
    await ligar(grupo, 'historicoFuncionarios', false);
    assert.deepEqual(codigos(await acessos(grupo)), [AVISO]);
    assert.deepEqual(codigos(await ligar(grupo, 'historicoFuncionarios', true)), []);
  });

  test('GA5 o aviso descreve a CONFIGURAÇÃO do grupo: um integrante que recebe o Histórico pelo perfil continua com acesso efetivo', async () => {
    await g.pool.query(
      "INSERT INTO permissoes_recurso (empresa_id, perfil, recurso, pode_visualizar) VALUES ($1, 'SUPERVISOR', 'employeeHistory', true) ON CONFLICT DO NOTHING",
      [g.empresas.A],
    );
    const grupo = await novoGrupo();
    const u = await g.usuarioPronto(master, { grupoAcessoId: grupo, tipoConta: 'SUPERVISOR' });
    await ligar(grupo, 'editarFuncionario', true);
    await ligar(grupo, 'historicoFuncionarios', false);
    assert.deepEqual(codigos(await acessos(grupo)), [AVISO], 'o grupo, como configurado, não concede o Histórico');
    const efetivo = (await efetivas(u)).recursos.employeeHistory;
    assert.deepEqual([efetivo.visualizar, efetivo.editar], [true, true], 'o integrante não perdeu o acesso: vem do perfil');
  });

  test('GA6 o aviso não muda o catálogo do grupo nem as demais respostas', async () => {
    const grupo = await novoGrupo();
    const a = await acessos(grupo);
    assert.deepEqual(a.toggles.map((t) => t.id), ['dashboard', 'historicoFuncionarios', 'cadastrarFuncionario', 'editarFuncionario', 'fichaEpi', 'entregasSolicitacao', 'gestaoGhe', 'analiseEstoque', 'operacoesEstoque', 'cadastrarProduto', 'entradaLote', 'registrarBaixa', 'importacaoFuncionarios', 'exportarHistoricoFuncionarios', 'reportsAudit', 'reportsFiscal']);
    assert.equal(a.grupo.id, grupo);
  });
});
