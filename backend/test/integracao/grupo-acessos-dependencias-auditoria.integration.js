'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { montar } = require('./helpers/gestao-usuarios-app');
const { criarGrupoPermissaoController } = require('../../src/controllers/grupo-permissao.controller');
const { criarGrupoPermissaoRoutes } = require('../../src/routes/grupo-permissao.routes');

/**
 * Etapa H — auditoria, informação e sincronização das DEPENDÊNCIAS dos toggles (GRUPO). PostgreSQL real, schema temporário.
 * A regra de autorização do grupo NÃO muda: ligar uma funcionalidade dependente continua garantindo a leitura no grupo, mesmo
 * quando o grupo tinha a leitura negada (`false`, só possível por API/dado legado: o toggle nunca grava `false`).
 */
const AVISO = 'DEPENDENCIA_REABILITADA';
const ACAO = 'GRUPO_PERMISSAO_RECURSO_CONFIGURADA';

describe('Dependências de toggles — auditoria, alterados e aviso (grupo)', () => {
  let g;
  let master;
  let masterB;
  before(async () => {
    g = await montar({ extras: ({ pool, exigirEmpresarial }) => [
      criarGrupoPermissaoRoutes({ controller: criarGrupoPermissaoController({ pool }), exigirSessao: exigirEmpresarial }),
    ] });
    master = await g.contaDaEmpresa(g.empresas.A);
    masterB = await g.contaDaEmpresa(g.empresas.B);
  });
  after(async () => { if (g) await g.encerrar(); });

  let n = 0;
  const novoGrupo = async () => {
    n += 1;
    return (await g.um('INSERT INTO grupos_acesso (empresa_id, nome, criado_por) VALUES ($1, $2, $3) RETURNING id', [g.empresas.A, `Grupo Aud ${n}`, master.usuarioId])).id;
  };
  const ligar = (c, grupo, toggle, ligado) => g.request(g.app).put(`/api/grupos-acesso/${grupo}/acessos/${toggle}`).set('Cookie', g.cookie(c)).send({ ligado });
  const lista = (c, grupo) => g.request(g.app).get(`/api/grupos-acesso/${grupo}/acessos`).set('Cookie', g.cookie(c));
  const estados = async (grupo) => Object.fromEntries((await lista(master, grupo)).body.acessos.toggles.map((t) => [t.id, t.ligado]));
  const auditoria = (grupo) => g.todos("SELECT empresa_id, usuario_id, contexto, dados_anteriores, dados_novos FROM logs_auditoria WHERE acao = $1 AND referencia = $2 ORDER BY id", [ACAO, String(grupo)]);
  const linha = async (grupo) => {
    const l = (await g.todos("SELECT pode_visualizar, pode_criar, pode_editar FROM grupo_permissoes_recurso WHERE grupo_acesso_id = $1 AND recurso = 'atendimentoToken'", [grupo]))[0];
    return l === undefined ? null : [l.pode_visualizar, l.pode_criar, l.pode_editar];
  };
  const codigos = (r) => (r.body.avisos ?? []).map((a) => a.codigo);

  test('GD1 a dependência gravada no grupo é auditada ligada à operação original; o registro da operação pedida não muda', async () => {
    const grupo = await novoGrupo();
    const r = await ligar(master, grupo, 'tokenCadastrar', true);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const a = await auditoria(grupo);
    assert.equal(a.length, 2);
    const dependencia = a.find((x) => x.contexto.causa === 'dependencia');
    const principal = a.find((x) => x.contexto.causa === undefined);
    assert.ok(dependencia && principal);
    assert.equal(dependencia.contexto.acessoOrigem, 'tokenCadastrar');
    assert.deepEqual(dependencia.dados_novos, { podeVisualizar: true, podeCriar: null, podeEditar: null, podeExcluir: null });
    assert.deepEqual(principal.dados_novos, { podeVisualizar: true, podeCriar: true, podeEditar: null, podeExcluir: null });
    for (const x of a) assert.deepEqual([x.empresa_id, x.usuario_id], [g.empresas.A, master.usuarioId]);
  });

  test('GD2 sem mudança efetiva não há auditoria: dependência já concedida, repetição e desligar', async () => {
    const grupo = await novoGrupo();
    await ligar(master, grupo, 'tokenVisualizar', true);
    const antes = (await auditoria(grupo)).length;
    await ligar(master, grupo, 'tokenEditar', true);
    const a = await auditoria(grupo);
    assert.equal(a.length, antes + 1, 'a leitura já era do grupo: só o principal');
    assert.equal(a.at(-1).contexto.causa, undefined);
    await ligar(master, grupo, 'tokenEditar', true);
    assert.equal((await auditoria(grupo)).length, antes + 1, 'repetir não audita');
    await ligar(master, grupo, 'tokenEditar', false);
    const depois = await auditoria(grupo);
    assert.equal(depois.length, antes + 2);
    assert.equal(depois.at(-1).contexto.causa, undefined);
  });

  test('GD3 `alterados` traz todos os acessos do grupo que mudaram (aditivo) e confere com a recarga', async () => {
    const grupo = await novoGrupo();
    const r = await ligar(master, grupo, 'tokenCadastrar', true);
    assert.deepEqual(Object.keys(r.body).sort(), ['acesso', 'alterados', 'avisos', 'status']);
    assert.deepEqual(r.body.alterados.map((t) => [t.id, t.ligado]).sort(), [['tokenCadastrar', true], ['tokenVisualizar', true]]);
    const recarga = await estados(grupo);
    for (const t of r.body.alterados) assert.equal(recarga[t.id], t.ligado, t.id);
    const off = await ligar(master, grupo, 'tokenCadastrar', false);
    assert.deepEqual(off.body.alterados.map((t) => t.id), ['tokenCadastrar']);
    assert.deepEqual(await linha(grupo), [true, null, null], 'a leitura concedida como dependência permanece, como sempre');
  });

  test('GD4 regra mantida: leitura NEGADA no grupo (dado legado) é reaberta ao ligar a dependente; o MASTER é informado e a auditoria registra a negação anterior', async () => {
    const grupo = await novoGrupo();
    await g.pool.query("INSERT INTO grupo_permissoes_recurso (empresa_id, grupo_acesso_id, recurso, pode_visualizar) VALUES ($1, $2, 'atendimentoToken', false)", [g.empresas.A, grupo]);
    const r = await ligar(master, grupo, 'tokenEditar', true);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(await linha(grupo), [true, null, true], 'a autorização é a de sempre: a concessão nova reabre a leitura');
    const aviso = r.body.avisos.find((a) => a.codigo === AVISO);
    assert.ok(aviso, 'aviso presente');
    assert.deepEqual(aviso.acessos, ['Atendimento Token: Consultar']);
    const dependencia = (await auditoria(grupo)).find((x) => x.contexto.causa === 'dependencia');
    assert.deepEqual(dependencia.dados_anteriores, { podeVisualizar: false, podeCriar: null, podeEditar: null, podeExcluir: null }, 'o registro mostra que era uma negação');
    assert.equal(codigos(await lista(master, grupo)).includes(AVISO), false);
  });

  test('GD5 Funcionários e Estoque usam o mesmo mecanismo: dependência auditada e aviso com o nome certo', async () => {
    const f = await novoGrupo();
    const rf = await ligar(master, f, 'editarFuncionario', true);
    assert.deepEqual(rf.body.alterados.map((t) => t.id).sort(), ['editarFuncionario', 'historicoFuncionarios']);
    assert.equal((await auditoria(f)).filter((x) => x.contexto.causa === 'dependencia').length, 1);
    const e = await novoGrupo();
    await g.pool.query("INSERT INTO grupo_permissoes_recurso (empresa_id, grupo_acesso_id, recurso, pode_visualizar) VALUES ($1, $2, 'materials', false)", [g.empresas.A, e]);
    const re = await ligar(master, e, 'registrarBaixa', true);
    assert.deepEqual(re.body.alterados.map((t) => t.id), ['registrarBaixa']);
    assert.deepEqual(re.body.avisos.find((a) => a.codigo === AVISO).acessos, ['Materiais (leitura)']);
  });

  test('GD6 autoridade e isolamento: outra empresa 404; sem sessão 401; ADMINISTRADOR sem autoridade de grupo 403 — nada gravado nem auditado', async () => {
    const grupo = await novoGrupo();
    assert.equal((await ligar(masterB, grupo, 'tokenCadastrar', true)).status, 404);
    assert.equal((await g.request(g.app).put(`/api/grupos-acesso/${grupo}/acessos/tokenCadastrar`).send({ ligado: true })).status, 401);
    const adm = await g.contaDaEmpresa(g.empresas.A, 'ADMINISTRADOR');
    assert.equal((await ligar(adm, grupo, 'tokenCadastrar', true)).status, 403);
    assert.equal(await linha(grupo), null);
    assert.deepEqual(await auditoria(grupo), []);
  });

  test('GD7 nenhum segredo nas respostas nem na auditoria', async () => {
    const grupo = await novoGrupo();
    const r = await ligar(master, grupo, 'tokenGerarAtivacao', true);
    const texto = JSON.stringify([r.body, await auditoria(grupo)]);
    assert.equal(/senha|hash|cookie|authorization|segredo|secret|codigo_?ativacao|bearer|jwt/i.test(texto), false);
  });
});
