'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { abrirPagina, ler, semComentarios, semComentariosHtml } = require('./helpers/dom-pagina');

const E = require('../js/entregas-epi-historico');

/**
 * EPIs Entregues (12K-C): módulo e página. Histórico real de itens entregues da empresa (GET /entregas-epi/itens),
 * só leitura. Validade, dias restantes e status vêm do servidor; a tela só apresenta, em nós e texto.
 */

const ARQUIVO = 'pages/delivered-items.html';
const ATAQUE = '<img src=x onerror=alert(1)>';

const item = (extra = {}) => ({
  itemId: 1, entregaId: 10, fichaId: 5, fichaNumero: 3, origem: 'DIRETA',
  trabalhador: { nome: 'Ana Sapateira', matricula: 'M-001', setor: 'Produção' },
  material: { id: 9, nome: 'Sapatão de segurança', tipo: 'Sapato de Segurança' },
  tamanho: '40', quantidade: 2, motivo: 'ADMISSAO', previstoNoGhe: true, ca: { numero: '12345', validade: '2099-12-31' },
  dataEntrega: '2026-04-10', entregueEm: '2026-04-10T15:00:00.000Z', prazoUsoDias: 180, validadeUso: '2026-10-07', diasRestantes: 12,
  responsavel: { nome: 'Responsável Real' }, status: 'PROXIMO', ...extra,
});

describe('módulo: consulta, modelo e CSV', () => {
  test('listar envia só o que foi preenchido e é válido, com texto codificado e limite padrão; nunca CPF', async () => {
    const chamadas = [];
    global.EpiHttp = { requisitar: async (m, c) => { chamadas.push([m, c]); return { ok: true }; } };
    await E.acoes.listar({});
    await E.acoes.listar({ item: ' sapát ', funcionario: 'João & Cia', de: '2026-01-01', ate: '31/12/2026', status: 'VENCIDO', pagina: 3, limite: 50 });
    await E.acoes.listar({ item: '', funcionario: '   ', status: 'QUALQUER', de: 'x', pagina: 0, limite: -1, cpf: '52998224725' });
    assert.deepEqual(chamadas, [
      ['GET', '/entregas-epi/itens?pagina=1&limite=20'],
      ['GET', '/entregas-epi/itens?item=sap%C3%A1t&funcionario=Jo%C3%A3o%20%26%20Cia&de=2026-01-01&status=VENCIDO&pagina=3&limite=50'],
      ['GET', '/entregas-epi/itens?pagina=1&limite=20'],
    ]);
    delete global.EpiHttp;
  });

  test('texto de busca acima de 100 caracteres é cortado antes da rede', async () => {
    const chamadas = [];
    global.EpiHttp = { requisitar: async (m, c) => { chamadas.push(c); return { ok: true }; } };
    await E.acoes.listar({ item: 'a'.repeat(300) });
    assert.equal(chamadas[0].includes(`item=${'a'.repeat(100)}&`), true);
    delete global.EpiHttp;
  });

  test('modelo: dias restantes e rótulos pelo status do servidor; período invertido; erros em texto próprio; paginação', () => {
    const M = E.modelo;
    assert.equal(M.textoDias({ diasRestantes: -3, status: 'VENCIDO' }), 'Vencido há 3 dias');
    assert.equal(M.textoDias({ diasRestantes: -1, status: 'VENCIDO' }), 'Vencido há 1 dia');
    assert.equal(M.textoDias({ diasRestantes: 0, status: 'PROXIMO' }), 'Vence hoje');
    assert.equal(M.textoDias({ diasRestantes: 12, status: 'PROXIMO' }), 'Vence em 12 dias');
    assert.equal(M.textoDias({ diasRestantes: 90, status: 'VALIDO' }), '90 dias');
    assert.equal(M.textoDias({ diasRestantes: null }), '—');
    assert.deepEqual(['VALIDO', 'PROXIMO', 'VENCIDO', 'X'].map(M.rotuloStatus), ['Válido', 'Próximo do vencimento', 'Vencido', '—']);
    assert.equal(M.dataBr('2026-10-07'), '07/10/2026');
    assert.equal(M.dataBr('lixo'), '—');
    assert.equal(M.periodoInvertido('2026-02-01', '2026-01-01'), true);
    assert.equal(M.periodoInvertido('2026-01-01', '2026-01-01'), false);
    assert.equal(M.periodoInvertido('', '2026-01-01'), false);
    assert.equal(M.erro({ status: 403 }), E.TEXTOS.SEM_AUTORIDADE);
    assert.equal(M.erro({ status: 400, detalhes: [{ campo: 'query.status' }] }), E.TEXTOS.FILTRO_INVALIDO, 'só parâmetro da consulta é culpa dos filtros');
    assert.equal(M.erro({ status: 400, detalhes: [{ campo: 'params.id' }] }), E.TEXTOS.SERVIDOR_DESATUALIZADO, 'servidor antigo: /entregas-epi/:id recusa "itens"');
    assert.equal(M.erro({ status: 400, detalhes: null }), E.TEXTOS.FALHA);
    assert.equal(E.TEXTOS.VAZIO_FILTRO, 'Nenhuma entrega encontrada para os filtros informados.');
    assert.equal(M.erro({ status: 500, message: 'SEGREDO' }), E.TEXTOS.FALHA);
    assert.deepEqual(M.paginacao({ pagina: 2, limite: 20, total: 45 }, 20), { texto: '21–40 de 45', anterior: true, proxima: true });
    assert.deepEqual(M.paginacao({ pagina: 3, limite: 20, total: 45 }, 5), { texto: '41–45 de 45', anterior: true, proxima: false });
    assert.deepEqual(M.paginacao({ pagina: 1, limite: 20, total: 0 }, 0), { texto: '', anterior: false, proxima: false });
  });

  test('CSV com as mesmas colunas da tabela e células neutralizadas contra fórmula', () => {
    const csv = E.modelo.csv([item({ trabalhador: { nome: '=CMD()', matricula: 'M', setor: null }, tamanho: null, status: 'VENCIDO', diasRestantes: -5 })]);
    const [cabecalho, linha] = csv.split('\n');
    assert.equal(cabecalho, '"Funcionário";"Setor";"Tipo";"Item entregue";"Tamanho";"Quantidade";"Data da entrega";"Validade de uso";"Dias restantes";"Status";"Entregue por"');
    assert.ok(linha.startsWith('"\'=CMD()";"—";"Sapato de Segurança";"Sapatão de segurança";"Único";"2";"10/04/2026";"07/10/2026";"-5";"Vencido";"Responsável Real"'.replace('"-5"', '"\'-5"')), linha);
  });

  test('fonte do módulo: sem innerHTML, sem armazenamento do navegador e sem CPF', () => {
    const fonte = semComentarios(ler('js/entregas-epi-historico.js'));
    assert.equal(/innerHTML|outerHTML|insertAdjacentHTML|localStorage|sessionStorage|document\.cookie|\bcpf\b/i.test(fonte), false);
  });
});

// ── página ──────────────────────────────────────────────────────────
const NENHUMA = { visualizar: false, criar: false, editar: false, excluir: false };
const area = (v) => ({ consultar: v, alterar: v });
function permissoes(ficha = true) {
  return {
    status: 'ok', empresaId: 3, usuarioId: 1, perfil: 'USUARIO', recursos: { epiFicha: { ...NENHUMA, visualizar: ficha } }, acoes: {},
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
const lista = (itens, extra = {}) => ({ status: 200, corpo: { status: 'ok', itens, total: itens.length, pagina: 1, limite: 20, diasProximoVencimento: 30, ...extra } });

function abrir({ ficha = true, itens = [item()], resposta = null } = {}) {
  return abrirPagina(ARQUIVO, {
    rotas: {
      'GET /auth/me': { status: 200, corpo: contexto() },
      'GET /auth/global/me': { status: 200, corpo: { status: 'ok', empresas: [{ id: 3 }] } },
      'GET /auth/permissoes': { status: 200, corpo: permissoes(ficha) },
      'GET /entregas-epi/itens': resposta || (() => lista(itens)),
    },
  });
}
async function pronta(opcoes) {
  const pg = abrir(opcoes);
  await pg.esperar();
  await pg.esperar();
  return pg;
}
const consultas = (pg) => pg.chamadas.filter((c) => c.chave === 'GET /entregas-epi/itens');
const linhas = (pg) => pg.consulta('#deliveredTableBody tr');
const celulas = (tr) => tr.children.map((td) => td.textContent.trim());

describe('EPIs Entregues — página (DOM simulado, sessão e permissões reais)', () => {
  test('abre pela sessão e pela permissão, consulta a primeira página e mostra as 11 colunas da referência visual na ordem', async () => {
    const pg = await pronta();
    assert.equal(pg.visivel('telaSessao'), false);
    assert.equal(consultas(pg).length, 1);
    assert.deepEqual(pg.consulta('#deliveredTable thead th').map((th) => th.textContent.trim()),
      ['Funcionário', 'Setor', 'Tipo', 'Item entregue', 'Tam.', 'Qtd.', 'Data da entrega', 'Validade de uso', 'Dias restantes', 'Status', 'Entregue por']);
    const [tr] = linhas(pg);
    const c = celulas(tr);
    assert.equal(c.length, 11);
    assert.deepEqual([c[0], c[1], c[2], c[4], c[5], c[6], c[10]], ['Ana Sapateira', 'Produção', 'Sapato de Segurança', '40', '2', '10/04/2026', 'Responsável Real']);
    assert.ok(c[3].startsWith('Sapatão de segurança'));
    assert.ok(c[7].startsWith('07/10/2026') && c[7].includes('(6 meses de uso)'), c[7]);
    assert.deepEqual([c[8], c[9]], ['Vence em 12 dias', 'Próximo do vencimento']);
  });

  test('mantém os três status e a entrega anterior do mesmo EPI (histórico): cada linha com a própria validade', async () => {
    const itens = [
      item({ itemId: 3, status: 'VALIDO', diasRestantes: 170, validadeUso: '2027-04-01', dataEntrega: '2026-10-05' }),
      item({ itemId: 2, status: 'PROXIMO', diasRestantes: 0, validadeUso: '2026-10-05' }),
      item({ itemId: 1, status: 'VENCIDO', diasRestantes: -20, validadeUso: '2026-09-15', dataEntrega: '2026-03-19' }),
    ];
    const pg = await pronta({ itens });
    assert.deepEqual(linhas(pg).map((tr) => [tr.getAttribute('data-item'), celulas(tr)[8], celulas(tr)[9]]), [
      ['3', '170 dias', 'Válido'], ['2', 'Vence hoje', 'Próximo do vencimento'], ['1', 'Vencido há 20 dias', 'Vencido'],
    ]);
    assert.equal(pg.texto('paginacaoTexto'), '1–3 de 3');
  });

  test('filtros: tipo de item é pesquisa por texto (não dropdown), funcionário por texto, período por datas e status fechado; Filtrar envia tudo', async () => {
    const pg = await pronta();
    assert.equal(pg.consulta('select#deliveredType').length, 0, 'o tipo não é seleção fechada');
    assert.equal(pg.consulta('#deliveredType')[0].getAttribute('type'), 'search');
    assert.deepEqual(pg.consulta('#deliveredStatus option').map((o) => [o.getAttribute('value'), o.textContent.trim()]),
      [['', 'Todos'], ['VALIDO', 'Válido'], ['PROXIMO', 'Próximo do vencimento'], ['VENCIDO', 'Vencido']]);
    pg.consulta('#deliveredType')[0].value = 'sapat';
    pg.consulta('#deliveredEmployee')[0].value = 'ana';
    pg.consulta('#deliveredFrom')[0].value = '2026-01-01';
    pg.consulta('#deliveredTo')[0].value = '2026-12-31';
    pg.consulta('#deliveredStatus')[0].value = 'VENCIDO';
    await pg.consulta('#botaoFiltrar')[0].disparar('click');
    await pg.esperar();
    await pg.esperar();
    const ultima = consultas(pg).at(-1);
    assert.deepEqual([...new URL(ultima.url).searchParams.entries()], [
      ['item', 'sapat'], ['funcionario', 'ana'], ['de', '2026-01-01'], ['ate', '2026-12-31'], ['status', 'VENCIDO'], ['pagina', '1'], ['limite', '20'],
    ]);
    assert.equal(/cpf/i.test(ultima.url), false);
  });

  test('filtros vazios nunca geram parâmetro: o pedido é só página e limite, ao abrir, ao filtrar e depois de Limpar; cada filtro isolado envia só o seu', async () => {
    const pg = await pronta();
    const parametros = () => [...new URL(consultas(pg).at(-1).url).searchParams.entries()];
    assert.deepEqual(parametros(), [['pagina', '1'], ['limite', '20']], 'ao abrir');
    const filtrar = async () => { await pg.consulta('#botaoFiltrar')[0].disparar('click'); await pg.esperar(); await pg.esperar(); };
    const limpar = async () => { await pg.consulta('#botaoLimpar')[0].disparar('click'); await pg.esperar(); await pg.esperar(); };
    await filtrar();
    assert.deepEqual(parametros(), [['pagina', '1'], ['limite', '20']], 'Filtrar sem nada preenchido');
    const isolados = [
      ['#deliveredType', 'luva', [['item', 'luva']]],
      ['#deliveredEmployee', 'm-001', [['funcionario', 'm-001']]],
      ['#deliveredFrom', '2026-10-01', [['de', '2026-10-01']]],
      ['#deliveredTo', '2026-10-06', [['ate', '2026-10-06']]],
      ['#deliveredStatus', 'VALIDO', [['status', 'VALIDO']]],
    ];
    for (const [seletor, valor, esperado] of isolados) {
      pg.consulta(seletor)[0].value = valor;
      await filtrar();
      assert.deepEqual(parametros(), [...esperado, ['pagina', '1'], ['limite', '20']], seletor);
      await limpar();
      assert.deepEqual(parametros(), [['pagina', '1'], ['limite', '20']], `Limpar depois de ${seletor}`);
    }
    pg.consulta('#deliveredFrom')[0].value = '2026-09-01';
    pg.consulta('#deliveredTo')[0].value = '2026-10-06';
    await filtrar();
    assert.deepEqual(parametros(), [['de', '2026-09-01'], ['ate', '2026-10-06'], ['pagina', '1'], ['limite', '20']], 'intervalo completo no formato AAAA-MM-DD');
    assert.equal(pg.texto('aviso'), '', 'nenhum aviso de erro numa consulta válida');
    // Espaços e valores inválidos viram "omitido", nunca parâmetro vazio.
    await limpar();
    pg.consulta('#deliveredType')[0].value = '   ';
    pg.consulta('#deliveredEmployee')[0].value = '';
    await filtrar();
    assert.deepEqual(parametros(), [['pagina', '1'], ['limite', '20']]);
    assert.equal(/=(&|$)/.test(consultas(pg).at(-1).url), false, 'nenhum parâmetro vazio');
  });

  test('consulta válida sem resultado mostra "Nenhuma entrega encontrada..." sem aviso de erro; 400 da consulta e servidor antigo têm textos diferentes', async () => {
    const vazio = await pronta({ itens: [] });
    vazio.consulta('#deliveredType')[0].value = 'capacete';
    await vazio.consulta('#botaoFiltrar')[0].disparar('click');
    await vazio.esperar();
    await vazio.esperar();
    assert.equal(vazio.texto('deliveredTableBody'), 'Nenhuma entrega encontrada para os filtros informados.');
    assert.equal(vazio.texto('aviso'), '');
    const filtroRuim = await pronta({ resposta: () => ({ status: 400, corpo: { status: 'error', codigo: 'VALIDACAO', message: 'x', detalhes: [{ campo: 'query.status', mensagem: 'inválido' }] } }) });
    assert.equal(filtroRuim.texto('aviso'), E.TEXTOS.FILTRO_INVALIDO);
    const antigo = await pronta({ resposta: () => ({ status: 400, corpo: { status: 'error', codigo: 'VALIDACAO', message: 'x', detalhes: [{ campo: 'params.id', mensagem: 'inválido' }] } }) });
    assert.equal(antigo.texto('aviso'), E.TEXTOS.SERVIDOR_DESATUALIZADO);
    assert.equal(antigo.texto('aviso').includes('filtros'), false, 'não culpa os filtros');
  });

  test('Limpar zera os filtros e volta à primeira página; período invertido para antes da rede, com aviso', async () => {
    const pg = await pronta();
    pg.consulta('#deliveredFrom')[0].value = '2026-12-31';
    pg.consulta('#deliveredTo')[0].value = '2026-01-01';
    const antes = consultas(pg).length;
    await pg.consulta('#botaoFiltrar')[0].disparar('click');
    await pg.esperar();
    assert.equal(consultas(pg).length, antes, 'nada foi consultado');
    assert.equal(pg.texto('aviso'), E.TEXTOS.PERIODO_INVERTIDO);
    await pg.consulta('#botaoLimpar')[0].disparar('click');
    await pg.esperar();
    await pg.esperar();
    assert.equal(consultas(pg).length, antes + 1);
    assert.equal(new URL(consultas(pg).at(-1).url).search, '?pagina=1&limite=20');
    assert.equal(pg.consulta('#deliveredFrom')[0].value, '');
    assert.equal(pg.texto('aviso'), '');
  });

  test('paginação: Próxima e Anterior consultam a página certa; vazio com e sem filtro tem texto próprio', async () => {
    const itens = Array.from({ length: 20 }, (_, i) => item({ itemId: i + 1 }));
    const pg = await pronta({ resposta: () => lista(itens, { total: 45 }) });
    assert.equal(pg.texto('paginacaoTexto'), '1–20 de 45');
    assert.equal(pg.consulta('#paginaProxima')[0].disabled, false);
    await pg.consulta('#paginaProxima')[0].disparar('click');
    await pg.esperar();
    assert.equal(new URL(consultas(pg).at(-1).url).searchParams.get('pagina'), '2');
    const vazio = await pronta({ itens: [] });
    assert.equal(vazio.texto('deliveredTableBody'), E.TEXTOS.VAZIO);
    vazio.consulta('#deliveredType')[0].value = 'capacete';
    await vazio.consulta('#botaoFiltrar')[0].disparar('click');
    await vazio.esperar();
    await vazio.esperar();
    assert.equal(vazio.texto('deliveredTableBody'), E.TEXTOS.VAZIO_FILTRO);
  });

  test('sem epiFicha.visualizar nada é consultado; 401 encerra a sessão; falha mostra o texto da tela, nunca o do servidor', async () => {
    const semAcesso = await pronta({ ficha: false });
    assert.equal(consultas(semAcesso).length, 0);
    const caiu = await pronta({ resposta: () => ({ status: 401, corpo: { status: 'error', codigo: 'NAO_AUTENTICADO', message: 'texto do servidor' } }) });
    assert.equal(caiu.textoDoDom().includes('texto do servidor'), false);
    const falha = await pronta({ resposta: () => ({ status: 500, corpo: { status: 'error', codigo: 'ERRO', message: 'texto do servidor' } }) });
    assert.equal(falha.texto('aviso'), E.TEXTOS.FALHA);
    assert.equal(falha.textoDoDom().includes('texto do servidor'), false);
    const proibido = await pronta({ resposta: () => ({ status: 403, corpo: { status: 'error', codigo: 'PERMISSAO_NEGADA', message: 'texto do servidor' } }) });
    assert.equal(proibido.texto('aviso'), E.TEXTOS.SEM_AUTORIDADE);
  });

  test('segurança: conteúdo da API só como texto, sem CPF na tela e nada no armazenamento do navegador', async () => {
    const pg = await pronta({ itens: [item({ trabalhador: { nome: ATAQUE, matricula: 'M', setor: ATAQUE }, material: { id: 1, nome: ATAQUE, tipo: ATAQUE }, responsavel: { nome: ATAQUE } })] });
    assert.equal(pg.consulta('#deliveredTableBody img').length, 0, 'nenhum elemento injetado');
    assert.equal(celulas(linhas(pg)[0])[0], ATAQUE);
    assert.equal(/\d{3}\.\d{3}\.\d{3}-\d{2}|cpf/i.test(pg.textoDoDom()), false);
    assert.deepEqual(pg.storage.filter((s) => s.operacao === 'escrita' && (s.storage === 'localStorage' || s.storage === 'sessionStorage')), []);
  });
});

describe('EPIs Entregues — inspeção estática', () => {
  const html = ler(ARQUIVO);
  const codigo = semComentariosHtml ? semComentariosHtml(html) : html;

  test('página integrada: sem protótipo, sem login simulado, sem quiosque, sem biblioteca remota, módulos na ordem e menu com o item ativo', () => {
    const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
    assert.deepEqual(scripts, ['../js/tema.js', '../js/api-http.js', '../portal/config.js', '../js/sessao-empresarial.js', '../js/permissoes-efetivas.js', '../js/pagina-base.js', '../js/entregas-epi-historico.js']);
    for (const proibido of [/db-api\.js/, /main\.js/, /xlsx/i, /loginScreen/, /Cobresul/, /doLogin/, /kiosk/i, /localStorage|sessionStorage/, /innerHTML/, /cdn\.jsdelivr/]) {
      assert.equal(proibido.test(codigo), false, `contém ${proibido}`);
    }
    assert.match(html, /<a class="active" href="javascript:void\(0\)" data-pagina="deliveredItems" style="display:none"><div class="nav-icon green">inventory<\/div>EPIs Entregues<\/a>/);
    assert.match(semComentarios(html), /EpiPermissoes\.prepararPagina\(\{\s*pagina: 'deliveredItems'/);
  });

  test('referência visual preservada: título, cartão de consulta e as 11 colunas', () => {
    assert.match(html, />EPIs Entregues<\/h2>/);
    assert.match(html, /<h2>Consulta de entregas realizadas<\/h2>/);
    assert.match(html, /<div class="filters-grid"/);
    assert.match(html, /<th>Entregue por<\/th>/);
  });

  test('acabamento: texto abaixo do título, cartão intacto e filtros responsivos sem overflow (cinco campos, botões abaixo)', () => {
    assert.match(html, /margin-top:4px">Relatório de EPIs entregues aos funcionários\.<\/p>/);
    assert.equal(/Listagem de todos os EPIs/.test(html), false);
    assert.match(html, /<h2>Consulta de entregas realizadas<\/h2>/);
    assert.match(html, /<p>Filtre as entregas por tipo de item, funcionário e período conforme a necessidade\.<\/p>/);
    const filtros = html.slice(html.indexOf('<div class="filters-grid"'), html.indexOf('<div class="table-wrap">'));
    assert.deepEqual([...filtros.matchAll(/<label for="([^"]+)">([^<]+)<\/label>/g)].map((m) => [m[1], m[2]]), [
      ['deliveredType', 'Tipo de item'], ['deliveredEmployee', 'Funcionário'], ['deliveredFrom', 'Período inicial'], ['deliveredTo', 'Período final'], ['deliveredStatus', 'Status de validade'],
    ]);
    assert.match(html, /\.filters-grid\{grid-template-columns:repeat\(auto-fit,minmax\(min\(100%,210px\),1fr\)\)\}/);
    assert.match(html, /\.filters-grid \.filters-actions\{grid-column:1 \/ -1;justify-content:flex-end\}/);
    assert.match(html, /\.filters-grid \.field,\.filters-grid \.input,\.filters-grid \.select\{min-width:0;max-width:100%/);
    assert.equal(/overflow-x|min-width:\s*\d{3,}px/.test(filtros), false, 'nenhum scroll horizontal nem largura fixa nos filtros');
  });

  test('permissão da tela: a mesma da Ficha de EPI (o servidor exige epiFicha.visualizar), sem permissão nova e sem alterar', () => {
    const P = require('../js/permissoes-efetivas'); // eslint-disable-line global-require
    assert.deepEqual(P.PAGINAS.deliveredItems, { abrir: [{ recurso: 'epiFicha', operacao: 'visualizar' }], alterar: [] });
  });

  test('publicação: módulo e página na allowlist', () => {
    const arquivos = JSON.parse(ler('publicacao/allowlist.json')).arquivos;
    for (const f of ['js/entregas-epi-historico.js', 'pages/delivered-items.html']) assert.ok(arquivos.includes(f), f);
  });
});
