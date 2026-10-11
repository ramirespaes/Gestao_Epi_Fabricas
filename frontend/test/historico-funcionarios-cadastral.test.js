'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { abrirPagina, ler, semComentariosHtml } = require('./helpers/dom-pagina');

/**
 * Histórico de Funcionários — pacote G (RED): seção "Histórico de Alterações Cadastrais".
 *
 * Fonte: GET /funcionarios/:id/eventos?tipo=CADASTRAL&pagina=&limite= (mesmo endpoint e envelope dos pacotes E e F), pelo
 * id interno. Cada evento: { id, tipo, ocorridoEm, alteracoes: [{ campo, anterior, novo }], responsavel }. Cartão próprio,
 * separado de EPIs, GHE e situação, sujeito à exibição condicional. Contrato de tela: título "Histórico de Alterações
 * Cadastrais"; #historyCadastralTimeline; cada evento [data-evento-id]; paginação #historyCadastralAnterior,
 * #historyCadastralProxima, #historyCadastralPagina; nova tentativa #historyCadastralTentar. Vazio (resposta válida):
 * "Nenhuma alteração cadastral registrada para este colaborador.". Por evento: data e hora (São Paulo), tipo ("Cadastro",
 * "Importação", "Alteração"), uma linha por campo com o rótulo (Nome, Matrícula, Setor, Cargo / função) — na alteração
 * "<anterior> → <novo>", no registro inicial só o valor —, e o responsável (nome, ou "—"). Campo desconhecido não
 * aparece; valor nulo vira "—". Fixtures sintéticas.
 */

const ARQUIVO = 'pages/employee-history.html';
const VAZIO = 'Nenhuma alteração cadastral registrada para este colaborador.';

// ── servidor falso ─────────────────────────────────────────────────
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
const okDetalhe = (f) => ({ status: 200, corpo: { status: 'ok', funcionario: f } });
const erro = (status, codigo) => ({ status, corpo: { status: 'error', codigo, message: 'x' } });
const resumoFicha = { totalEntregas: 1, totalItens: 1, ultimaEntregaEm: '2026-03-11T01:30:00.000Z', episDistintos: 1, episDentroPrazoUso: 1 };
const okFichas = (id) => ({ status: 200, corpo: { status: 'ok', fichas: [{ id: 500 + id, numero: 1, funcionarioId: id, criadaEm: '2026-01-02T12:00:00.000Z', funcionarioAtual: { id }, resumo: resumoFicha }], total: 1, pagina: 1, limite: 1 } });
const okEntregas = (id) => ({ status: 200, corpo: { status: 'ok', ficha: { id: 500 + id, numero: 1, funcionarioId: id }, entregas: [], total: 0, pagina: 1, limite: 20 } });
const A = (campo, anterior, novo) => ({ campo, anterior, novo });
const evento = (id, extra = {}) => ({
  id: String(id), tipo: 'ALTERACAO', ocorridoEm: '2026-04-11T01:15:00.000Z',
  alteracoes: [A('setor', 'Produção', 'Manutenção')], responsavel: { id: 7, nome: 'Responsável Fictício' }, ...extra,
});
const okEventos = (funcionarioId, tipo, eventos, { total = eventos.length, pagina = 1, limite = 20 } = {}) => ({
  status: 200, corpo: { status: 'ok', funcionarioId, tipo, eventos, total, pagina, limite },
});
const outrosTipos = {
  GHE: (id) => okEventos(id, 'GHE', [{ id: 'g1', tipo: 'CADASTRO', ocorridoEm: '2026-01-01T12:00:00.000Z', anterior: null, novo: { id: 10, codigo: 'GHE-010', descricao: 'Caldeiraria' }, responsavel: null }]),
  SITUACAO: (id) => okEventos(id, 'SITUACAO', [{ id: 's1', tipo: 'CADASTRO', ocorridoEm: '2026-01-01T12:00:00.000Z', anterior: null, novo: 'ATIVO', responsavel: null }]),
};

/** cadastral: { id: array | resposta | função(pagina) }; GHE e situação respondem com um evento cada. */
function rotas({ lista = [funcionario(11)], cadastral = {}, extra = {} } = {}) {
  const r = { 'GET /funcionarios': Array.isArray(lista) ? okLista(lista) : lista, 'GET /fichas-epi': (c) => okFichas(Number(new URL(c.url).searchParams.get('funcionarioId'))) };
  for (const id of [11, 12]) {
    r[`GET /funcionarios/${id}`] = okDetalhe(funcionario(id));
    r[`GET /fichas-epi/${500 + id}/entregas`] = okEntregas(id);
    const s = cadastral[id] ?? [evento(900 + id)];
    r[`GET /funcionarios/${id}/eventos`] = (c) => {
      const q = new URL(c.url).searchParams;
      const tipo = q.get('tipo');
      if (tipo !== 'CADASTRAL') return outrosTipos[tipo] ? outrosTipos[tipo](id) : erro(400, 'VALIDACAO');
      if (Array.isArray(s)) return okEventos(id, 'CADASTRAL', s);
      return typeof s === 'function' ? s(Number(q.get('pagina') || 1), c) : s;
    };
  }
  return { ...r, ...extra };
}

async function abrir(opcoes = {}) {
  const pg = abrirPagina(ARQUIVO, {
    rotas: {
      'GET /auth/me': { status: 200, corpo: contexto() },
      'GET /auth/global/me': { status: 200, corpo: { status: 'ok', empresas: [{ id: 3 }] } },
      'GET /auth/permissoes': { status: 200, corpo: permissoes() },
      ...rotas(opcoes),
    },
  });
  await pg.esperar();
  await pg.esperar();
  return pg;
}

// ── helpers de tela ────────────────────────────────────────────────
const limpo = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const existe = (pg, id) => pg.consulta(`#${id}`).length > 0;
const visivel = (pg, id) => existe(pg, id) && pg.visivel(id);
const usavel = (pg, id) => visivel(pg, id) && !pg.el(id).disabled;
const areaCad = (pg) => (existe(pg, 'historyCadastralTimeline') ? limpo(pg.el('historyCadastralTimeline').textContent) : '');
const ids = (pg) => pg.consulta('#historyCadastralTimeline [data-evento-id]').map((e) => e.getAttribute('data-evento-id'));
const textoEvento = (pg, id) => {
  const e = pg.consulta(`#historyCadastralTimeline [data-evento-id="${id}"]`)[0];
  assert.ok(e, `o evento ${id} não está no histórico cadastral (${ids(pg)})`);
  return limpo(e.textContent);
};
const chamadasCad = (pg) => pg.chamadas.filter((c) => c.metodo === 'GET' && /^\/funcionarios\/\d+\/eventos$/.test(c.caminho) && new URL(c.url).searchParams.get('tipo') === 'CADASTRAL');
const param = (c, nome) => new URL(c.url).searchParams.get(nome);
const SUJEIRA = /\bnull\b|\bundefined\b|NaN|Invalid Date|\[object Object\]/;
async function assentar(pg) { for (let i = 0; i < 5; i += 1) await pg.esperar(); }
async function buscar(pg, valor) {
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
async function abrirCom(opcoes = {}) { const pg = await abrir(opcoes); await buscar(pg, 'Pessoa'); return pg; }
const adiada = () => { let liberar; const p = new Promise((r) => { liberar = r; }); return { p, liberar: () => liberar() }; };

// ═══════════════════════════════════════════════════════════════════
describe('C1 — seção própria e fluxo', () => {
  test('C1.1 a página tem um cartão "Histórico de Alterações Cadastrais" com #historyCadastralTimeline', () => {
    const html = semComentariosHtml(ler(ARQUIVO));
    assert.match(html, /<h2>Histórico de Alterações Cadastrais<\/h2>/);
    assert.match(html, /id="historyCadastralTimeline"/);
  });

  test('C1.2 identificado o funcionário, consulta GET /funcionarios/:id/eventos?tipo=CADASTRAL&pagina=1&limite=20 pelo id interno', async () => {
    const pg = await abrirCom();
    const c = chamadasCad(pg);
    assert.equal(c.length, 1, String(pg.chamadas.map((x) => x.url)));
    assert.equal(c[0].caminho, '/funcionarios/11/eventos');
    assert.deepEqual([param(c[0], 'pagina'), param(c[0], 'limite')], ['1', '20']);
    assert.deepEqual(ids(pg), ['911']);
  });

  test('C1.3 segue a exibição condicional: oculta antes da escolha, visível depois; sem consulta antes da escolha', async () => {
    const pg = await abrir({ lista: [funcionario(11), funcionario(12)] });
    assert.equal(existe(pg, 'historyCadastralTimeline'), true);
    assert.equal(visivel(pg, 'historyCadastralTimeline'), false);
    await buscar(pg, 'Pessoa');
    assert.equal(visivel(pg, 'historyCadastralTimeline'), false);
    assert.equal(chamadasCad(pg).length, 0);
    await selecionar(pg, 12);
    assert.equal(visivel(pg, 'historyCadastralTimeline'), true);
    assert.equal(chamadasCad(pg)[0].caminho, '/funcionarios/12/eventos');
  });

  test('C1.4 EPIs, GHE, situação e cadastro em seções separadas; ficha e indicadores preservados', async () => {
    const pg = await abrirCom();
    assert.deepEqual(ids(pg), ['911']);
    assert.equal(pg.consulta('#historyGheTimeline [data-evento-id="911"]').length + pg.consulta('#historySituacaoTimeline [data-evento-id="911"]').length, 0);
    assert.deepEqual(pg.consulta('#historyGheTimeline [data-evento-id]').map((e) => e.getAttribute('data-evento-id')), ['g1']);
    assert.deepEqual(pg.consulta('#historySituacaoTimeline [data-evento-id]').map((e) => e.getAttribute('data-evento-id')), ['s1']);
    assert.equal(pg.el('historyEmployeeName').value, 'Pessoa 11');
    assert.deepEqual(['hkpiTotal', 'hkpiEpis', 'hkpiUltima', 'hkpiAtivos'].map((i) => limpo(pg.el(i).textContent)), ['1', '1', '10/03/2026', '1']);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('C2 — conteúdo de cada evento', () => {
  test('C2.1 alteração de vários campos: data e hora em São Paulo, "Alteração", uma linha por campo com rótulo e anterior → novo, responsável', async () => {
    const pg = await abrirCom({ cadastral: { 11: [evento(1, { alteracoes: [A('nome', 'Ana', 'Ana Souza'), A('matricula', 'M-1', 'M-2'), A('setor', 'Produção', 'Manutenção'), A('funcao', 'Operador', 'Mecânico')] })] } });
    const t = textoEvento(pg, 1);
    assert.match(t, /10\/04\/2026/);
    assert.match(t, /22:15/);
    assert.match(t, /Alteração/);
    assert.match(t, /Nome:? Ana → Ana Souza/);
    assert.match(t, /Matrícula:? M-1 → M-2/);
    assert.match(t, /Setor:? Produção → Manutenção/);
    assert.match(t, /Cargo \/ função:? Operador → Mecânico/);
    assert.match(t, /Responsável Fictício/);
    assert.equal(/\b(nome|matricula|setor|funcao)\b:|ALTERACAO/.test(t), false, 'nunca o código cru');
    assert.equal(SUJEIRA.test(t), false, t);
  });

  test('C2.2 cadastro e importação: rótulo próprio e só o valor inicial (sem "→")', async () => {
    const pg = await abrirCom({ cadastral: { 11: [
      evento(2, { tipo: 'IMPORTACAO', alteracoes: [A('nome', null, 'Pessoa Importada'), A('matricula', null, 'IMP-1')] }),
      evento(1, { tipo: 'CADASTRO', alteracoes: [A('nome', null, 'Pessoa Cadastrada'), A('setor', null, 'Produção')] }),
    ] } });
    assert.match(textoEvento(pg, 2), /Importação/);
    assert.match(textoEvento(pg, 2), /Nome:? Pessoa Importada/);
    assert.match(textoEvento(pg, 1), /Cadastro/);
    assert.match(textoEvento(pg, 1), /Setor:? Produção/);
    for (const id of [1, 2]) {
      assert.equal(textoEvento(pg, id).includes('→'), false, 'registro inicial não tem anterior');
      assert.equal(SUJEIRA.test(textoEvento(pg, id)), false);
    }
  });

  test('C2.3 valor nulo vira "—"; campo desconhecido não aparece; responsável indisponível "—"', async () => {
    const pg = await abrirCom({ cadastral: { 11: [evento(1, { responsavel: null, alteracoes: [A('matricula', null, 'M-9'), A('cpf', '52998224725', '11144477735')] })] } });
    const t = textoEvento(pg, 1);
    assert.match(t, /Matrícula:? — → M-9/);
    assert.match(t, /Responsável:? —/);
    for (const proibido of ['cpf', '52998224725', '11144477735']) assert.equal(t.includes(proibido), false, proibido);
    assert.equal(SUJEIRA.test(t), false, t);
  });

  test('C2.4 ordem do servidor; vazio (resposta válida) com a mensagem neutra e sem paginação', async () => {
    const ordem = await abrirCom({ cadastral: { 11: [evento(3), evento(2), evento(1)] } });
    assert.deepEqual(ids(ordem), ['3', '2', '1']);
    const vazio = await abrirCom({ cadastral: { 11: [] } });
    assert.ok(areaCad(vazio).includes(VAZIO), areaCad(vazio));
    assert.equal(usavel(vazio, 'historyCadastralProxima'), false);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('C3 — paginação real', () => {
  const pagina = (p) => okEventos(11, 'CADASTRAL', Array.from({ length: p === 1 ? 20 : 2 }, (_, k) => evento(1000 - (p - 1) * 20 - k)), { total: 22, pagina: p });

  test('C3.1 só a primeira página; próxima pelo total; na última não há próxima; sempre a mesma pessoa', async () => {
    const pg = await abrirCom({ cadastral: { 11: pagina } });
    assert.equal(chamadasCad(pg).length, 1);
    assert.ok(usavel(pg, 'historyCadastralProxima'));
    assert.equal(usavel(pg, 'historyCadastralAnterior'), false);
    assert.match(limpo(pg.el('historyCadastralPagina').textContent), /1\D+2/);
    await pg.el('historyCadastralProxima').disparar('click');
    await assentar(pg);
    const ultima = chamadasCad(pg).at(-1);
    assert.deepEqual([ultima.caminho, param(ultima, 'pagina')], ['/funcionarios/11/eventos', '2']);
    assert.equal(ids(pg)[0], '980');
    assert.equal(usavel(pg, 'historyCadastralProxima'), false);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('C4 — erros', () => {
  for (const [nome, falha] of [['500', erro(500, 'ERRO_INTERNO')], ['rede', new Error('rede')], ['corpo vazio', { status: 200, corpo: {} }],
    ['404', erro(404, 'FUNCIONARIO_NAO_ENCONTRADO')], ['de outro funcionário', okEventos(99, 'CADASTRAL', [evento(1)])]]) {
    test(`C4 ${nome}: falha só na seção cadastral, nunca "nenhuma alteração"; ficha, GHE e situação intactos; nova tentativa possível`, async () => {
      const pg = await abrirCom({ cadastral: { 11: falha } });
      assert.match(areaCad(pg), /não foi possível/i, areaCad(pg));
      assert.equal(areaCad(pg).includes(VAZIO), false);
      assert.deepEqual(ids(pg), []);
      assert.equal(pg.el('historyEmployeeName').value, 'Pessoa 11');
      assert.equal(pg.consulta('#historyGheTimeline [data-evento-id]').length, 1);
      assert.equal(pg.consulta('#historySituacaoTimeline [data-evento-id]').length, 1);
      assert.ok(usavel(pg, 'historyCadastralTentar'));
    });
  }

  test('C4.1 tentar de novo refaz só a consulta cadastral do mesmo funcionário', async () => {
    let falhar = true;
    const pg = await abrirCom({ cadastral: { 11: () => (falhar ? erro(500, 'ERRO_INTERNO') : okEventos(11, 'CADASTRAL', [evento(7)])) } });
    const detalhes = pg.chamadas.filter((c) => c.caminho === '/funcionarios/11').length;
    falhar = false;
    await pg.el('historyCadastralTentar').disparar('click');
    await assentar(pg);
    assert.deepEqual(ids(pg), ['7']);
    assert.equal(pg.chamadas.filter((c) => c.caminho === '/funcionarios/11').length, detalhes);
  });

  test('C4.2 403: "sem permissão" na seção; 401: sessão encerrada e ida ao Portal', async () => {
    const negado = await abrirCom({ cadastral: { 11: erro(403, 'SEM_PERMISSAO') } });
    assert.match(areaCad(negado), /permiss/i);
    assert.equal(areaCad(negado).includes(VAZIO), false);
    const sessao = await abrirCom({ cadastral: { 11: erro(401, 'SESSAO_INVALIDA') } });
    assert.ok(sessao.navegacoes.some((d) => /portal\/index\.html/.test(d)), String(sessao.navegacoes));
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('C5 — respostas atrasadas e limites', () => {
  test('C5.1 histórico de A atrasado: B escolhido mostra só B; o de A que chega depois é descartado', async () => {
    const a = adiada();
    const pg = await abrir({ lista: [funcionario(11), funcionario(12)], cadastral: { 11: async () => { await a.p; return okEventos(11, 'CADASTRAL', [evento(111)]); }, 12: [evento(122)] } });
    await buscar(pg, 'Pessoa');
    const pendente = clicarSelecionar(pg, 11);
    await assentar(pg);
    assert.equal(chamadasCad(pg).length, 1);
    await selecionar(pg, 12);
    a.liberar();
    await pendente;
    await assentar(pg);
    assert.deepEqual(ids(pg), ['122']);
  });

  test('C5.2 Limpar e nova pesquisa descartam o pendente; a seção volta a ficar oculta', async () => {
    for (const acao of ['limpar', 'pesquisar']) {
      const a = adiada();
      const pg = await abrir({
        lista: (c) => (new URL(c.url).searchParams.get('busca') === 'Pessoa' ? okLista([funcionario(11)]) : okLista([])),
        cadastral: { 11: async () => { await a.p; return okEventos(11, 'CADASTRAL', [evento(111)]); } },
      });
      pg.el('historySearchValue').value = 'Pessoa';
      const pendente = pg.el('botaoConsultar').disparar('click');
      await assentar(pg);
      assert.equal(chamadasCad(pg).length, 1, acao);
      if (acao === 'limpar') await pg.el('botaoLimparHistorico').disparar('click');
      else await buscar(pg, 'Ninguém');
      await assentar(pg);
      a.liberar();
      await pendente;
      await assentar(pg);
      assert.deepEqual(ids(pg), [], acao);
      assert.equal(visivel(pg, 'historyCadastralTimeline'), false, acao);
    }
  });

  test('C5.3 montada com nós e texto (sem innerHTML); nenhum CPF na área; sem escrita nem exportação', async () => {
    const pg = await abrirCom();
    assert.deepEqual(ids(pg), ['911']);
    assert.equal(pg.documento.usosDeInnerHTML.some((u) => u.id === 'historyCadastralTimeline'), false);
    assert.equal(/\*\*\*\.\*\*\*/.test(areaCad(pg)), false);
    assert.equal(pg.chamadas.some((c) => !['GET', 'POST'].includes(c.metodo) || (c.metodo === 'POST' && c.caminho !== '/funcionarios/consulta-cpf')), false);
  });
});
