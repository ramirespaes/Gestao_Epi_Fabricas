'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { montar } = require('./helpers/gestao-usuarios-app');
const provisionamento = require('../../src/services/provisionamento-permissoes.service');

/**
 * Gestão de Usuários — correções pontuais (RED), PostgreSQL real.
 *
 * 1. MASTER: o acesso "Gestão de Usuários" mostra a autoridade EFETIVA. O MASTER ativo administra usuários pela regra da
 *    autoridade administrativa (autoridade-administrativa.js; /auth/permissoes → administracao.usuarios), não por uma
 *    linha de GERENCIAR_USUARIOS no perfil. O toggle passa a vir ligado e fixo para o MASTER ativo, sem nenhuma concessão
 *    gravada (nem no perfil, nem individual) e sem mudar o RBAC; inativo não tem autoridade. Os demais perfis seguem a
 *    regra de hoje (ação GERENCIAR_USUARIOS).
 * 2. Aviso de dependência em Funcionários: quando a configuração resulta em visualizar desligado com criar e/ou editar
 *    ligados, GET .../acessos e PUT .../acessos/:acesso trazem `avisos: [{ codigo: 'FUNCIONARIOS_SEM_VISUALIZAR' }]`
 *    (lista vazia quando não há). Nada é revogado: criar e editar continuam concedidos.
 * Aprovar/Reprovar (decisão da SST) e o Pedido de EPI não mudam.
 */
const BASE = '/api/administracao/usuarios';
const AVISO = 'FUNCIONARIOS_SEM_VISUALIZAR';

describe('Gestão de Usuários — Master efetivo e aviso de Funcionários (PostgreSQL real)', () => {
  let g;
  let master;
  before(async () => {
    g = await montar();
    // O perfil MASTER como em produção: o provisionamento oficial (que NÃO inclui GERENCIAR_USUARIOS).
    await provisionamento.provisionar(g.pool, { empresaId: g.empresas.A, dryRun: false });
    master = await g.contaDaEmpresa(g.empresas.A);
  });
  after(async () => { if (g) await g.encerrar(); });

  const lista = (c, id) => g.request(g.app).get(`${BASE}/${id}/acessos`).set('Cookie', g.cookie(c));
  const ligar = (c, id, toggle, ligado) => g.request(g.app).put(`${BASE}/${id}/acessos/${toggle}`).set('Cookie', g.cookie(c)).send({ ligado });
  const acessos = async (c, id) => {
    const r = await lista(c, id);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.acessos;
  };
  const toggle = (a, id) => a.toggles.find((t) => t.id === id);
  const permissoesDe = async (c) => (await g.request(g.app).get('/api/auth/permissoes').set('Cookie', g.cookie(c))).body;
  const permissoesPorEmail = async (email) => (await g.request(g.app).get('/api/auth/permissoes').set('Cookie', g.deCookies(g.cookiesDe(await g.login(email, g.SENHA_PROVISORIA))))).body;
  const gravadoMaster = () => g.todos("SELECT acao_codigo, permitido FROM permissoes_acao WHERE empresa_id = $1 AND perfil = 'MASTER' AND acao_codigo = 'GERENCIAR_USUARIOS'", [g.empresas.A]);
  const individuais = (usuarioId) => g.todos("SELECT acao_codigo FROM usuario_autorizacoes WHERE usuario_id = $1 AND acao_codigo = 'GERENCIAR_USUARIOS'", [usuarioId]);
  const codigos = (a) => (Array.isArray(a.avisos) ? a.avisos.map((x) => x.codigo) : a.avisos);

  describe('M — MASTER: autoridade efetiva de Gestão de Usuários', () => {
    test('M1 MASTER ativo: "Gestão de Usuários" ligado e fixo; tudo continua somente leitura', async () => {
      const alvo = await g.contaDaEmpresa(g.empresas.A);
      const a = await acessos(master, alvo.usuarioId);
      assert.deepEqual([toggle(a, 'gestaoUsuarios').ligado, toggle(a, 'gestaoUsuarios').fixo], [true, true]);
      assert.deepEqual([a.podeAlterar, a.motivoSomenteLeitura], [false, 'USUARIO_MASTER']);
      assert.ok(a.toggles.every((t) => t.fixo === true));
    });

    test('M2 é a mesma autoridade que /auth/permissoes já devolve ao MASTER (administracao.usuarios), sem concessão gravada', async () => {
      const alvo = await g.contaDaEmpresa(g.empresas.A);
      const p = await permissoesDe(alvo);
      assert.deepEqual(p.administracao.usuarios, { consultar: true, alterar: true }, 'autoridade efetiva do MASTER ativo');
      assert.equal(p.acoes.GERENCIAR_USUARIOS, false, 'a ação do catálogo continua sem concessão ao perfil (RBAC inalterado)');
      assert.equal(toggle(await acessos(master, alvo.usuarioId), 'gestaoUsuarios').ligado, true);
    });

    test('M3 nada é concedido artificialmente: nenhuma linha de GERENCIAR_USUARIOS no perfil MASTER nem individual, antes e depois de ler', async () => {
      const alvo = await g.contaDaEmpresa(g.empresas.A);
      assert.deepEqual(await gravadoMaster(), []);
      await acessos(master, alvo.usuarioId);
      await acessos(alvo, master.usuarioId);
      assert.deepEqual(await gravadoMaster(), [], 'sem linha no perfil');
      assert.deepEqual(await individuais(alvo.usuarioId), [], 'sem autorização individual');
    });

    test('M4 o MASTER continua não configurável: ligar/desligar Gestão de Usuários nele é recusado como hoje', async () => {
      const alvo = await g.contaDaEmpresa(g.empresas.A);
      for (const ligado of [true, false]) {
        const r = await ligar(master, alvo.usuarioId, 'gestaoUsuarios', ligado);
        assert.deepEqual([r.status, r.body.codigo], [409, 'USUARIO_MASTER_PERMISSOES_FIXAS']);
      }
      assert.deepEqual(await gravadoMaster(), []);
    });

    test('M5 MASTER inativo não tem a autoridade: o acesso aparece desligado', async () => {
      const alvo = await g.contaDaEmpresa(g.empresas.A);
      await g.pool.query('UPDATE usuarios SET ativo = false WHERE id = $1', [alvo.usuarioId]);
      const a = await acessos(master, alvo.usuarioId);
      assert.equal(toggle(a, 'gestaoUsuarios').ligado, false);
    });

    test('M6 decisão da SST e Pedido de EPI do MASTER não mudam: Aprovar/Reprovar desligados; request como hoje', async () => {
      const alvo = await g.contaDaEmpresa(g.empresas.A);
      const a = await acessos(master, alvo.usuarioId);
      assert.deepEqual([toggle(a, 'aprovarSolicitacoes').ligado, toggle(a, 'reprovarSolicitacoes').ligado], [false, false]);
      assert.equal(a.toggles.some((t) => /pedido/i.test(t.rotulo)), false, 'nenhum toggle novo de Pedido de EPI');
      const p = await permissoesDe(alvo);
      assert.deepEqual([p.acoes.APROVAR_SOLICITACAO, p.acoes.REPROVAR_SOLICITACAO], [false, false]);
      assert.deepEqual(p.recursos.request, { visualizar: true, criar: true, editar: true, excluir: false });
    });
  });

  describe('P — demais perfis sem alteração', () => {
    test('P1 ADMINISTRADOR sem autorização: desligado; com a autorização individual (pelo toggle): ligado — como hoje', async () => {
      const adm = await g.usuarioPronto(master, { tipoConta: 'ADMINISTRADOR' });
      assert.equal(toggle(await acessos(master, adm.id), 'gestaoUsuarios').ligado, false);
      assert.equal((await ligar(master, adm.id, 'gestaoUsuarios', true)).body.acesso.ligado, true);
      assert.equal(toggle(await acessos(master, adm.id), 'gestaoUsuarios').ligado, true);
      assert.equal((await ligar(master, adm.id, 'gestaoUsuarios', false)).body.acesso.ligado, false);
    });

    test('P2 SUPERVISOR e USUARIO: Gestão de Usuários desligado e editável pelo MASTER', async () => {
      for (const tipoConta of ['SUPERVISOR', 'USUARIO']) {
        const u = await g.usuarioPronto(master, { tipoConta });
        const a = await acessos(master, u.id);
        assert.deepEqual([toggle(a, 'gestaoUsuarios').ligado, toggle(a, 'gestaoUsuarios').fixo, a.podeAlterar], [false, false, true], tipoConta);
      }
    });
  });

  describe('A — aviso: Funcionários com criar/editar e sem visualizar', () => {
    test('A1 sem nada ligado e com visualizar ligado: lista de avisos vazia', async () => {
      const u = await g.usuarioPronto(master);
      assert.deepEqual(codigos(await acessos(master, u.id)), []);
      await ligar(master, u.id, 'editarFuncionario', true); // liga também o visualizar (dependência)
      assert.deepEqual(codigos(await acessos(master, u.id)), []);
    });

    test('A2 desligar o Histórico de Funcionários com editar e criar ligados: aviso no GET e na resposta do PUT; nada é revogado', async () => {
      const u = await g.usuarioPronto(master);
      await ligar(master, u.id, 'cadastrarFuncionario', true);
      await ligar(master, u.id, 'editarFuncionario', true);
      const off = await ligar(master, u.id, 'historicoFuncionarios', false);
      assert.equal(off.status, 200, JSON.stringify(off.body));
      assert.equal(off.body.acesso.ligado, false);
      assert.deepEqual(codigos(off.body), [AVISO], 'a resposta do PUT traz o aviso, para a tela atualizar sem recarregar');
      const a = await acessos(master, u.id);
      assert.deepEqual(codigos(a), [AVISO]);
      assert.deepEqual([toggle(a, 'cadastrarFuncionario').ligado, toggle(a, 'editarFuncionario').ligado], [true, true], 'criar e editar continuam');
      const efetivo = (await permissoesPorEmail(u.email)).recursos.employeeHistory;
      assert.deepEqual([efetivo.visualizar, efetivo.criar, efetivo.editar], [false, true, true], 'as permissões gravadas ficam como estão');
    });

    test('A3 só editar (ou só criar) sem visualizar também avisa; religar o Histórico tira o aviso', async () => {
      for (const operacao of ['editarFuncionario', 'cadastrarFuncionario']) {
        const u = await g.usuarioPronto(master);
        await ligar(master, u.id, operacao, true);
        await ligar(master, u.id, 'historicoFuncionarios', false);
        assert.deepEqual(codigos(await acessos(master, u.id)), [AVISO], operacao);
        const on = await ligar(master, u.id, 'historicoFuncionarios', true);
        assert.deepEqual(codigos(on.body), [], `${operacao}: aviso some ao religar`);
      }
    });

    test('A4 MASTER nunca recebe o aviso', async () => {
      const alvo = await g.contaDaEmpresa(g.empresas.A);
      assert.deepEqual(codigos(await acessos(master, alvo.usuarioId)), []);
    });
  });
});
