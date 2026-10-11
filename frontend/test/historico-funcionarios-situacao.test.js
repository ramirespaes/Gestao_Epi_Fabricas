'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { abrirPagina, ler, semComentariosHtml } = require('./helpers/dom-pagina');

/**
 * Histórico de Funcionários — pacote F (RED): seção "Histórico de Situação".
 *
 * Fonte: GET /funcionarios/:id/eventos?tipo=SITUACAO&pagina=&limite= (mesmo endpoint e envelope do pacote E), pelo id
 * interno do funcionário identificado. Cartão próprio, separado da linha do tempo de EPIs e do histórico de GHE, sujeito
 * à exibição condicional. Contrato de tela: cartão com o título "Histórico de Situação"; #historySituacaoTimeline; cada
 * evento [data-evento-id]; paginação #historySituacaoAnterior, #historySituacaoProxima, #historySituacaoPagina; nova
 * tentativa #historySituacaoTentar. Vazio (resposta válida): "Nenhuma alteração de situação registrada para este
 * colaborador.". Por evento: data e hora (São Paulo), tipo ("Cadastro", "Importação", "Alteração"), "Situação inicial:"
 * ou "Situação anterior:" / "Situação nova:" com Ativo, Afastado ou Inativo, e responsável (nome, ou "—").
 * Fixtures sintéticas.
 */

const ARQUIVO = 'pages/employee-history.html';
const VAZIO = 'Nenhuma alteração de situação registrada para este colaborador.';

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
const okFichas = () => ({ status: 200, corpo: { status: 'ok', fichas: [], total: 0, pagina: 1, limite: 1 } });
const evento = (id, extra = {}) => ({
  id: String(id), tipo: 'ALTERACAO', ocorridoEm: '2026-04-11T01:15:00.000Z', anterior: 'ATIVO', novo: 'AFASTADO', responsavel: { id: 7, nome: 'Responsável Fictício' }, ...extra,
});
const okEventos = (funcionarioId, tipo, eventos, { total = eventos.length, pagina = 1, limite = 20 } = {}) => ({
  status: 200, corpo: { status: 'ok', funcionarioId, tipo, eventos, total, pagina, limite },
});

/** situacao: { id: array | resposta | função(pagina) }; o histórico de GHE responde vazio. */
function rotas({ lista = [funcionario(11)], situacao = {}, extra = {} } = {}) {
  const r = {
    'GET /funcionarios': Array.isArray(lista) ? okLista(lista) : lista,
    'GET /fichas-epi': okFichas(),
  };
  for (const id of [11, 12]) {
    r[`GET /funcionarios/${id}`] = okDetalhe(funcionario(id));
    const s = situacao[id] ?? [evento(900 + id)];
    r[`GET /funcionarios/${id}/eventos`] = (c) => {
      const q = new URL(c.url).searchParams;
      if (q.get('tipo') !== 'SITUACAO') return okEventos(id, q.get('tipo'), []);
      if (Array.isArray(s)) return okEventos(id, 'SITUACAO', s);
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
const areaSit = (pg) => (existe(pg, 'historySituacaoTimeline') ? limpo(pg.el('historySituacaoTimeline').textContent) : '');
const ids = (pg) => pg.consulta('#historySituacaoTimeline [data-evento-id]').map((e) => e.getAttribute('data-evento-id'));
const textoEvento = (pg, id) => {
  const e = pg.consulta(`#historySituacaoTimeline [data-evento-id="${id}"]`)[0];
  assert.ok(e, `o evento ${id} não está no histórico de situação (${ids(pg)})`);
  return limpo(e.textContent);
};
const chamadasSit = (pg) => pg.chamadas.filter((c) => c.metodo === 'GET' && /^\/funcionarios\/\d+\/eventos$/.test(c.caminho) && new URL(c.url).searchParams.get('tipo') === 'SITUACAO');
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
describe('S1 — seção própria e fluxo', () => {
  test('S1.1 a página tem um cartão "Histórico de Situação" com #historySituacaoTimeline', () => {
    const html = semComentariosHtml(ler(ARQUIVO));
    assert.match(html, /<h2>Histórico de Situação<\/h2>/);
    assert.match(html, /id="historySituacaoTimeline"/);
  });

  test('S1.2 identificado o funcionário, consulta GET /funcionarios/:id/eventos?tipo=SITUACAO&pagina=1&limite=20 pelo id interno', async () => {
    const pg = await abrirCom();
    const c = chamadasSit(pg);
    assert.equal(c.length, 1, String(pg.chamadas.map((x) => x.url)));
    assert.equal(c[0].caminho, '/funcionarios/11/eventos');
    assert.deepEqual([param(c[0], 'pagina'), param(c[0], 'limite')], ['1', '20']);
    assert.deepEqual(ids(pg), ['911']);
  });

  test('S1.3 segue a exibição condicional: oculta antes da escolha, visível depois; sem consulta antes da escolha', async () => {
    const pg = await abrir({ lista: [funcionario(11), funcionario(12)] });
    assert.equal(existe(pg, 'historySituacaoTimeline'), true);
    assert.equal(visivel(pg, 'historySituacaoTimeline'), false);
    await buscar(pg, 'Pessoa');
    assert.equal(visivel(pg, 'historySituacaoTimeline'), false);
    assert.equal(chamadasSit(pg).length, 0);
    await selecionar(pg, 12);
    assert.equal(visivel(pg, 'historySituacaoTimeline'), true);
    assert.equal(chamadasSit(pg)[0].caminho, '/funcionarios/12/eventos');
  });

  test('S1.4 situação, GHE e entregas em seções separadas, sem se misturar', async () => {
    const pg = await abrirCom();
    assert.equal(pg.consulta('#historyGheTimeline [data-evento-id="911"]').length, 0);
    assert.equal(pg.consulta('#historyTimeline [data-evento-id]').length, 0);
    assert.deepEqual(ids(pg), ['911']);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('S2 — conteúdo de cada evento', () => {
  test('S2.1 alteração: data e hora em São Paulo, "Alteração", situação anterior e nova com rótulos, responsável', async () => {
    const pg = await abrirCom({ situacao: { 11: [evento(1)] } });
    const t = textoEvento(pg, 1);
    assert.match(t, /10\/04\/2026/);
    assert.match(t, /22:15/);
    assert.match(t, /Alteração/);
    assert.match(t, /Situação anterior:? Ativo/);
    assert.match(t, /Situação nova:? Afastado/);
    assert.match(t, /Responsável Fictício/);
    assert.equal(/ATIVO|AFASTADO|INATIVO|ALTERACAO/.test(t), false, 'nunca o código cru');
    assert.equal(SUJEIRA.test(t), false, t);
  });

  test('S2.2 cadastro e importação: "Situação inicial", sem situação anterior', async () => {
    const pg = await abrirCom({ situacao: { 11: [evento(2, { tipo: 'IMPORTACAO', anterior: null, novo: 'ATIVO' }), evento(1, { tipo: 'CADASTRO', anterior: null, novo: 'INATIVO' })] } });
    assert.match(textoEvento(pg, 2), /Importação/);
    assert.match(textoEvento(pg, 2), /Situação inicial:? Ativo/);
    assert.match(textoEvento(pg, 1), /Cadastro/);
    assert.match(textoEvento(pg, 1), /Situação inicial:? Inativo/);
    for (const id of [1, 2]) {
      assert.equal(/Situação anterior/.test(textoEvento(pg, id)), false);
      assert.equal(SUJEIRA.test(textoEvento(pg, id)), false);
    }
  });

  test('S2.3 responsável indisponível: "—"; situação desconhecida não aparece crua', async () => {
    const pg = await abrirCom({ situacao: { 11: [evento(1, { responsavel: null, novo: 'SUSPENSO' })] } });
    const t = textoEvento(pg, 1);
    assert.match(t, /Responsável:? —/);
    assert.equal(t.includes('SUSPENSO'), false);
    assert.equal(SUJEIRA.test(t), false, t);
  });

  test('S2.4 ordem do servidor; vazio (resposta válida) com a mensagem neutra e sem paginação', async () => {
    const ordem = await abrirCom({ situacao: { 11: [evento(3), evento(2), evento(1)] } });
    assert.deepEqual(ids(ordem), ['3', '2', '1']);
    const vazio = await abrirCom({ situacao: { 11: [] } });
    assert.ok(areaSit(vazio).includes(VAZIO), areaSit(vazio));
    assert.equal(usavel(vazio, 'historySituacaoProxima'), false);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('S3 — paginação real', () => {
  const pagina = (p) => okEventos(11, 'SITUACAO', Array.from({ length: p === 1 ? 20 : 3 }, (_, k) => evento(1000 - (p - 1) * 20 - k)), { total: 23, pagina: p });

  test('S3.1 só a primeira página; próxima pelo total; na página 2 (última) não há próxima; sempre a mesma pessoa e o tipo SITUACAO', async () => {
    const pg = await abrirCom({ situacao: { 11: pagina } });
    assert.equal(chamadasSit(pg).length, 1);
    assert.ok(usavel(pg, 'historySituacaoProxima'));
    assert.equal(usavel(pg, 'historySituacaoAnterior'), false);
    assert.match(limpo(pg.el('historySituacaoPagina').textContent), /1\D+2/);
    await pg.el('historySituacaoProxima').disparar('click');
    await assentar(pg);
    const ultima = chamadasSit(pg).at(-1);
    assert.deepEqual([ultima.caminho, param(ultima, 'pagina')], ['/funcionarios/11/eventos', '2']);
    assert.equal(ids(pg)[0], '980');
    assert.equal(usavel(pg, 'historySituacaoProxima'), false);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('S4 — erros', () => {
  for (const [nome, falha] of [['500', erro(500, 'ERRO_INTERNO')], ['rede', new Error('rede')], ['corpo vazio', { status: 200, corpo: {} }],
    ['de outro funcionário', okEventos(99, 'SITUACAO', [evento(1)])]]) {
    test(`S4 ${nome}: falha só na seção de situação, nunca "nenhuma alteração"; ficha intacta; nova tentativa possível`, async () => {
      const pg = await abrirCom({ situacao: { 11: falha } });
      assert.match(areaSit(pg), /não foi possível/i, areaSit(pg));
      assert.equal(areaSit(pg).includes(VAZIO), false);
      assert.deepEqual(ids(pg), []);
      assert.equal(pg.el('historyEmployeeName').value, 'Pessoa 11');
      assert.ok(usavel(pg, 'historySituacaoTentar'));
    });
  }

  test('S4.1 tentar de novo refaz só a consulta de situação do mesmo funcionário', async () => {
    let falhar = true;
    const pg = await abrirCom({ situacao: { 11: () => (falhar ? erro(500, 'ERRO_INTERNO') : okEventos(11, 'SITUACAO', [evento(7)])) } });
    const detalhes = pg.chamadas.filter((c) => c.caminho === '/funcionarios/11').length;
    falhar = false;
    await pg.el('historySituacaoTentar').disparar('click');
    await assentar(pg);
    assert.deepEqual(ids(pg), ['7']);
    assert.equal(pg.chamadas.filter((c) => c.caminho === '/funcionarios/11').length, detalhes);
  });

  test('S4.2 403: "sem permissão" na seção; 401: sessão encerrada e ida ao Portal', async () => {
    const negado = await abrirCom({ situacao: { 11: erro(403, 'SEM_PERMISSAO') } });
    assert.match(areaSit(negado), /permiss/i);
    assert.equal(areaSit(negado).includes(VAZIO), false);
    const sessao = await abrirCom({ situacao: { 11: erro(401, 'SESSAO_INVALIDA') } });
    assert.ok(sessao.navegacoes.some((d) => /portal\/index\.html/.test(d)), String(sessao.navegacoes));
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('S5 — respostas atrasadas e limites', () => {
  test('S5.1 situação de A atrasada: B escolhido mostra só B; a de A que chega depois é descartada', async () => {
    const a = adiada();
    const pg = await abrir({ lista: [funcionario(11), funcionario(12)], situacao: { 11: async () => { await a.p; return okEventos(11, 'SITUACAO', [evento(111)]); }, 12: [evento(122)] } });
    await buscar(pg, 'Pessoa');
    const pendente = clicarSelecionar(pg, 11);
    await assentar(pg);
    assert.equal(chamadasSit(pg).length, 1);
    await selecionar(pg, 12);
    a.liberar();
    await pendente;
    await assentar(pg);
    assert.deepEqual(ids(pg), ['122']);
  });

  test('S5.2 Limpar e nova pesquisa descartam a situação pendente; a seção volta a ficar oculta', async () => {
    for (const acao of ['limpar', 'pesquisar']) {
      const a = adiada();
      const pg = await abrir({
        lista: (c) => (new URL(c.url).searchParams.get('busca') === 'Pessoa' ? okLista([funcionario(11)]) : okLista([])),
        situacao: { 11: async () => { await a.p; return okEventos(11, 'SITUACAO', [evento(111)]); } },
      });
      pg.el('historySearchValue').value = 'Pessoa';
      const pendente = pg.el('botaoConsultar').disparar('click');
      await assentar(pg);
      assert.equal(chamadasSit(pg).length, 1, acao);
      if (acao === 'limpar') await pg.el('botaoLimparHistorico').disparar('click');
      else await buscar(pg, 'Ninguém');
      await assentar(pg);
      a.liberar();
      await pendente;
      await assentar(pg);
      assert.deepEqual(ids(pg), [], acao);
      assert.equal(visivel(pg, 'historySituacaoTimeline'), false, acao);
    }
  });

  test('S5.3 montada com nós e texto (sem innerHTML), sem escrita nem exportação', async () => {
    const pg = await abrirCom();
    assert.deepEqual(ids(pg), ['911']);
    assert.equal(pg.documento.usosDeInnerHTML.some((u) => u.id === 'historySituacaoTimeline'), false);
    assert.equal(pg.chamadas.some((c) => !['GET', 'POST'].includes(c.metodo) || (c.metodo === 'POST' && c.caminho !== '/funcionarios/consulta-cpf')), false);
  });
});
