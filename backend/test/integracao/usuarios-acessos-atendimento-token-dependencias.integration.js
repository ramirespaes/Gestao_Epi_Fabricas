'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { montar } = require('./helpers/gestao-usuarios-app');
const { criarGrupoPermissaoController } = require('../../src/controllers/grupo-permissao.controller');
const { criarGrupoPermissaoRoutes } = require('../../src/routes/grupo-permissao.routes');
const { criarTokenCentralRoutes } = require('../../src/routes/token-central.routes');
const { criarTokenDispositivoRoutes } = require('../../src/routes/token-dispositivo.routes');
const { criarTokenAtivacaoRoutes } = require('../../src/routes/token-ativacao.routes');

/**
 * Etapa H — verificação de segurança das DEPENDÊNCIAS dos toggles do Atendimento Token (PostgreSQL real, schema temporário).
 *
 * Pergunta: ligar Cadastrar, Editar, Revogar ou Gerar ativação mexe no BLOQUEIO INDIVIDUAL de Consultar?
 *
 * DECISÃO DEFINITIVA (fase 10): a regra de autorização NÃO muda — uma concessão nova é uma decisão nova, e ligar uma
 * funcionalidade dependente reabre a leitura, mesmo bloqueada (igual a Funcionários e Estoque). Os testes "REGRA MANTIDA"
 * provam que a autorização continua exatamente a mesma; a diferença desde a fase 8 é só a visibilidade (a reabilitação passou a
 * ser auditada). A auditoria, o aviso e o `alterados` têm testes próprios em usuarios-acessos-dependencias-auditoria.
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
const DOS_TOGGLES = { tokenVisualizar: 'consultar', tokenCadastrar: 'cadastrar', tokenEditar: 'editar', tokenRevogar: 'revogar', tokenGerarAtivacao: 'gerar', tokenRedes: 'redes', tokenPrevia: 'previa' };
const DEPENDENTES = [['tokenCadastrar', 'cadastrar'], ['tokenEditar', 'editar'], ['tokenRevogar', 'revogar'], ['tokenGerarAtivacao', 'gerar']];

describe('Atendimento Token — dependências × bloqueio individual (PostgreSQL real)', () => {
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
  });
  after(async () => { if (g) await g.encerrar(); });

  const ligar = (c, id, toggle, ligado) => g.request(g.app).put(`${BASE}/${id}/acessos/${toggle}`).set('Cookie', g.cookie(c)).send({ ligado });
  const lista = (c, id) => g.request(g.app).get(`${BASE}/${id}/acessos`).set('Cookie', g.cookie(c));
  const toggles = async (id) => Object.fromEntries((await lista(master, id)).body.acessos.toggles.filter((t) => IDS.includes(t.id)).map((t) => [t.id, t.ligado]));
  const cookieDe = async (u) => g.deCookies(g.cookiesDe(await g.login(u.email, g.SENHA_PROVISORIA)));
  const rotas = async (u) => {
    const cookie = await cookieDe(u);
    const r = {};
    for (const [nome, [metodo, caminho]] of Object.entries(ROTAS)) r[nome] = (await g.request(g.app)[metodo](`/api${caminho}`).set('Cookie', cookie).send({})).status !== 403;
    return r;
  };
  const efetivas = async (u) => (await g.request(g.app).get('/api/auth/permissoes').set('Cookie', await cookieDe(u))).body;
  /** A tela (GET acessos), as permissões efetivas do menu e as rotas reais precisam dizer a mesma coisa. */
  const coerente = async (u, rotulo) => {
    const t = await toggles(u.id);
    const p = await efetivas(u);
    const r = await rotas(u);
    assert.equal(t.tokenVisualizar, p.recursos.atendimentoToken?.visualizar ?? false, `${rotulo}: Consultar (tela × menu)`);
    assert.equal(t.tokenCadastrar, p.recursos.atendimentoToken?.criar ?? false, `${rotulo}: Cadastrar (tela × menu)`);
    assert.equal(t.tokenEditar, p.recursos.atendimentoToken?.editar ?? false, `${rotulo}: Editar (tela × menu)`);
    assert.equal(t.tokenRevogar, p.acoes.TOKEN_REVOGAR_DISPOSITIVO === true, `${rotulo}: Revogar (tela × menu)`);
    assert.equal(t.tokenGerarAtivacao, p.acoes.TOKEN_GERAR_ATIVACAO === true, `${rotulo}: Gerar (tela × menu)`);
    assert.equal(t.tokenRedes, p.acoes.TOKEN_GERENCIAR_REDES === true, `${rotulo}: Redes (tela × menu)`);
    assert.equal(t.tokenPrevia, p.acoes.TOKEN_PREVIA_CATALOGO_REAL === true, `${rotulo}: Prévia (tela × menu)`);
    for (const [toggle, rota] of Object.entries(DOS_TOGGLES)) assert.equal(r[rota], t[toggle], `${rotulo}: ${toggle} (tela × rota real)`);
    return { t, p, r };
  };
  const linha = async (id) => (await g.todos("SELECT pode_visualizar, pode_criar, pode_editar, pode_excluir FROM usuario_permissoes_recurso WHERE usuario_id = $1 AND recurso = 'atendimentoToken'", [id]))[0] ?? null;
  const flags = async (id) => { const l = await linha(id); return l === null ? null : [l.pode_visualizar, l.pode_criar, l.pode_editar]; };
  const bloqueiosAcao = async (id) => (await g.todos("SELECT acao_codigo FROM usuario_bloqueios WHERE usuario_id = $1 AND acao_codigo LIKE 'TOKEN_%' ORDER BY 1", [id])).map((r) => r.acao_codigo);
  const auditoria = async (id) => (await g.todos("SELECT acao, dados_novos FROM logs_auditoria WHERE referencia = $1 AND acao <> 'USUARIO_CRIADO' ORDER BY id", [String(id)])).map((r) => ({ acao: r.acao, ...r.dados_novos }));
  let n = 0;
  const novoGrupo = async () => {
    n += 1;
    return (await g.um('INSERT INTO grupos_acesso (empresa_id, nome, criado_por) VALUES ($1, $2, $3) RETURNING id', [g.empresas.A, `Grupo Dep ${n}`, master.usuarioId])).id;
  };
  const ligarGrupo = (c, grupo, toggle, ligado) => g.request(g.app).put(`/api/grupos-acesso/${grupo}/acessos/${toggle}`).set('Cookie', g.cookie(c)).send({ ligado });
  const linhaGrupo = async (grupo) => (await g.todos("SELECT pode_visualizar, pode_criar, pode_editar FROM grupo_permissoes_recurso WHERE grupo_acesso_id = $1 AND recurso = 'atendimentoToken'", [grupo]))[0] ?? null;

  /** Consultar concedido pelo grupo e BLOQUEADO só para este usuário, pelo caminho normal da tela (Consultar OFF). */
  async function bloqueadoPorGrupo() {
    const grupo = await novoGrupo();
    assert.equal((await ligarGrupo(master, grupo, 'tokenVisualizar', true)).status, 200);
    const u = await g.usuarioPronto(master, { grupoAcessoId: grupo });
    assert.equal((await rotas(u)).consultar, true, 'antes: o grupo concede Consultar');
    assert.equal((await ligar(master, u.id, 'tokenVisualizar', false)).status, 200);
    assert.deepEqual(await flags(u.id), [false, null, null], 'Consultar OFF sobre a concessão do grupo = bloqueio individual');
    assert.equal((await rotas(u)).consultar, false, 'o bloqueio individual vence o grupo');
    return { grupo, u };
  }
  /** Bloqueio individual de Consultar SEM nenhuma concessão por trás (dado legado ou gravado pelas APIs antigas). */
  async function bloqueadoDireto() {
    const u = await g.usuarioPronto(master);
    await g.pool.query("INSERT INTO usuario_permissoes_recurso (empresa_id, usuario_id, recurso, pode_visualizar, concedido_por) VALUES ($1, $2, 'atendimentoToken', false, $3)", [g.empresas.A, u.id, master.usuarioId]);
    return u;
  }

  test('D1 Consultar permitido (individual) e Cadastrar habilitado: os dois ligados, sem duplicar; desligar Cadastrar mantém Consultar', async () => {
    const u = await g.usuarioPronto(master);
    await ligar(master, u.id, 'tokenVisualizar', true);
    assert.deepEqual(await flags(u.id), [true, null, null]);
    await ligar(master, u.id, 'tokenCadastrar', true);
    assert.deepEqual(await flags(u.id), [true, true, null]);
    const c = await coerente(u, 'D1 ligado');
    assert.deepEqual([c.t.tokenVisualizar, c.t.tokenCadastrar], [true, true]);
    await ligar(master, u.id, 'tokenCadastrar', false);
    assert.deepEqual(await flags(u.id), [true, null, null], 'só a regra própria saiu');
    await coerente(u, 'D1 desligado');
  });

  test('D2 REGRA MANTIDA: Consultar bloqueado pelo caminho normal e Cadastrar ligado — a concessão nova reabre Consultar (e a mudança agora é auditada)', async () => {
    const { u } = await bloqueadoPorGrupo();
    const antes = await auditoria(u.id);
    const r = await ligar(master, u.id, 'tokenCadastrar', true);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.acesso.ligado, true);
    assert.deepEqual(await flags(u.id), [null, true, null], 'a flag visualizar=false foi apagada (volta a herdar do grupo)');
    const c = await coerente(u, 'D2');
    assert.equal(c.t.tokenVisualizar, true, 'Consultar voltou a valer: o usuário recebeu uma permissão que estava bloqueada');
    assert.equal(c.r.consultar, true);
    const novos = (await auditoria(u.id)).slice(antes.length);
    assert.deepEqual(novos.map((a) => [a.acao, a.acesso]), [['USUARIO_ACESSO_ALTERADO', 'tokenCadastrar'], ['USUARIO_ACESSO_ALTERADO', 'tokenVisualizar']], 'a alteração pedida E a reabilitação de Consultar são auditadas');
  });

  test('D2b REGRA MANTIDA: bloqueio de Consultar sem concessão por trás e Cadastrar ligado — vira CONCESSÃO individual de Consultar (auditada)', async () => {
    const u = await bloqueadoDireto();
    assert.deepEqual(await flags(u.id), [false, null, null]);
    assert.equal((await rotas(u)).consultar, false);
    const antes = await auditoria(u.id);
    await ligar(master, u.id, 'tokenCadastrar', true);
    assert.deepEqual(await flags(u.id), [true, true, null], 'visualizar passou de false para true (concessão gravada em nome do MASTER)');
    const c = await coerente(u, 'D2b');
    assert.deepEqual([c.t.tokenVisualizar, c.t.tokenCadastrar], [true, true]);
    const novos = (await auditoria(u.id)).slice(antes.length);
    assert.deepEqual(novos.map((a) => a.acesso), ['tokenCadastrar', 'tokenVisualizar'], 'o Cadastrar e a dependência aparecem na auditoria');
  });

  test('D3-D5 REGRA MANTIDA: Editar, Revogar e Gerar ativação também reabrem Consultar quando ligados (auditado)', async () => {
    for (const [toggle, rota] of DEPENDENTES.filter(([t]) => t !== 'tokenCadastrar')) {
      const { u } = await bloqueadoPorGrupo();
      assert.equal((await rotas(u))[rota], false, `${toggle}: antes, sem a própria permissão`);
      const antes = await auditoria(u.id);
      const r = await ligar(master, u.id, toggle, true);
      assert.equal(r.status, 200, `${toggle} ${JSON.stringify(r.body)}`);
      const l = await flags(u.id);
      assert.notEqual(l?.[0], false, `${toggle}: o bloqueio de Consultar não pode mais existir`);
      const c = await coerente(u, `D3-5 ${toggle}`);
      assert.deepEqual([c.t.tokenVisualizar, c.t[toggle], c.r.consultar, c.r[rota]], [true, true, true, true], toggle);
      const novos = (await auditoria(u.id)).slice(antes.length);
      assert.equal(novos.some((a) => a.acesso === 'tokenVisualizar'), true, `${toggle}: o desbloqueio de Consultar é auditado`);
      assert.equal(novos.some((a) => a.acesso === toggle || a.acao === 'USUARIO_PERMISSAO_ACAO_ALTERADA'), true, `${toggle}: a própria mudança é auditada`);
    }
  });

  test('D6 toggles SEM dependência (Prévia, Redes) ligados não tocam no bloqueio de Consultar', async () => {
    const { u } = await bloqueadoPorGrupo();
    await ligar(master, u.id, 'tokenPrevia', true);
    await ligar(master, u.id, 'tokenRedes', true);
    assert.deepEqual(await flags(u.id), [false, null, null], 'o bloqueio de Consultar continua');
    const c = await coerente(u, 'D6');
    assert.deepEqual([c.r.consultar, c.r.previa, c.r.redes], [false, true, true]);
  });

  test('D7 Consultar concedido pelo grupo e outra funcionalidade ligada individualmente: nada é duplicado, nada do grupo é tocado', async () => {
    const grupo = await novoGrupo();
    await ligarGrupo(master, grupo, 'tokenVisualizar', true);
    const u = await g.usuarioPronto(master, { grupoAcessoId: grupo });
    await ligar(master, u.id, 'tokenEditar', true);
    assert.deepEqual(await flags(u.id), [null, null, true], 'só Editar é exceção individual; Consultar segue vindo do grupo');
    assert.deepEqual(await linhaGrupo(grupo), { pode_visualizar: true, pode_criar: null, pode_editar: null });
    const c = await coerente(u, 'D7');
    assert.deepEqual([c.r.consultar, c.r.editar], [true, true]);
    await ligar(master, u.id, 'tokenEditar', false);
    assert.equal(await linha(u.id), null, 'a camada individual voltou ao padrão');
    assert.equal((await coerente(u, 'D7 desligado')).r.consultar, true, 'a leitura do grupo permanece');
  });

  test('D8 o bloqueio individual prevalece sobre o grupo enquanto ninguém o alterar explicitamente: mudanças no GRUPO não o desfazem', async () => {
    const { grupo, u } = await bloqueadoPorGrupo();
    const outro = await g.usuarioPronto(master, { grupoAcessoId: grupo });
    await ligarGrupo(master, grupo, 'tokenEditar', true);
    await ligarGrupo(master, grupo, 'tokenCadastrar', true);
    await ligarGrupo(master, grupo, 'tokenVisualizar', false);
    await ligarGrupo(master, grupo, 'tokenVisualizar', true);
    assert.deepEqual(await flags(u.id), [false, null, null], 'a linha individual não foi tocada pelo grupo');
    const bloqueado = await coerente(u, 'D8 bloqueado');
    assert.equal(bloqueado.r.consultar, false, 'o bloqueio individual vence o grupo');
    assert.equal(bloqueado.r.editar, true, 'o grupo continua concedendo o resto');
    const livre = await coerente(outro, 'D8 outro integrante');
    assert.deepEqual([livre.r.consultar, livre.r.editar], [true, true], 'o outro integrante não é afetado');
  });

  test('D9 desligar uma funcionalidade não retira as independentes (nem a leitura concedida como dependência)', async () => {
    const u = await g.usuarioPronto(master);
    for (const t of ['tokenCadastrar', 'tokenEditar', 'tokenRevogar', 'tokenGerarAtivacao', 'tokenRedes', 'tokenPrevia']) await ligar(master, u.id, t, true);
    await ligar(master, u.id, 'tokenCadastrar', false);
    const c = await coerente(u, 'D9');
    assert.deepEqual(c.t, { tokenVisualizar: true, tokenCadastrar: false, tokenEditar: true, tokenRevogar: true, tokenGerarAtivacao: true, tokenRedes: true, tokenPrevia: true });
    await ligar(master, u.id, 'tokenRevogar', false);
    const d = await coerente(u, 'D9 revogar');
    assert.deepEqual(d.t, { tokenVisualizar: true, tokenCadastrar: false, tokenEditar: true, tokenRevogar: false, tokenGerarAtivacao: true, tokenRedes: true, tokenPrevia: true });
    assert.deepEqual(await bloqueiosAcao(u.id), [], 'desligar o que não vem de outra camada não cria bloqueio');
  });

  test('D10 recarga: o estado persistido volta igual em nova leitura e em nova sessão, e tela, menu e rotas concordam', async () => {
    const { u } = await bloqueadoPorGrupo();
    const lido1 = await toggles(u.id);
    assert.equal(lido1.tokenVisualizar, false);
    await coerente(u, 'D10 bloqueado');
    await ligar(master, u.id, 'tokenEditar', true);
    const lido2 = await toggles(u.id);
    const lido3 = await toggles(u.id);
    assert.deepEqual(lido2, lido3, 'leituras repetidas são estáveis');
    assert.deepEqual([lido2.tokenVisualizar, lido2.tokenEditar], [true, true]);
    await coerente(u, 'D10 depois do Editar');
  });

  test('D11 sem autoridade: ADMINISTRADOR (mesmo autorizado a administrar) e usuário comum não alteram nada; sem sessão é 401; o bloqueio fica intacto', async () => {
    const { u } = await bloqueadoPorGrupo();
    const adm = await g.administradorAutorizado(g.empresas.A, master);
    const comum = await g.usuarioPronto(master);
    const antes = await auditoria(u.id);
    const negadoAdm = await ligar(adm, u.id, 'tokenCadastrar', true);
    assert.deepEqual([negadoAdm.status, negadoAdm.body.codigo], [403, 'PERMISSOES_INDIVIDUAIS_SOMENTE_MASTER']);
    const comumCookie = await cookieDe(comum);
    const negadoComum = await g.request(g.app).put(`${BASE}/${u.id}/acessos/tokenCadastrar`).set('Cookie', comumCookie).send({ ligado: true });
    assert.equal(negadoComum.status, 403);
    assert.equal((await g.request(g.app).put(`${BASE}/${u.id}/acessos/tokenCadastrar`).send({ ligado: true })).status, 401);
    assert.deepEqual(await flags(u.id), [false, null, null], 'o bloqueio de Consultar continua');
    assert.equal((await auditoria(u.id)).length, antes.length, 'nenhuma auditoria nasceu das tentativas negadas');
  });

  test('D12 isolamento entre empresas: o MASTER de outra empresa não altera o usuário nem o grupo, e o bloqueio fica intacto', async () => {
    const { grupo, u } = await bloqueadoPorGrupo();
    const antes = await auditoria(u.id);
    assert.equal((await ligar(masterB, u.id, 'tokenCadastrar', true)).status, 404);
    assert.equal((await lista(masterB, u.id)).status, 404);
    assert.equal((await ligarGrupo(masterB, grupo, 'tokenEditar', true)).status, 404);
    assert.deepEqual(await flags(u.id), [false, null, null]);
    assert.deepEqual(await linhaGrupo(grupo), { pode_visualizar: true, pode_criar: null, pode_editar: null });
    assert.equal((await auditoria(u.id)).length, antes.length);
    const deB = await g.usuarioPronto(masterB);
    assert.equal((await ligar(master, deB.id, 'tokenCadastrar', true)).status, 404);
    assert.equal(await linha(deB.id), null);
  });

  test('D14 CONSISTÊNCIA com os módulos homologados: Funcionários e Estoque têm exatamente o mesmo comportamento (o bloqueio da leitura é removido ao ligar a operação dependente)', async () => {
    const casos = [
      ['cadastrarFuncionario', 'employeeHistory', (p) => p.recursos.employeeHistory.criar],
      ['editarFuncionario', 'employeeHistory', (p) => p.recursos.employeeHistory.editar],
      ['cadastrarProduto', 'materials', (p) => p.recursos.materials.criar],
      ['entradaLote', 'materials', (p) => p.acoes.ENTRADA_ESTOQUE],
    ];
    for (const [toggle, recurso, efeito] of casos) {
      const u = await g.usuarioPronto(master);
      await g.pool.query('INSERT INTO usuario_permissoes_recurso (empresa_id, usuario_id, recurso, pode_visualizar, concedido_por) VALUES ($1, $2, $3, false, $4)', [g.empresas.A, u.id, recurso, master.usuarioId]);
      assert.equal((await efetivas(u)).recursos[recurso]?.visualizar ?? false, false, `${toggle}: leitura bloqueada de partida`);
      const r = await ligar(master, u.id, toggle, true);
      assert.equal(r.status, 200, `${toggle} ${JSON.stringify(r.body)}`);
      const p = await efetivas(u);
      assert.equal(p.recursos[recurso].visualizar, true, `${toggle}: a leitura bloqueada foi reaberta pela dependência (igual ao Token)`);
      assert.equal(efeito(p), true, toggle);
      const [l] = await g.todos('SELECT pode_visualizar FROM usuario_permissoes_recurso WHERE usuario_id = $1 AND recurso = $2', [u.id, recurso]);
      assert.equal(l.pode_visualizar, true, `${toggle}: o bloqueio virou concessão individual`);
    }
  });

  test('D13 bloqueio da própria AÇÃO: ligar a ação remove o bloqueio dela (alteração explícita) e isso é auditado; o bloqueio de OUTRA ação não é tocado', async () => {
    const grupo = await novoGrupo();
    await ligarGrupo(master, grupo, 'tokenRevogar', true);
    await ligarGrupo(master, grupo, 'tokenPrevia', true);
    const u = await g.usuarioPronto(master, { grupoAcessoId: grupo });
    await ligar(master, u.id, 'tokenRevogar', false);
    await ligar(master, u.id, 'tokenPrevia', false);
    assert.deepEqual(await bloqueiosAcao(u.id), ['TOKEN_PREVIA_CATALOGO_REAL', 'TOKEN_REVOGAR_DISPOSITIVO']);
    const antes = await auditoria(u.id);
    await ligar(master, u.id, 'tokenRevogar', true);
    assert.deepEqual(await bloqueiosAcao(u.id), ['TOKEN_PREVIA_CATALOGO_REAL'], 'só o bloqueio do Revogar saiu');
    const novos = (await auditoria(u.id)).slice(antes.length);
    assert.ok(novos.some((a) => a.acao === 'USUARIO_ACESSO_ALTERADO' && a.acesso === 'tokenRevogar' && a.ligado === true), `a mudança do acesso é auditada: ${JSON.stringify(novos)}`);
    assert.equal((await rotas(u)).previa, false, 'a Prévia continua bloqueada');
  });
});
