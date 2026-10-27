'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { abrirPagina } = require('./helpers/dom-pagina');

/**
 * Dashboard 12I — legenda compacta da "Distribuição por setor": a rosca continua com TODOS os setores (nenhum agrupado em "Outros",
 * total intocado), mas a legenda mostra de início só os 10 setores com mais funcionários, em ordem decrescente, em duas colunas de cinco;
 * "Ver todos os setores" expande (área interna com rolagem) e "Mostrar menos" recolhe. A legenda do gráfico de EPIs entregues não muda.
 */
const BASE = { permitido: true, periodo: 'MES', de: '2026-10-01', ate: '2026-10-31' };
const PRODUTOS = [{ materialId: 1, nome: 'Luva', total: 2 }, { materialId: 2, nome: 'Botina', total: 1 }];
async function abrir(setores, total) {
  const grafico = { ...BASE, total, setores };
  const sem = { consultar: false, alterar: false };
  const rotas = {
    'GET /auth/me': () => ({ status: 200, corpo: { status: 'ok', usuario: { id: 7, nome: 'Exemplo', email: 'teste@example.invalid', perfil: 'ADMINISTRADOR' }, empresa: { id: 3, nome: 'Demonstração', cnpj: '00000000000000' } } }),
    'GET /auth/global/me': () => ({ status: 200, corpo: { status: 'ok', empresas: [{ id: 3 }] } }),
    'GET /auth/permissoes': () => ({ status: 200, corpo: { status: 'ok', empresaId: 3, usuarioId: 7, perfil: 'ADMINISTRADOR', recursos: { dashboard: { visualizar: true, criar: false, editar: false, excluir: false } }, acoes: {}, administracao: { gruposAcesso: sem, permissoesGrupo: sem, vinculosGrupo: sem, usuarios: sem, autorizacoesIndividuais: { consultar: false, concederDireta: false, delegar: false }, vinculosSst: sem } } }),
    'GET /dashboard/indicadores': () => ({ status: 200, corpo: { status: 'ok', indicadores: {} } }),
    'GET /dashboard/graficos/setores': () => ({ status: 200, corpo: { status: 'ok', grafico } }),
    'GET /dashboard/graficos/epis-entregues': () => ({ status: 200, corpo: { status: 'ok', grafico: { ...BASE, total: 3, agrupamento: 'DIA', produtos: PRODUTOS, series: [] } } }),
  };
  const pg = abrirPagina('pages/dashboard.html', { rotas, largura: 1440 });
  await pg.esperar();
  return pg;
}
const gerar = (n) => Array.from({ length: n }, (_, i) => ({ setor: `Setor ${String(i + 1).padStart(2, '0')}`, quantidade: n - i }));
const total = (s) => s.reduce((a, b) => a + b.quantidade, 0);
const itens = (pg) => pg.consulta('#graficoSetores .gr-rosca-item');
const visiveis = (pg) => itens(pg).filter((i) => !i.hidden);
const nomesVisiveis = (pg) => visiveis(pg).map((i) => i.getAttribute('data-setor'));
const alternar = (pg) => pg.consulta('#graficoSetores .gr-rosca-alternar')[0];
const arcos = (pg) => pg.consulta('#graficoSetores .gr-rosca-segmento');

test('0 setores: estado vazio, sem legenda e sem botão de expandir', async () => {
  const pg = await abrir([], 0);
  assert.equal(itens(pg).length, 0);
  assert.equal(alternar(pg), undefined);
  assert.equal(pg.consulta('#graficoSetores .gr-estado')[0].textContent, 'Nenhum funcionário ativo cadastrado no período.');
});

test('1, 5 e 10 setores: todos visíveis, sem botão de expandir; rosca e total intocados', async () => {
  for (const n of [1, 5, 10]) {
    const s = gerar(n);
    const pg = await abrir(s, total(s));
    assert.equal(itens(pg).length, n, `${n} itens`);
    assert.equal(visiveis(pg).length, n, `${n} visíveis`);
    assert.equal(alternar(pg), undefined, `${n}: sem alternar`);
    assert.equal(pg.consulta('#graficoSetores .gr-rosca-legenda.is-expandida').length, 0);
    assert.equal(arcos(pg).length, n);
    assert.equal(pg.consulta('#graficoSetores .gr-rosca-total')[0].textContent, String(total(s)));
  }
});

test('11 setores: só os 10 maiores visíveis, em ordem decrescente; o 11º fica no DOM oculto; o botão diz quantos há; a rosca tem 11 fatias e o total soma todos', async () => {
  const s = gerar(11);
  const pg = await abrir(s, total(s));
  assert.equal(itens(pg).length, 11);
  assert.deepEqual(nomesVisiveis(pg), gerar(10).map((x) => x.setor));
  assert.equal(itens(pg)[10].hidden, true);
  assert.equal(arcos(pg).length, 11, 'nenhum setor sai do gráfico');
  assert.equal(pg.consulta('#graficoSetores .gr-rosca-total')[0].textContent, '66');
  const b = alternar(pg);
  assert.ok(b, 'botão Ver todos');
  assert.equal(b.getAttribute('type'), 'button');
  assert.equal(b.getAttribute('aria-expanded'), 'false');
  assert.equal(b.getAttribute('aria-controls'), 'legendaSetores');
  assert.equal(pg.consulta('#graficoSetores .gr-rosca-legenda')[0].getAttribute('id'), 'legendaSetores');
  assert.match(b.textContent, /Ver todos os setores \(11\)/);
  const lado = pg.consulta('#graficoSetores .gr-rosca-lado')[0];
  assert.ok(lado, 'legenda e botão ficam no mesmo bloco lateral');
  assert.equal(lado.children.length, 2);
  assert.equal(lado.children[1], b);
});

test('muitos setores fora de ordem: a legenda ordena por quantidade (decrescente) e mostra os 10 maiores; a rosca mantém a ordem e os valores do servidor', async () => {
  const s = [{ setor: 'Pequeno', quantidade: 1 }, ...gerar(30).map((x) => ({ setor: x.setor + 'x', quantidade: x.quantidade + 1 })), { setor: 'Gigante', quantidade: 500 }];
  const pg = await abrir(s, total(s));
  const v = nomesVisiveis(pg);
  assert.equal(v.length, 10);
  assert.equal(v[0], 'Gigante');
  assert.equal(v.includes('Pequeno'), false);
  const quantidades = visiveis(pg).map((i) => Number(i.querySelector('.gr-rosca-quantidade').textContent));
  assert.deepEqual(quantidades, [...quantidades].sort((a, b) => b - a));
  assert.equal(itens(pg).length, 32);
  assert.equal(arcos(pg).length, 32);
  // A rosca segue a ordem do servidor: a primeira fatia é a de "Pequeno", a última a de "Gigante".
  assert.equal(arcos(pg)[0].getAttribute('aria-label').split(':')[0], 'Pequeno');
  assert.equal(arcos(pg)[31].getAttribute('aria-label').split(':')[0], 'Gigante');
  const fatias = arcos(pg).map((e) => Number(e.getAttribute('stroke-dasharray').split(' ')[0]));
  assert.ok(Math.abs(fatias.reduce((a, b) => a + b, 0) - 100) < 1e-9);
  const pct = visiveis(pg)[0].querySelector('.gr-rosca-percentual').textContent;
  assert.equal(pct, (500 / total(s) * 100).toLocaleString('pt-BR', { maximumSignificantDigits: 3 }) + '%');
});

test('expandir e recolher: "Ver todos os setores" mostra todos (área com rolagem) e "Mostrar menos" volta aos 10; estado aria preservado; nada é recriado', async () => {
  const s = gerar(25);
  const pg = await abrir(s, total(s));
  const antes = itens(pg);
  const b = alternar(pg);
  await b.disparar('click');
  assert.equal(visiveis(pg).length, 25);
  assert.equal(b.getAttribute('aria-expanded'), 'true');
  assert.match(b.textContent, /Mostrar menos/);
  const legenda = pg.consulta('#graficoSetores .gr-rosca-legenda')[0];
  assert.equal(legenda.classList.contains('is-expandida'), true);
  await b.disparar('click');
  assert.equal(visiveis(pg).length, 10);
  assert.equal(b.getAttribute('aria-expanded'), 'false');
  assert.equal(legenda.classList.contains('is-expandida'), false);
  assert.match(b.textContent, /Ver todos os setores \(25\)/);
  assert.deepEqual(itens(pg), antes, 'os mesmos nós: expandir e recolher só alternam hidden');
  assert.equal(arcos(pg).length, 25);
});

test('hover e foco continuam destacando o par item/fatia, inclusive num setor oculto da legenda (a fatia segue na rosca)', async () => {
  const s = gerar(12);
  const pg = await abrir(s, total(s));
  const fatias = arcos(pg);
  const botoes = pg.consulta('#graficoSetores .gr-rosca-setor');
  await fatias[11].disparar('mouseenter');
  assert.equal(fatias[11].classList.contains('is-ativo'), true);
  assert.equal(botoes[11].classList.contains('is-ativo'), true);
  await fatias[11].disparar('mouseleave');
  assert.equal(fatias[11].classList.contains('is-ativo'), false);
  await botoes[0].disparar('focus');
  assert.equal(fatias[0].classList.contains('is-ativo'), true);
  await botoes[0].disparar('blur');
  assert.equal(fatias[0].classList.contains('is-ativo'), false);
});

test('trocar o período reconstrói a legenda recolhida (10 visíveis) sem resíduo do estado anterior', async () => {
  const s = gerar(15);
  const pg = await abrir(s, total(s));
  await alternar(pg).disparar('click');
  assert.equal(visiveis(pg).length, 15);
  pg.el('periodoSetores').value = 'ANO';
  await pg.el('periodoSetores').disparar('change');
  await pg.esperar();
  assert.equal(visiveis(pg).length, 10);
  assert.equal(pg.consulta('#graficoSetores .gr-rosca-alternar').length, 1, 'um único botão depois da troca');
  assert.equal(alternar(pg).getAttribute('aria-expanded'), 'false');
});

test('a legenda do gráfico de EPIs entregues não ganha limite, bloco lateral nem botão', async () => {
  const s = gerar(25);
  const pg = await abrir(s, total(s));
  assert.equal(pg.consulta('#graficoEntregas .gr-rosca-alternar').length, 0);
  assert.equal(pg.consulta('#graficoEntregas .gr-rosca-lado').length, 0);
  assert.equal(pg.consulta('#graficoEntregas .gr-rosca-item[hidden]').length, 0);
  assert.equal(pg.consulta('#graficoEntregas .gr-rosca-item').length, PRODUTOS.length);
});

test('CSS: itens ocultos não ocupam espaço, a legenda expandida rola internamente e as duas colunas da legenda continuam no container', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'css', 'dashboard.css'), 'utf8');
  assert.match(css, /\.gr-rosca-item\[hidden\]\{display:none\}/);
  assert.match(css, /\.gr-rosca-legenda\.is-expandida\{max-height:264px;overflow-y:auto/);
  assert.match(css, /\.gr-rosca-lado\{min-width:0;display:grid/);
  assert.match(css, /\.gr-rosca-alternar\{[^}]*min-height:36px/);
  assert.match(css, /@container setores-rosca \(min-width:280px\)\{\s*body\.dashboard-visual \.gr-rosca-legenda\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)\}/);
});
