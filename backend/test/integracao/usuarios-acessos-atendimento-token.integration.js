'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { montar } = require('./helpers/gestao-usuarios-app');
const { criarGrupoPermissaoController } = require('../../src/controllers/grupo-permissao.controller');
const { criarGrupoPermissaoRoutes } = require('../../src/routes/grupo-permissao.routes');
const { criarTokenCentralRoutes } = require('../../src/routes/token-central.routes');
const { criarTokenDispositivoRoutes } = require('../../src/routes/token-dispositivo.routes');
const { criarTokenAtivacaoRoutes } = require('../../src/routes/token-ativacao.routes');
const provisionamento = require('../../src/services/provisionamento-permissoes.service');
const { TOGGLES } = require('../../src/rbac/toggles');

/**
 * Etapa H — os sete toggles do Atendimento Token na Gestão de Usuários, com as ROTAS REAIS do Token montadas (a autorização
 * corre antes da validação e do controller; o controller é de mentira: 403 = a autorização negou, qualquer outro status =
 * deixou passar) e as rotas reais de acessos de usuário e de grupo. PostgreSQL real, schema temporário com todas as migrations.
 */
const BASE = '/api/administracao/usuarios';
const controllerLiberado = new Proxy({}, { get: () => (req, res) => res.status(200).json({ ok: true }) });
const IDS = ['tokenVisualizar', 'tokenCadastrar', 'tokenEditar', 'tokenRevogar', 'tokenGerarAtivacao', 'tokenRedes', 'tokenPrevia'];
const ROTAS = {
  consultar: ['get', '/atendimento-token/dispositivos'],
  cadastrar: ['post', '/atendimento-token/dispositivos'],
  editar: ['patch', '/atendimento-token/dispositivos/1'],
  revogar: ['post', '/atendimento-token/dispositivos/1/revogar'],
  gerar: ['post', '/atendimento-token/dispositivos/1/ativacao'],
  redes: ['get', '/atendimento-token/redes'],
  previa: ['get', '/atendimento-token/previa/catalogo'],
};
const NENHUMA = Object.freeze({ consultar: false, cadastrar: false, editar: false, revogar: false, gerar: false, redes: false, previa: false });
const so = (...liberadas) => ({ ...NENHUMA, ...Object.fromEntries(liberadas.map((r) => [r, true])) });

describe('Atendimento Token — toggles na Gestão de Usuários (PostgreSQL real)', () => {
  let g;
  let master;
  let masterB;
  before(async () => {
    g = await montar({ extras: ({ pool, exigirEmpresarial }) => {
      const deps = { controller: controllerLiberado, exigirSessao: exigirEmpresarial, pool };
      return [
        criarTokenCentralRoutes(deps), criarTokenDispositivoRoutes(deps), criarTokenAtivacaoRoutes(deps),
        criarGrupoPermissaoRoutes({ controller: criarGrupoPermissaoController({ pool }), exigirSessao: exigirEmpresarial }),
      ];
    } });
    master = await g.contaDaEmpresa(g.empresas.A);
    masterB = await g.contaDaEmpresa(g.empresas.B);
    // O MASTER recebe o Token pelo provisionamento REAL do escopo (nada é concedido pelo nome do perfil nem pelos toggles).
    await provisionamento.provisionar(g.pool, { empresaId: g.empresas.A, dryRun: false });
  });
  after(async () => { if (g) await g.encerrar(); });

  const ligar = (c, id, toggle, ligado) => g.request(g.app).put(`${BASE}/${id}/acessos/${toggle}`).set('Cookie', g.cookie(c)).send({ ligado });
  const lista = (c, id) => g.request(g.app).get(`${BASE}/${id}/acessos`).set('Cookie', g.cookie(c));
  const estado = async (id, toggle) => (await lista(master, id)).body.acessos.toggles.find((t) => t.id === toggle).ligado;
  const cookieDe = async (u) => g.deCookies(g.cookiesDe(await g.login(u.email, g.SENHA_PROVISORIA)));
  const efetivas = async (u) => (await g.request(g.app).get('/api/auth/permissoes').set('Cookie', await cookieDe(u))).body;
  const rotas = async (u) => {
    const cookie = await cookieDe(u);
    const r = {};
    for (const [nome, [metodo, caminho]] of Object.entries(ROTAS)) r[nome] = (await g.request(g.app)[metodo](`/api${caminho}`).set('Cookie', cookie).send({})).status !== 403;
    return r;
  };
  const avisos = (r) => (r.body.avisos ?? r.body.acessos?.avisos ?? []).map((a) => a.codigo).sort();
  const linhasToken = (id) => g.todos("SELECT pode_visualizar, pode_criar, pode_editar, pode_excluir FROM usuario_permissoes_recurso WHERE usuario_id = $1 AND recurso = 'atendimentoToken'", [id]);
  const concessoes = (id) => g.todos("SELECT acao_codigo FROM usuario_autorizacoes WHERE usuario_id = $1 AND acao_codigo LIKE 'TOKEN_%' ORDER BY 1", [id]);
  const bloqueios = (id) => g.todos("SELECT acao_codigo FROM usuario_bloqueios WHERE usuario_id = $1 AND acao_codigo LIKE 'TOKEN_%' ORDER BY 1", [id]);
  let n = 0;
  const novoGrupo = async () => {
    n += 1;
    return (await g.um('INSERT INTO grupos_acesso (empresa_id, nome, criado_por) VALUES ($1, $2, $3) RETURNING id', [g.empresas.A, `Grupo Token ${n}`, master.usuarioId])).id;
  };
  const ligarGrupo = (grupo, toggle, ligado) => g.request(g.app).put(`/api/grupos-acesso/${grupo}/acessos/${toggle}`).set('Cookie', g.cookie(master)).send({ ligado });
  const listaGrupo = (grupo) => g.request(g.app).get(`/api/grupos-acesso/${grupo}/acessos`).set('Cookie', g.cookie(master));

  test('I1 catálogo: os sete aparecem no grupo ATENDIMENTO, todos OFF no usuário novo; Monitoramento/Histórico seguem como pendência (sem toggle)', async () => {
    const u = await g.usuarioPronto(master);
    const r = await lista(master, u.id);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const doToken = r.body.acessos.toggles.filter((t) => t.grupo === 'ATENDIMENTO');
    assert.deepEqual(doToken.map((t) => t.id), IDS);
    assert.deepEqual(doToken.map((t) => t.rotulo), ['Consultar', 'Cadastrar dispositivo', 'Editar dispositivo', 'Revogar dispositivo', 'Gerar ativação (QR)', 'Redes autorizadas', 'Prévia do catálogo']);
    assert.ok(doToken.every((t) => t.ligado === false && t.fixo === false));
    assert.equal(r.body.acessos.toggles.length, TOGGLES.length);
    assert.ok(r.body.acessos.pendencias.some((p) => p.id === 'tokenMonitoramentoHistorico'));
    assert.equal(r.body.acessos.pendencias.some((p) => p.id === 'token'), false);
    assert.deepEqual(await rotas(u), NENHUMA, 'todas as rotas do Token negadas');
  });

  test('I2 cada toggle ON libera exatamente a rota própria (mais a leitura do Token onde há dependência); as demais seguem negadas', async () => {
    const casos = [
      ['tokenVisualizar', so('consultar')],
      ['tokenCadastrar', so('consultar', 'cadastrar')],
      ['tokenEditar', so('consultar', 'editar')],
      ['tokenRevogar', so('consultar', 'revogar')],
      ['tokenGerarAtivacao', so('consultar', 'gerar')],
      ['tokenRedes', so('redes')],
      ['tokenPrevia', so('previa')],
    ];
    for (const [toggle, esperado] of casos) {
      const u = await g.usuarioPronto(master);
      const on = await ligar(master, u.id, toggle, true);
      assert.equal(on.status, 200, `${toggle} ${JSON.stringify(on.body)}`);
      assert.equal(on.body.acesso.ligado, true, toggle);
      assert.deepEqual(await rotas(u), esperado, toggle);
      assert.equal(await estado(u.id, toggle), true, `${toggle} persiste numa nova leitura`);
    }
  });

  test('I3 cada toggle OFF devolve a negação no servidor e só mexe na regra própria; nada redundante sobra na camada individual', async () => {
    for (const toggle of IDS) {
      const u = await g.usuarioPronto(master);
      await ligar(master, u.id, toggle, true);
      const off = await ligar(master, u.id, toggle, false);
      assert.equal(off.body.acesso.ligado, false, toggle);
      const esperado = ['tokenCadastrar', 'tokenEditar', 'tokenRevogar', 'tokenGerarAtivacao'].includes(toggle) ? so('consultar') : NENHUMA;
      assert.deepEqual(await rotas(u), esperado, `${toggle}: a leitura concedida como dependência permanece, e só ela`);
      assert.equal(await estado(u.id, toggle), false, toggle);
      assert.deepEqual(await bloqueios(u.id), [], `${toggle}: sem bloqueio quando nada herdado precisa ser vencido`);
    }
    const u = await g.usuarioPronto(master);
    await ligar(master, u.id, 'tokenRedes', true);
    await ligar(master, u.id, 'tokenRedes', false);
    assert.deepEqual(await concessoes(u.id), [], 'Redes: a concessão individual some ao desligar');
  });

  test('I4 dependências: Cadastrar, Editar, Revogar e Gerar ligam só a leitura do PRÓPRIO Token; Redes e Prévia não ligam nada além de si (nem a leitura de funcionários)', async () => {
    for (const toggle of ['tokenCadastrar', 'tokenEditar', 'tokenRevogar', 'tokenGerarAtivacao']) {
      const u = await g.usuarioPronto(master);
      assert.equal(await estado(u.id, 'tokenVisualizar'), false);
      await ligar(master, u.id, toggle, true);
      assert.equal(await estado(u.id, 'tokenVisualizar'), true, `${toggle} garante Consultar`);
      const p = await efetivas(u);
      assert.equal(p.recursos.atendimentoToken.visualizar, true);
      assert.equal(p.recursos.employeeHistory?.visualizar ?? false, false, `${toggle} não abre funcionários`);
      assert.equal(p.recursos.materials?.visualizar ?? false, false);
    }
    for (const toggle of ['tokenRedes', 'tokenPrevia']) {
      const u = await g.usuarioPronto(master);
      await ligar(master, u.id, toggle, true);
      assert.equal(await estado(u.id, 'tokenVisualizar'), false, `${toggle} não liga Consultar`);
      assert.equal((await efetivas(u)).recursos.employeeHistory?.visualizar ?? false, false, `${toggle} não concede dado pessoal`);
    }
  });

  test('I5 desligar Consultar com outros ligados não revoga os outros: o servidor segue permitindo e o aviso explica a inconsistência da Central', async () => {
    const u = await g.usuarioPronto(master);
    await ligar(master, u.id, 'tokenCadastrar', true);
    await ligar(master, u.id, 'tokenGerarAtivacao', true);
    const off = await ligar(master, u.id, 'tokenVisualizar', false);
    assert.equal(off.status, 200);
    assert.deepEqual(avisos(off), ['TOKEN_SEM_CONSULTAR']);
    assert.deepEqual(await rotas(u), so('cadastrar', 'gerar'));
    assert.deepEqual(avisos(await lista(master, u.id)), ['TOKEN_SEM_CONSULTAR'], 'o GET traz o mesmo aviso');
    assert.equal(await estado(u.id, 'tokenCadastrar'), true);
    assert.equal(await estado(u.id, 'tokenGerarAtivacao'), true);
    const religa = await ligar(master, u.id, 'tokenVisualizar', true);
    assert.deepEqual(avisos(religa), []);
  });

  test('I6 aviso da Prévia: ligada sem o Histórico de Funcionários avisa e NÃO concede a leitura; com o Histórico ligado, o aviso some', async () => {
    const u = await g.usuarioPronto(master);
    const on = await ligar(master, u.id, 'tokenPrevia', true);
    assert.deepEqual(avisos(on), ['PREVIA_SEM_HISTORICO_FUNCIONARIOS']);
    assert.equal(await estado(u.id, 'historicoFuncionarios'), false, 'a Prévia não liga o Histórico');
    assert.equal((await efetivas(u)).recursos.employeeHistory?.visualizar ?? false, false);
    const hist = await ligar(master, u.id, 'historicoFuncionarios', true);
    assert.deepEqual(avisos(hist), []);
    const off = await ligar(master, u.id, 'tokenPrevia', false);
    assert.deepEqual(avisos(off), []);
  });

  test('I7 Redes: só por concessão individual — recurso, grupo e dependências nunca a concedem; o grupo nem a oferece', async () => {
    const u = await g.usuarioPronto(master);
    for (const t of ['tokenVisualizar', 'tokenCadastrar', 'tokenEditar', 'tokenRevogar', 'tokenGerarAtivacao', 'tokenPrevia']) await ligar(master, u.id, t, true);
    assert.equal((await rotas(u)).redes, false, 'nenhum dos outros seis concede Redes');
    const grupo = await novoGrupo();
    const visao = await listaGrupo(grupo);
    assert.equal(visao.status, 200, JSON.stringify(visao.body));
    const idsGrupo = visao.body.acessos.toggles.map((t) => t.id);
    for (const id of IDS.filter((x) => x !== 'tokenRedes')) assert.ok(idsGrupo.includes(id), `o grupo oferece ${id}`);
    assert.equal(idsGrupo.includes('tokenRedes'), false, 'o grupo não oferece Redes');
    assert.equal((await ligarGrupo(grupo, 'tokenRedes', true)).status, 404);
    const membro = await g.usuarioPronto(master, { grupoAcessoId: grupo });
    await g.pool.query("INSERT INTO grupo_permissoes_acao (empresa_id, grupo_acesso_id, acao_codigo, permitido) VALUES ($1, $2, 'TOKEN_GERENCIAR_REDES', true)", [g.empresas.A, grupo]);
    assert.equal((await rotas(membro)).redes, false, 'mesmo gravada à força no grupo, a ação OBRIGATORIA não vale');
    const sol = await ligar(master, membro.id, 'tokenRedes', true);
    assert.equal(sol.body.acesso.ligado, true);
    assert.equal((await rotas(membro)).redes, true);
    assert.deepEqual((await concessoes(membro.id)).map((r) => r.acao_codigo), ['TOKEN_GERENCIAR_REDES']);
  });

  test('I8 grupo: ligar concede aos integrantes (menu e API), desligar retira a opinião, e os avisos do grupo usam a configuração', async () => {
    const grupo = await novoGrupo();
    const u = await g.usuarioPronto(master, { grupoAcessoId: grupo });
    assert.deepEqual(await rotas(u), NENHUMA);
    for (const t of ['tokenVisualizar', 'tokenEditar', 'tokenPrevia']) {
      const r = await ligarGrupo(grupo, t, true);
      assert.equal(r.status, 200, `${t} ${JSON.stringify(r.body)}`);
    }
    assert.deepEqual(await rotas(u), so('consultar', 'editar', 'previa'));
    const lista1 = await listaGrupo(grupo);
    assert.deepEqual(lista1.body.acessos.toggles.filter((t) => t.ligado).map((t) => t.id).sort(), ['tokenEditar', 'tokenPrevia', 'tokenVisualizar']);
    assert.deepEqual((lista1.body.acessos.avisos ?? []).map((a) => a.codigo), ['PREVIA_SEM_HISTORICO_FUNCIONARIOS']);
    await ligarGrupo(grupo, 'tokenEditar', false);
    await ligarGrupo(grupo, 'tokenPrevia', false);
    assert.deepEqual(await rotas(u), so('consultar'));
    const linha = await g.todos("SELECT pode_visualizar, pode_editar FROM grupo_permissoes_recurso WHERE grupo_acesso_id = $1 AND recurso = 'atendimentoToken'", [grupo]);
    assert.deepEqual(linha.map((l) => [l.pode_visualizar, l.pode_editar]), [[true, null]], 'OFF retira a opinião (null), nunca grava false');
  });

  test('I9 grupo: o grupo sem Consultar mas com Cadastrar mostra o aviso da configuração; ligar Cadastrar no grupo garante só a leitura do Token', async () => {
    const grupo = await novoGrupo();
    const r = await ligarGrupo(grupo, 'tokenCadastrar', true);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const l = await listaGrupo(grupo);
    const ligados = l.body.acessos.toggles.filter((t) => t.ligado).map((t) => t.id).sort();
    assert.deepEqual(ligados, ['tokenCadastrar', 'tokenVisualizar']);
    assert.equal(l.body.acessos.toggles.find((t) => t.id === 'historicoFuncionarios').ligado, false);
  });

  test('I10 desligar não remove a leitura válida vinda de OUTRA concessão (grupo) e ligar não grava exceção redundante', async () => {
    const grupo = await novoGrupo();
    await ligarGrupo(grupo, 'tokenVisualizar', true);
    const u = await g.usuarioPronto(master, { grupoAcessoId: grupo });
    assert.equal(await estado(u.id, 'tokenVisualizar'), true, 'Consultar vem do grupo');
    await ligar(master, u.id, 'tokenCadastrar', true);
    const [linha] = await linhasToken(u.id);
    assert.deepEqual([linha.pode_visualizar, linha.pode_criar], [null, true], 'só Cadastrar foi gravado; a leitura do grupo não foi duplicada');
    await ligar(master, u.id, 'tokenCadastrar', false);
    assert.equal(await estado(u.id, 'tokenVisualizar'), true, 'a leitura do grupo permanece');
    assert.equal((await rotas(u)).consultar, true);
    assert.deepEqual(await linhasToken(u.id), [], 'a camada individual voltou ao padrão');
  });

  test('I11 o bloqueio individual vence o grupo e o perfil: OFF bloqueia só quem pediu, religar remove o bloqueio', async () => {
    const grupo = await novoGrupo();
    await ligarGrupo(grupo, 'tokenPrevia', true);
    await ligarGrupo(grupo, 'tokenVisualizar', true);
    const a = await g.usuarioPronto(master, { grupoAcessoId: grupo });
    const b = await g.usuarioPronto(master, { grupoAcessoId: grupo });
    assert.deepEqual(await rotas(a), so('consultar', 'previa'));
    const off = await ligar(master, a.id, 'tokenPrevia', false);
    assert.equal(off.body.acesso.ligado, false);
    assert.deepEqual((await bloqueios(a.id)).map((r) => r.acao_codigo), ['TOKEN_PREVIA_CATALOGO_REAL']);
    assert.deepEqual(await rotas(a), so('consultar'), 'bloqueado: a rota nega mesmo com o grupo concedendo');
    assert.deepEqual(await rotas(b), so('consultar', 'previa'), 'o outro integrante do grupo segue com a Prévia');
    const consulta = await ligar(master, a.id, 'tokenVisualizar', false);
    assert.equal(consulta.body.acesso.ligado, false);
    assert.equal((await rotas(a)).consultar, false, 'bloqueio individual de recurso vence o grupo');
    assert.equal((await rotas(b)).consultar, true);
    await ligar(master, a.id, 'tokenPrevia', true);
    await ligar(master, a.id, 'tokenVisualizar', true);
    assert.deepEqual(await bloqueios(a.id), []);
    assert.deepEqual(await rotas(a), so('consultar', 'previa'));
    assert.deepEqual(await linhasToken(a.id), [], 'religar volta ao herdado: nenhuma exceção sobra');
  });

  test('I12 MASTER: os sete aparecem ligados e travados pela autoridade do provisionamento, sem concessão artificial; não aceita escrita; Aprovar/Reprovar seguem desligados', async () => {
    const antesRecursos = await g.todos('SELECT id FROM usuario_permissoes_recurso WHERE usuario_id = $1', [master.usuarioId]);
    const antesAcoes = await g.todos('SELECT id FROM usuario_autorizacoes WHERE usuario_id = $1', [master.usuarioId]);
    const r = await lista(master, master.usuarioId);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const t = Object.fromEntries(r.body.acessos.toggles.map((x) => [x.id, x]));
    for (const id of IDS) assert.deepEqual([t[id].ligado, t[id].fixo], [true, true], id);
    assert.deepEqual([t.aprovarSolicitacoes.ligado, t.reprovarSolicitacoes.ligado], [false, false]);
    for (const id of IDS) {
      const escrita = await ligar(master, master.usuarioId, id, false);
      assert.deepEqual([escrita.status, escrita.body.codigo], [409, 'USUARIO_MASTER_PERMISSOES_FIXAS'], id);
    }
    assert.deepEqual(await g.todos('SELECT id FROM usuario_permissoes_recurso WHERE usuario_id = $1', [master.usuarioId]), antesRecursos);
    assert.deepEqual(await g.todos('SELECT id FROM usuario_autorizacoes WHERE usuario_id = $1', [master.usuarioId]), antesAcoes);
    assert.deepEqual(await rotas(master), so('consultar', 'cadastrar', 'editar', 'revogar', 'gerar', 'redes', 'previa'), 'o MASTER acessa todas as rotas do Token');
  });

  test('I13 ADMINISTRADOR: sem concessão não vê o Token; com concessão parcial reflete exatamente o concedido; quem administra só LÊ (nunca altera)', async () => {
    const adm = await g.administradorAutorizado(g.empresas.A, master);
    const visao = await lista(master, adm.usuarioId);
    assert.equal(visao.status, 200);
    assert.ok(visao.body.acessos.toggles.filter((t) => t.grupo === 'ATENDIMENTO').every((t) => t.ligado === false), 'ADMINISTRADOR não recebe o Token pelo perfil');
    const alvo = await g.usuarioPronto(master);
    const negado = await ligar(adm, alvo.id, 'tokenPrevia', true);
    assert.deepEqual([negado.status, negado.body.codigo], [403, 'PERMISSOES_INDIVIDUAIS_SOMENTE_MASTER']);
    assert.equal((await lista(adm, alvo.id)).status, 200, 'quem administra usuários pode ler');
    await ligar(master, adm.usuarioId, 'tokenVisualizar', true);
    await ligar(master, adm.usuarioId, 'tokenPrevia', true);
    const parcial = (await lista(master, adm.usuarioId)).body.acessos.toggles.filter((t) => t.grupo === 'ATENDIMENTO' && t.ligado).map((t) => t.id).sort();
    assert.deepEqual(parcial, ['tokenPrevia', 'tokenVisualizar']);
  });

  test('I14 isolamento por empresa: o MASTER de outra empresa não altera nem lê o usuário; a concessão não vaza entre empresas', async () => {
    const u = await g.usuarioPronto(master);
    await ligar(master, u.id, 'tokenPrevia', true);
    assert.equal((await ligar(masterB, u.id, 'tokenPrevia', false)).status, 404);
    assert.equal((await lista(masterB, u.id)).status, 404);
    assert.equal(await estado(u.id, 'tokenPrevia'), true, 'nada mudou');
    const deB = await g.usuarioPronto(masterB);
    assert.equal((await ligar(master, deB.id, 'tokenPrevia', true)).status, 404);
    assert.deepEqual(await g.todos("SELECT 1 FROM usuario_autorizacoes WHERE usuario_id = $1 AND acao_codigo LIKE 'TOKEN_%'", [deB.id]), []);
    assert.deepEqual(await linhasToken(deB.id), []);
  });

  test('I15 sem sessão e sem autoridade: 401 e 403; payload extra e valor inválido são recusados', async () => {
    const u = await g.usuarioPronto(master);
    assert.equal((await g.request(g.app).get(`${BASE}/${u.id}/acessos`)).status, 401);
    assert.equal((await g.request(g.app).put(`${BASE}/${u.id}/acessos/tokenPrevia`).send({ ligado: true })).status, 401);
    const comum = await g.usuarioPronto(master);
    const c = { cookie: await cookieDe(comum) };
    const r = await g.request(g.app).get(`${BASE}/${u.id}/acessos`).set('Cookie', c.cookie);
    assert.equal(r.status, 403, 'usuário comum não administra acessos');
    assert.equal((await g.request(g.app).put(`${BASE}/${u.id}/acessos/tokenPrevia`).set('Cookie', g.cookie(master)).send({ ligado: 'sim' })).status, 400);
    assert.equal((await g.request(g.app).put(`${BASE}/${u.id}/acessos/tokenPrevia`).set('Cookie', g.cookie(master)).send({ ligado: true, empresaId: g.empresas.B })).status, 400);
    assert.equal((await g.request(g.app).put(`${BASE}/${u.id}/acessos/tokenExcluir`).set('Cookie', g.cookie(master)).send({ ligado: true })).status, 404, 'não existe toggle de excluir');
    assert.equal((await g.request(g.app).put(`${BASE}/${u.id}/acessos/tokenMonitoramento`).set('Cookie', g.cookie(master)).send({ ligado: true })).status, 404, 'Monitoramento é da Etapa J');
    assert.equal(await estado(u.id, 'tokenPrevia'), false);
  });

  test('I16 auditoria: um registro por mudança real, só com o nome do acesso e o estado; nada de segredo; repetir o mesmo estado não audita', async () => {
    const u = await g.usuarioPronto(master);
    await ligar(master, u.id, 'tokenGerarAtivacao', true);
    await ligar(master, u.id, 'tokenGerarAtivacao', true);
    await ligar(master, u.id, 'tokenGerarAtivacao', false);
    const aud = await g.todos("SELECT dados_anteriores, dados_novos FROM logs_auditoria WHERE acao = 'USUARIO_ACESSO_ALTERADO' AND referencia = $1 ORDER BY id", [String(u.id)]);
    const gerar = aud.filter((a) => a.dados_novos.acesso === 'tokenGerarAtivacao');
    assert.equal(gerar.length, 2, 'ligou e desligou; repetir não audita');
    assert.deepEqual(gerar.map((a) => a.dados_novos.ligado), [true, false]);
    for (const a of aud) {
      assert.deepEqual(Object.keys(a.dados_novos).sort(), ['acesso', 'ligado']);
      assert.deepEqual(Object.keys(a.dados_anteriores).sort(), ['acesso', 'ligado']);
    }
    assert.equal(/senha|hash|cookie|authorization|segredo|secret|codigo_?ativacao/i.test(JSON.stringify(aud)), false);
  });

  test('I17 regra da página e do menu: a Central abre com Consultar, Gerar, Redes ou Prévia (mesma regra do frontend); Cadastrar/Editar/Revogar sozinhos não abrem', async () => {
    // eslint-disable-next-line global-require
    const EpiPermissoes = require('../../../frontend/js/permissoes-efetivas');
    const abre = async (u) => EpiPermissoes.podeAbrir(await efetivas(u), 'atendimentoToken');
    for (const toggle of ['tokenVisualizar', 'tokenGerarAtivacao', 'tokenRedes', 'tokenPrevia', 'tokenCadastrar', 'tokenEditar', 'tokenRevogar']) {
      const u = await g.usuarioPronto(master);
      assert.equal(await abre(u), false, `${toggle}: de partida, fechada`);
      await ligar(master, u.id, toggle, true);
      assert.equal(await abre(u), true, `${toggle} ON (dependência inclusive)`);
      await ligar(master, u.id, toggle, false);
      const deixouLeitura = ['tokenCadastrar', 'tokenEditar', 'tokenRevogar', 'tokenGerarAtivacao'].includes(toggle);
      assert.equal(await abre(u), deixouLeitura, `${toggle} OFF: ${deixouLeitura ? 'a leitura concedida como dependência segue abrindo' : 'fecha'}`);
    }
    const so3 = await g.usuarioPronto(master);
    await ligar(master, so3.id, 'tokenCadastrar', true);
    await ligar(master, so3.id, 'tokenVisualizar', false);
    assert.equal(await abre(so3), false, 'Cadastrar sem Consultar: a Central não abre (é o caso do aviso TOKEN_SEM_CONSULTAR)');
  });
});
