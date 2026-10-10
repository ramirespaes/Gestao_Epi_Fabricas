'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { montar } = require('./helpers/gestao-usuarios-app');
const provisionamento = require('../../src/services/provisionamento-permissoes.service');
const { criarFuncionarioController } = require('../../src/controllers/funcionario.controller');
const { criarFuncionarioRoutes } = require('../../src/routes/funcionario.routes');
const { criarGrupoPermissaoController } = require('../../src/controllers/grupo-permissao.controller');
const { criarGrupoPermissaoRoutes } = require('../../src/routes/grupo-permissao.routes');

/**
 * RBAC da Gestão de Funcionários (RED) — as três permissões que já existem, sem nenhuma nova:
 *   employeeHistory.visualizar  → consulta (lista, :id, consulta por CPF, seletor de GHE);
 *   employeeHistory.criar       → cadastro individual;
 *   employeeHistory.editar      → edição individual, troca de GHE, situação (rota nova, inativar e reativar).
 *
 * O ENFORCEMENT do servidor é por operação (não cumulativo): quem só tem criar cadastra; quem só tem editar edita. A dependência
 * com visualizar vive na ATRIBUIÇÃO (toggles ON/OFF de usuário e de grupo, pelo mecanismo existente `dependencias`) e no
 * PROVISIONAMENTO do MASTER, que concede as três juntas. A importação segue com a ação própria IMPORTAR_FUNCIONARIOS.
 *
 * Rotas e controller REAIS de funcionários, com a sessão empresarial real. Os pedidos usam um id que não existe e corpos
 * vazios: o que importa é 403 (autorização negou) contra qualquer outro status (a autorização deixou passar), sem gravar nada.
 */
const BASE_USUARIOS = '/api/administracao/usuarios';
const ID_INEXISTENTE = 999999;

describe('Gestão de Funcionários — RBAC (PostgreSQL real)', () => {
  let g;
  let master;
  before(async () => {
    g = await montar({ extras: ({ pool, exigirEmpresarial }) => [
      criarFuncionarioRoutes({ controller: criarFuncionarioController({ pool }), exigirSessao: exigirEmpresarial, pool }),
      criarGrupoPermissaoRoutes({ controller: criarGrupoPermissaoController({ pool }), exigirSessao: exigirEmpresarial }),
    ] });
    for (const empresaId of [g.empresas.A, g.empresas.B]) await provisionamento.provisionar(g.pool, { empresaId, dryRun: false });
    master = await g.contaDaEmpresa(g.empresas.A);
  });
  after(async () => { if (g) await g.encerrar(); });

  const como = async (u) => g.deCookies(g.cookiesDe(await g.login(u.email, g.SENHA_PROVISORIA)));
  const efetivas = async (u) => (await g.request(g.app).get('/api/auth/permissoes').set('Cookie', await como(u))).body;
  const chamar = async (u, metodo, caminho, corpo) => g.request(g.app)[metodo](`/api${caminho}`).set('Cookie', await como(u)).send(corpo ?? {});
  const negada = async (u, metodo, caminho, corpo) => (await chamar(u, metodo, caminho, corpo)).status === 403;
  const ligar = (c, id, toggle, ligado) => g.request(g.app).put(`${BASE_USUARIOS}/${id}/acessos/${toggle}`).set('Cookie', g.cookie(c)).send({ ligado });
  const lista = (c, id) => g.request(g.app).get(`${BASE_USUARIOS}/${id}/acessos`).set('Cookie', g.cookie(c));
  const toggleDe = async (c, id, toggle) => (await lista(c, id)).body.acessos?.toggles?.find((t) => t.id === toggle);
  const ligadoEm = async (id, toggle) => (await toggleDe(master, id, toggle))?.ligado;
  const conceder = (u, ops) => g.pool.query(
    `INSERT INTO usuario_permissoes_recurso (empresa_id, usuario_id, recurso, pode_visualizar, pode_criar, pode_editar, concedido_por)
     VALUES ($1, $2, 'employeeHistory', $3, $4, $5, $6)`,
    [g.empresas.A, u.id, ops.includes('v'), ops.includes('c'), ops.includes('e'), master.usuarioId],
  );

  // Cada endpoint de funcionários e a operação que o protege.
  const ENDPOINTS = [
    { nome: 'listar', op: 'v', metodo: 'get', caminho: '/funcionarios' },
    { nome: 'seletor de GHE', op: 'v', metodo: 'get', caminho: '/funcionarios/ghes' },
    { nome: 'consulta por id', op: 'v', metodo: 'get', caminho: `/funcionarios/${ID_INEXISTENTE}` },
    { nome: 'consulta por CPF', op: 'v', metodo: 'post', caminho: '/funcionarios/consulta-cpf' },
    { nome: 'cadastro individual', op: 'c', metodo: 'post', caminho: '/funcionarios' },
    { nome: 'edição individual', op: 'e', metodo: 'patch', caminho: `/funcionarios/${ID_INEXISTENTE}` },
    { nome: 'troca de GHE', op: 'e', metodo: 'patch', caminho: `/funcionarios/${ID_INEXISTENTE}`, corpo: { grupoHomogeneoId: 1 } },
    { nome: 'situação (rota nova)', op: 'e', metodo: 'post', caminho: `/funcionarios/${ID_INEXISTENTE}/situacao`, corpo: { situacao: 'AFASTADO' } },
    { nome: 'inativar (legado)', op: 'e', metodo: 'post', caminho: `/funcionarios/${ID_INEXISTENTE}/inativar` },
    { nome: 'reativar (legado)', op: 'e', metodo: 'post', caminho: `/funcionarios/${ID_INEXISTENTE}/reativar` },
  ];
  const permitidos = async (u) => {
    const r = {};
    for (const e of ENDPOINTS) r[e.nome] = !(await negada(u, e.metodo, e.caminho, e.corpo));
    return r;
  };
  const esperado = (ops) => Object.fromEntries(ENDPOINTS.map((e) => [e.nome, ops.includes(e.op)]));

  describe('enforcement do servidor: por operação, sem exigência cumulativa', () => {
    const COMBINACOES = ['', 'v', 'c', 'e', 'vc', 've', 'ce', 'vce'];
    for (const ops of COMBINACOES) {
      test(`permissões [${ops || 'nenhuma'}]: cada endpoint segue só a própria operação`, async () => {
        const u = await g.usuarioPronto(master);
        if (ops !== '') await conceder(u, ops);
        assert.deepEqual(await permitidos(u), esperado(ops));
      });
    }

    test('quem só tem criar cadastra mas não consulta; quem só tem editar edita (inclusive GHE e situação) mas não cadastra nem consulta', async () => {
      const soCriar = await g.usuarioPronto(master);
      await conceder(soCriar, 'c');
      assert.equal(await negada(soCriar, 'post', '/funcionarios'), false);
      assert.equal(await negada(soCriar, 'get', '/funcionarios'), true);
      assert.equal(await negada(soCriar, 'post', `/funcionarios/${ID_INEXISTENTE}/situacao`, { situacao: 'AFASTADO' }), true);
      const soEditar = await g.usuarioPronto(master);
      await conceder(soEditar, 'e');
      assert.equal(await negada(soEditar, 'patch', `/funcionarios/${ID_INEXISTENTE}`, { grupoHomogeneoId: 1 }), false);
      assert.equal(await negada(soEditar, 'post', `/funcionarios/${ID_INEXISTENTE}/situacao`, { situacao: 'AFASTADO' }), false);
      assert.equal(await negada(soEditar, 'post', '/funcionarios'), true);
      assert.equal(await negada(soEditar, 'get', '/funcionarios'), true);
    });

    test('sem sessão, nenhum endpoint de funcionários responde (401)', async () => {
      for (const e of ENDPOINTS) {
        // eslint-disable-next-line no-await-in-loop
        const r = await g.request(g.app)[e.metodo](`/api${e.caminho}`).send(e.corpo ?? {});
        assert.equal(r.status, 401, e.nome);
      }
    });
  });

  describe('importação: permissão própria, independente de criar e editar', () => {
    test('ter visualizar + criar + editar não importa; só a ação IMPORTAR_FUNCIONARIOS importa, e ela não dá criar nem editar nem consultar', async () => {
      const completo = await g.usuarioPronto(master);
      await conceder(completo, 'vce');
      assert.equal(await negada(completo, 'post', '/funcionarios/importacao'), true);
      assert.equal(await negada(completo, 'get', '/funcionarios/importacao/ghes'), true);

      const importador = await g.usuarioPronto(master);
      assert.equal((await ligar(master, importador.id, 'importacaoFuncionarios', true)).status, 200);
      assert.equal(await negada(importador, 'post', '/funcionarios/importacao'), false);
      assert.deepEqual(await permitidos(importador), esperado(''), 'importar não consulta, não cadastra e não edita');
    });
  });

  describe('atribuição pelo mecanismo existente de acessos (toggles): a dependência com visualizar', () => {
    test('os acessos de cadastrar e de editar funcionário existem no grupo Colaboradores, desligados, ao lado de Histórico e Importação', async () => {
      const u = await g.usuarioPronto(master);
      const toggles = (await lista(master, u.id)).body.acessos?.toggles ?? [];
      const colaboradores = toggles.filter((t) => t.grupo === 'COLABORADORES').map((t) => t.id);
      for (const id of ['historicoFuncionarios', 'importacaoFuncionarios', 'cadastrarFuncionario', 'editarFuncionario']) {
        assert.ok(colaboradores.includes(id), `${id} no grupo COLABORADORES: ${JSON.stringify(colaboradores)}`);
      }
      assert.equal(toggles.find((t) => t.id === 'cadastrarFuncionario')?.ligado, false);
      assert.equal(toggles.find((t) => t.id === 'editarFuncionario')?.ligado, false);
    });

    test('ligar "cadastrar" concede criar E garante visualizar (nunca editar); só o cadastro e a consulta passam no servidor', async () => {
      const u = await g.usuarioPronto(master);
      const r = await ligar(master, u.id, 'cadastrarFuncionario', true);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const p = (await efetivas(u)).recursos.employeeHistory;
      assert.deepEqual([p?.visualizar, p?.criar, p?.editar], [true, true, false]);
      assert.deepEqual(await permitidos(u), esperado('vc'));
    });

    test('ligar "editar" concede editar E garante visualizar (nunca criar); edição, GHE e situação passam, o cadastro não', async () => {
      const u = await g.usuarioPronto(master);
      const r = await ligar(master, u.id, 'editarFuncionario', true);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const p = (await efetivas(u)).recursos.employeeHistory;
      assert.deepEqual([p?.visualizar, p?.criar, p?.editar], [true, false, true]);
      assert.deepEqual(await permitidos(u), esperado('ve'));
    });

    test('desligar criar ou editar mexe só na regra própria: a leitura concedida pela dependência continua e o outro acesso não cai', async () => {
      const u = await g.usuarioPronto(master);
      assert.equal((await ligar(master, u.id, 'cadastrarFuncionario', true)).status, 200);
      assert.equal((await ligar(master, u.id, 'editarFuncionario', true)).status, 200);
      assert.equal((await ligar(master, u.id, 'cadastrarFuncionario', false)).status, 200);
      let p = (await efetivas(u)).recursos.employeeHistory;
      assert.deepEqual([p?.visualizar, p?.criar, p?.editar], [true, false, true]);
      assert.equal((await ligar(master, u.id, 'editarFuncionario', false)).status, 200);
      p = (await efetivas(u)).recursos.employeeHistory;
      assert.deepEqual([p?.visualizar, p?.criar, p?.editar], [true, false, false]);
      assert.deepEqual([await ligadoEm(u.id, 'cadastrarFuncionario'), await ligadoEm(u.id, 'editarFuncionario'), await ligadoEm(u.id, 'historicoFuncionarios')], [false, false, true]);
    });

    test('ligar só a consulta (Histórico de Funcionários) não concede criar nem editar, e a importação segue independente dos novos acessos', async () => {
      const u = await g.usuarioPronto(master);
      assert.equal((await ligar(master, u.id, 'historicoFuncionarios', true)).status, 200);
      assert.deepEqual(await permitidos(u), esperado('v'));
      assert.equal((await ligar(master, u.id, 'cadastrarFuncionario', true)).status, 200);
      assert.equal((await efetivas(u)).acoes.IMPORTAR_FUNCIONARIOS ?? false, false, 'cadastrar não importa');
      assert.equal(await negada(u, 'post', '/funcionarios/importacao'), true);
    });

    test('só o MASTER atribui; MASTER é fixo nos novos acessos; outra empresa não alcança o usuário; nenhuma permissão nova é criada', async () => {
      const u = await g.usuarioPronto(master);
      const adm = await g.administradorAutorizado(g.empresas.A, master);
      for (const toggle of ['cadastrarFuncionario', 'editarFuncionario']) {
        // eslint-disable-next-line no-await-in-loop
        assert.equal((await ligar(adm, u.id, toggle, true)).body.codigo, 'PERMISSOES_INDIVIDUAIS_SOMENTE_MASTER', toggle);
        // eslint-disable-next-line no-await-in-loop
        assert.equal((await ligar(await g.contaDaEmpresa(g.empresas.B), u.id, toggle, true)).status, 404, toggle);
        // eslint-disable-next-line no-await-in-loop
        const doMaster = await toggleDe(master, master.usuarioId, toggle);
        assert.equal(doMaster?.fixo, true, `${toggle} fixo no MASTER`);
        // eslint-disable-next-line no-await-in-loop
        assert.equal((await ligar(master, master.usuarioId, toggle, false)).body.codigo, 'USUARIO_MASTER_PERMISSOES_FIXAS', toggle);
      }
      assert.equal(await ligadoEm(u.id, 'cadastrarFuncionario'), false, 'nada foi concedido pelas tentativas negadas');
      const novas = await g.todos("SELECT codigo FROM acoes WHERE codigo ~* '(FUNCIONARIO|COLABORADOR|GHE|SITUACAO)' ORDER BY codigo");
      assert.deepEqual(novas.map((a) => a.codigo), ['IMPORTAR_FUNCIONARIOS'], 'nenhuma ação nova para GHE ou situação');
    });
  });

  describe('atribuição pelo grupo: a mesma dependência', () => {
    let n = 0;
    const novoGrupo = async () => {
      n += 1;
      return (await g.um('INSERT INTO grupos_acesso (empresa_id, nome, criado_por) VALUES ($1, $2, $3) RETURNING id', [g.empresas.A, `Grupo funcionários ${n}`, master.usuarioId])).id;
    };
    const ligarNoGrupo = (grupo, toggle, ligado) => g.request(g.app).put(`/api/grupos-acesso/${grupo}/acessos/${toggle}`).set('Cookie', g.cookie(master)).send({ ligado });

    test('ligar cadastrar/editar no grupo concede aos integrantes a operação E a leitura; desligar não derruba a leitura nem o outro acesso', async () => {
      const grupo = await novoGrupo();
      const u = await g.usuarioPronto(master, { grupoAcessoId: grupo });
      const a = await ligarNoGrupo(grupo, 'cadastrarFuncionario', true);
      assert.equal(a.status, 200, JSON.stringify(a.body));
      let p = (await efetivas(u)).recursos.employeeHistory;
      assert.deepEqual([p?.visualizar, p?.criar, p?.editar], [true, true, false]);
      const b = await ligarNoGrupo(grupo, 'editarFuncionario', true);
      assert.equal(b.status, 200, JSON.stringify(b.body));
      p = (await efetivas(u)).recursos.employeeHistory;
      assert.deepEqual([p?.visualizar, p?.criar, p?.editar], [true, true, true]);
      assert.deepEqual(await permitidos(u), esperado('vce'));
      assert.equal((await ligarNoGrupo(grupo, 'cadastrarFuncionario', false)).status, 200);
      p = (await efetivas(u)).recursos.employeeHistory;
      assert.deepEqual([p?.visualizar, p?.criar, p?.editar], [true, false, true]);
    });

    test('o grupo não concede a importação por consequência de criar/editar, e o outro grupo/empresa não recebe', async () => {
      const grupo = await novoGrupo();
      const u = await g.usuarioPronto(master, { grupoAcessoId: grupo });
      await ligarNoGrupo(grupo, 'editarFuncionario', true);
      assert.equal((await efetivas(u)).acoes.IMPORTAR_FUNCIONARIOS ?? false, false);
      const semGrupo = await g.usuarioPronto(master);
      assert.equal((await efetivas(semGrupo)).recursos.employeeHistory?.editar ?? false, false, 'quem não é do grupo não recebe');
    });
  });

  describe('MASTER e isolamento multiempresa', () => {
    test('o MASTER continua com consulta, cadastro e edição pelo provisionamento (as três juntas), e a importação como ação própria', async () => {
      // O MASTER da fixture entra por sessão global + seleção de empresa; as permissões efetivas vêm do cookie dele.
      const r = await g.request(g.app).get('/api/auth/permissoes').set('Cookie', g.cookie(master));
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const e = r.body.recursos.employeeHistory;
      assert.deepEqual([e?.visualizar, e?.criar, e?.editar], [true, true, true]);
      assert.equal(r.body.acoes.IMPORTAR_FUNCIONARIOS, true);
    });

    test('quem edita na empresa B não alcança funcionário da A: a rota responde 404 e a situação da A não muda', async () => {
      const f = await g.um(
        "INSERT INTO funcionarios (empresa_id, matricula, nome, cpf, grupo_homogeneo_id) VALUES ($1, 'RBAC-1', 'Func RBAC', $2, NULL) RETURNING id", [g.empresas.A, g.cpfFicticio(8101)],
      );
      const contaB = await g.contaDaEmpresa(g.empresas.B);
      const r = await g.request(g.app).post(`/api/funcionarios/${f.id}/situacao`).set('Cookie', g.cookie(contaB)).send({ situacao: 'AFASTADO' });
      assert.equal(r.status, 404, JSON.stringify(r.body));
      assert.equal((await g.um('SELECT situacao FROM funcionarios WHERE id = $1', [f.id])).situacao, 'ATIVO');
      const patch = await g.request(g.app).patch(`/api/funcionarios/${f.id}`).set('Cookie', g.cookie(contaB)).send({ setor: 'Invasão' });
      assert.equal(patch.status, 404);
    });
  });
});
