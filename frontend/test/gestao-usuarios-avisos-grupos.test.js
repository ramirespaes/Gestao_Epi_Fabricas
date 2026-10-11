'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { abrirPagina } = require('./helpers/dom-pagina');

/**
 * Gestão de Usuários — complemento RED: aviso FUNCIONARIOS_SEM_VISUALIZAR no modal "Permissões do grupo".
 *
 * Mesmo contrato do aviso individual (código vindo do servidor em `acessos.avisos` e na resposta do PUT; mesmo
 * #avisoDependencias [data-aviso]), com o texto do GRUPO: descreve a configuração do grupo (concede cadastrar/editar e
 * não concede o Histórico) e lembra que o perfil e as exceções individuais continuam valendo — nunca diz que os
 * integrantes perderam o acesso.
 */

const ARQUIVO = 'pages/gestao-usuarios.html';
const AVISO = 'FUNCIONARIOS_SEM_VISUALIZAR';
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
  status: 'ok',
  usuario: { id: 1, nome: 'Pessoa Master', email: 'master@validacao-epi.invalid', perfil: 'MASTER' },
  empresa: { id: 3, nome: 'SafeWork Homologação Ltda', cnpj: '11222333000181' },
  preferencias: { tema: 'claro', modoVisual: 'padrao' },
});
const USUARIOS = [{
  id: 1, nome: 'Pessoa Master', email: 'master@validacao-epi.invalid', perfil: 'MASTER', ativo: true, criadoEm: '2026-10-05T19:17:16.762Z', grupo: null,
  podeGerenciar: true, proprio: true, perfilFixo: true, cpfMascarado: null, matricula: null, setor: null, horarioTrabalho: null, acessoQualquerIp: true,
}];
const G7 = { id: 7, nome: 'Almoxarifado', descricao: null, ativo: true };
const T = (id, rotulo, ligado) => ({ id, rotulo, grupo: 'COLABORADORES', ligado });
const TOGGLES = (historico, cadastrar, editar) => [
  T('historicoFuncionarios', 'Histórico de Funcionários', historico),
  T('cadastrarFuncionario', 'Cadastrar Funcionário', cadastrar),
  T('editarFuncionario', 'Editar Funcionário', editar),
];
const acessosDoGrupo = (toggles, avisos) => ({ status: 200, corpo: { status: 'ok', acessos: { grupo: { id: 7, nome: 'Almoxarifado', ativo: true }, toggles, ...(avisos === undefined ? {} : { avisos }) } } });

async function abrirPermissoesDoGrupo(rotas) {
  const pg = abrirPagina(ARQUIVO, {
    rotas: {
      'GET /auth/me': { status: 200, corpo: contexto() },
      'GET /auth/global/me': { status: 200, corpo: { status: 'ok', empresas: [{ id: 3 }] } },
      'GET /auth/permissoes': { status: 200, corpo: permissoes() },
      'GET /administracao/usuarios': { status: 200, corpo: { status: 'ok', usuarios: USUARIOS, total: 1, pagina: 1, limite: 100, paginas: 1, mastersAtivos: 1, perfisGerenciaveis: ['USUARIO'], perfisCadastraveis: ['USUARIO'] } },
      'GET /grupos-acesso': { status: 200, corpo: { status: 'ok', grupos: [G7] } },
      'GET /grupos-acesso/7': { status: 200, corpo: { status: 'ok', grupo: G7 } },
      ...rotas,
    },
  });
  await pg.esperar();
  await pg.esperar();
  for (const seletor of ['[data-act="grupos"]', '[data-grupo-acao="permissoes"][data-grupo-id="7"]']) {
    const alvo = pg.consulta(seletor)[0];
    assert.ok(alvo, seletor);
    await alvo.disparar('click');
    await pg.esperar();
    await pg.esperar();
  }
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
const textoAviso = (pg) => (pg.consulta('#avisoDependencias').length ? pg.texto('avisoDependencias').replace(/\s+/g, ' ').trim() : '');

describe('Permissões do grupo — aviso de Funcionários sem o Histórico', () => {
  test('AG1 grupo concede editar e não concede o Histórico: aviso sobre a configuração do grupo, sem dizer que os integrantes perderam o acesso', async () => {
    const pg = await abrirPermissoesDoGrupo({ 'GET /grupos-acesso/7/acessos': acessosDoGrupo(TOGGLES(false, false, true), [{ codigo: AVISO }]) });
    assert.deepEqual(avisosNaTela(pg), [AVISO]);
    assert.ok(pg.visivel('avisoDependencias'));
    const t = textoAviso(pg);
    assert.match(t, /grupo/i);
    assert.match(t, /Cadastro de Colaboradores/);
    assert.match(t, /perfil/i, 'lembra que o perfil (e as exceções individuais) continuam valendo');
    assert.equal(/perde|perderam|perdem|sem acesso/i.test(t), false, `não afirma perda de acesso dos integrantes: ${t}`);
  });

  test('AG2 grupo concede criar e não concede o Histórico: o mesmo aviso', async () => {
    const pg = await abrirPermissoesDoGrupo({ 'GET /grupos-acesso/7/acessos': acessosDoGrupo(TOGGLES(false, true, false), [{ codigo: AVISO }]) });
    assert.deepEqual(avisosNaTela(pg), [AVISO]);
  });

  test('AG3 grupo sem inconsistência (sem avisos, ou campo ausente): nada é mostrado', async () => {
    for (const avisos of [[], undefined]) {
      const pg = await abrirPermissoesDoGrupo({ 'GET /grupos-acesso/7/acessos': acessosDoGrupo(TOGGLES(true, true, true), avisos) });
      assert.deepEqual(avisosNaTela(pg), [], String(avisos));
    }
  });

  test('AG4 o aviso acompanha a resposta do PUT: aparece ao desligar o Histórico, some ao religar; editar continua ligado', async () => {
    const pg = await abrirPermissoesDoGrupo({
      'GET /grupos-acesso/7/acessos': acessosDoGrupo(TOGGLES(true, true, true), []),
      'PUT /grupos-acesso/7/acessos/historicoFuncionarios': (c) => ({
        status: 200, corpo: { status: 'ok', acesso: T('historicoFuncionarios', 'Histórico de Funcionários', c.corpo.ligado), avisos: c.corpo.ligado ? [] : [{ codigo: AVISO }] },
      }),
    });
    await alternar(pg, 'historicoFuncionarios', false);
    assert.deepEqual(avisosNaTela(pg), [AVISO]);
    assert.equal(pg.consulta('[data-acesso="editarFuncionario"]')[0].checked, true, 'nada é revogado na tela');
    const put = pg.chamadas.filter((c) => c.metodo === 'PUT');
    assert.deepEqual(put.map((c) => [c.caminho, c.corpo]), [['/grupos-acesso/7/acessos/historicoFuncionarios', { ligado: false }]], 'só o que a pessoa pediu foi salvo');
    await alternar(pg, 'historicoFuncionarios', true);
    assert.deepEqual(avisosNaTela(pg), []);
  });

  test('AG5 o texto do grupo é diferente do texto individual (descreve a configuração do grupo)', async () => {
    const grupo = await abrirPermissoesDoGrupo({ 'GET /grupos-acesso/7/acessos': acessosDoGrupo(TOGGLES(false, false, true), [{ codigo: AVISO }]) });
    const PU = require('../js/permissoes-usuario');
    const textoGrupo = textoAviso(grupo);
    assert.ok(textoGrupo.length > 0);
    assert.ok(PU.TEXTOS.AVISOS && PU.TEXTOS.AVISOS_GRUPO, 'textos do aviso individual e do grupo no módulo');
    assert.notEqual(PU.TEXTOS.AVISOS[AVISO], PU.TEXTOS.AVISOS_GRUPO[AVISO]);
    assert.ok(textoGrupo.includes(PU.TEXTOS.AVISOS_GRUPO[AVISO]));
  });
});
