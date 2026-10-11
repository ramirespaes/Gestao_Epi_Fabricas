'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { abrirPagina, ler, semComentarios } = require('./helpers/dom-pagina');

/**
 * Histórico de Funcionários — pacote J (RED): "Exportar Histórico de Funcionários" na tela Configurar permissões.
 *
 * O toggle vem do servidor como os demais (a tela não tem lista própria). O que muda na tela é só o AVISO
 * EXPORTAR_HISTORICO_SEM_VISUALIZAR (código do servidor em `acessos.avisos` e na resposta do PUT): ligado não é o mesmo
 * que autorizado — a exportação exige as duas permissões. Texto próprio para o usuário e para o grupo, como o aviso de
 * Funcionários. Nenhuma exportação, botão de download ou arquivo neste pacote (o Histórico continua sem exportar).
 */

const ARQUIVO = 'pages/gestao-usuarios.html';
const AVISO = 'EXPORTAR_HISTORICO_SEM_VISUALIZAR';
const TOGGLE = 'exportarHistoricoFuncionarios';
const NENHUMA = { visualizar: false, criar: false, editar: false, excluir: false };
const area = (v) => ({ consultar: v, alterar: v });
const permissoes = () => ({
  status: 'ok', empresaId: 3, usuarioId: 1, perfil: 'MASTER', recursos: { dashboard: { ...NENHUMA, visualizar: true } }, acoes: {},
  administracao: {
    gruposAcesso: area(true), permissoesGrupo: area(true), vinculosGrupo: area(true), usuarios: area(true),
    autorizacoesIndividuais: { consultar: false, concederDireta: false, delegar: false }, vinculosSst: area(false),
  },
});
const contexto = () => ({
  status: 'ok', usuario: { id: 1, nome: 'Pessoa Master', email: 'master@validacao-epi.invalid', perfil: 'MASTER' },
  empresa: { id: 3, nome: 'SafeWork Homologação Ltda', cnpj: '11222333000181' }, preferencias: { tema: 'claro', modoVisual: 'padrao' },
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
const T = (id, rotulo, ligado, fixo = false) => ({ id, rotulo, grupo: 'COLABORADORES', ligado, fixo });
const TOGGLES = (historico, exportar) => [
  T('historicoFuncionarios', 'Histórico de Funcionários', historico),
  T('cadastrarFuncionario', 'Cadastrar Funcionário', false),
  T(TOGGLE, 'Exportar Histórico de Funcionários', exportar),
];
const acessosDoUsuario = (toggles, avisos) => ({
  status: 200,
  corpo: { status: 'ok', acessos: { usuario: { id: 4, nome: 'Bruno Almoxarife', perfil: 'USUARIO', ativo: true }, podeAlterar: true, motivoSomenteLeitura: null, toggles, pendencias: [], ...(avisos === undefined ? {} : { avisos }) } },
});
const G7 = { id: 7, nome: 'Almoxarifado', descricao: null, ativo: true };
const acessosDoGrupo = (toggles, avisos) => ({ status: 200, corpo: { status: 'ok', acessos: { grupo: { id: 7, nome: 'Almoxarifado', ativo: true }, toggles, ...(avisos === undefined ? {} : { avisos }) } } });

async function abrirPagina0(rotas) {
  const pg = abrirPagina(ARQUIVO, {
    rotas: {
      'GET /auth/me': { status: 200, corpo: contexto() },
      'GET /auth/global/me': { status: 200, corpo: { status: 'ok', empresas: [{ id: 3 }] } },
      'GET /auth/permissoes': { status: 200, corpo: permissoes() },
      'GET /administracao/usuarios': listagem(),
      'GET /grupos-acesso': { status: 200, corpo: { status: 'ok', grupos: [G7] } },
      'GET /grupos-acesso/7': { status: 200, corpo: { status: 'ok', grupo: G7 } },
      ...rotas,
    },
  });
  await pg.esperar();
  await pg.esperar();
  return pg;
}
async function clicarEmSequencia(pg, seletores) {
  for (const seletor of seletores) {
    const alvo = pg.consulta(seletor)[0];
    assert.ok(alvo, seletor);
    await alvo.disparar('click');
    await pg.esperar();
    await pg.esperar();
  }
}
async function permissoesDoUsuario(rotas) {
  const pg = await abrirPagina0(rotas);
  await clicarEmSequencia(pg, ['.kebab[data-menu="4"]', '#actionMenuInner [data-acao="permissoes"]']);
  return pg;
}
async function permissoesDoGrupo(rotas) {
  const pg = await abrirPagina0(rotas);
  await clicarEmSequencia(pg, ['[data-act="grupos"]', '[data-grupo-acao="permissoes"][data-grupo-id="7"]']);
  assert.ok(pg.texto('modal').includes('Permissões do grupo Almoxarifado'), 'o modal do grupo abriu');
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
const avisosNaTela = (pg) => pg.consulta('#avisoDependencias [data-aviso]').map((e) => e.getAttribute('data-aviso'));
const textoAviso = (pg) => (pg.consulta(`#avisoDependencias [data-aviso="${AVISO}"]`).length
  ? pg.consulta(`#avisoDependencias [data-aviso="${AVISO}"]`)[0].textContent.replace(/\s+/g, ' ').trim() : '');

describe('JF1 — toggle e aviso no usuário', () => {
  test('JF1.1 o toggle vem do servidor e aparece em Colaboradores, com o rótulo exato', async () => {
    const pg = await permissoesDoUsuario({ 'GET /administracao/usuarios/4/acessos': acessosDoUsuario(TOGGLES(true, false), []) });
    const el = pg.consulta(`[data-acesso="${TOGGLE}"]`)[0];
    assert.ok(el, 'interruptor do acesso');
    assert.equal(el.checked, false);
    assert.match(pg.texto('modal'), /Exportar Histórico de Funcionários/);
  });

  test('JF1.2 aviso do servidor: explica que exportar está ligado mas a exportação exige também o Histórico de Funcionários', async () => {
    const pg = await permissoesDoUsuario({ 'GET /administracao/usuarios/4/acessos': acessosDoUsuario(TOGGLES(false, true), [{ codigo: AVISO }]) });
    assert.deepEqual(avisosNaTela(pg), [AVISO]);
    assert.ok(pg.visivel('avisoDependencias'));
    const t = textoAviso(pg);
    assert.match(t, /Exportar Histórico de Funcionários/);
    assert.match(t, /Histórico de Funcionários.*desligad/i);
    assert.match(t, /duas permiss/i);
  });

  test('JF1.3 o aviso acompanha o PUT: aparece ao ligar exportar sem o Histórico e some ao ligar o Histórico', async () => {
    let historico = false;
    const pg = await permissoesDoUsuario({
      'GET /administracao/usuarios/4/acessos': acessosDoUsuario(TOGGLES(false, false), []),
      [`PUT /administracao/usuarios/4/acessos/${TOGGLE}`]: (c) => ({ status: 200, corpo: { status: 'ok', acesso: T(TOGGLE, 'Exportar Histórico de Funcionários', c.corpo.ligado), avisos: c.corpo.ligado && !historico ? [{ codigo: AVISO }] : [] } }),
      'PUT /administracao/usuarios/4/acessos/historicoFuncionarios': (c) => { historico = c.corpo.ligado; return { status: 200, corpo: { status: 'ok', acesso: T('historicoFuncionarios', 'Histórico de Funcionários', c.corpo.ligado), avisos: [] } }; },
    });
    await alternar(pg, TOGGLE, true);
    assert.deepEqual(avisosNaTela(pg), [AVISO]);
    assert.match(textoAviso(pg), /duas permiss/i);
    await alternar(pg, 'historicoFuncionarios', true);
    assert.deepEqual(avisosNaTela(pg), []);
    assert.equal(pg.consulta(`[data-acesso="${TOGGLE}"]`)[0].checked, true, 'exportar continua ligado');
  });
});

describe('JF2 — aviso no grupo', () => {
  test('JF2.1 grupo concede exportar e não o Histórico: texto próprio do grupo (configuração), diferente do individual', async () => {
    const pg = await permissoesDoGrupo({ 'GET /grupos-acesso/7/acessos': acessosDoGrupo(TOGGLES(false, true), [{ codigo: AVISO }]) });
    assert.deepEqual(avisosNaTela(pg), [AVISO]);
    const t = textoAviso(pg);
    assert.match(t, /grupo/i);
    assert.match(t, /Exportar Histórico de Funcionários/);
    assert.match(t, /duas permiss/i);
    assert.equal(/perde|perderam|perdem/i.test(t), false, 'não afirma perda de acesso');
    const individual = await permissoesDoUsuario({ 'GET /administracao/usuarios/4/acessos': acessosDoUsuario(TOGGLES(false, true), [{ codigo: AVISO }]) });
    assert.notEqual(textoAviso(individual), t);
  });
});

describe('JF3 — limites do pacote J', () => {
  test('JF3.1 o módulo continua sem conhecer toggles, ações ou recursos: só traduz o código do aviso', () => {
    const fonte = semComentarios(ler('js/permissoes-usuario.js'));
    assert.match(fonte, /EXPORTAR_HISTORICO_SEM_VISUALIZAR/);
    for (const proibido of [TOGGLE, 'EXPORTAR_HISTORICO_FUNCIONARIOS', 'employeeHistory', 'historicoFuncionarios', "perfil === 'MASTER'"]) {
      assert.equal(fonte.includes(proibido), false, `${proibido} não pode estar no módulo`);
    }
  });

  // Pacote I: com as duas permissões a exportação existe, mas só depois de escolher um colaborador (ver historico-funcionarios-exportacao.test.js).
  test('JF3.2 com as duas permissões e sem colaborador escolhido, Exportar segue oculto e desabilitado e nada é pedido sozinho', async () => {
    const pg = abrirPagina('pages/employee-history.html', {
      rotas: {
        'GET /auth/me': { status: 200, corpo: { ...contexto(), usuario: { id: 7, nome: 'Pessoa', email: 'p@validacao-epi.invalid', perfil: 'USUARIO' } } },
        'GET /auth/global/me': { status: 200, corpo: { status: 'ok', empresas: [{ id: 3 }] } },
        'GET /auth/permissoes': { status: 200, corpo: { ...permissoes(), perfil: 'USUARIO', recursos: { employeeHistory: { ...NENHUMA, visualizar: true } }, acoes: { EXPORTAR_HISTORICO_FUNCIONARIOS: true } } },
      },
    });
    await pg.esperar();
    await pg.esperar();
    const botao = pg.el('botaoExportarHistorico');
    assert.equal(botao.disabled, true);
    assert.equal(pg.visivel('botaoExportarHistorico'), false);
    assert.deepEqual(pg.chamadas.filter((c) => /export|download|arquivo/i.test(c.url)).map((c) => c.url), []);
  });
});
