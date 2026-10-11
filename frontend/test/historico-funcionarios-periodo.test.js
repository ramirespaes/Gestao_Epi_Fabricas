'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { abrirPagina, ler, semComentariosHtml } = require('./helpers/dom-pagina');

/**
 * Histórico de Funcionários — pacote H (RED): FILTRO POR PERÍODO dos quatro históricos (entregas de EPI, GHE, situação e
 * alterações cadastrais).
 *
 * Contrato da tela proposto por este RED:
 *   - cartão próprio, entre os indicadores e a linha do tempo de EPIs, oculto até o colaborador ser identificado;
 *   - #historyPeriodoInicial e #historyPeriodoFinal (input type="date", rótulos "Data inicial" e "Data final"),
 *     #botaoAplicarPeriodo ("Aplicar filtro") e #botaoTodoHistorico ("Todo o histórico");
 *   - #historyPeriodoEstado: "Todo o histórico" ou o período aplicado em dd/mm/aaaa ("01/01/2026 a 31/01/2026");
 *   - #historyPeriodoErro: a recusa local (nenhuma requisição): falta uma das datas, data inválida, final antes da inicial.
 * Período aplicado: as quatro seções voltam à página 1 com `de` e `ate` (YYYY-MM-DD, o mesmo texto do campo, sem fuso)
 * — os nomes que o backend já usa em GET /fichas-epi/:id/entregas. A ficha cadastral e a ficha de EPI (resumo = os
 * quatro indicadores, sempre do histórico completo) não são relidas; GET /fichas-epi nunca leva período.
 * "Todo o histórico" volta às consultas sem período. O período continua ao trocar de colaborador; Limpar o desfaz.
 */

const ARQUIVO = 'pages/employee-history.html';
const NENHUMA = { visualizar: false, criar: false, editar: false, excluir: false };
const area = (v) => ({ consultar: v, alterar: v });
const permissoes = (epis) => ({
  status: 'ok', empresaId: 3, usuarioId: 7, perfil: 'USUARIO',
  recursos: { employeeHistory: { ...NENHUMA, visualizar: true }, epiFicha: { ...NENHUMA, visualizar: epis } }, acoes: {},
  administracao: {
    gruposAcesso: area(false), permissoesGrupo: area(false), vinculosGrupo: area(false), usuarios: area(false),
    autorizacoesIndividuais: { consultar: false, concederDireta: false, delegar: false }, vinculosSst: area(false),
  },
});
const contexto = () => ({
  status: 'ok', usuario: { id: 7, nome: 'Pessoa Teste', email: 'pessoa@validacao-epi.invalid', perfil: 'USUARIO' },
  empresa: { id: 3, nome: 'SafeWork Homologação Ltda', cnpj: '11222333000181' }, preferencias: { tema: 'claro', modoVisual: 'padrao' },
});
const funcionario = (id) => ({
  id, empresaId: 3, nome: `Pessoa ${id}`, matricula: `M-${id}`, cpfMascarado: '***.***.***-25', setor: `Setor ${id}`, funcao: `Função ${id}`,
  situacao: 'ATIVO', ativo: true, grupoHomogeneoId: 10, grupoHomogeneo: { id: 10, codigo: 'GHE-010', descricao: 'Caldeiraria' },
});
const okLista = (itens) => ({ status: 200, corpo: { status: 'ok', funcionarios: itens, total: itens.length, pagina: 1, limite: 20 } });
const erro = (status, codigo) => ({ status, corpo: { status: 'error', codigo, message: 'x' } });
const resumoFicha = { totalEntregas: 7, totalItens: 9, ultimaEntregaEm: '2026-03-11T01:30:00.000Z', episDistintos: 4, episDentroPrazoUso: 2 };
const INDICADORES_ESPERADOS = ['7', '4', '10/03/2026', '2'];
const okFichas = (id) => ({ status: 200, corpo: { status: 'ok', fichas: [{ id: 500 + id, numero: 1, funcionarioId: id, criadaEm: '2026-01-02T12:00:00.000Z', funcionarioAtual: { id }, resumo: resumoFicha }], total: 1, pagina: 1, limite: 1 } });
const entrega = (id, funcionarioId) => ({
  id, ficha: { id: 500 + funcionarioId, numero: 1, funcionarioId }, origem: 'DIRETA', entregueEm: '2026-01-10T13:30:00.000Z', dataOperacional: '2026-01-10',
  trabalhador: { nome: `Pessoa ${funcionarioId}`, matricula: `M-${funcionarioId}`, funcao: 'F', setor: 'S' }, ghe: null, responsavel: { id: 7, nome: 'Responsável' },
  itens: [{ id: id * 10, materialId: 40, loteId: 70, quantidade: 1, motivo: 'ADMISSAO', justificativa: null, previstoNoGhe: true, justificativaForaGhe: null,
    material: { nome: 'Luva Nitrílica', tipo: 'Luva', codigoInterno: 'LUV-001', unidade: 'PAR', prazoUsoDias: 30, oculosComGrau: false, exigeCa: true },
    lote: { tamanho: 'M', caNumero: '45678', caValidade: '2028-01-31' }, operacaoId: 800 }],
  confirmacao: null,
});
const okEntregas = (funcionarioId, entregas, { total = entregas.length, pagina = 1 } = {}) => ({
  status: 200, corpo: { status: 'ok', ficha: { id: 500 + funcionarioId, numero: 1, funcionarioId }, entregas, total, pagina, limite: 20 },
});
const okEventos = (funcionarioId, tipo, eventos, { total = eventos.length, pagina = 1 } = {}) => ({
  status: 200, corpo: { status: 'ok', funcionarioId, tipo, eventos, total, pagina, limite: 20 },
});
const evento = (tipo, id) => {
  const base = { id: String(id), tipo: 'ALTERACAO', ocorridoEm: '2026-01-10T13:00:00.000Z', responsavel: { id: 7, nome: 'Responsável' } };
  if (tipo === 'GHE') return { ...base, anterior: null, novo: { id: 10, codigo: 'GHE-010', descricao: 'Caldeiraria' } };
  if (tipo === 'SITUACAO') return { ...base, anterior: 'ATIVO', novo: 'AFASTADO' };
  return { ...base, alteracoes: [{ campo: 'setor', anterior: 'A', novo: 'B' }] };
};
const comPeriodo = (q) => q.has('de') || q.has('ate');
const SECOES = { GHE: 'historyGheTimeline', SITUACAO: 'historySituacaoTimeline', CADASTRAL: 'historyCadastralTimeline' };

/**
 * Por padrão, cada histórico devolve um registro "T" (sem período) ou "P" (com período): ids `<tipo>-T-<func>` e
 * `<tipo>-P-<func>`; entregas 100+func (todo) e 200+func (período). `eventos(func, tipo, q, c)` e `entregas(func, q, c)`
 * podem devolver outra resposta (ou uma Promise dela); undefined = padrão.
 */
function rotas({ lista = [funcionario(11), funcionario(12)], eventos = () => undefined, entregas = () => undefined, epis = true, extra = {} } = {}) {
  const r = {
    'GET /auth/me': { status: 200, corpo: contexto() },
    'GET /auth/global/me': { status: 200, corpo: { status: 'ok', empresas: [{ id: 3 }] } },
    'GET /auth/permissoes': { status: 200, corpo: permissoes(epis) },
    'GET /funcionarios': okLista(lista),
    'POST /funcionarios/consulta-cpf': okLista([funcionario(11)]),
    'GET /fichas-epi': (c) => okFichas(Number(new URL(c.url).searchParams.get('funcionarioId'))),
  };
  for (const id of [11, 12]) {
    r[`GET /funcionarios/${id}`] = { status: 200, corpo: { status: 'ok', funcionario: funcionario(id) } };
    r[`GET /fichas-epi/${500 + id}/entregas`] = (c) => {
      const q = new URL(c.url).searchParams;
      const proprio = entregas(id, q, c);
      if (proprio !== undefined) return proprio;
      return okEntregas(id, [entrega((comPeriodo(q) ? 200 : 100) + id, id)]);
    };
    r[`GET /funcionarios/${id}/eventos`] = (c) => {
      const q = new URL(c.url).searchParams;
      const tipo = q.get('tipo');
      const proprio = eventos(id, tipo, q, c);
      if (proprio !== undefined) return proprio;
      return okEventos(id, tipo, [evento(tipo, `${tipo}-${comPeriodo(q) ? 'P' : 'T'}-${id}`)]);
    };
  }
  return { ...r, ...extra };
}

const limpo = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const existe = (pg, id) => pg.consulta(`#${id}`).length > 0;
const visivel = (pg, id) => existe(pg, id) && pg.visivel(id);
const usavel = (pg, id) => visivel(pg, id) && !pg.el(id).disabled;
const textoDe = (pg, id) => (existe(pg, id) ? limpo(pg.el(id).textContent) : '');
const SUJEIRA = /\bnull\b|\bundefined\b|NaN|Invalid Date|\[object Object\]/;
async function assentar(pg) { for (let i = 0; i < 6; i += 1) await pg.esperar(); }

function exigir(pg, id) { assert.ok(existe(pg, id), `#${id} não existe na página`); return pg.el(id); }
function datas(pg, inicial, final) {
  exigir(pg, 'historyPeriodoInicial').value = inicial;
  exigir(pg, 'historyPeriodoFinal').value = final;
}
async function aplicar(pg, inicial, final) {
  datas(pg, inicial, final);
  await exigir(pg, 'botaoAplicarPeriodo').disparar('click');
  await assentar(pg);
}
async function todoHistorico(pg) {
  await exigir(pg, 'botaoTodoHistorico').disparar('click');
  await assentar(pg);
}

async function abrir(opcoes = {}) {
  const pg = abrirPagina(ARQUIVO, { rotas: rotas(opcoes) });
  await pg.esperar();
  await pg.esperar();
  return pg;
}
async function buscar(pg, valor = 'Pessoa') {
  pg.el('historySearchValue').value = valor;
  await pg.el('botaoConsultar').disparar('click');
  await assentar(pg);
}
function clicarSelecionar(pg, id) {
  const botao = pg.consulta(`#historyResultados [data-id="${id}"]`)[0];
  assert.ok(botao, `o resultado ${id} não está na lista`);
  return botao.disparar('click');
}
async function selecionar(pg, id) { await clicarSelecionar(pg, id); await assentar(pg); }
/** Abre, pesquisa e escolhe o colaborador 11. */
async function abrirCom11(opcoes = {}) { const pg = await abrir(opcoes); await buscar(pg); await selecionar(pg, 11); return pg; }

// Chamadas de histórico (entregas e eventos) e consultas auxiliares.
const doHistorico = (c) => c.metodo === 'GET' && (/^\/funcionarios\/\d+\/eventos$/.test(c.caminho) || /^\/fichas-epi\/\d+\/entregas$/.test(c.caminho));
const historicos = (pg) => pg.chamadas.filter(doHistorico);
const param = (c, nome) => new URL(c.url).searchParams.get(nome);
const tipoDe = (c) => (c.caminho.endsWith('/entregas') ? 'ENTREGAS' : param(c, 'tipo'));
const resumoChamadas = (lista) => lista.map((c) => [c.caminho, tipoDe(c), param(c, 'de'), param(c, 'ate'), param(c, 'pagina'), param(c, 'limite')])
  .sort((a, b) => String(a[1]).localeCompare(String(b[1])));
const idsEventos = (pg, tipo) => pg.consulta(`#${SECOES[tipo]} [data-evento-id]`).map((e) => e.getAttribute('data-evento-id'));
const idsEntregas = (pg) => pg.consulta('#historyTimeline [data-entrega-id]').map((e) => e.getAttribute('data-entrega-id'));
const indicadores = (pg) => ['hkpiTotal', 'hkpiEpis', 'hkpiUltima', 'hkpiAtivos'].map((i) => limpo(pg.el(i).textContent));
const adiada = () => { let liberar; const p = new Promise((r) => { liberar = r; }); return { p, liberar: () => liberar() }; };

/** O que a tela mostra nos quatro históricos. */
const quadro = (pg) => ({ entregas: idsEntregas(pg), GHE: idsEventos(pg, 'GHE'), SITUACAO: idsEventos(pg, 'SITUACAO'), CADASTRAL: idsEventos(pg, 'CADASTRAL') });
const quadroDe = (func, letra) => ({
  entregas: [String((letra === 'P' ? 200 : 100) + func)], GHE: [`GHE-${letra}-${func}`], SITUACAO: [`SITUACAO-${letra}-${func}`], CADASTRAL: [`CADASTRAL-${letra}-${func}`],
});

// ═══════════════════════════════════════════════════════════════════
describe('P1 — controle de período na página', () => {
  test('P1.1 cartão próprio entre os indicadores e a linha do tempo: datas (type="date"), "Aplicar filtro", "Todo o histórico", estado e erro', () => {
    const html = semComentariosHtml(ler(ARQUIVO));
    for (const id of ['historyPeriodoInicial', 'historyPeriodoFinal', 'botaoAplicarPeriodo', 'botaoTodoHistorico', 'historyPeriodoEstado', 'historyPeriodoErro']) {
      assert.match(html, new RegExp(`id="${id}"`), id);
    }
    assert.match(html, /<input[^>]*id="historyPeriodoInicial"[^>]*type="date"|<input[^>]*type="date"[^>]*id="historyPeriodoInicial"/);
    assert.match(html, /<input[^>]*id="historyPeriodoFinal"[^>]*type="date"|<input[^>]*type="date"[^>]*id="historyPeriodoFinal"/);
    assert.match(html, /<label[^>]*for="historyPeriodoInicial"[^>]*>\s*Data inicial\s*</);
    assert.match(html, /<label[^>]*for="historyPeriodoFinal"[^>]*>\s*Data final\s*</);
    assert.match(html, /id="botaoAplicarPeriodo"[^>]*>[\s\S]*?Aplicar filtro[\s\S]*?<\/button>/);
    assert.match(html, /id="botaoTodoHistorico"[^>]*>[\s\S]*?Todo o histórico[\s\S]*?<\/button>/);
    const pos = (id) => html.indexOf(`id="${id}"`);
    assert.ok(pos('hkpiAtivos') < pos('historyPeriodoInicial') && pos('historyPeriodoInicial') < pos('historyTimeline'),
      'o filtro fica depois dos indicadores (que não filtra) e antes dos históricos (que filtra)');
  });

  test('P1.2 oculto até a identificação; aparece com "Todo o histórico"; Limpar oculta; antes da escolha, aplicar não consulta nada', async () => {
    const pg = await abrir();
    assert.equal(existe(pg, 'historyPeriodoInicial'), true);
    assert.equal(visivel(pg, 'historyPeriodoInicial'), false);
    datas(pg, '2026-01-01', '2026-01-31');
    await pg.el('botaoAplicarPeriodo').disparar('click');
    await assentar(pg);
    assert.deepEqual(historicos(pg), []);
    await buscar(pg);
    assert.equal(visivel(pg, 'historyPeriodoInicial'), false, 'vários resultados: ainda ninguém identificado');
    await selecionar(pg, 11);
    assert.equal(visivel(pg, 'historyPeriodoInicial'), true);
    assert.equal(usavel(pg, 'botaoAplicarPeriodo') && usavel(pg, 'botaoTodoHistorico'), true);
    assert.match(textoDe(pg, 'historyPeriodoEstado'), /Todo o histórico/);
    await pg.el('botaoLimparHistorico').disparar('click');
    await assentar(pg);
    assert.equal(visivel(pg, 'historyPeriodoInicial'), false);
  });

  test('P1.3 sem período (padrão): as quatro consultas continuam sem de/ate, como nos pacotes C, E, F e G', async () => {
    const pg = await abrirCom11();
    const chamadas = historicos(pg);
    assert.equal(chamadas.length, 4, String(chamadas.map((c) => c.url)));
    assert.deepEqual(chamadas.filter((c) => param(c, 'de') !== null || param(c, 'ate') !== null), []);
    assert.deepEqual(quadro(pg), quadroDe(11, 'T'));
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('P2 — aplicar e remover o período', () => {
  test('P2.1 aplicar: as quatro seções voltam à página 1 com de/ate; ficha, ficha de EPI e indicadores não são relidos nem mudam', async () => {
    const pg = await abrirCom11();
    const antes = pg.chamadas.length;
    const indicadoresAntes = indicadores(pg);
    assert.deepEqual(indicadoresAntes, INDICADORES_ESPERADOS);
    await aplicar(pg, '2026-01-01', '2026-01-31');
    const novas = pg.chamadas.slice(antes);
    assert.deepEqual(resumoChamadas(novas.filter(doHistorico)), [
      ['/funcionarios/11/eventos', 'CADASTRAL', '2026-01-01', '2026-01-31', '1', '20'],
      ['/fichas-epi/511/entregas', 'ENTREGAS', '2026-01-01', '2026-01-31', '1', '20'],
      ['/funcionarios/11/eventos', 'GHE', '2026-01-01', '2026-01-31', '1', '20'],
      ['/funcionarios/11/eventos', 'SITUACAO', '2026-01-01', '2026-01-31', '1', '20'],
    ]);
    assert.deepEqual(novas.filter((c) => !doHistorico(c)).map((c) => c.url), [], 'nada além dos quatro históricos: nem o detalhe, nem GET /fichas-epi');
    assert.deepEqual(quadro(pg), quadroDe(11, 'P'));
    assert.deepEqual(indicadores(pg), indicadoresAntes);
    assert.equal(pg.el('historyEmployeeName').value, 'Pessoa 11');
    assert.match(textoDe(pg, 'historyPeriodoEstado'), /01\/01\/2026 a 31\/01\/2026/);
    assert.equal(textoDe(pg, 'historyPeriodoErro'), '');
  });

  test('P2.2 as datas vão exatamente como digitadas (sem fuso): virada de ano e dia único', async () => {
    const pg = await abrirCom11();
    let antes = pg.chamadas.length;
    await aplicar(pg, '2025-12-31', '2026-01-01');
    for (const c of pg.chamadas.slice(antes).filter(doHistorico)) assert.deepEqual([param(c, 'de'), param(c, 'ate')], ['2025-12-31', '2026-01-01'], c.url);
    assert.match(textoDe(pg, 'historyPeriodoEstado'), /31\/12\/2025 a 01\/01\/2026/);
    antes = pg.chamadas.length;
    await aplicar(pg, '2026-02-28', '2026-02-28');
    const dia = pg.chamadas.slice(antes).filter(doHistorico);
    assert.equal(dia.length, 4);
    for (const c of dia) assert.deepEqual([param(c, 'de'), param(c, 'ate')], ['2026-02-28', '2026-02-28'], c.url);
  });

  test('P2.3 "Todo o histórico": limpa as datas e volta às quatro consultas sem período, na página 1; indicadores intactos', async () => {
    const pg = await abrirCom11();
    await aplicar(pg, '2026-01-01', '2026-01-31');
    const antes = pg.chamadas.length;
    await todoHistorico(pg);
    const novas = pg.chamadas.slice(antes);
    assert.deepEqual(resumoChamadas(novas.filter(doHistorico)), [
      ['/funcionarios/11/eventos', 'CADASTRAL', null, null, '1', '20'],
      ['/fichas-epi/511/entregas', 'ENTREGAS', null, null, '1', '20'],
      ['/funcionarios/11/eventos', 'GHE', null, null, '1', '20'],
      ['/funcionarios/11/eventos', 'SITUACAO', null, null, '1', '20'],
    ]);
    assert.deepEqual(novas.filter((c) => !doHistorico(c)).map((c) => c.url), []);
    assert.deepEqual(quadro(pg), quadroDe(11, 'T'));
    assert.deepEqual([pg.el('historyPeriodoInicial').value, pg.el('historyPeriodoFinal').value], ['', '']);
    assert.match(textoDe(pg, 'historyPeriodoEstado'), /Todo o histórico/);
    assert.deepEqual(indicadores(pg), INDICADORES_ESPERADOS);
  });

  test('P2.4 nenhuma consulta a GET /fichas-epi leva período (os quatro indicadores são sempre do histórico completo)', async () => {
    const pg = await abrirCom11();
    await aplicar(pg, '2026-01-01', '2026-01-31');
    await selecionar(pg, 12);
    await todoHistorico(pg);
    const fichas = pg.chamadas.filter((c) => c.caminho === '/fichas-epi');
    assert.ok(fichas.length >= 2);
    for (const c of fichas) assert.deepEqual([param(c, 'de'), param(c, 'ate')], [null, null], c.url);
    assert.deepEqual(indicadores(pg), INDICADORES_ESPERADOS);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('P3 — paginação com período', () => {
  const pagina = (func, tipo, q) => {
    const p = Number(q.get('pagina'));
    const letra = comPeriodo(q) ? 'P' : 'T';
    const total = comPeriodo(q) ? 25 : 22;
    const n = p === 1 ? 20 : total - 20;
    return okEventos(func, tipo, Array.from({ length: n }, (_, k) => evento(tipo, `${tipo}-${letra}${p}-${k}`)), { total, pagina: p });
  };
  const paginaEntregas = (func, q) => {
    const p = Number(q.get('pagina'));
    const base = comPeriodo(q) ? 5000 : 1000;
    const total = comPeriodo(q) ? 25 : 22;
    const n = p === 1 ? 20 : total - 20;
    return okEntregas(func, Array.from({ length: n }, (_, k) => entrega(base + p * 100 + k, func)), { total, pagina: p });
  };

  test('P3.1 em outra página, aplicar volta à 1; a próxima página continua com o mesmo período e o total do período', async () => {
    const pg = await abrirCom11({ eventos: pagina, entregas: paginaEntregas });
    for (const id of ['historyCadastralProxima', 'historyEpisProxima']) { await exigir(pg, id).disparar('click'); await assentar(pg); }
    const ultimaDe = (tipo) => historicos(pg).filter((c) => tipoDe(c) === tipo).at(-1);
    assert.deepEqual([param(ultimaDe('CADASTRAL'), 'pagina'), param(ultimaDe('ENTREGAS'), 'pagina')], ['2', '2']);
    await aplicar(pg, '2026-01-01', '2026-01-31');
    for (const tipo of ['ENTREGAS', 'GHE', 'SITUACAO', 'CADASTRAL']) assert.deepEqual([param(ultimaDe(tipo), 'pagina'), param(ultimaDe(tipo), 'de')], ['1', '2026-01-01'], tipo);
    assert.match(textoDe(pg, 'historyCadastralPagina'), /1\D+2/);
    assert.match(textoDe(pg, 'historyEpisPagina'), /1\D+2/);
    for (const id of ['historyCadastralProxima', 'historyEpisProxima']) { await exigir(pg, id).disparar('click'); await assentar(pg); }
    for (const tipo of ['CADASTRAL', 'ENTREGAS']) {
      assert.deepEqual([param(ultimaDe(tipo), 'pagina'), param(ultimaDe(tipo), 'de'), param(ultimaDe(tipo), 'ate')], ['2', '2026-01-01', '2026-01-31'], tipo);
    }
    assert.equal(idsEventos(pg, 'CADASTRAL').length, 5);
    assert.equal(idsEntregas(pg).length, 5);
    assert.equal(usavel(pg, 'historyCadastralProxima'), false);
  });

  test('P3.2 período sem registros: cada seção diz que não há registros NO PERÍODO, sem paginação e sem falha', async () => {
    const vazio = (func, tipo, q) => (comPeriodo(q) ? okEventos(func, tipo, []) : undefined);
    const pg = await abrirCom11({ eventos: vazio, entregas: (func, q) => (comPeriodo(q) ? okEntregas(func, []) : undefined) });
    await aplicar(pg, '2024-06-01', '2024-06-30');
    for (const id of ['historyTimeline', ...Object.values(SECOES)]) {
      const t = textoDe(pg, id);
      assert.match(t, /período/i, `${id}: ${t}`);
      assert.equal(/não foi possível/i.test(t), false, id);
      assert.equal(SUJEIRA.test(t), false, id);
    }
    assert.deepEqual(quadro(pg), { entregas: [], GHE: [], SITUACAO: [], CADASTRAL: [] });
    for (const id of ['historyEpisProxima', 'historyGheProxima', 'historySituacaoProxima', 'historyCadastralProxima']) assert.equal(usavel(pg, id), false, id);
    assert.deepEqual(indicadores(pg), INDICADORES_ESPERADOS);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('P4 — validação local (nenhuma requisição)', () => {
  const casos = [
    ['só a data inicial', '2026-01-01', '', /Informe a data inicial e a data final/i],
    ['só a data final', '', '2026-01-31', /Informe a data inicial e a data final/i],
    ['nenhuma data', '', '', /Informe a data inicial e a data final/i],
    ['final antes da inicial', '2026-02-01', '2026-01-31', /data final precisa ser igual ou posterior à (data )?inicial/i],
    ['data inicial inexistente', '2026-02-30', '2026-03-31', /Data inicial inválida/i],
    ['data final em outro formato', '2026-01-01', '31/01/2026', /Data final inválida/i],
    ['texto qualquer', 'ontem', '2026-01-31', /Data inicial inválida/i],
  ];
  for (const [nome, inicial, final, mensagem] of casos) {
    test(`P4 ${nome}: mensagem, nenhuma consulta, nada muda na tela`, async () => {
      const pg = await abrirCom11();
      await aplicar(pg, '2026-01-01', '2026-01-31');
      const antes = pg.chamadas.length;
      const tela = quadro(pg);
      await aplicar(pg, inicial, final);
      assert.match(textoDe(pg, 'historyPeriodoErro'), mensagem);
      assert.deepEqual(pg.chamadas.slice(antes).map((c) => c.url), []);
      assert.deepEqual(quadro(pg), tela);
      assert.match(textoDe(pg, 'historyPeriodoEstado'), /01\/01\/2026 a 31\/01\/2026/, 'o período aplicado continua o mesmo');
      assert.deepEqual(indicadores(pg), INDICADORES_ESPERADOS);
      assert.equal(pg.el('historyEmployeeName').value, 'Pessoa 11');
    });
  }

  test('P4.8 depois da recusa, um período válido aplica e apaga a mensagem; "Todo o histórico" também a apaga', async () => {
    const pg = await abrirCom11();
    await aplicar(pg, '2026-02-01', '2026-01-31');
    assert.notEqual(textoDe(pg, 'historyPeriodoErro'), '');
    await aplicar(pg, '2026-01-01', '2026-01-31');
    assert.equal(textoDe(pg, 'historyPeriodoErro'), '');
    assert.deepEqual(quadro(pg), quadroDe(11, 'P'));
    await aplicar(pg, '2026-01-01', '');
    assert.notEqual(textoDe(pg, 'historyPeriodoErro'), '');
    await todoHistorico(pg);
    assert.equal(textoDe(pg, 'historyPeriodoErro'), '');
    assert.deepEqual(quadro(pg), quadroDe(11, 'T'));
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('P5 — respostas atrasadas, troca de colaborador e Limpar', () => {
  test('P5.1 período A atrasado e "Todo o histórico" logo depois: as respostas de A que chegam depois são descartadas', async () => {
    const a = adiada();
    const atrasar = (resposta) => async () => { await a.p; return resposta; };
    const pg = await abrirCom11({
      eventos: (func, tipo, q) => (q.get('de') === '2026-01-01' ? atrasar(okEventos(func, tipo, [evento(tipo, `${tipo}-A`)]))() : undefined),
      entregas: (func, q) => (q.get('de') === '2026-01-01' ? atrasar(okEntregas(func, [entrega(999, func)]))() : undefined),
    });
    datas(pg, '2026-01-01', '2026-01-31');
    const pendente = exigir(pg, 'botaoAplicarPeriodo').disparar('click');
    await assentar(pg);
    await todoHistorico(pg);
    a.liberar();
    await pendente;
    await assentar(pg);
    assert.deepEqual(quadro(pg), quadroDe(11, 'T'));
  });

  test('P5.2 período B aplicado enquanto A está pendente: só B aparece', async () => {
    const a = adiada();
    const pg = await abrirCom11({
      eventos: (func, tipo, q) => (q.get('de') === '2026-01-01' ? (async () => { await a.p; return okEventos(func, tipo, [evento(tipo, `${tipo}-A`)]); })() : undefined),
      entregas: (func, q) => (q.get('de') === '2026-01-01' ? (async () => { await a.p; return okEntregas(func, [entrega(999, func)]); })() : undefined),
    });
    datas(pg, '2026-01-01', '2026-01-31');
    const pendente = exigir(pg, 'botaoAplicarPeriodo').disparar('click');
    await assentar(pg);
    await aplicar(pg, '2026-02-01', '2026-02-28');
    a.liberar();
    await pendente;
    await assentar(pg);
    assert.deepEqual(quadro(pg), quadroDe(11, 'P'));
    assert.match(textoDe(pg, 'historyPeriodoEstado'), /01\/02\/2026 a 28\/02\/2026/);
  });

  test('P5.3 troca de colaborador com período: o novo vem com o mesmo período; o pendente do anterior é descartado', async () => {
    const a = adiada();
    const pg = await abrir({
      eventos: (func, tipo, q) => (func === 11 && comPeriodo(q) ? (async () => { await a.p; return okEventos(11, tipo, [evento(tipo, `${tipo}-atrasado-11`)]); })() : undefined),
    });
    await buscar(pg);
    await selecionar(pg, 11);
    datas(pg, '2026-01-01', '2026-01-31');
    const pendente = exigir(pg, 'botaoAplicarPeriodo').disparar('click');
    await assentar(pg);
    const antes = pg.chamadas.length;
    await selecionar(pg, 12);
    a.liberar();
    await pendente;
    await assentar(pg);
    const do12 = pg.chamadas.slice(antes).filter(doHistorico);
    assert.equal(do12.length, 4, String(do12.map((c) => c.url)));
    for (const c of do12) {
      assert.match(c.caminho, /\/(funcionarios\/12|fichas-epi\/512)\//, c.url);
      assert.deepEqual([param(c, 'de'), param(c, 'ate'), param(c, 'pagina')], ['2026-01-01', '2026-01-31', '1'], c.url);
    }
    assert.deepEqual(quadro(pg), quadroDe(12, 'P'));
    assert.match(textoDe(pg, 'historyPeriodoEstado'), /01\/01\/2026 a 31\/01\/2026/);
    assert.equal(pg.el('historyEmployeeName').value, 'Pessoa 12');
  });

  test('P5.4 Limpar desfaz o período: datas vazias, "Todo o histórico", e a próxima escolha consulta sem período', async () => {
    const pg = await abrirCom11();
    await aplicar(pg, '2026-01-01', '2026-01-31');
    await pg.el('botaoLimparHistorico').disparar('click');
    await assentar(pg);
    assert.deepEqual([pg.el('historyPeriodoInicial').value, pg.el('historyPeriodoFinal').value], ['', '']);
    assert.match(textoDe(pg, 'historyPeriodoEstado'), /Todo o histórico/);
    const antes = pg.chamadas.length;
    await buscar(pg);
    await selecionar(pg, 11);
    const novas = pg.chamadas.slice(antes).filter(doHistorico);
    assert.equal(novas.length, 4);
    assert.deepEqual(novas.filter((c) => param(c, 'de') !== null || param(c, 'ate') !== null).map((c) => c.url), []);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('P6 — erros, permissões e segurança com período', () => {
  test('P6.1 falha com período: "Tentar novamente" refaz a mesma consulta com o mesmo período e página (eventos e entregas)', async () => {
    let falhar = true;
    const pg = await abrirCom11({
      eventos: (func, tipo, q) => (tipo === 'CADASTRAL' && comPeriodo(q) && falhar ? erro(500, 'ERRO_INTERNO') : undefined),
      entregas: (func, q) => (comPeriodo(q) && falhar ? erro(500, 'ERRO_INTERNO') : undefined),
    });
    await aplicar(pg, '2026-01-01', '2026-01-31');
    assert.match(textoDe(pg, 'historyCadastralTimeline'), /não foi possível/i);
    assert.match(textoDe(pg, 'historyTimeline'), /não foi possível/i);
    assert.deepEqual([idsEventos(pg, 'GHE'), idsEventos(pg, 'SITUACAO')], [['GHE-P-11'], ['SITUACAO-P-11']], 'as outras seções seguem com o período');
    falhar = false;
    const antes = pg.chamadas.length;
    for (const id of ['historyCadastralTentar', 'historyEpisTentar']) { await exigir(pg, id).disparar('click'); await assentar(pg); }
    assert.deepEqual(resumoChamadas(pg.chamadas.slice(antes).filter(doHistorico)), [
      ['/funcionarios/11/eventos', 'CADASTRAL', '2026-01-01', '2026-01-31', '1', '20'],
      ['/fichas-epi/511/entregas', 'ENTREGAS', '2026-01-01', '2026-01-31', '1', '20'],
    ]);
    assert.deepEqual(quadro(pg), quadroDe(11, 'P'));
    assert.deepEqual(indicadores(pg), INDICADORES_ESPERADOS);
  });

  test('P6.2 403 com período: "sem permissão" só na seção; 401: sessão encerrada e ida ao Portal', async () => {
    const negado = await abrirCom11({ eventos: (func, tipo, q) => (tipo === 'GHE' && comPeriodo(q) ? erro(403, 'SEM_PERMISSAO') : undefined) });
    await aplicar(negado, '2026-01-01', '2026-01-31');
    assert.match(textoDe(negado, 'historyGheTimeline'), /permiss/i);
    assert.deepEqual(idsEventos(negado, 'CADASTRAL'), ['CADASTRAL-P-11']);
    const sessao = await abrirCom11({ eventos: (func, tipo, q) => (comPeriodo(q) ? erro(401, 'SESSAO_INVALIDA') : undefined) });
    await aplicar(sessao, '2026-01-01', '2026-01-31');
    assert.ok(sessao.navegacoes.some((d) => /portal\/index\.html/.test(d)), String(sessao.navegacoes));
  });

  test('P6.3 sem epiFicha.visualizar: o período nunca consulta a ficha nem as entregas; a área de EPIs continua "sem permissão"', async () => {
    const pg = await abrirCom11({ epis: false });
    await aplicar(pg, '2026-01-01', '2026-01-31');
    assert.deepEqual(pg.chamadas.filter((c) => c.caminho.startsWith('/fichas-epi')).map((c) => c.url), []);
    assert.equal(textoDe(pg, 'historyTimeline'), 'Sem permissão para ver o histórico de EPIs.');
    assert.deepEqual([idsEventos(pg, 'GHE'), idsEventos(pg, 'SITUACAO'), idsEventos(pg, 'CADASTRAL')], [['GHE-P-11'], ['SITUACAO-P-11'], ['CADASTRAL-P-11']]);
  });

  test('P6.4 busca por CPF e depois período: o CPF nunca vai à URL; nada em armazenamento do navegador; sem innerHTML no filtro', async () => {
    const pg = await abrir();
    await buscar(pg, '529.982.247-25');
    await aplicar(pg, '2026-01-01', '2026-01-31');
    assert.equal(historicos(pg).filter((c) => param(c, 'de') === '2026-01-01').length, 4);
    assert.deepEqual(pg.chamadas.filter((c) => /52998224725|529\.982/.test(c.url)).map((c) => c.url), []);
    assert.deepEqual(pg.storage.filter((s) => ['setItem', 'removeItem', 'clear'].includes(s.operacao) && /periodo|historico|2026-01/i.test(`${s.chave} ${s.valor}`)), []);
    const ids = ['historyPeriodoInicial', 'historyPeriodoFinal', 'historyPeriodoEstado', 'historyPeriodoErro'];
    assert.equal(pg.documento.usosDeInnerHTML.some((u) => ids.includes(u.id)), false);
  });
});
