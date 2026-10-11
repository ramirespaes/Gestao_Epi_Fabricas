'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { abrirPagina, ler, semComentariosHtml } = require('./helpers/dom-pagina');

/**
 * Histórico de Funcionários — pacote E (RED): seção "Histórico de GHE".
 *
 * Fonte: GET /funcionarios/:id/eventos?tipo=GHE&pagina=&limite= (contrato proposto no RED do backend), pelo id interno
 * do funcionário identificado. Seção própria, separada da linha do tempo de EPIs, e sujeita à exibição condicional.
 * Contrato de tela fixado: cartão com o título "Histórico de GHE"; #historyGheTimeline; cada evento
 * [data-evento-id="<id>"]; paginação #historyGheAnterior, #historyGheProxima, #historyGhePagina; nova tentativa
 * #historyGheTentar. Vazio (resposta válida): "Nenhuma alteração de GHE registrada para este colaborador.".
 * Por evento: data e hora (São Paulo), tipo ("Cadastro", "Importação", "Alteração"), GHE anterior → novo
 * ("<código> — <descrição>", "Sem GHE" para null) e responsável (nome, ou "—").
 * A apresentação do GHE registrado só com o id (código e descrição null) depende de decisão de produto e não é fixada
 * aqui além de "nada sujo". Fixtures sintéticas.
 */

const ARQUIVO = 'pages/employee-history.html';
const VAZIO_GHE = 'Nenhuma alteração de GHE registrada para este colaborador.';

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
const resumo = { totalEntregas: 1, totalItens: 1, ultimaEntregaEm: '2026-03-11T01:30:00.000Z', episDistintos: 1, episDentroPrazoUso: 1 };
const okFichas = (id) => ({
  status: 200,
  corpo: { status: 'ok', fichas: [{ id: 500 + id, numero: 1, funcionarioId: id, criadaEm: '2026-01-02T12:00:00.000Z', funcionarioAtual: { id }, resumo }], total: 1, pagina: 1, limite: 1 },
});
const okEntregas = (id) => ({
  status: 200,
  corpo: {
    status: 'ok', ficha: { id: 500 + id, numero: 1, funcionarioId: id }, total: 1, pagina: 1, limite: 20,
    entregas: [{
      id: 30, ficha: { id: 500 + id, numero: 1, funcionarioId: id }, origem: 'DIRETA', entregueEm: '2026-03-10T13:30:00.000Z', dataOperacional: '2026-03-10',
      empresa: { nome: 'E', cnpj: '11222333000181', endereco: null, cidade: null, uf: null }, trabalhador: { nome: 'T', matricula: null, funcao: null, setor: null },
      ghe: null, responsavel: { id: 7, nome: 'Responsável Entrega' }, confirmacao: null,
      itens: [{ id: 300, materialId: 40, loteId: 70, quantidade: 1, motivo: 'ADMISSAO', justificativa: null, previstoNoGhe: true, justificativaForaGhe: null,
        material: { nome: 'Luva Fictícia', tipo: 'Luva', codigoInterno: 'LUV-1', unidade: 'PAR', prazoUsoDias: 30, oculosComGrau: false, exigeCa: true },
        lote: { tamanho: 'M', caNumero: '1', caValidade: '2030-01-01' }, operacaoId: 1 }],
    }],
  },
});
const G = (id, codigo, descricao) => ({ id, codigo, descricao });
const evento = (id, extra = {}) => ({
  id: String(id), tipo: 'ALTERACAO', ocorridoEm: '2026-04-11T01:15:00.000Z', anterior: G(20, 'GHE-020', 'Soldagem'), novo: G(10, 'GHE-010', 'Caldeiraria'),
  responsavel: { id: 7, nome: 'Responsável Fictício' }, ...extra,
});
const okEventos = (funcionarioId, eventos, { total = eventos.length, pagina = 1, limite = 20 } = {}) => ({
  status: 200, corpo: { status: 'ok', funcionarioId, tipo: 'GHE', eventos, total, pagina, limite },
});

/** eventos: { id: array | resposta | função(pagina, chamada) }. */
function rotas({ lista = [funcionario(11)], eventos = {}, extra = {} } = {}) {
  const r = {
    'GET /funcionarios': Array.isArray(lista) ? okLista(lista) : lista,
    'GET /fichas-epi': (c) => okFichas(Number(new URL(c.url).searchParams.get('funcionarioId'))),
  };
  for (const id of [11, 12]) {
    r[`GET /funcionarios/${id}`] = okDetalhe(funcionario(id));
    r[`GET /fichas-epi/${500 + id}/entregas`] = okEntregas(id);
    const e = eventos[id] ?? [evento(900 + id)];
    r[`GET /funcionarios/${id}/eventos`] = Array.isArray(e) ? okEventos(id, e)
      : typeof e === 'function' ? (c) => e(Number(new URL(c.url).searchParams.get('pagina') || 1), c) : e;
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
const areaGhe = (pg) => (existe(pg, 'historyGheTimeline') ? limpo(pg.el('historyGheTimeline').textContent) : '');
const idsEventos = (pg) => pg.consulta('#historyGheTimeline [data-evento-id]').map((e) => e.getAttribute('data-evento-id'));
const textoEvento = (pg, id) => {
  const e = pg.consulta(`#historyGheTimeline [data-evento-id="${id}"]`)[0];
  assert.ok(e, `o evento ${id} não está no histórico de GHE (${idsEventos(pg)})`);
  return limpo(e.textContent);
};
// Pacote F: o mesmo endpoint também serve tipo=SITUACAO; aqui contam só as consultas de GHE.
const chamadasEventos = (pg) => pg.chamadas.filter((c) => c.metodo === 'GET' && /^\/funcionarios\/\d+\/eventos$/.test(c.caminho)
  && new URL(c.url).searchParams.get('tipo') === 'GHE');
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
describe('G1 — seção própria e fluxo', () => {
  test('G1.1 a página tem um cartão "Histórico de GHE" com #historyGheTimeline, fora da linha do tempo de EPIs', () => {
    const html = semComentariosHtml(ler(ARQUIVO));
    assert.match(html, /<h2>Histórico de GHE<\/h2>/);
    assert.match(html, /id="historyGheTimeline"/);
  });

  test('G1.2 identificado o funcionário, consulta GET /funcionarios/:id/eventos?tipo=GHE&pagina=1&limite=20 pelo id interno', async () => {
    const pg = await abrirCom();
    const c = chamadasEventos(pg);
    assert.equal(c.length, 1, String(pg.chamadas.map((x) => x.url)));
    assert.equal(c[0].caminho, '/funcionarios/11/eventos');
    assert.deepEqual([param(c[0], 'tipo'), param(c[0], 'pagina'), param(c[0], 'limite')], ['GHE', '1', '20']);
    assert.deepEqual(idsEventos(pg), ['911']);
  });

  test('G1.3 a seção segue a exibição condicional: oculta na tela inicial e com vários resultados; visível depois da escolha', async () => {
    const pg = await abrir({ lista: [funcionario(11), funcionario(12)] });
    assert.equal(existe(pg, 'historyGheTimeline'), true, 'a seção existe');
    assert.equal(visivel(pg, 'historyGheTimeline'), false, 'oculta antes da pesquisa');
    await buscar(pg, 'Pessoa');
    assert.equal(visivel(pg, 'historyGheTimeline'), false, 'oculta com a lista de resultados');
    assert.equal(chamadasEventos(pg).length, 0, 'nenhuma consulta antes da escolha');
    await selecionar(pg, 12);
    assert.equal(visivel(pg, 'historyGheTimeline'), true);
    assert.equal(chamadasEventos(pg)[0].caminho, '/funcionarios/12/eventos');
  });

  test('G1.4 eventos de GHE e entregas de EPI não se misturam', async () => {
    const pg = await abrirCom();
    assert.equal(pg.consulta('#historyTimeline [data-evento-id]').length, 0, 'nenhum evento de GHE na linha do tempo de EPIs');
    assert.equal(pg.consulta('#historyGheTimeline [data-entrega-id]').length, 0, 'nenhuma entrega no histórico de GHE');
    assert.equal(pg.consulta('#historyTimeline [data-entrega-id]').length, 1, 'as entregas continuam');
  });

  test('G1.5 a ficha, os quatro indicadores e as entregas continuam intactos', async () => {
    const pg = await abrirCom();
    assert.equal(pg.el('historyEmployeeName').value, 'Pessoa 11');
    assert.deepEqual(['hkpiTotal', 'hkpiEpis', 'hkpiUltima', 'hkpiAtivos'].map((id) => limpo(pg.el(id).textContent)), ['1', '1', '10/03/2026', '1']);
    assert.deepEqual(idsEventos(pg), ['911']);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('G2 — conteúdo de cada evento', () => {
  test('G2.1 alteração: data e hora em São Paulo, "Alteração", GHE anterior → novo com código e descrição, responsável', async () => {
    // 01:15 UTC de 11/04 = 22:15 de 10/04 em São Paulo.
    const pg = await abrirCom({ eventos: { 11: [evento(1)] } });
    const t = textoEvento(pg, 1);
    assert.match(t, /10\/04\/2026/);
    assert.match(t, /22:15/);
    assert.equal(/11\/04\/2026/.test(t), false, 'a data não é a de UTC');
    assert.match(t, /Alteração/);
    assert.match(t, /GHE-020 — Soldagem[\s\S]*GHE-010 — Caldeiraria/, 'anterior antes do novo');
    assert.match(t, /Responsável Fictício/);
    assert.equal(SUJEIRA.test(t), false, t);
  });

  test('G2.2 cadastro e importação: rótulos próprios; sem GHE anterior não aparece "null"', async () => {
    const pg = await abrirCom({ eventos: { 11: [
      evento(2, { tipo: 'IMPORTACAO', anterior: null, novo: G(10, 'GHE-010', 'Caldeiraria') }),
      evento(1, { tipo: 'CADASTRO', anterior: null, novo: G(20, 'GHE-020', 'Soldagem') }),
    ] } });
    assert.match(textoEvento(pg, 2), /Importação/);
    assert.match(textoEvento(pg, 1), /Cadastro/);
    for (const id of [1, 2]) assert.equal(SUJEIRA.test(textoEvento(pg, id)), false, textoEvento(pg, id));
    assert.equal(/IMPORTACAO|CADASTRO|ALTERACAO/.test(areaGhe(pg)), false, 'nunca o código cru');
  });

  test('G2.3 GHE nulo vira "Sem GHE"; GHE sem código mostra só a descrição', async () => {
    const pg = await abrirCom({ eventos: { 11: [evento(1, { anterior: null, novo: G(30, null, 'Legado sem código') })] } });
    const t = textoEvento(pg, 1);
    assert.match(t, /Sem GHE/);
    assert.match(t, /Legado sem código/);
    assert.equal(SUJEIRA.test(t), false, t);
  });

  test('G2.4 responsável indisponível: "—", nada inventado', async () => {
    const pg = await abrirCom({ eventos: { 11: [evento(1, { responsavel: null })] } });
    const t = textoEvento(pg, 1);
    assert.match(t, /Responsável:? —/);
    assert.equal(SUJEIRA.test(t), false, t);
  });

  test('G2.5 GHE registrado só com o id (evento legado): nada sujo e o id interno não é apresentado como código', async () => {
    const pg = await abrirCom({ eventos: { 11: [evento(1, { anterior: G(20, null, null), novo: G(10, null, null) })] } });
    const t = textoEvento(pg, 1);
    assert.equal(SUJEIRA.test(t), false, t);
    assert.equal(/\b(10|20)\b/.test(t.replace(/\d{2}\/\d{2}\/\d{4}|\d{2}:\d{2}/g, '')), false, `o id interno não vira código: ${t}`);
  });

  test('G2.6 só os campos do contrato são lidos: campos extras da resposta nunca aparecem', async () => {
    const pg = await abrirCom({ eventos: { 11: [evento(1, { contexto: { ip: '203.0.113.9' }, dispositivo: 'Navegador X', cpf: '52998224725' })] } });
    const t = areaGhe(pg);
    for (const p of ['203.0.113.9', 'Navegador X', '52998224725']) assert.equal(t.includes(p), false, p);
  });

  test('G2.7 ordem do servidor (mais recente primeiro), sem reordenar', async () => {
    const pg = await abrirCom({ eventos: { 11: [evento(3, { ocorridoEm: '2026-05-01T12:00:00.000Z' }), evento(2, { ocorridoEm: '2026-05-01T12:00:00.000Z' }), evento(1, { ocorridoEm: '2025-01-01T12:00:00.000Z' })] } });
    assert.deepEqual(idsEventos(pg), ['3', '2', '1']);
  });

  // GREEN E (decisão aprovada): GHE gravado só pelo id usa a identificação ATUAL, sempre marcada como tal.
  test('G2.9 só id + identificação atual: "<código> — <descrição> (identificação atual)"; sem ela, "GHE histórico sem identificação disponível"', async () => {
    const pg = await abrirCom({ eventos: { 11: [
      evento(2, { anterior: { id: 20, codigo: null, descricao: null, atual: { codigo: 'GHE-020', descricao: 'Soldagem' } }, novo: { id: 10, codigo: null, descricao: null, atual: null } }),
      evento(1, { tipo: 'CADASTRO', anterior: null, novo: { id: 30, codigo: null, descricao: null, atual: { codigo: null, descricao: 'Legado sem código' } } }),
    ] } });
    const alteracao = textoEvento(pg, 2);
    assert.match(alteracao, /GHE-020 — Soldagem \(identificação atual\)/);
    assert.match(alteracao, /GHE histórico sem identificação disponível/);
    assert.match(textoEvento(pg, 1), /Legado sem código \(identificação atual\)/);
    for (const id of [1, 2]) assert.equal(SUJEIRA.test(textoEvento(pg, id)), false, textoEvento(pg, id));
  });

  test('G2.10 GHE registrado na época prevalece: nunca é trocado pela identificação atual nem leva o aviso', async () => {
    const pg = await abrirCom({ eventos: { 11: [evento(1, { novo: { id: 10, codigo: 'GHE-010', descricao: 'Caldeiraria', atual: { codigo: 'GHE-011', descricao: 'Renomeada' } } })] } });
    const t = textoEvento(pg, 1);
    assert.match(t, /GHE-010 — Caldeiraria/);
    assert.equal(/identificação atual|Renomeada|GHE-011/.test(t), false, t);
  });

  test('G2.8 funcionário sem eventos (resposta válida): mensagem neutra, sem erro e sem paginação', async () => {
    const pg = await abrirCom({ eventos: { 11: [] } });
    assert.ok(areaGhe(pg).includes(VAZIO_GHE), areaGhe(pg));
    assert.equal(usavel(pg, 'historyGheProxima'), false);
    assert.equal(usavel(pg, 'historyGheTentar'), false);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('G3 — paginação real', () => {
  const pagina = (p) => okEventos(11, Array.from({ length: p === 1 ? 20 : 5 }, (_, k) => evento(1000 - (p - 1) * 20 - k)), { total: 25, pagina: p });

  test('G3.1 só a primeira página; próxima pela metadado total; anterior indisponível na primeira', async () => {
    const pg = await abrirCom({ eventos: { 11: pagina } });
    assert.equal(chamadasEventos(pg).length, 1);
    assert.equal(idsEventos(pg).length, 20);
    assert.ok(usavel(pg, 'historyGheProxima'));
    assert.equal(usavel(pg, 'historyGheAnterior'), false);
    assert.match(limpo(pg.el('historyGhePagina').textContent), /1\D+2/);
  });

  test('G3.2 próxima página pede pagina=2 do MESMO funcionário; na última não há próxima', async () => {
    const pg = await abrirCom({ eventos: { 11: pagina } });
    await pg.el('historyGheProxima').disparar('click');
    await assentar(pg);
    const ultima = chamadasEventos(pg).at(-1);
    assert.deepEqual([ultima.caminho, param(ultima, 'pagina'), param(ultima, 'tipo')], ['/funcionarios/11/eventos', '2', 'GHE']);
    assert.equal(idsEventos(pg)[0], '980');
    assert.equal(usavel(pg, 'historyGheProxima'), false);
    assert.ok(usavel(pg, 'historyGheAnterior'));
  });

  test('G3.3 total igual a uma página: nenhuma próxima falsa', async () => {
    const pg = await abrirCom({ eventos: { 11: () => okEventos(11, Array.from({ length: 20 }, (_, k) => evento(500 - k)), { total: 20 }) } });
    assert.equal(idsEventos(pg).length, 20);
    assert.equal(usavel(pg, 'historyGheProxima'), false);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('G4 — erros', () => {
  for (const [nome, falha] of [['500', erro(500, 'ERRO_INTERNO')], ['rede', new Error('rede')], ['corpo vazio', { status: 200, corpo: {} }],
    ['de outro funcionário', okEventos(99, [evento(1)])]]) {
    test(`G4 ${nome}: falha só na seção de GHE, nunca "nenhuma alteração"; ficha, indicadores e entregas intactos; nova tentativa possível`, async () => {
      const pg = await abrirCom({ eventos: { 11: falha } });
      assert.match(areaGhe(pg), /não foi possível/i, areaGhe(pg));
      assert.equal(areaGhe(pg).includes(VAZIO_GHE), false);
      assert.deepEqual(idsEventos(pg), []);
      assert.equal(pg.el('historyEmployeeName').value, 'Pessoa 11');
      assert.equal(limpo(pg.el('hkpiTotal').textContent), '1');
      assert.equal(pg.consulta('#historyTimeline [data-entrega-id]').length, 1);
      assert.ok(usavel(pg, 'historyGheTentar'));
    });
  }

  test('G4.1 tentar de novo refaz só a consulta de eventos do MESMO funcionário', async () => {
    let falhar = true;
    const pg = await abrirCom({ eventos: { 11: () => (falhar ? erro(500, 'ERRO_INTERNO') : okEventos(11, [evento(7)])) } });
    const detalhes = pg.chamadas.filter((c) => c.caminho === '/funcionarios/11').length;
    falhar = false;
    await pg.el('historyGheTentar').disparar('click');
    await assentar(pg);
    assert.deepEqual(idsEventos(pg), ['7']);
    assert.equal(chamadasEventos(pg).at(-1).caminho, '/funcionarios/11/eventos');
    assert.equal(pg.chamadas.filter((c) => c.caminho === '/funcionarios/11').length, detalhes, 'a ficha não é relida');
  });

  test('G4.2 403: "sem permissão" na seção, nunca "nenhuma alteração"; a ficha continua', async () => {
    const pg = await abrirCom({ eventos: { 11: erro(403, 'SEM_PERMISSAO') } });
    assert.match(areaGhe(pg), /permiss/i);
    assert.equal(areaGhe(pg).includes(VAZIO_GHE), false);
    assert.equal(pg.el('historyEmployeeName').value, 'Pessoa 11');
  });

  test('G4.3 401: sessão encerrada e ida ao Portal', async () => {
    const pg = await abrirCom({ eventos: { 11: erro(401, 'SESSAO_INVALIDA') } });
    assert.equal(chamadasEventos(pg).length, 1);
    assert.ok(pg.navegacoes.some((d) => /portal\/index\.html/.test(d)), String(pg.navegacoes));
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('G5 — respostas atrasadas, Limpar, nova pesquisa e sessão', () => {
  test('G5.1 eventos de A atrasados: B escolhido mostra só os de B; os de A que chegam depois são descartados', async () => {
    const a = adiada();
    const pg = await abrir({ lista: [funcionario(11), funcionario(12)], eventos: { 11: async () => { await a.p; return okEventos(11, [evento(111)]); }, 12: [evento(122)] } });
    await buscar(pg, 'Pessoa');
    const pendente = clicarSelecionar(pg, 11);
    await assentar(pg);
    assert.equal(chamadasEventos(pg).length, 1, 'os eventos de A foram pedidos');
    await selecionar(pg, 12);
    a.liberar();
    await pendente;
    await assentar(pg);
    assert.deepEqual(idsEventos(pg), ['122']);
  });

  test('G5.2 página 2 de A atrasada: trocar para B descarta a página de A', async () => {
    const a = adiada();
    const pg = await abrir({ lista: [funcionario(11), funcionario(12)], eventos: {
      11: async (p) => { if (p === 2) await a.p; return okEventos(11, [evento(p === 2 ? 112 : 111)], { total: 25, pagina: p }); },
      12: [evento(122)],
    } });
    await buscar(pg, 'Pessoa');
    await selecionar(pg, 11);
    const pendente = pg.el('historyGheProxima').disparar('click');
    await assentar(pg);
    await selecionar(pg, 12);
    a.liberar();
    await pendente;
    await assentar(pg);
    assert.deepEqual(idsEventos(pg), ['122']);
  });

  test('G5.3 erro atrasado de A não aparece para B', async () => {
    const a = adiada();
    const pg = await abrir({ lista: [funcionario(11), funcionario(12)], eventos: { 11: async () => { await a.p; return erro(500, 'ERRO_INTERNO'); }, 12: [evento(122)] } });
    await buscar(pg, 'Pessoa');
    const pendente = clicarSelecionar(pg, 11);
    await assentar(pg);
    await selecionar(pg, 12);
    a.liberar();
    await pendente;
    await assentar(pg);
    assert.deepEqual(idsEventos(pg), ['122']);
    assert.equal(/não foi possível/i.test(areaGhe(pg)), false);
  });

  test('G5.4 Limpar e nova pesquisa descartam eventos pendentes; a seção volta a ficar oculta', async () => {
    for (const acao of ['limpar', 'pesquisar']) {
      const a = adiada();
      const pg = await abrir({
        lista: (c) => (new URL(c.url).searchParams.get('busca') === 'Pessoa' ? okLista([funcionario(11)]) : okLista([])),
        eventos: { 11: async () => { await a.p; return okEventos(11, [evento(111)]); } },
      });
      pg.el('historySearchValue').value = 'Pessoa';
      const pendente = pg.el('botaoConsultar').disparar('click');
      await assentar(pg);
      assert.equal(chamadasEventos(pg).length, 1, `${acao}: eventos pedidos`);
      if (acao === 'limpar') await pg.el('botaoLimparHistorico').disparar('click');
      else await buscar(pg, 'Ninguém');
      await assentar(pg);
      a.liberar();
      await pendente;
      await assentar(pg);
      assert.deepEqual(idsEventos(pg), [], acao);
      assert.equal(visivel(pg, 'historyGheTimeline'), false, acao);
    }
  });

  test('G5.5 sessão encerrada (401 em outra consulta): os eventos pendentes não aparecem depois', async () => {
    const a = adiada();
    const pg = await abrir({ lista: [funcionario(11), funcionario(12)], eventos: { 11: async () => { await a.p; return okEventos(11, [evento(111)]); } },
      extra: { 'GET /funcionarios/12': erro(401, 'SESSAO_INVALIDA') } });
    await buscar(pg, 'Pessoa');
    const pendente = clicarSelecionar(pg, 11);
    await assentar(pg);
    await selecionar(pg, 12);
    assert.ok(pg.navegacoes.some((d) => /portal\/index\.html/.test(d)), String(pg.navegacoes));
    a.liberar();
    await pendente;
    await assentar(pg);
    assert.deepEqual(idsEventos(pg), []);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('G6 — limites', () => {
  test('G6.1 montada com nós e texto (sem innerHTML), sem escrita nem exportação', async () => {
    const pg = await abrirCom();
    assert.deepEqual(idsEventos(pg), ['911']);
    assert.equal(pg.documento.usosDeInnerHTML.some((u) => u.id === 'historyGheTimeline'), false);
    assert.equal(pg.chamadas.some((c) => !['GET', 'POST'].includes(c.metodo) || (c.metodo === 'POST' && c.caminho !== '/funcionarios/consulta-cpf')), false);
  });
});
