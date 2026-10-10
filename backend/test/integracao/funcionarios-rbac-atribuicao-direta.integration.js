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
 * RBAC da Gestão de Funcionários — complementação (RED): as APIs DIRETAS de atribuição por operação, as antigas, não os toggles:
 *   usuário: PATCH /administracao/usuarios/:id/permissoes/recursos/:recurso   { visualizar, criar, editar, excluir } (tri-state)
 *   grupo:   PATCH /grupos-acesso/:id/permissoes/recursos/:recurso            { podeVisualizar, podeCriar, podeEditar, podeExcluir }
 *
 * Contrato aprovado: conceder employeeHistory.criar ou employeeHistory.editar garante employeeHistory.visualizar NA ATRIBUIÇÃO;
 * não é exigência cumulativa no endpoint, não concede a outra operação, não revoga nada por tabela e preserva a revogação
 * independente, as camadas (perfil → grupo → exceção individual) e o MASTER fixo.
 *
 * Os testes de "garantia" mostram o que falta hoje; os de preservação mostram o que já vale. Contradições explícitas
 * (criar:true com visualizar:false no mesmo pedido, ou sobre um visualizar já negado) NÃO são testadas aqui: não há contrato aprovado.
 */
const RECURSO = 'employeeHistory';

describe('RBAC de Funcionários — atribuição direta por operação (PostgreSQL real)', () => {
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
  const efetivas = async (u) => (await g.request(g.app).get('/api/auth/permissoes').set('Cookie', await como(u))).body.recursos?.[RECURSO] ?? {};
  const trio = (e) => [e.visualizar ?? false, e.criar ?? false, e.editar ?? false];
  const direta = (c, id, flags, recurso = RECURSO) => g.request(g.app).patch(`/api/administracao/usuarios/${id}/permissoes/recursos/${recurso}`).set('Cookie', g.cookie(c)).send(flags);
  const doGrupo = (c, grupo, flags, recurso = RECURSO) => g.request(g.app).patch(`/api/grupos-acesso/${grupo}/permissoes/recursos/${recurso}`).set('Cookie', g.cookie(c)).send(flags);
  const linhaIndividual = (id, recurso = RECURSO) => g.um('SELECT pode_visualizar, pode_criar, pode_editar, pode_excluir FROM usuario_permissoes_recurso WHERE usuario_id = $1 AND recurso = $2', [id, recurso]);
  const linhaGrupo = (grupo, recurso = RECURSO) => g.um('SELECT pode_visualizar, pode_criar, pode_editar, pode_excluir FROM grupo_permissoes_recurso WHERE grupo_acesso_id = $1 AND recurso = $2', [grupo, recurso]);
  let n = 0;
  const novoGrupo = async () => {
    n += 1;
    return (await g.um('INSERT INTO grupos_acesso (empresa_id, nome, criado_por) VALUES ($1, $2, $3) RETURNING id', [g.empresas.A, `Grupo direto ${n}`, master.usuarioId])).id;
  };
  const rotaPermitida = async (u, metodo, caminho) => (await g.request(g.app)[metodo](`/api${caminho}`).set('Cookie', await como(u)).send({})).status !== 403;

  describe('usuário — APIs diretas', () => {
    test('conceder criar garante visualizar (nunca editar): efetivo [v,c,e] = [true,true,false]; cadastro e consulta passam no servidor', async () => {
      const u = await g.usuarioPronto(master);
      const r = await direta(master, u.id, { criar: true });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(trio(await efetivas(u)), [true, true, false]);
      assert.equal(await rotaPermitida(u, 'post', '/funcionarios'), true);
      assert.equal(await rotaPermitida(u, 'get', '/funcionarios'), true);
      assert.equal(await rotaPermitida(u, 'patch', '/funcionarios/999999'), false, 'criar não é editar');
    });

    test('conceder editar garante visualizar (nunca criar): efetivo [true,false,true]; edição, GHE e situação passam, o cadastro não', async () => {
      const u = await g.usuarioPronto(master);
      const r = await direta(master, u.id, { editar: true });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(trio(await efetivas(u)), [true, false, true]);
      assert.equal(await rotaPermitida(u, 'get', '/funcionarios'), true);
      assert.equal(await rotaPermitida(u, 'patch', '/funcionarios/999999'), true);
      assert.equal(await rotaPermitida(u, 'post', '/funcionarios'), false, 'editar não é criar');
    });

    test('criar e editar juntos num pedido: garante visualizar', async () => {
      const u = await g.usuarioPronto(master);
      assert.equal((await direta(master, u.id, { criar: true, editar: true })).status, 200);
      assert.deepEqual(trio(await efetivas(u)), [true, true, true]);
    });

    test('a garantia vale também pela cadeia de camadas: visualizar vindo do GRUPO basta, e nenhuma linha redundante de visualizar é gravada no usuário', async () => {
      const grupo = await novoGrupo();
      assert.equal((await doGrupo(master, grupo, { podeVisualizar: true })).status, 200);
      const u = await g.usuarioPronto(master, { grupoAcessoId: grupo });
      assert.equal((await direta(master, u.id, { criar: true })).status, 200);
      assert.deepEqual(trio(await efetivas(u)), [true, true, false]);
      const linha = await linhaIndividual(u.id);
      assert.equal(linha?.pode_visualizar ?? null, null, 'já herdado do grupo: nada a gravar');
      assert.equal(linha?.pode_criar, true);
    });

    test('revogação independente preservada: tirar criar/editar não mexe em visualizar, e tirar visualizar não mexe em criar', async () => {
      const u = await g.usuarioPronto(master);
      assert.equal((await direta(master, u.id, { visualizar: true, criar: true, editar: true })).status, 200);
      assert.equal((await direta(master, u.id, { criar: null })).status, 200);
      assert.deepEqual(trio(await efetivas(u)), [true, false, true]);
      assert.equal((await direta(master, u.id, { editar: false })).status, 200);
      assert.deepEqual(trio(await efetivas(u)), [true, false, false], 'false só nega a própria operação');
      assert.equal((await direta(master, u.id, { visualizar: null })).status, 200);
      assert.deepEqual(trio(await efetivas(u)), [false, false, false], 'tirar visualizar não revoga nada por tabela e não reconcede');
    });

    // Decisão funcional 1: uma NOVA concessão parcial de criar/editar, sem falar de visualizar, satisfaz a dependência mesmo sobre uma
    // negação anterior (a concessão posterior é uma decisão nova). Antes desta decisão o teste afirmava que a negação era preservada.
    test('visualizar negado ANTES e nova concessão parcial de criar: a leitura passa a true (nunca editar)', async () => {
      const u = await g.usuarioPronto(master);
      assert.equal((await direta(master, u.id, { visualizar: false })).status, 200);
      assert.deepEqual(trio(await efetivas(u)), [false, false, false]);
      assert.equal((await direta(master, u.id, { criar: true })).status, 200);
      assert.deepEqual(trio(await efetivas(u)), [true, true, false]);
      assert.equal((await linhaIndividual(u.id)).pode_visualizar, true);
    });

    test('visualizar negado ANTES e nova concessão parcial de editar: a leitura passa a true (nunca criar)', async () => {
      const u = await g.usuarioPronto(master);
      assert.equal((await direta(master, u.id, { visualizar: false })).status, 200);
      assert.equal((await direta(master, u.id, { editar: true })).status, 200);
      assert.deepEqual(trio(await efetivas(u)), [true, false, true]);
    });

    describe('pedido contraditório (criar/editar true + visualizar false no MESMO pedido): recusado, de forma atômica', () => {
      const contrataditorios = [{ criar: true, visualizar: false }, { editar: true, visualizar: false }, { criar: true, editar: true, visualizar: false }];
      const auditorias = async (id) => (await g.todos("SELECT id FROM logs_auditoria WHERE referencia = $1 AND acao = 'USUARIO_PERMISSAO_RECURSO_ALTERADA'", [String(id)])).length;

      test('400 VALIDACAO (VALOR_NAO_PERMITIDO em body.visualizar); a linha individual e a auditoria ficam como estavam', async () => {
        const u = await g.usuarioPronto(master);
        assert.equal((await direta(master, u.id, { editar: false })).status, 200, 'estado de partida: uma linha com uma operação');
        const antes = await linhaIndividual(u.id);
        const auditoriasAntes = await auditorias(u.id);
        for (const corpo of contrataditorios) {
          // eslint-disable-next-line no-await-in-loop
          const r = await direta(master, u.id, corpo);
          assert.deepEqual([r.status, r.body.codigo], [400, 'VALIDACAO'], JSON.stringify(corpo));
          assert.ok((r.body.detalhes ?? []).some((d) => d.campo === 'body.visualizar' && d.codigo === 'VALOR_NAO_PERMITIDO'), JSON.stringify(r.body));
          // eslint-disable-next-line no-await-in-loop
          assert.deepEqual(await linhaIndividual(u.id), antes, JSON.stringify(corpo));
        }
        assert.equal(await auditorias(u.id), auditoriasAntes, 'nenhuma auditoria de alteração bem-sucedida');
        assert.deepEqual(trio(await efetivas(u)), [false, false, false]);
      });

      test('a recusa não depende de haver linha anterior, e a regra é só de Funcionários (materials aceita o mesmo pedido, como sempre)', async () => {
        const u = await g.usuarioPronto(master);
        assert.equal((await direta(master, u.id, { criar: true, visualizar: false })).status, 400);
        assert.equal(await linhaIndividual(u.id), undefined);
        const outro = await direta(master, u.id, { criar: true, visualizar: false }, 'materials');
        assert.equal(outro.status, 200, JSON.stringify(outro.body));
      });

      // visualizar OMITIDO ≠ visualizar enviado como null: a omissão aplica a dependência; o null explícito é a instrução de limpar a opinião
      // direta e, junto com criar/editar = true, contradiz a garantia na mesma operação (como o false).
      test('criar/editar = true + visualizar = null EXPLÍCITO: 400 VALIDACAO (VALOR_NAO_PERMITIDO em body.visualizar); linha e auditoria ficam como estavam', async () => {
        const u = await g.usuarioPronto(master);
        assert.equal((await direta(master, u.id, { editar: false })).status, 200, 'estado de partida: uma linha com uma operação');
        const antes = await linhaIndividual(u.id);
        const auditoriasAntes = await auditorias(u.id);
        for (const corpo of [{ criar: true, visualizar: null }, { editar: true, visualizar: null }, { criar: true, editar: true, visualizar: null }]) {
          // eslint-disable-next-line no-await-in-loop
          const r = await direta(master, u.id, corpo);
          assert.deepEqual([r.status, r.body.codigo], [400, 'VALIDACAO'], JSON.stringify(corpo));
          assert.ok((r.body.detalhes ?? []).some((d) => d.campo === 'body.visualizar' && d.codigo === 'VALOR_NAO_PERMITIDO'), JSON.stringify(r.body));
          // eslint-disable-next-line no-await-in-loop
          assert.deepEqual(await linhaIndividual(u.id), antes, JSON.stringify(corpo));
        }
        assert.equal(await auditorias(u.id), auditoriasAntes, 'nenhuma auditoria de alteração bem-sucedida');
        assert.deepEqual(trio(await efetivas(u)), [false, false, false], 'nenhuma concessão indevida');
      });

      test('null explícito: a recusa vale com visualizar já concedido (nada muda), não vale para outro recurso, e o null isolado ou com criar false/null segue permitido', async () => {
        const u = await g.usuarioPronto(master);
        assert.equal((await direta(master, u.id, { visualizar: true })).status, 200);
        assert.equal((await direta(master, u.id, { criar: true, visualizar: null })).status, 400);
        assert.deepEqual(trio(await efetivas(u)), [true, false, false], 'a leitura anterior ficou intacta');
        assert.equal((await direta(master, u.id, { criar: true, visualizar: null }, 'materials')).status, 200, 'outro recurso: tri-state como sempre');
        assert.equal((await direta(master, u.id, { criar: false, visualizar: null })).status, 200);
        assert.equal((await direta(master, u.id, { criar: null, visualizar: null })).status, 200);
        assert.equal((await direta(master, u.id, { visualizar: null })).status, 200, 'visualizar = null isolado');
      });

      test('omitido continua garantindo; visualizar = true com criar/editar continua permitido', async () => {
        const omitido = await g.usuarioPronto(master);
        assert.equal((await direta(master, omitido.id, { editar: true })).status, 200);
        assert.deepEqual(trio(await efetivas(omitido)), [true, false, true]);
        const explicito = await g.usuarioPronto(master);
        assert.equal((await direta(master, explicito.id, { criar: true, visualizar: true })).status, 200);
        assert.deepEqual(trio(await efetivas(explicito)), [true, true, false]);
      });

      test('autoridade e isolamento antes da validação do null: sem ser MASTER 403, MASTER-alvo fixo, outra empresa 404 — nada gravado', async () => {
        const u = await g.usuarioPronto(master);
        const adm = await g.administradorAutorizado(g.empresas.A, master);
        assert.equal((await direta(adm, u.id, { criar: true, visualizar: null })).body.codigo, 'PERMISSOES_INDIVIDUAIS_SOMENTE_MASTER');
        assert.equal((await direta(master, master.usuarioId, { criar: true, visualizar: null })).body.codigo, 'USUARIO_MASTER_PERMISSOES_FIXAS');
        assert.equal((await direta(await g.contaDaEmpresa(g.empresas.B), u.id, { criar: true, visualizar: null })).status, 404);
        assert.equal(await linhaIndividual(u.id), undefined);
      });

      test('só criar/editar com true contradizem: criar:false + visualizar:false e visualizar:false sozinho continuam aceitos', async () => {
        const u = await g.usuarioPronto(master);
        assert.equal((await direta(master, u.id, { criar: false, visualizar: false })).status, 200);
        assert.equal((await direta(master, u.id, { visualizar: false })).status, 200);
      });

      test('autoridade e isolamento antes da validação: sem ser MASTER, 403; MASTER-alvo fixo; outra empresa 404 — nada gravado', async () => {
        const u = await g.usuarioPronto(master);
        const adm = await g.administradorAutorizado(g.empresas.A, master);
        assert.equal((await direta(adm, u.id, { criar: true, visualizar: false })).body.codigo, 'PERMISSOES_INDIVIDUAIS_SOMENTE_MASTER');
        assert.equal((await direta(master, master.usuarioId, { criar: true, visualizar: false })).body.codigo, 'USUARIO_MASTER_PERMISSOES_FIXAS');
        assert.equal((await direta(await g.contaDaEmpresa(g.empresas.B), u.id, { criar: true, visualizar: false })).status, 404);
        assert.equal(await linhaIndividual(u.id), undefined);
      });
    });

    test('negar ou limpar criar/editar não concede visualizar, e conceder visualizar sozinho não concede criar nem editar', async () => {
      const u = await g.usuarioPronto(master);
      assert.equal((await direta(master, u.id, { criar: false, editar: null })).status, 200);
      assert.deepEqual(trio(await efetivas(u)), [false, false, false]);
      assert.equal((await direta(master, u.id, { visualizar: true })).status, 200);
      assert.deepEqual(trio(await efetivas(u)), [true, false, false]);
    });

    test('sem escalonamento: a garantia só toca employeeHistory (nada em outros recursos, nada em excluir, nada na importação)', async () => {
      const u = await g.usuarioPronto(master);
      assert.equal((await direta(master, u.id, { criar: true })).status, 200);
      const linhas = await g.todos('SELECT recurso, pode_visualizar, pode_criar, pode_editar, pode_excluir FROM usuario_permissoes_recurso WHERE usuario_id = $1', [u.id]);
      assert.deepEqual(linhas.map((l) => l.recurso), [RECURSO]);
      assert.equal(linhas[0].pode_excluir, null);
      assert.equal((await g.request(g.app).get('/api/auth/permissoes').set('Cookie', await como(u))).body.acoes.IMPORTAR_FUNCIONARIOS ?? false, false);
      assert.equal(await rotaPermitida(u, 'post', '/funcionarios/importacao'), false);
    });

    test('outros recursos continuam como estavam: criar em materials NÃO inventa visualizar (a regra é de Funcionários)', async () => {
      const u = await g.usuarioPronto(master);
      assert.equal((await direta(master, u.id, { criar: true }, 'materials')).status, 200);
      const linha = await linhaIndividual(u.id, 'materials');
      assert.deepEqual([linha?.pode_visualizar ?? null, linha?.pode_criar], [null, true]);
    });

    test('autoridade e MASTER preservados: só o MASTER grava, MASTER é fixo, outra empresa não alcança, a garantia não vaza para outro usuário', async () => {
      const u = await g.usuarioPronto(master);
      const adm = await g.administradorAutorizado(g.empresas.A, master);
      assert.equal((await direta(adm, u.id, { criar: true })).body.codigo, 'PERMISSOES_INDIVIDUAIS_SOMENTE_MASTER');
      assert.equal((await direta(master, master.usuarioId, { criar: true })).body.codigo, 'USUARIO_MASTER_PERMISSOES_FIXAS');
      assert.equal((await direta(await g.contaDaEmpresa(g.empresas.B), u.id, { criar: true })).status, 404);
      assert.deepEqual(trio(await efetivas(u)), [false, false, false], 'as tentativas negadas não concederam nada');
      const outro = await g.usuarioPronto(master);
      assert.equal((await direta(master, u.id, { editar: true })).status, 200);
      assert.deepEqual(trio(await efetivas(outro)), [false, false, false]);
    });

    test('auditoria da atribuição continua e não leva dado sensível', async () => {
      const u = await g.usuarioPronto(master);
      assert.equal((await direta(master, u.id, { criar: true })).status, 200);
      const aud = await g.todos("SELECT acao, dados_novos FROM logs_auditoria WHERE referencia = $1 AND acao LIKE 'USUARIO_PERMISSAO%'", [String(u.id)]);
      assert.ok(aud.length >= 1, 'sem auditoria da atribuição');
      assert.equal(/senha|token|hash/i.test(JSON.stringify(aud)), false);
    });
  });

  describe('grupo — APIs diretas', () => {
    test('conceder podeCriar garante podeVisualizar no grupo (nunca podeEditar): os integrantes recebem [true,true,false]', async () => {
      const grupo = await novoGrupo();
      const u = await g.usuarioPronto(master, { grupoAcessoId: grupo });
      const r = await doGrupo(master, grupo, { podeCriar: true });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(trio(await efetivas(u)), [true, true, false]);
      const linha = await linhaGrupo(grupo);
      assert.deepEqual([linha?.pode_visualizar, linha?.pode_criar, linha?.pode_editar ?? null], [true, true, null]);
    });

    test('conceder podeEditar garante podeVisualizar no grupo (nunca podeCriar)', async () => {
      const grupo = await novoGrupo();
      const u = await g.usuarioPronto(master, { grupoAcessoId: grupo });
      const r = await doGrupo(master, grupo, { podeEditar: true });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(trio(await efetivas(u)), [true, false, true]);
    });

    test('revogação independente no grupo: limpar podeCriar não mexe em podeVisualizar; NULL limpa, FALSE nega só a própria operação', async () => {
      const grupo = await novoGrupo();
      const u = await g.usuarioPronto(master, { grupoAcessoId: grupo });
      assert.equal((await doGrupo(master, grupo, { podeVisualizar: true, podeCriar: true, podeEditar: true })).status, 200);
      assert.equal((await doGrupo(master, grupo, { podeCriar: null })).status, 200);
      assert.deepEqual(trio(await efetivas(u)), [true, false, true]);
      assert.equal((await doGrupo(master, grupo, { podeEditar: false })).status, 200);
      assert.deepEqual(trio(await efetivas(u)), [true, false, false]);
      assert.equal((await linhaGrupo(grupo)).pode_editar, false, 'FALSE nunca vira NULL');
    });

    test('a exceção individual continua prevalecendo sobre o grupo: o grupo concede criar+visualizar e o usuário tem criar negado', async () => {
      const grupo = await novoGrupo();
      const u = await g.usuarioPronto(master, { grupoAcessoId: grupo });
      assert.equal((await direta(master, u.id, { criar: false })).status, 200);
      assert.equal((await doGrupo(master, grupo, { podeCriar: true })).status, 200);
      assert.deepEqual(trio(await efetivas(u)), [true, false, false], 'grupo garante a leitura; a negação individual de criar vence');
    });

    test('sem escalonamento e sem vazamento: outro grupo, outra empresa e quem não é do grupo nada recebem; importação independente', async () => {
      const grupo = await novoGrupo();
      const outroGrupo = await novoGrupo();
      const doOutro = await g.usuarioPronto(master, { grupoAcessoId: outroGrupo });
      const semGrupo = await g.usuarioPronto(master);
      const integrante = await g.usuarioPronto(master, { grupoAcessoId: grupo });
      assert.equal((await doGrupo(master, grupo, { podeEditar: true })).status, 200);
      assert.deepEqual(trio(await efetivas(doOutro)), [false, false, false]);
      assert.deepEqual(trio(await efetivas(semGrupo)), [false, false, false]);
      assert.equal(await rotaPermitida(integrante, 'post', '/funcionarios/importacao'), false);
      assert.equal((await doGrupo(await g.contaDaEmpresa(g.empresas.B), grupo, { podeCriar: true })).status, 404);
      assert.equal((await linhaGrupo(grupo)).pode_criar ?? null, null);
    });

    // Decisão funcional 1, no grupo: a NOVA concessão satisfaz a dependência mesmo sobre uma negação anterior do grupo.
    test('podeVisualizar negado ANTES e nova concessão parcial de podeCriar / podeEditar: a leitura do grupo passa a true (sem conceder a outra)', async () => {
      const comCriar = await novoGrupo();
      const usuarioCriar = await g.usuarioPronto(master, { grupoAcessoId: comCriar });
      assert.equal((await doGrupo(master, comCriar, { podeVisualizar: false })).status, 200);
      assert.equal((await doGrupo(master, comCriar, { podeCriar: true })).status, 200);
      assert.equal((await linhaGrupo(comCriar)).pode_visualizar, true);
      assert.deepEqual(trio(await efetivas(usuarioCriar)), [true, true, false]);

      const comEditar = await novoGrupo();
      const usuarioEditar = await g.usuarioPronto(master, { grupoAcessoId: comEditar });
      assert.equal((await doGrupo(master, comEditar, { podeVisualizar: false })).status, 200);
      assert.equal((await doGrupo(master, comEditar, { podeEditar: true })).status, 200);
      assert.deepEqual(trio(await efetivas(usuarioEditar)), [true, false, true]);
    });

    describe('pedido contraditório no grupo (podeCriar/podeEditar true + podeVisualizar false): recusado, de forma atômica', () => {
      const auditorias = async (grupo) => (await g.todos("SELECT id FROM logs_auditoria WHERE referencia = $1 AND acao = 'GRUPO_PERMISSAO_RECURSO_CONFIGURADA'", [String(grupo)])).length;

      test('400 VALIDACAO (VALOR_NAO_PERMITIDO em body.podeVisualizar); a linha do grupo e a auditoria ficam como estavam', async () => {
        const grupo = await novoGrupo();
        const u = await g.usuarioPronto(master, { grupoAcessoId: grupo });
        assert.equal((await doGrupo(master, grupo, { podeExcluir: false })).status, 200, 'estado de partida');
        const antes = await linhaGrupo(grupo);
        const auditoriasAntes = await auditorias(grupo);
        for (const corpo of [{ podeCriar: true, podeVisualizar: false }, { podeEditar: true, podeVisualizar: false }, { podeCriar: true, podeEditar: true, podeVisualizar: false }]) {
          // eslint-disable-next-line no-await-in-loop
          const r = await doGrupo(master, grupo, corpo);
          assert.deepEqual([r.status, r.body.codigo], [400, 'VALIDACAO'], JSON.stringify(corpo));
          assert.ok((r.body.detalhes ?? []).some((d) => d.campo === 'body.podeVisualizar' && d.codigo === 'VALOR_NAO_PERMITIDO'), JSON.stringify(r.body));
          // eslint-disable-next-line no-await-in-loop
          assert.deepEqual(await linhaGrupo(grupo), antes, JSON.stringify(corpo));
        }
        assert.equal(await auditorias(grupo), auditoriasAntes);
        assert.deepEqual(trio(await efetivas(u)), [false, false, false]);
      });

      test('podeCriar/podeEditar = true + podeVisualizar = null EXPLÍCITO: 400 VALIDACAO (VALOR_NAO_PERMITIDO em body.podeVisualizar); linha e auditoria ficam como estavam', async () => {
        const grupo = await novoGrupo();
        const u = await g.usuarioPronto(master, { grupoAcessoId: grupo });
        assert.equal((await doGrupo(master, grupo, { podeExcluir: false })).status, 200, 'estado de partida');
        const antes = await linhaGrupo(grupo);
        const auditoriasAntes = await auditorias(grupo);
        for (const corpo of [{ podeCriar: true, podeVisualizar: null }, { podeEditar: true, podeVisualizar: null }, { podeCriar: true, podeEditar: true, podeVisualizar: null }]) {
          // eslint-disable-next-line no-await-in-loop
          const r = await doGrupo(master, grupo, corpo);
          assert.deepEqual([r.status, r.body.codigo], [400, 'VALIDACAO'], JSON.stringify(corpo));
          assert.ok((r.body.detalhes ?? []).some((d) => d.campo === 'body.podeVisualizar' && d.codigo === 'VALOR_NAO_PERMITIDO'), JSON.stringify(r.body));
          // eslint-disable-next-line no-await-in-loop
          assert.deepEqual(await linhaGrupo(grupo), antes, JSON.stringify(corpo));
        }
        assert.equal(await auditorias(grupo), auditoriasAntes);
        assert.deepEqual(trio(await efetivas(u)), [false, false, false]);
      });

      test('null explícito no grupo: não vale para outro recurso; o null isolado e com podeCriar false/null seguem permitidos; omitido e true continuam como aprovados', async () => {
        const grupo = await novoGrupo();
        assert.equal((await doGrupo(master, grupo, { podeCriar: true, podeVisualizar: null }, 'materials')).status, 200);
        assert.equal((await doGrupo(master, grupo, { podeCriar: false, podeVisualizar: null })).status, 200);
        assert.equal((await doGrupo(master, grupo, { podeVisualizar: null })).status, 200, 'podeVisualizar = null isolado');
        const omitido = await novoGrupo();
        assert.equal((await doGrupo(master, omitido, { podeEditar: true })).status, 200);
        assert.equal((await linhaGrupo(omitido)).pode_visualizar, true);
        const explicito = await novoGrupo();
        assert.equal((await doGrupo(master, explicito, { podeCriar: true, podeVisualizar: true })).status, 200);
        assert.equal((await linhaGrupo(explicito)).pode_visualizar, true);
      });

      test('autoridade e isolamento antes da validação do null: quem não administra grupos 403; outra empresa 404 — nada gravado', async () => {
        const grupo = await novoGrupo();
        const semAutoridade = await g.usuarioPronto(master);
        const r = await g.request(g.app).patch(`/api/grupos-acesso/${grupo}/permissoes/recursos/${RECURSO}`).set('Cookie', await como(semAutoridade)).send({ podeCriar: true, podeVisualizar: null });
        assert.equal(r.status, 403);
        assert.equal((await doGrupo(await g.contaDaEmpresa(g.empresas.B), grupo, { podeEditar: true, podeVisualizar: null })).status, 404);
        assert.equal(await linhaGrupo(grupo), undefined);
      });

      test('a regra é só de Funcionários, e podeCriar:false + podeVisualizar:false continua aceito', async () => {
        const grupo = await novoGrupo();
        assert.equal((await doGrupo(master, grupo, { podeCriar: true, podeVisualizar: false }, 'materials')).status, 200);
        assert.equal((await doGrupo(master, grupo, { podeCriar: false, podeVisualizar: false })).status, 200);
      });

      test('autoridade e isolamento antes da validação: quem não administra grupos, 403; outra empresa, 404 — nada gravado', async () => {
        const grupo = await novoGrupo();
        const semAutoridade = await g.usuarioPronto(master);
        const r = await g.request(g.app).patch(`/api/grupos-acesso/${grupo}/permissoes/recursos/${RECURSO}`).set('Cookie', await como(semAutoridade)).send({ podeCriar: true, podeVisualizar: false });
        assert.equal(r.status, 403);
        assert.equal((await doGrupo(await g.contaDaEmpresa(g.empresas.B), grupo, { podeCriar: true, podeVisualizar: false })).status, 404);
        assert.equal(await linhaGrupo(grupo), undefined);
      });
    });

    test('outros recursos continuam como estavam no grupo: podeCriar em materials NÃO inventa podeVisualizar', async () => {
      const grupo = await novoGrupo();
      assert.equal((await doGrupo(master, grupo, { podeCriar: true }, 'materials')).status, 200);
      const linha = await linhaGrupo(grupo, 'materials');
      assert.deepEqual([linha?.pode_visualizar ?? null, linha?.pode_criar], [null, true]);
    });

    test('quem não administra permissões de grupo é recusado (403) e nada é gravado', async () => {
      const grupo = await novoGrupo();
      const semAutoridade = await g.usuarioPronto(master);
      const r = await g.request(g.app).patch(`/api/grupos-acesso/${grupo}/permissoes/recursos/${RECURSO}`).set('Cookie', await como(semAutoridade)).send({ podeCriar: true });
      assert.equal(r.status, 403);
      assert.equal(await linhaGrupo(grupo), undefined);
    });
  });
});
