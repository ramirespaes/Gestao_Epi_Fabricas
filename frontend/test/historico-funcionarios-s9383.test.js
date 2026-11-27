'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { abrirPagina } = require('./helpers/dom-pagina');
const { FALHA, rejeitar, rejeicoesEscapadas } = require('./helpers/rejeicoes');

/**
 * Sonar S9383 (lote 04) — Histórico de Funcionários: cargas iniciadas sem espera (seleção, seções de eventos, EPIs, busca pelo Enter).
 * Uma rejeição inesperada não escapa: vira a falha conhecida da área ("Tentar novamente" nas seções) ou o aviso da página.
 * Fixtures sintéticas.
 */

const ARQUIVO = 'pages/employee-history.html';
const NENHUMA = { visualizar: false, criar: false, editar: false, excluir: false };
const area = (v) => ({ consultar: v, alterar: v });
const permissoes = () => ({
  status: 'ok', empresaId: 3, usuarioId: 7, perfil: 'USUARIO',
  recursos: { employeeHistory: { ...NENHUMA, visualizar: true }, epiFicha: { ...NENHUMA, visualizar: true } }, acoes: {},
  administracao: {
    gruposAcesso: area(false), permissoesGrupo: area(false), vinculosGrupo: area(false), usuarios: area(false),
    autorizacoesIndividuais: { consultar: false, concederDireta: false, delegar: false }, vinculosSst: area(false),
  },
});
const contexto = () => ({
  status: 'ok',
  usuario: { id: 7, nome: 'Pessoa Teste', email: 'pessoa@validacao-epi.invalid', perfil: 'USUARIO' },
  empresa: { id: 3, nome: 'SafeWork Homologação Ltda', cnpj: '11222333000181' },
  preferencias: { tema: 'claro', modoVisual: 'padrao' },
});
const funcionario = (id) => ({
  id, empresaId: 3, nome: `Pessoa ${id}`, matricula: `M-${id}`, cpfMascarado: '***.***.***-25', setor: `Setor ${id}`, funcao: `Função ${id}`,
  situacao: 'ATIVO', ativo: true, grupoHomogeneoId: 10, grupoHomogeneo: { id: 10, codigo: 'GHE-010', descricao: 'Caldeiraria' },
});
const okLista = (itens) => ({ status: 200, corpo: { status: 'ok', funcionarios: itens, total: itens.length, pagina: 1, limite: 20 } });
const semEventos = (id) => ({ status: 200, corpo: { status: 'ok', funcionarioId: id, tipo: 'GHE', eventos: [], total: 0, pagina: 1, limite: 20 } });

async function abrir() {
  const rotas = {
    'GET /auth/me': { status: 200, corpo: contexto() },
    'GET /auth/global/me': { status: 200, corpo: { status: 'ok', empresas: [{ id: 3 }] } },
    'GET /auth/permissoes': { status: 200, corpo: permissoes() },
    'GET /funcionarios': okLista([funcionario(11), funcionario(12)]),
    'GET /fichas-epi': { status: 200, corpo: { status: 'ok', fichas: [], total: 0, pagina: 1, limite: 1 } },
  };
  for (const id of [11, 12]) {
    rotas[`GET /funcionarios/${id}`] = { status: 200, corpo: { status: 'ok', funcionario: funcionario(id) } };
    rotas[`GET /funcionarios/${id}/eventos`] = semEventos(id);
  }
  const pg = abrirPagina(ARQUIVO, { rotas });
  await pg.esperar();
  await pg.esperar();
  return pg;
}

const H = (pg) => pg.janela.EpiHistoricoFuncionarios;
const limpo = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
async function buscar(pg) {
  pg.el('historySearchValue').value = 'Pessoa';
  await pg.el('botaoConsultar').disparar('click');
  for (let i = 0; i < 5; i += 1) await pg.esperar();
}
const selecionar = (pg, id) => pg.consulta(`#historyResultados [data-id="${id}"]`)[0].disparar('click');

describe('S9383 (lote 04) — Histórico de Funcionários', () => {
  test('S9383-H01 — selecionar: rejeição da consulta vira o aviso da página e nada escapa', async () => {
    const pg = await abrir();
    await buscar(pg);
    H(pg).acoes.detalhar = rejeitar;
    const escapadas = await rejeicoesEscapadas(pg, () => selecionar(pg, 11));
    assert.deepEqual(escapadas, []);
    assert.match(limpo(pg.el('aviso').textContent), new RegExp(H(pg).TEXTOS.RESPOSTA_INVALIDA));
    assert.equal(pg.textoDoDom().includes(FALHA), false);
  });

  test('S9383-H02 — seções de eventos e EPIs: rejeição vira a falha conhecida de cada área, com "Tentar novamente"', async () => {
    const pg = await abrir();
    await buscar(pg);
    H(pg).acoes.eventos = rejeitar;
    H(pg).acoes.fichaDoFuncionario = rejeitar;
    const escapadas = await rejeicoesEscapadas(pg, () => selecionar(pg, 11));
    assert.deepEqual(escapadas, []);
    assert.match(limpo(pg.el('historyGheTimeline').textContent), new RegExp(H(pg).TEXTOS.GHE_FALHA));
    assert.equal(pg.consulta('#historyGheTentar').length, 1);
    assert.match(limpo(pg.el('historyTimeline').textContent), new RegExp(H(pg).TEXTOS.EPIS_FALHA));
    assert.equal(pg.consulta('#historyEpisTentar').length, 1);
  });

  test('S9383-H03 — busca pelo Enter: rejeição vira o aviso da página', async () => {
    const pg = await abrir();
    pg.janela.EpiFuncionarios.acoes.listar = rejeitar;
    pg.el('historySearchValue').value = 'Pessoa';
    const escapadas = await rejeicoesEscapadas(pg, () => pg.el('historySearchValue').disparar('keydown', { key: 'Enter' }));
    assert.deepEqual(escapadas, []);
    assert.match(limpo(pg.el('aviso').textContent), new RegExp(H(pg).TEXTOS.RESPOSTA_INVALIDA));
  });

  test('S9383-H04 — falha de uma carga já obsoleta não pinta a área do funcionário atual', async () => {
    const pg = await abrir();
    await buscar(pg);
    const pendentes = [];
    const rejeitarDepois = () => pendentes.forEach((rej) => rej(new Error(FALHA)));
    H(pg).acoes.eventos = () => new Promise((_, rej) => { pendentes.push(rej); });
    await selecionar(pg, 11);
    await pg.esperar();
    H(pg).acoes.eventos = () => Promise.resolve({ ok: true, status: 200, dados: { funcionarioId: 12, tipo: 'GHE', eventos: [], total: 0, pagina: 1, limite: 20 } });
    await selecionar(pg, 12);
    await pg.esperar();
    const escapadas = await rejeicoesEscapadas(pg, async () => { rejeitarDepois(); });
    assert.deepEqual(escapadas, []);
    assert.doesNotMatch(limpo(pg.el('historyGheTimeline').textContent), new RegExp(H(pg).TEXTOS.GHE_FALHA));
  });
});
