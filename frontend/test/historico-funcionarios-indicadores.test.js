'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { abrirPagina, ler, semComentariosHtml } = require('./helpers/dom-pagina');

/**
 * Histórico de Funcionários — pacote D (RED): os quatro indicadores.
 *
 * Fonte: o `resumo` da ficha que a tela JÁ recebe em GET /fichas-epi?funcionarioId= (pacote C) — nenhuma chamada nova,
 * nenhuma leitura de todas as páginas de entregas no navegador.
 *   #hkpiTotal  "Retiradas realizadas"         ← resumo.totalEntregas
 *   #hkpiEpis   "EPIs distintos retirados"     ← resumo.episDistintos
 *   #hkpiUltima "Última retirada"              ← resumo.ultimaEntregaEm, dd/mm/aaaa em São Paulo, sem hora
 *   #hkpiAtivos "EPIs dentro do prazo de uso"  ← resumo.episDentroPrazoUso
 * Histórico total da ficha (sem período). Sem ficha (resposta válida) = 0, 0, "—", 0. Sem epiFicha.visualizar, 403,
 * falha, resposta inválida ou ficha de outro funcionário = "—" nos quatro, nunca zero. Campo ausente ou inválido no
 * resumo = "—" naquele card, nunca zero.
 */

const ARQUIVO = 'pages/employee-history.html';
const IDS = ['hkpiTotal', 'hkpiEpis', 'hkpiUltima', 'hkpiAtivos'];
const NEUTRO = ['—', '—', '—', '—'];

// ── servidor falso ─────────────────────────────────────────────────
const NENHUMA = { visualizar: false, criar: false, editar: false, excluir: false };
const area = (v) => ({ consultar: v, alterar: v });
const permissoes = ({ epi = true } = {}) => ({
  status: 'ok', empresaId: 3, usuarioId: 7, perfil: 'USUARIO',
  recursos: { employeeHistory: { ...NENHUMA, visualizar: true }, epiFicha: { ...NENHUMA, visualizar: epi } }, acoes: {},
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
const okDetalhe = (f) => ({ status: 200, corpo: { status: 'ok', funcionario: f } });
const erro = (status, codigo) => ({ status, corpo: { status: 'error', codigo, message: 'x' } });
const resumo = (extra = {}) => ({ totalEntregas: 2, totalItens: 3, ultimaEntregaEm: '2026-03-11T01:30:00.000Z', episDistintos: 1, episDentroPrazoUso: 0, ...extra });
const ficha = (fichaId, funcionarioId, r = resumo()) => ({
  id: fichaId, numero: 1, funcionarioId, criadaEm: '2026-01-02T12:00:00.000Z',
  funcionarioAtual: { id: funcionarioId, nome: `Pessoa ${funcionarioId}`, matricula: `M-${funcionarioId}`, cpfMascarado: '***.***.***-25', setor: 'S', funcao: 'F', ativo: true },
  resumo: r,
});
const okFichas = (lista) => ({ status: 200, corpo: { status: 'ok', fichas: lista, total: lista.length, pagina: 1, limite: 1 } });
const entrega = (id, fichaId, funcionarioId) => ({
  id, ficha: { id: fichaId, numero: 1, funcionarioId }, origem: 'DIRETA', entregueEm: '2026-03-10T13:30:00.000Z', dataOperacional: '2026-03-10',
  empresa: { nome: 'E', cnpj: '11222333000181', endereco: null, cidade: null, uf: null }, trabalhador: { nome: 'T', matricula: null, funcao: null, setor: null },
  ghe: null, responsavel: { id: 7, nome: 'R' },
  itens: [{ id: id * 10, materialId: 40, loteId: 70, quantidade: 1, motivo: 'ADMISSAO', justificativa: null, previstoNoGhe: true, justificativaForaGhe: null,
    material: { nome: 'Luva', tipo: 'Luva', codigoInterno: 'L-1', unidade: 'PAR', prazoUsoDias: 30, oculosComGrau: false, exigeCa: true },
    lote: { tamanho: 'M', caNumero: '1', caValidade: '2030-01-01' }, operacaoId: 1 }],
  confirmacao: null,
});
const okEntregas = (fichaId, funcionarioId, lista, total = lista.length) => ({
  status: 200, corpo: { status: 'ok', ficha: { id: fichaId, numero: 1, funcionarioId }, entregas: lista, total, pagina: 1, limite: 20 },
});

/** Funcionários: { id, ficha (id ou null), resumo, fichas (resposta crua ou função), entregas, total }. */
function rotasDe(lista, extra = {}) {
  const porId = new Map(lista.map((f) => [String(f.id), f]));
  const rotas = {
    'GET /funcionarios': okLista(lista.map((f) => funcionario(f.id))),
    'GET /fichas-epi': (c) => {
      const f = porId.get(new URL(c.url).searchParams.get('funcionarioId'));
      if (!f) return okFichas([]);
      if (f.fichas) return typeof f.fichas === 'function' ? f.fichas(c) : f.fichas;
      return okFichas(f.ficha ? [ficha(f.ficha, f.id, f.resumo)] : []);
    },
  };
  for (const f of lista) {
    rotas[`GET /funcionarios/${f.id}`] = okDetalhe(funcionario(f.id));
    if (f.ficha) rotas[`GET /fichas-epi/${f.ficha}/entregas`] = f.paginas || okEntregas(f.ficha, f.id, f.entregas || [entrega(30, f.ficha, f.id)], f.total);
  }
  return { ...rotas, ...extra };
}

async function abrir({ epi = true, rotas = {} } = {}) {
  const pg = abrirPagina(ARQUIVO, {
    rotas: {
      'GET /auth/me': { status: 200, corpo: contexto() },
      'GET /auth/global/me': { status: 200, corpo: { status: 'ok', empresas: [{ id: 3 }] } },
      'GET /auth/permissoes': { status: 200, corpo: permissoes({ epi }) },
      ...rotas,
    },
  });
  await pg.esperar();
  await pg.esperar();
  return pg;
}

// ── helpers de tela ────────────────────────────────────────────────
const limpo = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const cards = (pg) => IDS.map((id) => limpo(pg.el(id).textContent));
const chamadasFichas = (pg) => pg.chamadas.filter((c) => c.metodo === 'GET' && c.caminho === '/fichas-epi');
const chamadasEntregas = (pg) => pg.chamadas.filter((c) => c.metodo === 'GET' && /^\/fichas-epi\/\d+\/entregas$/.test(c.caminho));
async function assentar(pg) { for (let i = 0; i < 4; i += 1) await pg.esperar(); }
async function buscar(pg, texto) {
  pg.el('historySearchValue').value = texto;
  await pg.el('botaoConsultar').disparar('click');
  await assentar(pg);
}
function clicarSelecionar(pg, id) {
  const botao = pg.consulta(`#historyResultados [data-id="${id}"]`)[0];
  assert.ok(botao, `o resultado ${id} não está na lista`);
  return botao.disparar('click');
}
async function selecionar(pg, id) { await clicarSelecionar(pg, id); await assentar(pg); }
async function abrirCom(lista, opcoes = {}) {
  const pg = await abrir({ ...opcoes, rotas: rotasDe(lista, opcoes.rotas) });
  await buscar(pg, 'Pessoa');
  return pg;
}
const adiada = () => { let liberar; const p = new Promise((r) => { liberar = r; }); return { p, liberar: () => liberar() }; };

// ═══════════════════════════════════════════════════════════════════
describe('D1 — rótulos aprovados', () => {
  test('D1.1 os quatro cards têm os rótulos aprovados, nesta ordem, sobre os mesmos ids', () => {
    const html = semComentariosHtml(ler(ARQUIVO));
    const resumoHtml = html.slice(html.indexOf('history-summary'), html.indexOf('</section>', html.indexOf('history-summary')));
    const rotulos = [...resumoHtml.matchAll(/<span>([^<]+)<\/span>\s*<strong id="(hkpi\w+)"/g)].map((m) => [m[1].trim(), m[2]]);
    assert.deepEqual(rotulos, [
      ['Retiradas realizadas', 'hkpiTotal'], ['EPIs distintos retirados', 'hkpiEpis'], ['Última retirada', 'hkpiUltima'], ['EPIs dentro do prazo de uso', 'hkpiAtivos'],
    ]);
  });

  test('D1.2 os rótulos antigos saem da página', () => {
    const html = semComentariosHtml(ler(ARQUIVO));
    for (const antigo of ['Total de retiradas', 'EPIs diferentes', 'Itens ativos']) assert.equal(html.includes(antigo), false, antigo);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('D2 — valores vindos do resumo da ficha', () => {
  test('D2.1 os quatro valores saem do resumo: retiradas, distintos, última retirada (dd/mm/aaaa em São Paulo) e dentro do prazo', async () => {
    // 01:30 UTC de 11/03 = 22:30 de 10/03 em São Paulo.
    const pg = await abrirCom([{ id: 11, ficha: 511, resumo: resumo({ totalEntregas: 2, episDistintos: 1, episDentroPrazoUso: 0, ultimaEntregaEm: '2026-03-11T01:30:00.000Z' }) }]);
    assert.deepEqual(cards(pg), ['2', '1', '10/03/2026', '0']);
  });

  test('D2.2 a última retirada não mostra hora', async () => {
    const pg = await abrirCom([{ id: 11, ficha: 511, resumo: resumo({ ultimaEntregaEm: '2026-07-04T18:45:00.000Z' }) }]);
    assert.equal(cards(pg)[2], '04/07/2026');
    assert.equal(/:/.test(cards(pg)[2]), false);
  });

  test('D2.3 a fonte é o resumo, não a página de entregas: nenhuma chamada a mais e nenhuma página além da primeira', async () => {
    const pg = await abrirCom([{ id: 11, ficha: 511, total: 45, resumo: resumo({ totalEntregas: 45, episDistintos: 7, episDentroPrazoUso: 4 }) }]);
    assert.deepEqual(cards(pg), ['45', '7', '10/03/2026', '4']);
    assert.equal(chamadasFichas(pg).length, 1, 'a mesma consulta da ficha do pacote C');
    assert.equal(chamadasEntregas(pg).length, 1, 'só a primeira página');
    assert.equal(pg.chamadas.some((c) => c.metodo === 'GET' && /^\/fichas-epi\/\d+$/.test(c.caminho)), false, 'sem consulta extra ao detalhe da ficha');
  });

  test('D2.4 CASO F — funcionário sem ficha (resposta válida): 0, 0, "—", 0', async () => {
    const pg = await abrirCom([{ id: 11, ficha: null }]);
    assert.equal(chamadasFichas(pg).length, 1);
    assert.deepEqual(cards(pg), ['0', '0', '—', '0']);
  });

  test('D2.5 ficha com resumo zerado: 0, 0, "—", 0', async () => {
    const pg = await abrirCom([{ id: 11, ficha: 511, entregas: [], total: 0, resumo: resumo({ totalEntregas: 0, totalItens: 0, ultimaEntregaEm: null, episDistintos: 0, episDentroPrazoUso: 0 }) }]);
    assert.deepEqual(cards(pg), ['0', '0', '—', '0']);
  });

  test('D2.6 campo ausente ou inválido no resumo vira "—" naquele card, nunca zero', async () => {
    const pg = await abrirCom([{ id: 11, ficha: 511, resumo: { totalEntregas: 3, totalItens: 3, ultimaEntregaEm: 'não é data', episDistintos: -1 } }]);
    assert.deepEqual(cards(pg), ['3', '—', '—', '—']);
  });

  test('D2.7 a falha só das entregas não apaga indicadores vindos de um resumo válido', async () => {
    const pg = await abrirCom([{ id: 11, ficha: 511, paginas: erro(500, 'ERRO_INTERNO'), resumo: resumo({ totalEntregas: 4, episDistintos: 2, episDentroPrazoUso: 1 }) }]);
    assert.deepEqual(cards(pg), ['4', '2', '10/03/2026', '1']);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('D3 — permissão e falhas: neutro, nunca zero', () => {
  test('D3.1 sem epiFicha.visualizar: os quatro ficam "—" e nenhuma rota da ficha é chamada; a ficha cadastral continua', async () => {
    const pg = await abrirCom([{ id: 11, ficha: 511 }], { epi: false });
    assert.equal(pg.el('historyEmployeeName').value, 'Pessoa 11');
    assert.equal(pg.chamadas.some((c) => /^\/fichas-epi/.test(c.caminho)), false);
    assert.deepEqual(cards(pg), NEUTRO);
  });

  const falhas = [
    ['403', erro(403, 'SEM_PERMISSAO')],
    ['500', erro(500, 'ERRO_INTERNO')],
    ['rede', new Error('rede')],
    ['corpo vazio', { status: 200, corpo: {} }],
    ['ficha de outro funcionário', okFichas([ficha(599, 99, resumo({ totalEntregas: 9, episDistintos: 9, episDentroPrazoUso: 9 }))])],
  ];
  for (const [nome, falha] of falhas) {
    test(`D3 ${nome} na ficha: os valores do funcionário anterior somem e nada vira zero`, async () => {
      const pg = await abrir({ rotas: rotasDe([
        { id: 11, ficha: 511, resumo: resumo({ totalEntregas: 6, episDistintos: 5, episDentroPrazoUso: 4 }) },
        { id: 12, ficha: 512, fichas: falha },
      ]) });
      await buscar(pg, 'Pessoa');
      await selecionar(pg, 11);
      assert.deepEqual(cards(pg), ['6', '5', '10/03/2026', '4'], 'A carregado');
      await selecionar(pg, 12);
      assert.equal(pg.el('historyEmployeeName').value, 'Pessoa 12', 'a ficha cadastral de B continua');
      assert.deepEqual(cards(pg), NEUTRO);
      assert.equal(cards(pg).includes('9'), false, 'nada da ficha inconsistente');
    });
  }

  test('D3.2 401 na ficha: sessão encerrada, ida ao Portal e indicadores neutros', async () => {
    const pg = await abrir({ rotas: rotasDe([
      { id: 11, ficha: 511, resumo: resumo({ totalEntregas: 6 }) },
      { id: 12, ficha: 512, fichas: erro(401, 'SESSAO_INVALIDA') },
    ]) });
    await buscar(pg, 'Pessoa');
    await selecionar(pg, 11);
    assert.equal(cards(pg)[0], '6');
    await selecionar(pg, 12);
    assert.ok(pg.navegacoes.some((d) => /portal\/index\.html/.test(d)), String(pg.navegacoes));
    assert.deepEqual(cards(pg), NEUTRO);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('D4 — troca de funcionário e respostas atrasadas', () => {
  test('D4.1 A carregado → selecionar B: os cards de A somem na hora; a ficha atrasada de A não preenche os de B', async () => {
    const a = adiada();
    let primeira = true;
    const pg = await abrir({ rotas: rotasDe([
      { id: 11, ficha: 511, fichas: async () => { if (!primeira) await a.p; primeira = false; return okFichas([ficha(511, 11, resumo({ totalEntregas: 6, episDistintos: 5, episDentroPrazoUso: 4 }))]); } },
      { id: 12, ficha: 512, resumo: resumo({ totalEntregas: 1, episDistintos: 1, episDentroPrazoUso: 1, ultimaEntregaEm: '2026-05-20T15:00:00.000Z' }) },
    ]) });
    await buscar(pg, 'Pessoa');
    await selecionar(pg, 11);
    assert.deepEqual(cards(pg), ['6', '5', '10/03/2026', '4'], 'A carregado');
    const pendenteA = clicarSelecionar(pg, 11); // A de novo, agora com a ficha atrasada
    await assentar(pg);
    assert.deepEqual(cards(pg), NEUTRO, 'enquanto carrega, nada do valor anterior');
    await selecionar(pg, 12);
    assert.deepEqual(cards(pg), ['1', '1', '20/05/2026', '1']);
    a.liberar();
    await pendenteA;
    await assentar(pg);
    assert.deepEqual(cards(pg), ['1', '1', '20/05/2026', '1'], 'A atrasado não sobrescreve B');
  });

  test('D4.2 Limpar volta os cards ao estado inicial e descarta a ficha pendente', async () => {
    const a = adiada();
    let primeira = true;
    const pg = await abrir({ rotas: rotasDe([
      { id: 11, ficha: 511, fichas: async () => { if (!primeira) await a.p; primeira = false; return okFichas([ficha(511, 11, resumo({ totalEntregas: 6 }))]); } },
      { id: 12, ficha: 512 },
    ]) });
    await buscar(pg, 'Pessoa');
    await selecionar(pg, 11);
    assert.equal(cards(pg)[0], '6');
    const pendente = clicarSelecionar(pg, 11);
    await assentar(pg);
    await pg.el('botaoLimparHistorico').disparar('click');
    await assentar(pg);
    assert.deepEqual(cards(pg), NEUTRO);
    a.liberar();
    await pendente;
    await assentar(pg);
    assert.deepEqual(cards(pg), NEUTRO);
  });

  test('D4.3 nova busca limpa os cards e descarta a ficha pendente', async () => {
    const a = adiada();
    let primeira = true;
    const pg = await abrir({ rotas: rotasDe(
      [
        { id: 11, ficha: 511, fichas: async () => { if (!primeira) await a.p; primeira = false; return okFichas([ficha(511, 11, resumo({ totalEntregas: 6 }))]); } },
        { id: 12, ficha: 512 },
      ],
      { 'GET /funcionarios': (c) => (new URL(c.url).searchParams.get('busca') === 'Pessoa' ? okLista([funcionario(11), funcionario(12)]) : okLista([])) },
    ) });
    await buscar(pg, 'Pessoa');
    await selecionar(pg, 11);
    assert.equal(cards(pg)[0], '6');
    const pendente = clicarSelecionar(pg, 11);
    await assentar(pg);
    await buscar(pg, 'Outra');
    a.liberar();
    await pendente;
    await assentar(pg);
    assert.deepEqual(cards(pg), NEUTRO);
  });

  test('D4.4 sessão encerrada: a ficha pendente não preenche os cards depois', async () => {
    const a = adiada();
    let primeira = true;
    const pg = await abrir({ rotas: rotasDe([
      { id: 11, ficha: 511, fichas: async () => { if (!primeira) await a.p; primeira = false; return okFichas([ficha(511, 11, resumo({ totalEntregas: 6 }))]); } },
      { id: 12, ficha: 512 },
    ], { 'GET /funcionarios/12': erro(401, 'SESSAO_INVALIDA') }) });
    await buscar(pg, 'Pessoa');
    await selecionar(pg, 11);
    assert.equal(cards(pg)[0], '6');
    const pendente = clicarSelecionar(pg, 11);
    await assentar(pg);
    await selecionar(pg, 12);
    assert.ok(pg.navegacoes.some((d) => /portal\/index\.html/.test(d)), String(pg.navegacoes));
    a.liberar();
    await pendente;
    await assentar(pg);
    assert.deepEqual(cards(pg), NEUTRO);
  });
});
