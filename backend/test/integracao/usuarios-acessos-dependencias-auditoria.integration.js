'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { montar } = require('./helpers/gestao-usuarios-app');
const { criarGrupoPermissaoController } = require('../../src/controllers/grupo-permissao.controller');
const { criarGrupoPermissaoRoutes } = require('../../src/routes/grupo-permissao.routes');

/**
 * Etapa H — auditoria, informação e sincronização das DEPENDÊNCIAS dos toggles (usuário). PostgreSQL real, schema temporário.
 *
 * A REGRA DE AUTORIZAÇÃO NÃO MUDA (decisão definitiva): uma concessão nova é uma decisão nova; ligar uma funcionalidade
 * dependente continua reabrindo a leitura, mesmo bloqueada; a precedência perfil → grupo → individual → bloqueio é a de sempre.
 * O que muda é só a VISIBILIDADE: (1) cada dependência efetivamente alterada é auditada, ligada à operação original;
 * (2) o PUT devolve `alterados` (aditivo); (3) quando uma leitura explicitamente bloqueada é reabilitada, o PUT traz o aviso
 * `DEPENDENCIA_REABILITADA` com o nome do que foi reabilitado.
 */
const BASE = '/api/administracao/usuarios';
const AVISO = 'DEPENDENCIA_REABILITADA';

describe('Dependências de toggles — auditoria, alterados e aviso (usuário)', () => {
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

  const ligar = (c, id, toggle, ligado) => g.request(g.app).put(`${BASE}/${id}/acessos/${toggle}`).set('Cookie', g.cookie(c)).send({ ligado });
  const lista = (c, id) => g.request(g.app).get(`${BASE}/${id}/acessos`).set('Cookie', g.cookie(c));
  const estados = async (id) => Object.fromEntries((await lista(master, id)).body.acessos.toggles.map((t) => [t.id, t.ligado]));
  const cookieDe = async (u) => g.deCookies(g.cookiesDe(await g.login(u.email, g.SENHA_PROVISORIA)));
  const efetivas = async (u) => (await g.request(g.app).get('/api/auth/permissoes').set('Cookie', await cookieDe(u))).body;
  const linha = async (id, recurso) => {
    const l = (await g.todos('SELECT pode_visualizar, pode_criar, pode_editar FROM usuario_permissoes_recurso WHERE usuario_id = $1 AND recurso = $2', [id, recurso]))[0];
    return l === undefined ? null : [l.pode_visualizar, l.pode_criar, l.pode_editar];
  };
  const auditoria = (id) => g.todos(
    "SELECT empresa_id, usuario_id, acao, referencia, contexto, dados_anteriores, dados_novos FROM logs_auditoria WHERE referencia = $1 AND acao = 'USUARIO_ACESSO_ALTERADO' ORDER BY id",
    [String(id)],
  );
  const codigos = (r) => (r.body.avisos ?? []).map((a) => a.codigo);
  let n = 0;
  const novoGrupo = async () => {
    n += 1;
    return (await g.um('INSERT INTO grupos_acesso (empresa_id, nome, criado_por) VALUES ($1, $2, $3) RETURNING id', [g.empresas.A, `Grupo Dep ${n}`, master.usuarioId])).id;
  };
  const ligarGrupo = (grupo, toggle, ligado) => g.request(g.app).put(`/api/grupos-acesso/${grupo}/acessos/${toggle}`).set('Cookie', g.cookie(master)).send({ ligado });
  const bloquear = (id, recurso) => g.pool.query('INSERT INTO usuario_permissoes_recurso (empresa_id, usuario_id, recurso, pode_visualizar, concedido_por) VALUES ($1, $2, $3, false, $4)', [g.empresas.A, id, recurso, master.usuarioId]);

  test('DA1 a alteração solicitada E a dependência alterada são auditadas, ligadas à operação original, com ator, empresa, alvo e estado', async () => {
    const u = await g.usuarioPronto(master);
    const r = await ligar(master, u.id, 'tokenCadastrar', true);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const a = await auditoria(u.id);
    assert.equal(a.length, 2);
    const [principal, dependencia] = a;
    assert.deepEqual([principal.dados_anteriores, principal.dados_novos], [{ acesso: 'tokenCadastrar', ligado: false }, { acesso: 'tokenCadastrar', ligado: true }], 'o registro da operação pedida não mudou');
    assert.equal(principal.contexto.causa, undefined);
    assert.deepEqual([dependencia.dados_anteriores, dependencia.dados_novos], [{ acesso: 'tokenVisualizar', ligado: false }, { acesso: 'tokenVisualizar', ligado: true }]);
    assert.deepEqual([dependencia.contexto.causa, dependencia.contexto.acessoOrigem, dependencia.contexto.origem], ['dependencia', 'tokenCadastrar', 'administracao_usuarios']);
    for (const x of a) assert.deepEqual([x.empresa_id, x.usuario_id, x.referencia], [g.empresas.A, master.usuarioId, String(u.id)]);
  });

  test('DA2 nenhuma auditoria duplicada: dependência já efetiva, repetição do mesmo estado e desligar não geram registro de dependência', async () => {
    const u = await g.usuarioPronto(master);
    await ligar(master, u.id, 'tokenVisualizar', true);
    const antes = (await auditoria(u.id)).length;
    await ligar(master, u.id, 'tokenCadastrar', true);
    assert.equal((await auditoria(u.id)).length, antes + 1, 'Consultar já era efetivo: só o principal');
    await ligar(master, u.id, 'tokenCadastrar', true);
    assert.equal((await auditoria(u.id)).length, antes + 1, 'repetir o mesmo estado não audita nada');
    await ligar(master, u.id, 'tokenCadastrar', false);
    const a = await auditoria(u.id);
    assert.equal(a.length, antes + 2, 'desligar audita só o próprio acesso');
    assert.equal(a.at(-1).contexto.causa, undefined);
  });

  test('DA3 concessões individuais e por grupo são preservadas: nada é duplicado nem retirado, e a dependência vinda do grupo não é auditada como alterada', async () => {
    const grupo = await novoGrupo();
    await ligarGrupo(grupo, 'tokenVisualizar', true);
    const doGrupo = await g.usuarioPronto(master, { grupoAcessoId: grupo });
    await ligar(master, doGrupo.id, 'tokenEditar', true);
    assert.deepEqual(await linha(doGrupo.id, 'atendimentoToken'), [null, null, true]);
    assert.equal((await auditoria(doGrupo.id)).length, 1, 'a leitura do grupo já valia: só o principal');
    assert.deepEqual(await g.todos("SELECT pode_visualizar FROM grupo_permissoes_recurso WHERE grupo_acesso_id = $1 AND recurso = 'atendimentoToken'", [grupo]), [{ pode_visualizar: true }]);
    const individual = await g.usuarioPronto(master);
    await ligar(master, individual.id, 'tokenVisualizar', true);
    await ligar(master, individual.id, 'tokenRevogar', true);
    assert.deepEqual(await linha(individual.id, 'atendimentoToken'), [true, null, null]);
    assert.equal((await efetivas(individual)).acoes.TOKEN_REVOGAR_DISPOSITIVO, true);
  });

  test('DA4 a regra atual é mantida: dependência bloqueada é reaberta (nova concessão = nova decisão), com auditoria que registra o bloqueio anterior', async () => {
    const casos = [
      ['tokenCadastrar', 'atendimentoToken', 'tokenVisualizar', 'Atendimento Token: Consultar'],
      ['tokenEditar', 'atendimentoToken', 'tokenVisualizar', 'Atendimento Token: Consultar'],
      ['tokenRevogar', 'atendimentoToken', 'tokenVisualizar', 'Atendimento Token: Consultar'],
      ['tokenGerarAtivacao', 'atendimentoToken', 'tokenVisualizar', 'Atendimento Token: Consultar'],
      ['cadastrarFuncionario', 'employeeHistory', 'historicoFuncionarios', 'Funcionários: Histórico de Funcionários'],
      ['editarFuncionario', 'employeeHistory', 'historicoFuncionarios', 'Funcionários: Histórico de Funcionários'],
      ['cadastrarProduto', 'materials', 'materials.visualizar', 'Materiais (leitura)'],
      ['entradaLote', 'materials', 'materials.visualizar', 'Materiais (leitura)'],
      ['registrarBaixa', 'materials', 'materials.visualizar', 'Materiais (leitura)'],
    ];
    for (const [toggle, recurso, acessoDep, rotulo] of casos) {
      const u = await g.usuarioPronto(master);
      await bloquear(u.id, recurso);
      assert.equal((await efetivas(u)).recursos[recurso]?.visualizar ?? false, false, `${toggle}: bloqueio de partida`);
      const r = await ligar(master, u.id, toggle, true);
      assert.equal(r.status, 200, `${toggle} ${JSON.stringify(r.body)}`);
      assert.equal((await efetivas(u)).recursos[recurso].visualizar, true, `${toggle}: a regra de autorização é a de sempre (reabre)`);
      const a = await auditoria(u.id);
      const dependencia = a.find((x) => x.dados_novos.acesso === acessoDep);
      assert.ok(dependencia, `${toggle}: a dependência é auditada`);
      assert.deepEqual(dependencia.dados_anteriores, { acesso: acessoDep, ligado: false, bloqueadoIndividualmente: true }, `${toggle}: registra que era um bloqueio`);
      assert.deepEqual(dependencia.dados_novos, { acesso: acessoDep, ligado: true });
      assert.equal(dependencia.contexto.acessoOrigem, toggle);
      const aviso = (r.body.avisos ?? []).find((x) => x.codigo === AVISO);
      assert.ok(aviso, `${toggle}: o MASTER é informado`);
      assert.deepEqual(aviso.acessos, [rotulo], `${toggle}: o aviso diz o que foi reabilitado`);
    }
  });

  test('DA5 PUT devolve `alterados` com TODOS os acessos que mudaram (aditivo) e o estado confere com a recarga', async () => {
    const u = await g.usuarioPronto(master);
    const r = await ligar(master, u.id, 'tokenCadastrar', true);
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.body).sort(), ['acesso', 'alterados', 'avisos', 'status'], 'campos antigos intactos, só `alterados` é novo');
    assert.equal(r.body.acesso.id, 'tokenCadastrar');
    assert.deepEqual(r.body.alterados.map((t) => [t.id, t.ligado]).sort(), [['tokenCadastrar', true], ['tokenVisualizar', true]]);
    const recarga = await estados(u.id);
    for (const t of r.body.alterados) assert.equal(recarga[t.id], t.ligado, `${t.id}: tela × recarga`);
    const off = await ligar(master, u.id, 'tokenCadastrar', false);
    assert.deepEqual(off.body.alterados.map((t) => [t.id, t.ligado]), [['tokenCadastrar', false]], 'desligar altera só o próprio acesso');
    const semMudanca = await ligar(master, u.id, 'tokenCadastrar', false);
    assert.deepEqual(semMudanca.body.alterados, [], 'sem mudança efetiva, lista vazia');
  });

  test('DA6 aviso de reabilitação só quando havia bloqueio EXPLÍCITO: dependência apenas não concedida ou já efetiva não gera aviso; o GET não o repete', async () => {
    const livre = await g.usuarioPronto(master);
    assert.equal(codigos(await ligar(master, livre.id, 'tokenCadastrar', true)).includes(AVISO), false, 'não havia bloqueio');
    const bloqueado = await g.usuarioPronto(master);
    await bloquear(bloqueado.id, 'atendimentoToken');
    const r = await ligar(master, bloqueado.id, 'tokenEditar', true);
    assert.equal(codigos(r).includes(AVISO), true);
    assert.equal(codigos(await ligar(master, bloqueado.id, 'tokenEditar', false)).includes(AVISO), false, 'desligar não gera aviso');
    assert.equal(codigos(await ligar(master, bloqueado.id, 'tokenRevogar', true)).includes(AVISO), false, 'a leitura já está efetiva: nada foi reabilitado agora');
    assert.deepEqual(((await lista(master, bloqueado.id)).body.acessos.avisos ?? []).map((a) => a.codigo).filter((c) => c === AVISO), [], 'o GET descreve o estado, não o evento');
    // Linha individual que EXISTE, mas com a leitura em null (nem concedida nem bloqueada): reabrir não é reabilitar um bloqueio.
    const semOpiniao = await g.usuarioPronto(master);
    await g.pool.query('INSERT INTO usuario_permissoes_recurso (empresa_id, usuario_id, recurso, pode_editar, concedido_por) VALUES ($1, $2, $3, true, $4)', [g.empresas.A, semOpiniao.id, 'atendimentoToken', master.usuarioId]);
    const r2 = await ligar(master, semOpiniao.id, 'tokenCadastrar', true);
    assert.equal(codigos(r2).includes(AVISO), false, 'leitura null com outra operação na linha não é bloqueio');
    const dep = (await auditoria(semOpiniao.id)).find((x) => x.dados_novos.acesso === 'tokenVisualizar');
    assert.ok(dep, 'a dependência alterada continua auditada');
    assert.deepEqual(dep.dados_anteriores, { acesso: 'tokenVisualizar', ligado: false }, 'sem a marca de bloqueio');
  });

  test('DA7 Estoque (leitura sem toggle próprio): audita materials.visualizar, `alterados` traz só o toggle com linha, aviso nomeia a leitura', async () => {
    const u = await g.usuarioPronto(master);
    const r = await ligar(master, u.id, 'entradaLote', true);
    assert.deepEqual(r.body.alterados.map((t) => t.id), ['entradaLote']);
    const a = await auditoria(u.id);
    assert.deepEqual(a.map((x) => x.dados_novos.acesso), ['entradaLote', 'materials.visualizar']);
    assert.equal(a[1].contexto.acessoOrigem, 'entradaLote');
    assert.deepEqual((await efetivas(u)).acoes.ENTRADA_ESTOQUE, true);
  });

  test('DA8 Funcionários: dependência no Histórico alterada, auditada, `alterados` com os dois e sem afetar a outra operação', async () => {
    const u = await g.usuarioPronto(master);
    const r = await ligar(master, u.id, 'cadastrarFuncionario', true);
    assert.deepEqual(r.body.alterados.map((t) => [t.id, t.ligado]).sort(), [['cadastrarFuncionario', true], ['historicoFuncionarios', true]]);
    const e = await estados(u.id);
    assert.deepEqual([e.cadastrarFuncionario, e.historicoFuncionarios, e.editarFuncionario], [true, true, false]);
    assert.deepEqual((await auditoria(u.id)).map((x) => x.dados_novos.acesso), ['cadastrarFuncionario', 'historicoFuncionarios']);
  });

  test('DA9 só o MASTER altera: ADMINISTRADOR e usuário comum recebem 403, sem registro de auditoria nem `alterados`; sem sessão é 401', async () => {
    const alvo = await g.usuarioPronto(master);
    const adm = await g.administradorAutorizado(g.empresas.A, master);
    const comum = await g.usuarioPronto(master);
    const negado = await ligar(adm, alvo.id, 'tokenCadastrar', true);
    assert.deepEqual([negado.status, negado.body.codigo, negado.body.alterados], [403, 'PERMISSOES_INDIVIDUAIS_SOMENTE_MASTER', undefined]);
    const doComum = await g.request(g.app).put(`${BASE}/${alvo.id}/acessos/tokenCadastrar`).set('Cookie', await cookieDe(comum)).send({ ligado: true });
    assert.equal(doComum.status, 403);
    assert.equal((await g.request(g.app).put(`${BASE}/${alvo.id}/acessos/tokenCadastrar`).send({ ligado: true })).status, 401);
    assert.deepEqual(await auditoria(alvo.id), []);
    assert.equal(await linha(alvo.id, 'atendimentoToken'), null);
  });

  test('DA10 isolamento entre empresas: o MASTER de outra empresa não altera nem audita; o alvo fica intacto', async () => {
    const u = await g.usuarioPronto(master);
    assert.equal((await ligar(masterB, u.id, 'tokenCadastrar', true)).status, 404);
    assert.deepEqual(await auditoria(u.id), []);
    assert.equal(await linha(u.id, 'atendimentoToken'), null);
    const deB = await g.usuarioPronto(masterB);
    assert.equal((await ligar(master, deB.id, 'tokenCadastrar', true)).status, 404);
    assert.deepEqual(await auditoria(deB.id), []);
  });

  test('DA11 nenhum segredo nas respostas nem na auditoria', async () => {
    const u = await g.usuarioPronto(master);
    await bloquear(u.id, 'atendimentoToken');
    const r = await ligar(master, u.id, 'tokenGerarAtivacao', true);
    const texto = JSON.stringify([r.body, await auditoria(u.id)]);
    assert.equal(/senha|hash|cookie|authorization|segredo|secret|codigo_?ativacao|bearer|jwt/i.test(texto), false);
    assert.equal(texto.includes(g.SENHA_PROVISORIA), false);
  });

  test('DA12 consistência: o que o PUT mostra concorda com a recarga e com as permissões efetivas (menu/rotas) em toda a cadeia', async () => {
    const grupo = await novoGrupo();
    await ligarGrupo(grupo, 'tokenVisualizar', true);
    const u = await g.usuarioPronto(master, { grupoAcessoId: grupo });
    await ligar(master, u.id, 'tokenVisualizar', false);
    const r = await ligar(master, u.id, 'tokenCadastrar', true);
    const recarga = await estados(u.id);
    const p = await efetivas(u);
    for (const t of r.body.alterados) assert.equal(recarga[t.id], t.ligado, t.id);
    assert.deepEqual([recarga.tokenVisualizar, recarga.tokenCadastrar], [p.recursos.atendimentoToken.visualizar, p.recursos.atendimentoToken.criar]);
    assert.deepEqual([recarga.tokenVisualizar, recarga.tokenCadastrar], [true, true]);
  });
});
