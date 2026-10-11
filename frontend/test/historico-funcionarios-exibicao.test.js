'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { abrirPagina } = require('./helpers/dom-pagina');

/**
 * Histórico de Funcionários — exibição condicional da ficha (RED).
 *
 * Antes de um funcionário ser identificado, a página mostra só a pesquisa (Buscar colaborador, campo, Consultar e
 * Limpar). Os seis campos cadastrais, os quatro indicadores e a linha do tempo de EPIs só aparecem depois que o detalhe
 * real do funcionário escolhido (pelo id interno) chega; somem de novo em Limpar, nova pesquisa, falha, nenhum
 * resultado e sessão encerrada, e uma resposta atrasada nunca os traz de volta. Mede-se a VISIBILIDADE dos próprios
 * elementos (ids existentes), não o mecanismo usado para ocultá-los. Fixtures sintéticas.
 */

const ARQUIVO = 'pages/employee-history.html';
const CAMPOS = ['historyEmployeeName', 'historyEmployeeMatricula', 'historySector', 'historyEmployeeFuncao', 'historyEmployeeGhe', 'historyEmployeeSituacao'];
const CARDS = ['hkpiTotal', 'hkpiEpis', 'hkpiUltima', 'hkpiAtivos'];

// ── servidor falso ─────────────────────────────────────────────────
const NENHUMA = { visualizar: false, criar: false, editar: false, excluir: false };
const area = (v) => ({ consultar: v, alterar: v });
const permissoes = (epi) => ({
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
const resumo = { totalEntregas: 2, totalItens: 2, ultimaEntregaEm: '2026-03-11T01:30:00.000Z', episDistintos: 1, episDentroPrazoUso: 1 };
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
      ghe: null, responsavel: { id: 7, nome: 'Responsável Fictício' }, confirmacao: null,
      itens: [{ id: 300, materialId: 40, loteId: 70, quantidade: 1, motivo: 'ADMISSAO', justificativa: null, previstoNoGhe: true, justificativaForaGhe: null,
        material: { nome: 'Luva Fictícia', tipo: 'Luva', codigoInterno: 'LUV-1', unidade: 'PAR', prazoUsoDias: 30, oculosComGrau: false, exigeCa: true },
        lote: { tamanho: 'M', caNumero: '1', caValidade: '2030-01-01' }, operacaoId: 1 }],
    }],
  },
});

/** lista: array (sucesso) ou resposta/função; detalhes: { id: resposta|função } sobrepõe o detalhe padrão. */
function rotas({ lista = [funcionario(11)], porCpf = [funcionario(11)], detalhes = {}, entregas = {} } = {}) {
  const r = {
    'GET /funcionarios': Array.isArray(lista) ? okLista(lista) : lista,
    'POST /funcionarios/consulta-cpf': Array.isArray(porCpf) ? okLista(porCpf) : porCpf,
    'GET /fichas-epi': (c) => okFichas(Number(new URL(c.url).searchParams.get('funcionarioId'))),
  };
  for (const id of [11, 12, 13]) {
    r[`GET /funcionarios/${id}`] = detalhes[id] || okDetalhe(funcionario(id));
    r[`GET /fichas-epi/${500 + id}/entregas`] = entregas[id] || okEntregas(id);
  }
  return r;
}

async function abrir({ epi = true, ...opcoes } = {}) {
  const pg = abrirPagina(ARQUIVO, {
    rotas: {
      'GET /auth/me': { status: 200, corpo: contexto() },
      'GET /auth/global/me': { status: 200, corpo: { status: 'ok', empresas: [{ id: 3 }] } },
      'GET /auth/permissoes': { status: 200, corpo: permissoes(epi) },
      ...rotas(opcoes),
    },
  });
  await pg.esperar();
  await pg.esperar();
  return pg;
}

// ── helpers de tela ────────────────────────────────────────────────
const limpo = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const visivel = (pg, id) => pg.consulta(`#${id}`).length > 0 && pg.visivel(id);
/** O que a pessoa vê das três áreas: true só se TODOS os elementos da área estão visíveis; false se NENHUM está. */
function areas(pg) {
  const estado = (ids) => {
    const v = ids.map((id) => visivel(pg, id));
    if (v.every(Boolean)) return 'visivel';
    if (v.every((x) => !x)) return 'oculta';
    return `parcial(${ids.filter((_, i) => v[i]).join(',')})`;
  };
  return { ficha: estado(CAMPOS), indicadores: estado(CARDS), historico: estado(['historyTimeline']) };
}
const OCULTAS = { ficha: 'oculta', indicadores: 'oculta', historico: 'oculta' };
const VISIVEIS = { ficha: 'visivel', indicadores: 'visivel', historico: 'visivel' };
const detalhes = (pg) => pg.chamadas.filter((c) => c.metodo === 'GET' && /^\/funcionarios\/\d+$/.test(c.caminho)).map((c) => Number(c.caminho.split('/').pop()));
const aviso = (pg) => (pg.consulta('#aviso').length ? limpo(pg.el('aviso').textContent) : '');
async function assentar(pg) { for (let i = 0; i < 4; i += 1) await pg.esperar(); }
async function buscar(pg, valor) {
  pg.el('historySearchValue').value = valor;
  await pg.el('botaoConsultar').disparar('click');
  await assentar(pg);
}
function buscarSemEsperar(pg, valor) {
  pg.el('historySearchValue').value = valor;
  return pg.el('botaoConsultar').disparar('click');
}
function clicarSelecionar(pg, id) {
  const botao = pg.consulta(`#historyResultados [data-id="${id}"]`)[0];
  assert.ok(botao, `o resultado ${id} não está na lista`);
  return botao.disparar('click');
}
async function selecionar(pg, id) { await clicarSelecionar(pg, id); await assentar(pg); }
const adiada = () => { let liberar; const p = new Promise((r) => { liberar = r; }); return { p, liberar: () => liberar() }; };
/** Abre e deixa o funcionário 11 identificado e visível (pré-condição de vários cenários). */
async function comSelecionado(opcoes = {}) {
  const pg = await abrir({ lista: [funcionario(11), funcionario(12)], ...opcoes });
  await buscar(pg, 'Pessoa');
  await selecionar(pg, 11);
  assert.deepEqual(areas(pg), VISIVEIS, 'pré-condição: 11 identificado e visível');
  return pg;
}

// ═══════════════════════════════════════════════════════════════════
describe('X1 — tela inicial: só a pesquisa', () => {
  test('X1.1 ficha, indicadores e histórico ficam ocultos; pesquisa, Consultar e Limpar visíveis; nenhuma consulta', async () => {
    const pg = await abrir();
    assert.deepEqual(areas(pg), OCULTAS);
    for (const id of ['historySearchValue', 'botaoConsultar', 'botaoLimparHistorico']) assert.ok(visivel(pg, id), `#${id} visível`);
    assert.equal(pg.chamadas.some((c) => !c.caminho.startsWith('/auth/')), false);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('X2 — um resultado', () => {
  test('X2.1 resultado único: enquanto o detalhe não chega tudo continua oculto (com aviso de carregamento); depois as três áreas aparecem com os dados reais', async () => {
    const a = adiada();
    const pg = await abrir({ detalhes: { 11: async () => { await a.p; return okDetalhe(funcionario(11)); } } });
    const pendente = buscarSemEsperar(pg, 'Pessoa');
    await assentar(pg);
    assert.deepEqual(detalhes(pg), [11], 'a seleção automática pelo id foi feita');
    assert.deepEqual(areas(pg), OCULTAS, 'antes da identificação, nada da ficha');
    assert.ok(visivel(pg, 'historyFichaEstado') && /carregando/i.test(pg.el('historyFichaEstado').textContent), 'o estado de carregamento continua visível');
    a.liberar();
    await pendente;
    await assentar(pg);
    assert.deepEqual(areas(pg), VISIVEIS);
    assert.equal(pg.el('historyEmployeeName').value, 'Pessoa 11');
    assert.deepEqual(CARDS.map((id) => limpo(pg.el(id).textContent)), ['2', '1', '10/03/2026', '1']);
    assert.equal(pg.consulta('#historyTimeline [data-entrega-id]').length, 1);
  });

  test('X2.2 resultado único por CPF (busca única, POST): mesma regra de exibição', async () => {
    const pg = await abrir({ porCpf: [funcionario(12)] });
    assert.deepEqual(areas(pg), OCULTAS);
    await buscar(pg, '529.982.247-25');
    assert.equal(pg.chamadas.filter((c) => c.caminho === '/funcionarios/consulta-cpf').length, 1);
    assert.deepEqual(areas(pg), VISIVEIS);
    assert.equal(pg.el('historyEmployeeName').value, 'Pessoa 12');
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('X3 — vários resultados e seleção', () => {
  test('X3.1 vários resultados: a lista aparece e a ficha continua oculta até a escolha; escolher mostra as três áreas', async () => {
    const pg = await abrir({ lista: [funcionario(11), funcionario(12)] });
    await buscar(pg, 'Pessoa');
    assert.ok(visivel(pg, 'historyResultados'), 'lista visível');
    assert.deepEqual(detalhes(pg), []);
    assert.deepEqual(areas(pg), OCULTAS);
    await selecionar(pg, 12);
    assert.deepEqual(detalhes(pg), [12]);
    assert.deepEqual(areas(pg), VISIVEIS);
    assert.equal(pg.el('historyEmployeeMatricula').value, 'M-12');
  });

  test('X3.2 sem epiFicha.visualizar: após a escolha aparecem ficha, indicadores neutros e o aviso de sem permissão no histórico', async () => {
    const pg = await abrir({ epi: false, lista: [funcionario(11)] });
    await buscar(pg, 'Pessoa');
    assert.deepEqual(areas(pg), VISIVEIS);
    assert.deepEqual(CARDS.map((id) => limpo(pg.el(id).textContent)), ['—', '—', '—', '—']);
    assert.match(limpo(pg.el('historyTimeline').textContent), /permiss/i);
    assert.equal(pg.chamadas.some((c) => /^\/fichas-epi/.test(c.caminho)), false);
  });

  test('X3.3 falha só do histórico de EPIs: a ficha e os indicadores continuam à vista, com o erro no histórico', async () => {
    const pg = await abrir({ lista: [funcionario(11)], entregas: { 11: erro(500, 'ERRO_INTERNO') } });
    await buscar(pg, 'Pessoa');
    assert.deepEqual(areas(pg), VISIVEIS);
    assert.match(limpo(pg.el('historyTimeline').textContent), /não foi possível/i);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('X4 — Limpar e nova pesquisa', () => {
  test('X4.1 Limpar depois da seleção oculta de novo as três áreas e esvazia os dados', async () => {
    const pg = await comSelecionado();
    await pg.el('botaoLimparHistorico').disparar('click');
    await assentar(pg);
    assert.deepEqual(areas(pg), OCULTAS);
    assert.equal(pg.el('historyEmployeeName').value, '');
    for (const id of ['historySearchValue', 'botaoConsultar', 'botaoLimparHistorico']) assert.ok(visivel(pg, id), `#${id} visível`);
  });

  test('X4.2 nova pesquisa oculta o funcionário anterior já no clique, antes da resposta', async () => {
    const a = adiada();
    let listagens = 0;
    const pg = await comSelecionado({
      lista: async () => { listagens += 1; if (listagens > 1) await a.p; return okLista([funcionario(11), funcionario(12)]); },
    });
    const pendente = buscarSemEsperar(pg, 'Outra');
    await pg.esperar();
    assert.equal(listagens, 2, 'a nova pesquisa está pendente');
    assert.deepEqual(areas(pg), OCULTAS, 'nada do funcionário anterior enquanto a nova pesquisa corre');
    a.liberar();
    await pendente;
    await assentar(pg);
    assert.deepEqual(areas(pg), OCULTAS, 'vários resultados: continua oculta até a escolha');
  });

  test('X4.3 nova pesquisa com vários resultados: lista visível, ficha oculta, nada do anterior', async () => {
    const pg = await comSelecionado();
    await buscar(pg, 'Pessoa');
    assert.ok(visivel(pg, 'historyResultados'));
    assert.deepEqual(areas(pg), OCULTAS);
    assert.equal(pg.el('historyEmployeeName').value, '');
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('X5 — respostas atrasadas e sessão', () => {
  test('X5.1 detalhe atrasado e Limpar: a resposta que chega depois não mostra a ficha', async () => {
    const a = adiada();
    const pg = await abrir({ lista: [funcionario(11), funcionario(12)], detalhes: { 12: async () => { await a.p; return okDetalhe(funcionario(12)); } } });
    await buscar(pg, 'Pessoa');
    const pendente = clicarSelecionar(pg, 12);
    await assentar(pg);
    await pg.el('botaoLimparHistorico').disparar('click');
    await assentar(pg);
    a.liberar();
    await pendente;
    await assentar(pg);
    assert.deepEqual(areas(pg), OCULTAS);
    assert.equal(pg.el('historyEmployeeName').value, '');
  });

  test('X5.2 detalhe atrasado e nova pesquisa sem resultado: a resposta antiga não restaura a ficha', async () => {
    const a = adiada();
    const pg = await abrir({
      lista: (c) => (new URL(c.url).searchParams.get('busca') === 'Pessoa' ? okLista([funcionario(11), funcionario(12)]) : okLista([])),
      detalhes: { 12: async () => { await a.p; return okDetalhe(funcionario(12)); } },
    });
    await buscar(pg, 'Pessoa');
    const pendente = clicarSelecionar(pg, 12);
    await assentar(pg);
    await buscar(pg, 'Ninguém');
    assert.match(aviso(pg), /nenhum/i);
    a.liberar();
    await pendente;
    await assentar(pg);
    assert.deepEqual(areas(pg), OCULTAS);
  });

  test('X5.3 sessão encerrada (401) ao escolher outro funcionário: ida ao Portal e nada do anterior à vista', async () => {
    const pg = await comSelecionado({ detalhes: { 12: erro(401, 'SESSAO_INVALIDA') } });
    await selecionar(pg, 12);
    assert.ok(pg.navegacoes.some((d) => /portal\/index\.html/.test(d)), String(pg.navegacoes));
    assert.deepEqual(areas(pg), OCULTAS);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('X6 — falhas e nenhum resultado não revelam a seleção anterior', () => {
  for (const [nome, falha] of [['404', erro(404, 'FUNCIONARIO_NAO_ENCONTRADO')], ['403', erro(403, 'SEM_PERMISSAO')], ['500', erro(500, 'ERRO_INTERNO')], ['rede', new Error('rede')]]) {
    test(`X6 detalhe com ${nome} depois de outra seleção: aviso, as três áreas ocultas`, async () => {
      const pg = await comSelecionado({ detalhes: { 12: falha } });
      await selecionar(pg, 12);
      assert.notEqual(aviso(pg), '');
      assert.deepEqual(areas(pg), OCULTAS);
    });
  }

  test('X6.1 busca que falha (500) depois de uma seleção: aviso, áreas ocultas, controles de pesquisa à vista', async () => {
    let falhar = false;
    const pg = await comSelecionado({ lista: () => (falhar ? erro(500, 'ERRO_INTERNO') : okLista([funcionario(11), funcionario(12)])) });
    falhar = true;
    await buscar(pg, 'Pessoa');
    assert.match(aviso(pg), /não foi possível|falha/i);
    assert.deepEqual(areas(pg), OCULTAS);
    for (const id of ['historySearchValue', 'botaoConsultar', 'botaoLimparHistorico']) assert.ok(visivel(pg, id), `#${id} visível`);
  });

  // Decisão aprovada no GREEN: CPF recusado localmente (inválido ou incompleto) não inicia consulta e não mexe na ficha aberta.
  for (const [valor, mensagem] of [['529.982.247-26', /CPF inválido/], ['529.982', /CPF incompleto/]]) {
    test(`X6.3 "${valor}" com funcionário aberto: aviso, nenhuma requisição, a ficha anterior continua à vista e intacta`, async () => {
      const pg = await comSelecionado();
      const antes = pg.chamadas.length;
      await buscar(pg, valor);
      assert.equal(pg.chamadas.length, antes, 'nenhuma requisição');
      assert.match(aviso(pg), mensagem);
      assert.deepEqual(areas(pg), VISIVEIS);
      assert.equal(pg.el('historyEmployeeName').value, 'Pessoa 11');
      assert.deepEqual(CARDS.map((id) => limpo(pg.el(id).textContent)), ['2', '1', '10/03/2026', '1']);
      assert.equal(pg.consulta('#historyTimeline [data-entrega-id]').length, 1);
    });
  }

  test('X6.2 nenhum resultado depois de uma seleção: aviso, áreas ocultas', async () => {
    const pg = await comSelecionado({ lista: (c) => (new URL(c.url).searchParams.get('busca') === 'Pessoa' ? okLista([funcionario(11), funcionario(12)]) : okLista([])) });
    await buscar(pg, 'Ninguém');
    assert.match(aviso(pg), /nenhum/i);
    assert.deepEqual(areas(pg), OCULTAS);
  });
});
