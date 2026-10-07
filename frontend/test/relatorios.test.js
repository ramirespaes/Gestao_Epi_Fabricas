'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { abrirPagina, ler, semComentarios, semComentariosHtml } = require('./helpers/dom-pagina');

const R = require('../js/relatorios');

/**
 * Relatórios (12K-D, etapa 1): módulo e página. Estoque, Próximo do vencimento, Itens vencidos e EPIs entregues, só
 * leitura. Números, faixas e status vêm do servidor; a tela apresenta em nós e texto e exporta CSV de todas as linhas.
 */

const ARQUIVO = 'pages/reports.html';
const ATAQUE = '<img src=x onerror=alert(1)>';

const linhaEstoque = (extra = {}) => ({
  loteId: 7, materialId: 2, material: 'Botina Técnica', tipo: 'Botina de Segurança', tamanho: '40',
  ca: { numero: '111', validade: '2099-01-01', situacao: 'VALIDO' }, dataEntrada: '2026-10-01',
  quantidadeEntrada: 8, disponivelNoLote: 8, saldoFisicoNoLote: 8, estoqueMinimo: 10, saldoTotalMaterial: 13, status: 'DISPONIVEL', ...extra,
});
const entrega = (extra = {}) => ({
  itemId: 1, entregaId: 10, fichaId: 5, fichaNumero: 3, origem: 'DIRETA',
  trabalhador: { nome: 'Ana Sapateira', matricula: 'M-001', setor: 'Produção' },
  material: { id: 9, nome: 'Luva de raspa', tipo: 'Luva' }, tamanho: '9', quantidade: 2, ca: { numero: '9999', validade: '2099-12-31' },
  dataEntrega: '2026-10-01', prazoUsoDias: 30, validadeUso: '2026-10-31', diasRestantes: 25, responsavel: { nome: 'Responsável Real' }, status: 'PROXIMO', ...extra,
});

describe('módulo: consulta, ordenação, exportação e textos', () => {
  test('consultar envia só filtros válidos da aba, com ordem, página e limite; texto codificado e cortado; nunca CPF', async () => {
    const chamadas = [];
    global.EpiHttp = { requisitar: async (m, c) => { chamadas.push([m, c]); return { ok: true }; } };
    await R.acoes.consultar('proximoVencimento', {}, null, 1, 20);
    await R.acoes.consultar('proximoVencimento', { funcionario: ' João & Cia ', setor: 'Produção', item: 'a'.repeat(300), faixa: '11-20', cpf: '52998224725', de: '2026-01-01' }, { ordem: 'setor', direcao: 'desc' }, 3, 50);
    await R.acoes.consultar('proximoVencimento', { faixa: '31-40', funcionario: '   ' }, { ordem: 'senha_hash', direcao: 'x' }, 0, -1);
    await R.acoes.consultar('episEntregues', { de: '2026-01-01', ate: '31/12/2026', setor: 'manut' }, { ordem: 'quantidade', direcao: 'asc' }, 2, 100);
    await R.acoes.consultar('estoque', { busca: 'botina', status: 'EM_ALERTA' }, null, 1, 20);
    assert.deepEqual(chamadas, [
      ['GET', '/relatorios/proximo-vencimento?ordem=dias&direcao=asc&pagina=1&limite=20'],
      ['GET', `/relatorios/proximo-vencimento?funcionario=Jo%C3%A3o%20%26%20Cia&setor=Produ%C3%A7%C3%A3o&item=${'a'.repeat(100)}&faixa=11-20&ordem=setor&direcao=desc&pagina=3&limite=50`],
      ['GET', '/relatorios/proximo-vencimento?ordem=dias&direcao=asc&pagina=1&limite=20'],
      ['GET', '/relatorios/epis-entregues?de=2026-01-01&setor=manut&ordem=quantidade&direcao=asc&pagina=2&limite=100'],
      ['GET', '/relatorios/estoque?busca=botina&status=EM_ALERTA&ordem=material&direcao=asc&pagina=1&limite=20'],
    ]);
    assert.equal(chamadas.some(([, c]) => /cpf|senha_hash/i.test(c)), false);
    delete global.EpiHttp;
  });

  test('aba desconhecida é erro de programação, antes da rede', () => {
    assert.throws(() => R.acoes.consultar('auditoria', {}), TypeError);
    assert.throws(() => R.modelo.csv('fiscalizacao', []), TypeError);
  });

  test('ordenação: ordem padrão por aba; clicar na mesma coluna inverte; outra coluna começa crescente; coluna desconhecida volta ao padrão', () => {
    const M = R.modelo;
    assert.deepEqual(M.ordenacao(R.ABAS.estoque, null), { ordem: 'material', direcao: 'asc' });
    assert.deepEqual(M.ordenacao(R.ABAS.episEntregues, null), { ordem: 'dataEntrega', direcao: 'desc' });
    assert.deepEqual(M.ordenacao(R.ABAS.proximoVencimento, null), { ordem: 'dias', direcao: 'asc' });
    assert.deepEqual(M.alternarOrdem('proximoVencimento', null, 'dias'), { ordem: 'dias', direcao: 'desc' });
    assert.deepEqual(M.alternarOrdem('proximoVencimento', { ordem: 'dias', direcao: 'desc' }, 'dias'), { ordem: 'dias', direcao: 'asc' });
    assert.deepEqual(M.alternarOrdem('vencidos', null, 'funcionario'), { ordem: 'funcionario', direcao: 'asc' });
    assert.deepEqual(M.ordenacao(R.ABAS.vencidos, { ordem: 'x', direcao: 'desc' }), { ordem: 'dias', direcao: 'asc' });
  });

  test('exportação percorre TODAS as páginas do filtro e da ordem em uso (não só a página mostrada)', async () => {
    const chamadas = [];
    const todas = Array.from({ length: 230 }, (_, i) => entrega({ itemId: i + 1 }));
    global.EpiHttp = {
      requisitar: async (m, c) => {
        chamadas.push(c);
        const pagina = Number(/pagina=(\d+)/.exec(c)[1]);
        return { ok: true, dados: { itens: todas.slice((pagina - 1) * 100, pagina * 100), total: 230, pagina, limite: 100 } };
      },
    };
    const r = await R.acoes.todas('episEntregues', { funcionario: 'ana', de: '2026-01-01' }, { ordem: 'funcionario', direcao: 'desc' });
    assert.equal(r.ok, true);
    assert.equal(r.completa, true);
    assert.equal(r.linhas.length, 230);
    assert.equal(new Set(r.linhas.map((l) => l.itemId)).size, 230);
    assert.equal(chamadas.length, 3);
    for (const c of chamadas) {
      assert.match(c, /funcionario=ana/);
      assert.match(c, /de=2026-01-01/);
      assert.match(c, /ordem=funcionario&direcao=desc/);
      assert.match(c, /limite=100/);
    }
    delete global.EpiHttp;
  });

  test('exportação: falha de uma página aborta (nada parcial); relatório além do teto é marcado como incompleto', async () => {
    global.EpiHttp = { requisitar: async (m, c) => (/pagina=2&/.test(c) ? { ok: false, status: 500 } : { ok: true, dados: { itens: [entrega()], total: 300 } }) };
    const falha = await R.acoes.todas('vencidos', {}, null);
    assert.deepEqual([falha.ok, falha.resposta.status], [false, 500]);
    global.EpiHttp = { requisitar: async () => ({ ok: true, dados: { itens: [entrega()], total: 1000000 } }) };
    const incompleta = await R.acoes.todas('vencidos', {}, null);
    assert.deepEqual([incompleta.ok, incompleta.completa], [true, false]);
    delete global.EpiHttp;
  });

  test('CSV para o Excel: BOM UTF-8, ";" e CRLF, toda célula entre aspas, fórmula neutralizada, mesmas colunas da tabela', () => {
    const csv = R.modelo.csv('episEntregues', [
      entrega({ trabalhador: { nome: '=HYPERLINK("http://x")', matricula: 'M', setor: '+cmd' }, material: { id: 1, nome: 'Luva "nitrílica"; grossa', tipo: 'Luva' }, responsavel: { nome: '@alguem' } }),
      entrega({ itemId: 2, trabalhador: { nome: 'João', matricula: 'M2', setor: null } }),
    ]);
    assert.equal(csv.charCodeAt(0), 0xFEFF);
    const linhas = csv.slice(1).split('\r\n');
    assert.equal(linhas[0], '"Funcionário";"Setor";"EPI";"CA";"Quantidade";"Data da entrega";"Entregue por"');
    assert.equal(linhas.length, 3);
    assert.equal(linhas[1], '"\'=HYPERLINK(""http://x"")";"\'+cmd";"Luva ""nitrílica""; grossa";"9999";"2";"01/10/2026";"\'@alguem"');
    assert.match(linhas[2], /^"João";"—";/);
    assert.deepEqual(R.modelo.cabecalhoCsv('estoque'), ['Material', 'Tipo', 'CA', 'Lote', 'Data de entrada', 'Quantidade entrada', 'Disponível no lote', 'Estoque mínimo', 'Status']);
  });

  test('CSV não leva CPF, matrícula, IP, hash nem dado técnico: só as colunas da tela', () => {
    for (const aba of Object.keys(R.ABAS)) {
      const cab = R.modelo.cabecalhoCsv(aba).join('|').toLowerCase();
      for (const proibido of ['cpf', 'matrícula', 'ip', 'hash', 'token', 'senha']) assert.equal(new RegExp(`(^|[^a-zà-ú])${proibido}([^a-zà-ú]|$)`).test(cab), false, `${aba}: ${proibido}`);
    }
    const csv = R.modelo.csv('estoque', [linhaEstoque()]);
    assert.equal(/cpf|hash|token|senha/i.test(csv), false);
    assert.deepEqual(csv.slice(1).split('\r\n')[1].split(';'), ['"Botina Técnica"', '"Botina de Segurança"', '"111"', '"#7"', '"01/10/2026"', '"8"', '"8"', '"10"', '"Disponível"']);
  });

  test('nome do arquivo e erros em texto próprio', () => {
    assert.equal(R.modelo.nomeArquivo('estoque', '2026-10-06'), 'relatorio-estoque-2026-10-06.csv');
    assert.equal(R.modelo.nomeArquivo('vencidos', 'x'), 'relatorio-itens-vencidos-exportacao.csv');
    const M = R.modelo;
    assert.equal(M.erro({ status: 403 }), R.TEXTOS.SEM_AUTORIDADE);
    assert.equal(M.erro({ status: 400, detalhes: [{ campo: 'query.faixa' }] }), R.TEXTOS.FILTRO_INVALIDO);
    assert.equal(M.erro({ status: 400, detalhes: [{ campo: 'params.id' }] }), R.TEXTOS.FALHA);
    assert.equal(M.erro({ status: 404 }), R.TEXTOS.SERVIDOR_DESATUALIZADO);
    assert.equal(M.erro({ status: 500 }), R.TEXTOS.FALHA);
    assert.equal(M.periodoInvertido('2026-02-01', '2026-01-01'), true);
    assert.deepEqual(M.paginacao({ pagina: 2, limite: 20, total: 45 }, 20), { texto: '21–40 de 45', anterior: true, proxima: true });
  });

  test('indicadores e alertas: só os números do servidor; sem número vira traço', () => {
    assert.deepEqual(R.modelo.indicadores({ indicadores: { itensCadastrados: 10, comEstoqueDisponivel: 7, emAlerta: 4 } }), { itensCadastrados: '10', comEstoqueDisponivel: '7', emAlerta: '4' });
    assert.deepEqual(R.modelo.indicadores({}), { itensCadastrados: '—', comEstoqueDisponivel: '—', emAlerta: '—' });
    const a = R.modelo.alerta({ tipo: 'CA_AUSENTE', material: 'Protetor', caNumero: null, saldoTotal: 0, estoqueMinimo: 1 });
    assert.deepEqual([a.titulo, a.rotulo, a.detalhe], ['Protetor', 'CA ausente', 'Disponível: 0 · Estoque mínimo: 1']);
    assert.equal(R.modelo.alerta({ tipo: 'CA_PROXIMO', material: 'M', caNumero: '444', saldoTotal: 7, estoqueMinimo: 0 }).rotulo, 'CA próximo do vencimento');
  });

});

// ── página ──────────────────────────────────────────────────────────
const NENHUMA = { visualizar: false, criar: false, editar: false, excluir: false };
const area = (v) => ({ consultar: v, alterar: v });
function permissoes({ materiais = true, ficha = true } = {}) {
  return {
    status: 'ok', empresaId: 3, usuarioId: 1, perfil: 'USUARIO',
    recursos: { materials: { ...NENHUMA, visualizar: materiais }, epiFicha: { ...NENHUMA, visualizar: ficha } },
    acoes: {},
    administracao: {
      gruposAcesso: area(false), permissoesGrupo: area(false), vinculosGrupo: area(false), usuarios: area(false),
      autorizacoesIndividuais: { consultar: false, concederDireta: false, delegar: false }, vinculosSst: area(false),
    },
  };
}
const contexto = () => ({
  status: 'ok', usuario: { id: 1, nome: 'Pessoa', email: 'p@validacao-epi.invalid', perfil: 'USUARIO' },
  empresa: { id: 3, nome: 'Empresa Teste', cnpj: '11222333000181' }, preferencias: { tema: 'claro', modoVisual: 'padrao' },
});
const ESTOQUE = {
  indicadores: { itensCadastrados: 10, comEstoqueDisponivel: 7, emAlerta: 4 },
  alertas: [
    { tipo: 'SEM_ESTOQUE', materialId: 1, material: 'Capacete Classe B', tipoMaterial: 'Capacete', caNumero: null, situacaoCa: null, saldoTotal: 0, estoqueMinimo: 0 },
    { tipo: 'CA_VENCIDO', materialId: 2, material: ATAQUE, tipoMaterial: 'Luva', caNumero: '333', situacaoCa: 'VENCIDO', saldoTotal: 0, estoqueMinimo: 5 },
  ],
  linhas: [linhaEstoque(), linhaEstoque({ loteId: 8, quantidadeEntrada: 5, disponivelNoLote: 0, saldoFisicoNoLote: 5, status: 'SEM_ESTOQUE', ca: { numero: '333', validade: '2020-01-01', situacao: 'VENCIDO' } })],
  total: 2, pagina: 1, limite: 20, diasAlertaCa: 60,
};
const lista = (itens, extra = {}) => ({ status: 200, corpo: { status: 'ok', itens, total: itens.length, pagina: 1, limite: 20, ...extra } });

function abrir({ materiais = true, ficha = true, rotas = {} } = {}) {
  return abrirPagina(ARQUIVO, {
    rotas: {
      'GET /auth/me': { status: 200, corpo: contexto() },
      'GET /auth/global/me': { status: 200, corpo: { status: 'ok', empresas: [{ id: 3 }] } },
      'GET /auth/permissoes': { status: 200, corpo: permissoes({ materiais, ficha }) },
      'GET /relatorios/estoque': () => ({ status: 200, corpo: { status: 'ok', ...ESTOQUE } }),
      'GET /relatorios/proximo-vencimento': () => lista([entrega({ diasRestantes: 5, status: 'TROCAR_URGENTE' }), entrega({ itemId: 2, diasRestantes: 25 })]),
      'GET /relatorios/vencidos': () => lista([entrega({ itemId: 3, diasRestantes: -4, diasVencidos: 4, status: 'TROCA_URGENTE' })]),
      'GET /relatorios/epis-entregues': () => lista([entrega({ itemId: 4 }), entrega({ itemId: 5 })]),
      ...rotas,
    },
  });
}
async function pronta(opcoes) {
  const pg = abrir(opcoes);
  await pg.esperar();
  await pg.esperar();
  return pg;
}
const consultas = (pg, rota) => pg.chamadas.filter((c) => c.chave === `GET /relatorios/${rota}`);
const celulas = (tr) => tr.children.map((td) => td.textContent.trim());
const abrirAba = async (pg, aba) => {
  await pg.consulta(`.report-tab[data-aba="${aba}"]`)[0].disparar('click');
  await pg.esperar();
  await pg.esperar();
};

describe('Relatórios — página (DOM simulado, sessão e permissões reais)', () => {
  test('com materials.visualizar: abre no Estoque, consulta só o estoque e mostra indicadores, alertas e uma linha por lote', async () => {
    const pg = await pronta({ ficha: false });
    assert.equal(pg.visivel('telaSessao'), false);
    assert.equal(consultas(pg, 'estoque').length, 1);
    for (const outra of ['proximo-vencimento', 'vencidos', 'epis-entregues']) assert.equal(consultas(pg, outra).length, 0, outra);
    assert.deepEqual(['statCadastrados', 'statDisponiveis', 'statAlerta'].map((id) => pg.texto(id)), ['10', '7', '4']);
    const alertas = pg.consulta('#alertasEstoque .switch-row');
    assert.equal(alertas.length, 2);
    assert.equal(alertas[1].textContent.includes(ATAQUE), true, 'texto puro');
    assert.equal(pg.consulta('#alertasEstoque img').length, 0, 'nunca HTML');
    const linhas = pg.consulta('#corpo-estoque tr');
    assert.equal(linhas.length, 2);
    assert.deepEqual(pg.consulta('#cabecalho-estoque th').map((th) => th.textContent.replace(/[ ▲▼]/g, '')),
      ['Material', 'Tipo', 'CA', 'Lote', 'Datadeentrada', 'Quantidadeentrada', 'Disponívelnolote', 'Estoquemínimo', 'Status']);
    const bloqueada = celulas(linhas[1]);
    assert.ok(bloqueada[2].includes('333') && bloqueada[2].includes('CA vencido'), bloqueada[2]);
    assert.ok(bloqueada[6].startsWith('0') && bloqueada[6].includes('Físico 5 (bloqueado por CA)'), bloqueada[6]);
    assert.equal(bloqueada[8], 'Sem estoque');
    assert.equal(celulas(linhas[0])[8], 'Disponível');
  });

  test('só as abas da autoridade de cada fonte aparecem: sem materials, o Estoque some e a primeira aba de entregas abre', async () => {
    const pg = await pronta({ materiais: false, ficha: true });
    const visiveis = pg.consulta('.report-tab[data-aba]').filter((b) => pg.visivelNo(b)).map((b) => b.getAttribute('data-aba'));
    assert.deepEqual(visiveis, ['proximoVencimento', 'vencidos', 'episEntregues']);
    assert.equal(consultas(pg, 'estoque').length, 0);
    assert.equal(consultas(pg, 'proximo-vencimento').length, 1);
    const linhas = pg.consulta('#corpo-proximoVencimento tr');
    assert.equal(linhas.length, 2);
    assert.deepEqual(pg.consulta('#cabecalho-proximoVencimento th').map((th) => th.textContent.replace(/[ ▲▼]/g, '')),
      ['Funcionário', 'Setor', 'EPI', 'CA', 'Datadaentrega', 'Validadedeuso', 'Diasrestantes', 'Status']);
    assert.deepEqual([celulas(linhas[0])[6], celulas(linhas[0])[7]], ['5', 'Trocar urgente']);
    assert.deepEqual([celulas(linhas[1])[6], celulas(linhas[1])[7]], ['25', 'Próximo do vencimento']);
  });

  test('sem nenhuma das duas permissões a página não abre e nada é consultado', async () => {
    const pg = await pronta({ materiais: false, ficha: false });
    for (const rota of ['estoque', 'proximo-vencimento', 'vencidos', 'epis-entregues']) assert.equal(consultas(pg, rota).length, 0, rota);
    assert.equal(pg.texto('aviso').trim(), require('../js/permissoes-efetivas').MENSAGENS.SEM_ACESSO); // eslint-disable-line global-require
  });

  test('abas carregam sob demanda, uma vez: Itens vencidos mostra dias vencidos e "Troca urgente"; EPIs entregues mostra o histórico', async () => {
    const pg = await pronta();
    await abrirAba(pg, 'vencidos');
    await abrirAba(pg, 'vencidos');
    assert.equal(consultas(pg, 'vencidos').length, 1);
    const v = pg.consulta('#corpo-vencidos tr');
    assert.equal(v.length, 1);
    assert.deepEqual(pg.consulta('#cabecalho-vencidos th').map((th) => th.textContent.replace(/[ ▲▼]/g, '')),
      ['Funcionário', 'Setor', 'EPI', 'CA', 'Datadaentrega', 'Validadedeuso', 'Diasvencidos', 'Status']);
    assert.deepEqual([celulas(v[0])[6], celulas(v[0])[7]], ['4', 'Troca urgente']);
    assert.equal(pg.consulta('.report-tab[data-aba="vencidos"]')[0].textContent.trim(), 'Itens vencidos');
    await abrirAba(pg, 'episEntregues');
    const e = pg.consulta('#corpo-episEntregues tr');
    assert.equal(e.length, 2);
    assert.deepEqual(pg.consulta('#cabecalho-episEntregues th').map((th) => th.textContent.replace(/[ ▲▼]/g, '')),
      ['Funcionário', 'Setor', 'EPI', 'CA', 'Quantidade', 'Datadaentrega', 'Entreguepor']);
    assert.deepEqual(celulas(e[0]), ['Ana Sapateira', 'Produção', 'Luva de raspa', '9999', '2', '01/10/2026', 'Responsável Real']);
  });

  test('filtros: vazios nunca geram parâmetro; preenchidos vão como estão; Limpar volta ao pedido simples; período invertido não consulta', async () => {
    const pg = await pronta();
    await abrirAba(pg, 'episEntregues');
    const parametros = () => [...new URL(consultas(pg, 'epis-entregues').at(-1).url).searchParams.entries()];
    assert.deepEqual(parametros(), [['ordem', 'dataEntrega'], ['direcao', 'desc'], ['pagina', '1'], ['limite', '20']]);
    const area = pg.consulta('#filtros-episEntregues')[0];
    const campo = (nome) => area.querySelectorAll(`[data-filtro="${nome}"]`)[0];
    campo('funcionario').value = 'ana';
    campo('setor').value = 'prod';
    campo('item').value = 'luva';
    campo('de').value = '2026-09-01';
    campo('ate').value = '2026-10-06';
    await area.querySelectorAll('[data-acao-relatorio="filtrar"]')[0].disparar('click');
    await pg.esperar();
    await pg.esperar();
    assert.deepEqual(parametros(), [['de', '2026-09-01'], ['ate', '2026-10-06'], ['funcionario', 'ana'], ['setor', 'prod'], ['item', 'luva'], ['ordem', 'dataEntrega'], ['direcao', 'desc'], ['pagina', '1'], ['limite', '20']]);
    const antes = consultas(pg, 'epis-entregues').length;
    campo('de').value = '2026-12-01';
    await area.querySelectorAll('[data-acao-relatorio="filtrar"]')[0].disparar('click');
    await pg.esperar();
    assert.equal(consultas(pg, 'epis-entregues').length, antes, 'período invertido para antes da rede');
    assert.match(pg.texto('aviso'), /Período inválido/);
    await area.querySelectorAll('[data-acao-relatorio="limpar"]')[0].disparar('click');
    await pg.esperar();
    await pg.esperar();
    assert.deepEqual(parametros(), [['ordem', 'dataEntrega'], ['direcao', 'desc'], ['pagina', '1'], ['limite', '20']]);
  });

  test('clicar no cabeçalho ordena pelo servidor (mesma coluna inverte) e volta para a primeira página', async () => {
    const pg = await pronta();
    await abrirAba(pg, 'proximoVencimento');
    const ordem = () => [...new URL(consultas(pg, 'proximo-vencimento').at(-1).url).searchParams.entries()].filter(([k]) => k === 'ordem' || k === 'direcao').flat();
    assert.deepEqual(ordem(), ['ordem', 'dias', 'direcao', 'asc']);
    await pg.consulta('#cabecalho-proximoVencimento th[data-ordem="setor"]')[0].disparar('click');
    await pg.esperar();
    await pg.esperar();
    assert.deepEqual(ordem(), ['ordem', 'setor', 'direcao', 'asc']);
    await pg.consulta('#cabecalho-proximoVencimento th[data-ordem="setor"]')[0].disparar('click');
    await pg.esperar();
    await pg.esperar();
    assert.deepEqual(ordem(), ['ordem', 'setor', 'direcao', 'desc']);
    const th = pg.consulta('#cabecalho-proximoVencimento th[data-ordem="setor"]')[0];
    assert.equal(th.getAttribute('aria-sort'), 'descending');
    assert.ok(th.textContent.includes('▼'));
  });

  test('vazio e erro têm textos próprios; 403 vira a mensagem de permissão', async () => {
    const vazio = await pronta({ rotas: { 'GET /relatorios/estoque': () => ({ status: 200, corpo: { status: 'ok', indicadores: {}, alertas: [], linhas: [], total: 0, pagina: 1, limite: 20 } }) } });
    assert.equal(vazio.consulta('#corpo-estoque tr')[0].textContent.trim(), R.TEXTOS.VAZIO_ESTOQUE);
    assert.equal(vazio.texto('alertasEstoque').trim(), R.TEXTOS.SEM_ALERTAS);
    const negado = await pronta({ rotas: { 'GET /relatorios/estoque': () => ({ status: 403, corpo: { status: 'erro', codigo: 'SEM_PERMISSAO' } }) } });
    assert.match(negado.texto('aviso'), /Sem permissão para consultar este relatório/);
    const quebrado = await pronta({ rotas: { 'GET /relatorios/estoque': () => ({ status: 500, corpo: { status: 'erro' } }) } });
    assert.equal(quebrado.consulta('#corpo-estoque tr')[0].textContent.trim(), R.TEXTOS.FALHA);
  });

  test('Auditoria e Fiscalização seguem não integradas: só o aviso, sem dados, fichas, ZIP, PDF ou trilha de demonstração', async () => {
    const html = semComentariosHtml(ler(ARQUIVO));
    const [, auditoria] = /id="reportAudit"([\s\S]*?)<section id="reportFiscal"/.exec(html);
    const [, fiscal] = /id="reportFiscal"([\s\S]*)$/.exec(html);
    for (const bloco of [auditoria, fiscal]) {
      assert.match(bloco, /Em integração/);
      assert.equal(/<table|FIC-\d|PED-\d|Fulano|Sicrano|Beltrana|\d{2}\/04\/2026|<button/.test(bloco), false);
    }
    assert.equal(/Pacote para fiscalização|Fichas de EPI assinadas|Trilha de auditoria completa/.test(html), false);
  });

  test('a página é só leitura e segura: sem protótipo, sem biblioteca remota, sem innerHTML nem armazenamento do navegador', () => {
    const html = ler(ARQUIVO);
    const codigo = semComentarios(html);
    assert.equal(/db-api\.js|js\/main\.js|inspecao-visual|xlsx|loginScreen|Cobresul|showReportTab|exportReport|exportUpcomingReport/.test(semComentariosHtml(html)), false);
    assert.equal(/https?:\/\/(?!fonts\.googleapis\.com|www\.w3\.org\/2000\/svg)/.test(html.replace(/<!--[\s\S]*?-->/g, '')), false, 'sem biblioteca ou recurso remoto');
    for (const fonte of [codigo, semComentarios(ler('js/relatorios.js'))]) {
      assert.equal(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|localStorage|sessionStorage|indexedDB/.test(fonte), false);
    }
    assert.match(html, /<script src="\.\.\/js\/relatorios\.js"><\/script>/);
    assert.doesNotMatch(html, /Tício|Ana Souza|Fulano|Beltrana|\d{2}\/04\/2026|Botina de segurança<\/td>/);
  });

  test('o menu liga Relatórios por permissão (data-pagina) e a página é publicada com o módulo, em ordem', () => {
    assert.match(ler(ARQUIVO), /<a class="active" href="javascript:void\(0\)" data-pagina="reports" style="display:none"><div class="nav-icon indigo">analytics<\/div>Relatórios<\/a>/);
    assert.match(ler('pages/dashboard.html'), /<a href="reports\.html" data-pagina="reports" style="display:none"><div class="nav-icon indigo">analytics<\/div>Relatórios<\/a>/);
    assert.match(ler('portal/inicio.html'), /<a href="\.\.\/pages\/reports\.html" data-pagina="reports" style="display:none">Relatórios<\/a>/);
    const arquivos = JSON.parse(ler('publicacao/allowlist.json')).arquivos;
    for (const a of ['pages/reports.html', 'js/relatorios.js']) assert.equal(arquivos.filter((x) => x === a).length, 1, a);
    assert.deepEqual(arquivos, [...arquivos].sort());
    const P = require('../js/permissoes-efetivas'); // eslint-disable-line global-require
    assert.deepEqual(P.PAGINAS.reports, { abrir: [{ recurso: 'materials', operacao: 'visualizar' }, { recurso: 'epiFicha', operacao: 'visualizar' }], abrirComQualquer: true, alterar: [] });
    assert.equal('Relatórios' in P.INSPECAO_PROTOTIPOS, false);
  });
});
