'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { abrirPagina, ler, semComentarios } = require('./helpers/dom-pagina');

/**
 * Gestão de Usuários — correções pontuais (RED), tela "Configurar permissões".
 *
 * 1. O aviso de dependência vem do SERVIDOR como código (`acessos.avisos` no GET e `avisos` na resposta do PUT); a tela só
 *    traduz o código num texto e não conhece recurso, ação, operação nem perfil (mesma regra do módulo). Contrato de tela:
 *    #avisoDependencias com um item [data-aviso="<código>"] por aviso conhecido; código desconhecido não aparece.
 *    FUNCIONARIOS_SEM_VISUALIZAR → explica que o Cadastro de Colaboradores pode ficar inacessível pelo menu, embora as
 *    autorizações de cadastrar/editar continuem concedidas.
 * 2. MASTER: "Gestão de Usuários" ligado e travado quando o servidor diz ligado e fixo (a tela só mostra o que recebe).
 */

const ARQUIVO = 'pages/gestao-usuarios.html';
const AVISO = 'FUNCIONARIOS_SEM_VISUALIZAR';
const NENHUMA = { visualizar: false, criar: false, editar: false, excluir: false };
const area = (v) => ({ consultar: v, alterar: v });
const permissoes = () => ({
  status: 'ok', empresaId: 3, usuarioId: 1, perfil: 'MASTER', recursos: { dashboard: { ...NENHUMA, visualizar: true } }, acoes: {},
  administracao: {
    gruposAcesso: area(false), permissoesGrupo: area(false), vinculosGrupo: area(false), usuarios: area(true),
    autorizacoesIndividuais: { consultar: false, concederDireta: false, delegar: false }, vinculosSst: area(false),
  },
});
const contexto = () => ({
  status: 'ok',
  usuario: { id: 1, nome: 'Pessoa Master', email: 'master@validacao-epi.invalid', perfil: 'MASTER' },
  empresa: { id: 3, nome: 'SafeWork Homologação Ltda', cnpj: '11222333000181' },
  preferencias: { tema: 'claro', modoVisual: 'padrao' },
});
const usuario = (extra = {}) => ({
  id: 4, nome: 'Bruno Almoxarife', email: 'bruno@validacao-epi.invalid', perfil: 'USUARIO', ativo: true, criadoEm: '2026-10-05T19:17:16.762Z',
  grupo: null, podeGerenciar: true, proprio: false, cpfMascarado: null, matricula: null, setor: null, horarioTrabalho: null, acessoQualquerIp: true, ...extra,
});
const USUARIOS = [usuario({ id: 1, nome: 'Pessoa Master', perfil: 'MASTER', proprio: true, perfilFixo: true }), usuario()];
const listagem = () => ({
  status: 200,
  corpo: { status: 'ok', usuarios: USUARIOS, total: USUARIOS.length, pagina: 1, limite: 100, paginas: 1, mastersAtivos: 1, perfisGerenciaveis: ['USUARIO'], perfisCadastraveis: ['USUARIO'] },
});
const T = (id, rotulo, grupo, ligado, fixo = false) => ({ id, rotulo, grupo, ligado, fixo });
const TOGGLES = (historico, cadastrar, editar) => [
  T('historicoFuncionarios', 'Histórico de Funcionários', 'COLABORADORES', historico),
  T('cadastrarFuncionario', 'Cadastrar Funcionário', 'COLABORADORES', cadastrar),
  T('editarFuncionario', 'Editar Funcionário', 'COLABORADORES', editar),
  T('gestaoUsuarios', 'Gestão de Usuários', 'ADMINISTRACAO', false),
];
const acessosDe = ({ toggles, avisos, ...extra }) => ({
  status: 200,
  corpo: { status: 'ok', acessos: { usuario: { id: 4, nome: 'Bruno Almoxarife', perfil: 'USUARIO', ativo: true }, podeAlterar: true, motivoSomenteLeitura: null, toggles, pendencias: [], ...(avisos === undefined ? {} : { avisos }), ...extra } },
});

async function abrirPermissoes(rotas) {
  const pg = abrirPagina(ARQUIVO, {
    rotas: {
      'GET /auth/me': { status: 200, corpo: contexto() },
      'GET /auth/global/me': { status: 200, corpo: { status: 'ok', empresas: [{ id: 3 }] } },
      'GET /auth/permissoes': { status: 200, corpo: permissoes() },
      'GET /administracao/usuarios': listagem(),
      ...rotas,
    },
  });
  await pg.esperar();
  await pg.esperar();
  for (const seletor of ['.kebab[data-menu="4"]', '#actionMenuInner [data-acao="permissoes"]']) {
    const alvo = pg.consulta(seletor)[0];
    assert.ok(alvo, seletor);
    await alvo.disparar('click');
    await pg.esperar();
  }
  await pg.esperar();
  await pg.esperar();
  return pg;
}
const alternar = async (pg, acesso, ligado) => {
  const el = pg.consulta(`[data-acesso="${acesso}"]`)[0];
  assert.ok(el, acesso);
  el.checked = ligado;
  await el.disparar('change');
  await pg.esperar();
  await pg.esperar();
};
const textoAviso = (pg) => (pg.consulta('#avisoDependencias').length ? pg.texto('avisoDependencias').replace(/\s+/g, ' ').trim() : '');
const avisosNaTela = (pg) => pg.consulta('#avisoDependencias [data-aviso]').map((e) => e.getAttribute('data-aviso'));

describe('Configurar permissões — aviso de Funcionários sem visualizar', () => {
  test('AV1 o servidor manda o aviso: a tela explica que o Cadastro de Colaboradores pode ficar inacessível pelo menu, com cadastrar/editar ainda concedidos', async () => {
    const pg = await abrirPermissoes({ 'GET /administracao/usuarios/4/acessos': acessosDe({ toggles: TOGGLES(false, true, true), avisos: [{ codigo: AVISO }] }) });
    assert.deepEqual(avisosNaTela(pg), [AVISO]);
    assert.ok(pg.visivel('avisoDependencias'));
    const t = textoAviso(pg);
    assert.match(t, /Cadastro de Colaboradores/);
    assert.match(t, /inacess[ií]vel pelo menu/i);
    assert.match(t, /continua[m]? concedid/i);
  });

  test('AV2 sem avisos (lista vazia ou campo ausente): nada é mostrado', async () => {
    for (const avisos of [[], undefined]) {
      const pg = await abrirPermissoes({ 'GET /administracao/usuarios/4/acessos': acessosDe({ toggles: TOGGLES(true, true, true), avisos }) });
      assert.deepEqual(avisosNaTela(pg), [], String(avisos));
      assert.equal(/inacess/i.test(pg.textoDoDom()), false);
    }
  });

  test('AV3 depois de alternar, o aviso acompanha a resposta do PUT: aparece ao desligar o Histórico e some ao religar', async () => {
    const pg = await abrirPermissoes({
      'GET /administracao/usuarios/4/acessos': acessosDe({ toggles: TOGGLES(true, true, true), avisos: [] }),
      'PUT /administracao/usuarios/4/acessos/historicoFuncionarios': (c) => ({
        status: 200,
        corpo: { status: 'ok', acesso: T('historicoFuncionarios', 'Histórico de Funcionários', 'COLABORADORES', c.corpo.ligado), avisos: c.corpo.ligado ? [] : [{ codigo: AVISO }] },
      }),
    });
    assert.deepEqual(avisosNaTela(pg), []);
    await alternar(pg, 'historicoFuncionarios', false);
    assert.deepEqual(avisosNaTela(pg), [AVISO], 'aviso depois de desligar');
    assert.equal(pg.consulta('[data-acesso="editarFuncionario"]')[0].checked, true, 'editar continua ligado na tela');
    await alternar(pg, 'historicoFuncionarios', true);
    assert.deepEqual(avisosNaTela(pg), [], 'aviso some ao religar');
  });

  test('AV4 código desconhecido não aparece (nem o código cru)', async () => {
    const pg = await abrirPermissoes({ 'GET /administracao/usuarios/4/acessos': acessosDe({ toggles: TOGGLES(true, true, true), avisos: [{ codigo: 'OUTRO_AVISO' }] }) });
    assert.deepEqual(avisosNaTela(pg), []);
    assert.equal(pg.textoDoDom().includes('OUTRO_AVISO'), false);
  });

  test('AV5 o módulo continua sem conhecer recursos, toggles ou perfis (o aviso é só um código do servidor)', () => {
    const fonte = semComentarios(ler('js/permissoes-usuario.js'));
    assert.match(fonte, /FUNCIONARIOS_SEM_VISUALIZAR/, 'o texto do aviso é escolhido pelo código');
    for (const proibido of ['employeeHistory', 'historicoFuncionarios', 'cadastrarFuncionario', 'editarFuncionario', 'GERENCIAR_USUARIOS', "perfil === 'MASTER'"]) {
      assert.equal(fonte.includes(proibido), false, `${proibido} não pode estar no módulo`);
    }
  });
});

describe('Configurar permissões — MASTER', () => {
  test('MS1 o servidor diz Gestão de Usuários ligado e fixo: interruptor marcado e travado, com o aviso de somente leitura', async () => {
    const toggles = TOGGLES(true, true, true).map((t) => ({ ...t, ligado: true, fixo: true }));
    const pg = await abrirPermissoes({ 'GET /administracao/usuarios/4/acessos': acessosDe({ toggles, avisos: [], podeAlterar: false, motivoSomenteLeitura: 'USUARIO_MASTER', usuario: { id: 4, nome: 'Outro Master', perfil: 'MASTER', ativo: true } }) });
    const el = pg.consulta('[data-acesso="gestaoUsuarios"]')[0];
    assert.ok(el);
    assert.deepEqual([el.checked, el.getAttribute('disabled') !== null], [true, true]);
  });
});
