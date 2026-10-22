'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { abrirPagina } = require('./helpers/dom-pagina');
const G = require('../js/dashboard-graficos');

const BASE = { permitido: true, periodo: 'MES', de: '2026-10-01', ate: '2026-10-31' };
async function abrir(setores, total) {
  const grafico = { ...BASE, total, setores };
  const sem = { consultar: false, alterar: false };
  const rotas = {
    'GET /auth/me': () => ({ status: 200, corpo: { status: 'ok', usuario: { id: 7, nome: 'Exemplo', email: 'teste@example.invalid', perfil: 'ADMINISTRADOR' }, empresa: { id: 3, nome: 'Demonstração', cnpj: '00000000000000' } } }),
    'GET /auth/global/me': () => ({ status: 200, corpo: { status: 'ok', empresas: [{ id: 3 }] } }),
    'GET /auth/permissoes': () => ({ status: 200, corpo: { status: 'ok', empresaId: 3, usuarioId: 7, perfil: 'ADMINISTRADOR', recursos: { dashboard: { visualizar: true, criar: false, editar: false, excluir: false } }, acoes: {}, administracao: { gruposAcesso: sem, permissoesGrupo: sem, vinculosGrupo: sem, usuarios: sem, autorizacoesIndividuais: { consultar: false, concederDireta: false, delegar: false }, vinculosSst: sem } } }),
    'GET /dashboard/indicadores': () => ({ status: 200, corpo: { status: 'ok', indicadores: {} } }),
    'GET /dashboard/graficos/setores': () => ({ status: 200, corpo: { status: 'ok', grafico } }),
    'GET /dashboard/graficos/epis-entregues': () => ({ status: 200, corpo: { status: 'ok', grafico: { ...BASE, total: 0, agrupamento: 'DIA', produtos: [], series: [] } } }),
  };
  const pg = abrirPagina('pages/dashboard.html', { rotas, largura: 1440 });
  await pg.esperar();
  return pg;
}
const arcos = pg => pg.consulta('#graficoSetores .gr-rosca-segmento');
const nomes = pg => pg.consulta('#graficoSetores [data-setor]').map(e => e.getAttribute('data-setor'));

test('rosca: proporções exatas em relação ao total, sem o arredondamento da antiga barra máxima', async () => {
  const pg = await abrir([{ setor: 'A', quantidade: 3 }, { setor: 'B', quantidade: 2 }, { setor: 'C', quantidade: 1 }], 6);
  const fatias = arcos(pg).map(e => Number(e.getAttribute('stroke-dasharray').split(' ')[0]));
  assert.deepEqual(nomes(pg), ['A', 'B', 'C']);
  assert.equal(pg.consulta('.gr-rosca-total')[0].textContent, '6');
  assert.equal(pg.consulta('.gr-rosca-descricao')[0].textContent, 'Funcionários ativos');
  assert.ok(Math.abs(fatias.reduce((a, b) => a + b, 0) - 100) < 1e-10);
  assert.ok(Math.abs(fatias[1] - 100 / 3) < 1e-10);
  assert.deepEqual(pg.consulta('.gr-rosca-percentual').map(e => e.textContent), ['50%', '33,3%', '16,7%']);
});

test('rosca: setor com um funcionário permanece como segmento e item da legenda, mesmo abaixo de 0,1%', async () => {
  const pg = await abrir([{ setor: 'Maior', quantidade: 1000000 }, { setor: 'Um funcionário', quantidade: 1 }], 1000001);
  assert.equal(arcos(pg).length, 2);
  assert.ok(Number(arcos(pg)[1].getAttribute('stroke-dasharray').split(' ')[0]) > 0);
  assert.equal(pg.consulta('.gr-rosca-quantidade')[1].textContent, '1');
  assert.equal(pg.consulta('.gr-rosca-percentual')[1].textContent, '0,0001%');
});

test('rosca: setor único ocupa o círculo completo, e setores zerados não desenham uma fatia falsa', async () => {
  const pg = await abrir([{ setor: 'Único', quantidade: 8 }, { setor: 'Zero', quantidade: 0 }], 8);
  assert.equal(arcos(pg).length, 1);
  assert.equal(arcos(pg)[0].getAttribute('stroke-dasharray'), '100 0');
  assert.deepEqual(nomes(pg), ['Único', 'Zero']);
  assert.deepEqual(pg.consulta('.gr-rosca-percentual').map(e => e.textContent), ['100%', '0%']);
});

test('rosca: total zero não cria círculo fictício, mesmo se a resposta incluir um setor zerado', async () => {
  for (const setores of [[], [{ setor: 'Sem funcionários', quantidade: 0 }]]) {
    const pg = await abrir(setores, 0);
    assert.equal(arcos(pg).length, 0);
    assert.equal(pg.consulta('.gr-rosca-desenho').length, 0);
    assert.match(pg.el('graficoSetores').textContent, /nenhum funcionário ativo/i);
  }
});

test('rosca: total divergente da soma fica indisponível em vez de inventar fatias ou um novo total', async () => {
  const pg = await abrir([{ setor: 'A', quantidade: 3 }, { setor: 'B', quantidade: 2 }], 9);
  assert.equal(arcos(pg).length, 0);
  assert.equal(pg.consulta('.gr-rosca-total').length, 0);
  assert.match(pg.el('graficoSetores').textContent, /dados indisponíveis/i);
});

test('rosca: segmentos e botões da legenda têm foco, descrição completa e destaque sincronizado', async () => {
  const pg = await abrir([{ setor: 'Manutenção e serviços industriais', quantidade: 2 }, { setor: 'Administrativo', quantidade: 1 }], 3);
  const segmentos = arcos(pg), botoes = pg.consulta('.gr-rosca-setor');
  assert.equal(segmentos[0].getAttribute('tabindex'), '0');
  assert.equal(segmentos[0].getAttribute('role'), 'img');
  assert.match(segmentos[0].getAttribute('aria-label'), /Manutenção e serviços industriais: 2 funcionários, 66,7%/);
  assert.equal(botoes[0].getAttribute('type'), 'button');
  await segmentos[0].disparar('focus');
  assert.equal(botoes[0].classList.contains('is-ativo'), true);
  await botoes[1].disparar('mouseenter');
  assert.equal(segmentos[1].classList.contains('is-ativo'), true);
  assert.equal(segmentos[0].classList.contains('is-ativo'), false);
  await botoes[1].disparar('mouseleave');
  assert.equal(segmentos[1].classList.contains('is-ativo'), false);
});

test('rosca: nenhum setor é cortado ou agrupado, e nomes são inseridos como texto', async () => {
  const setores = Array.from({ length: 40 }, (_, i) => ({ setor: i === 0 ? '<img src=x onerror=alert(1)>' : 'Setor com nome extenso ' + i, quantidade: 1 }));
  const pg = await abrir(setores, 40);
  assert.equal(nomes(pg).length, 40);
  assert.equal(arcos(pg).length, 40);
  assert.equal(pg.consulta('.gr-rosca-nome')[0].textContent, setores[0].setor);
  assert.equal(pg.consulta('#graficoSetores img').length, 0);
  assert.equal(pg.consulta('.gr-rosca-total')[0].textContent, '40');
});

test('rosca: as cores dos setores se mantêm quando a ordem muda, sem alterar a paleta dos produtos', async () => {
  const pg = await abrir([{ setor: 'Produção', quantidade: 3 }, { setor: 'Logística', quantidade: 1 }], 4);
  const cor = arcos(pg)[0].getAttribute('stroke');
  const paleta = G.cores.PALETA.slice();
  pg.janela.EpiDashboardGraficos.renderizar.setores(pg.documento, pg.el('graficoSetores'), G.modelo.setores({ ...BASE, total: 4, setores: [{ setor: 'Logística', quantidade: 1 }, { setor: 'Produção', quantidade: 3 }] }));
  assert.equal(arcos(pg)[1].getAttribute('stroke'), cor);
  assert.deepEqual(G.cores.PALETA, paleta);
});
