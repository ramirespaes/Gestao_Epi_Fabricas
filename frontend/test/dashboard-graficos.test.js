'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { abrirPagina } = require('./helpers/dom-pagina');

const EpiHttp = require('../js/api-http');

/**
 * 12I — os dois painéis "em integração" do Dashboard viram gráficos reais, cada um com o seu seletor de período (Mês | 6 meses | 1 ano, padrão
 * Mês), independentes: trocar um período recarrega SÓ aquele gráfico.
 *   Distribuição por setor: rosca proporcional dos funcionários ATIVOS cadastrados no período, por setor (GET /dashboard/graficos/setores).
 *   Produtos que mais saem: rosca das unidades acumuladas por material no período, com Outros fora do top 5
 *     (GET /dashboard/graficos/epis-entregues); cor fixa por produto, legenda, valores na leitura ao passar o mouse ou focar.
 * O servidor decide a permissão de cada gráfico (permitido:false = "sem permissão", sem número); períodos, chaves e totais vêm do servidor;
 * nada é recalculado nem guardado no navegador; DOM só por nós e texto (nunca innerHTML).
 */

const RAIZ = path.join(__dirname, '..');
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
function modulo() {
  assert.ok(fs.existsSync(path.join(RAIZ, 'js/dashboard-graficos.js')), 'comportamento ausente: js/dashboard-graficos.js não existe');
  return require('../js/dashboard-graficos'); // eslint-disable-line global-require
}

const SETORES = { permitido: true, periodo: 'MES', de: '2026-10-01', ate: '2026-10-31', total: 6, setores: [{ setor: 'Produção', quantidade: 3 }, { setor: 'Manutenção', quantidade: 2 }, { setor: 'Sem setor', quantidade: 1 }] };
const ENTREGAS = {
  permitido: true, periodo: 'MES', de: '2026-10-01', ate: '2026-10-31', agrupamento: 'DIA', total: 26,
  produtos: [{ materialId: 7, nome: 'Luva', total: 20 }, { materialId: 9, nome: 'Botina', total: 6 }],
  series: [{ chave: '2026-10-01', quantidades: [0, 0] }, { chave: '2026-10-02', quantidades: [12, 6] }, { chave: '2026-10-03', quantidades: [8, 0] }],
};

describe('módulo: períodos, consultas e modelo', () => {
  test('PERIODOS e PADRAO: Mês (padrão), 6 meses e 1 ano, com os códigos do servidor', () => {
    const G = modulo();
    assert.deepEqual(G.PERIODOS.map((p) => [p.codigo, p.rotulo]), [['MES', 'Mês'], ['SEIS_MESES', '6 meses'], ['ANO', '1 ano']]);
    assert.equal(G.PADRAO, 'MES');
  });

  test('acoes consultam as duas rotas com o período na consulta; período desconhecido é TypeError antes da rede', async () => {
    const G = modulo();
    const chamadas = [];
    EpiHttp.configurar({ baseUrl: 'http://localhost:3000/api', fetch: async (url) => { chamadas.push(url); return { status: 200, ok: true, text: async () => JSON.stringify({ status: 'ok', grafico: SETORES }) }; } });
    await G.acoes.setores('MES');
    await G.acoes.episEntregues('SEIS_MESES');
    assert.deepEqual(chamadas, ['http://localhost:3000/api/dashboard/graficos/setores?periodo=MES', 'http://localhost:3000/api/dashboard/graficos/epis-entregues?periodo=SEIS_MESES']);
    for (const ruim of ['mes', 'SEMANA', '', undefined, 'MES&x=1']) {
      assert.throws(() => G.acoes.setores(ruim), TypeError, String(ruim));
      assert.throws(() => G.acoes.episEntregues(ruim), TypeError, String(ruim));
    }
    assert.equal(chamadas.length, 2);
  });

  test('modelo.setores: percentuais pela maior barra, texto por barra, total; negado, vazio e malformado têm estado próprio', () => {
    const G = modulo();
    const m = G.modelo.setores(SETORES);
    assert.equal(m.estado, 'ok');
    assert.equal(m.total, 6);
    assert.deepEqual(m.barras.map((b) => [b.rotulo, b.quantidade, b.percentual]), [['Produção', 3, 100], ['Manutenção', 2, 67], ['Sem setor', 1, 33]]);
    assert.deepEqual(m.barras.map((b) => b.texto), ['3 funcionários', '2 funcionários', '1 funcionário']);
    assert.equal(G.modelo.setores({ permitido: false }).estado, 'negado');
    assert.equal(G.modelo.setores({ ...SETORES, total: 0, setores: [] }).estado, 'vazio');
    for (const ruim of [null, {}, { permitido: true }, { ...SETORES, setores: [{ setor: 'X', quantidade: -1 }] }, { ...SETORES, setores: [{ setor: 5, quantidade: 1 }] }]) {
      assert.equal(G.modelo.setores(ruim).estado, 'invalido', JSON.stringify(ruim));
    }
  });

  test('modelo.episEntregues: produtos com cor fixa, colunas na ordem do servidor com rótulo do dia, segmentos por produto, altura pela maior coluna', () => {
    const G = modulo();
    const m = G.modelo.episEntregues(ENTREGAS);
    assert.equal(m.estado, 'ok');
    assert.equal(m.total, 26);
    assert.deepEqual(m.produtos.map((p) => [p.materialId, p.nome, p.total]), [[7, 'Luva', 20], [9, 'Botina', 6]]);
    assert.ok(m.produtos.every((p) => /^#[0-9a-f]{6}$/i.test(p.cor)));
    assert.notEqual(m.produtos[0].cor, m.produtos[1].cor);
    assert.deepEqual(m.colunas.map((c) => [c.chave, c.rotulo, c.total]), [['2026-10-01', '01', 0], ['2026-10-02', '02', 18], ['2026-10-03', '03', 8]]);
    assert.equal(m.maximo, 18);
    assert.deepEqual(m.colunas[1].segmentos.map((s) => [s.nome, s.quantidade, s.cor, s.altura]), [['Luva', 12, m.produtos[0].cor, 67], ['Botina', 6, m.produtos[1].cor, 33]]);
    assert.deepEqual(m.colunas[0].segmentos.map((s) => s.quantidade), [0, 0]);
    assert.equal(m.colunas[1].leitura, '02/10/2026 · Luva 12 · Botina 6 · total 18');
  });

  test('modelo.episEntregues por mês: rótulo "mmm/aa"; cor do produto é a mesma entre períodos (pelo material), nunca pela posição', () => {
    const G = modulo();
    const porMes = { ...ENTREGAS, periodo: 'ANO', agrupamento: 'MES', produtos: [{ materialId: 9, nome: 'Botina', total: 50 }, { materialId: 7, nome: 'Luva', total: 20 }], series: [{ chave: '2025-11', quantidades: [50, 20] }, { chave: '2026-10', quantidades: [0, 0] }] };
    const m1 = G.modelo.episEntregues(ENTREGAS);
    const m2 = G.modelo.episEntregues(porMes);
    assert.deepEqual(m2.colunas.map((c) => c.rotulo), ['nov/25', 'out/26']);
    assert.equal(m2.colunas[0].leitura, 'nov/2025 · Botina 50 · Luva 20 · total 70');
    assert.equal(m2.produtos.find((p) => p.materialId === 7).cor, m1.produtos.find((p) => p.materialId === 7).cor, 'a Luva mantém a cor ao mudar de posição');
    assert.equal(m2.produtos.find((p) => p.materialId === 9).cor, m1.produtos.find((p) => p.materialId === 9).cor);
  });

  test('modelo.episEntregues: negado, vazio (sem produtos) e malformado', () => {
    const G = modulo();
    assert.equal(G.modelo.episEntregues({ permitido: false }).estado, 'negado');
    assert.equal(G.modelo.episEntregues({ ...ENTREGAS, total: 0, produtos: [], series: ENTREGAS.series.map((s) => ({ chave: s.chave, quantidades: [] })) }).estado, 'vazio');
    for (const ruim of [null, { permitido: true }, { ...ENTREGAS, series: [{ chave: '2026-10-01', quantidades: [1] }] }, { ...ENTREGAS, agrupamento: 'SEMANA' }, { ...ENTREGAS, produtos: [{ materialId: 7, nome: 'Luva', total: 'x' }] }]) {
      assert.equal(G.modelo.episEntregues(ruim).estado, 'invalido', JSON.stringify(ruim));
    }
  });

  test('o módulo e a página não usam innerHTML, armazenamento do navegador nem bibliotecas externas', () => {
    const fonte = ler('js/dashboard-graficos.js');
    for (const trecho of ['innerHTML', 'localStorage', 'sessionStorage', 'document.write', 'https://', 'http://']) assert.equal(fonte.includes(trecho), false, trecho);
    const html = ler('pages/dashboard.html');
    assert.equal(html.includes('em integração</p>\n          </section>\n          <section class="chart-shell">'), false, 'os painéis dos gráficos deixaram de ser placeholders');
    assert.ok(html.includes('js/dashboard-graficos.js'), 'a página carrega o módulo');
    assert.ok(JSON.parse(ler('publicacao/allowlist.json')).arquivos.includes('js/dashboard-graficos.js'), 'allowlist');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Página em DOM simulado (harness real: todos os scripts da página)
// ═══════════════════════════════════════════════════════════════════
const NENHUMA = { visualizar: false, criar: false, editar: false, excluir: false };
const area = (v) => ({ consultar: v, alterar: v });
const permissoes = () => ({
  status: 'ok', empresaId: 3, usuarioId: 7, perfil: 'ADMINISTRADOR', recursos: { dashboard: { ...NENHUMA, visualizar: true } }, acoes: {},
  administracao: { gruposAcesso: area(false), permissoesGrupo: area(false), vinculosGrupo: area(false), usuarios: area(false), autorizacoesIndividuais: { consultar: false, concederDireta: false, delegar: false }, vinculosSst: area(false) },
});
const INDICADORES = { itensDisponiveis: { permitido: true, valor: 40 }, estoqueAbaixoMinimo: { permitido: true, valor: 3 }, saldoLivre: { permitido: true, valor: 30 }, comprometido: { permitido: true, valor: 10 }, semCobertura: { permitido: true, valor: 2 }, necessidadeReposicao: { permitido: true, valor: 11 }, caVencido: { permitido: true, valor: 4, aVencer: 5, diasAlerta: 60 }, funcionariosAtivos: { permitido: true, valor: 17 }, solicitacoesAguardandoSst: { permitido: true, valor: 5 }, solicitacoesAguardandoEstoque: { permitido: true, valor: 3 }, disponiveisParaEntrega: { permitido: true, valor: 2 }, episEntregues: { permitido: true, valor: 31, de: '2026-10-01', ate: '2026-10-31' }, proximoVencimentoUso: { permitido: true, valor: 8 } };

async function abrir({ setores = () => SETORES, entregas = () => ENTREGAS } = {}) {
  modulo();
  const corpo = (status, c) => ({ status, corpo: c });
  const rotas = {
    'GET /auth/me': () => corpo(200, { status: 'ok', usuario: { id: 7, nome: 'Eva', email: 'eva@example.invalid', perfil: 'ADMINISTRADOR' }, empresa: { id: 3, nome: 'Empresa Teste', cnpj: '00000000000000' } }),
    'GET /auth/global/me': () => corpo(200, { status: 'ok', empresas: [{ id: 3 }] }),
    'GET /auth/permissoes': () => corpo(200, permissoes()),
    'GET /dashboard/indicadores': () => corpo(200, { status: 'ok', indicadores: INDICADORES }),
    'GET /dashboard/graficos/setores': async (c) => { const g = await setores(c); return g instanceof Error ? g : (g.status ? g : corpo(200, { status: 'ok', grafico: g })); },
    'GET /dashboard/graficos/epis-entregues': async (c) => { const g = await entregas(c); return g instanceof Error ? g : (g.status ? g : corpo(200, { status: 'ok', grafico: g })); },
  };
  const pg = abrirPagina('pages/dashboard.html', { rotas, largura: 1440 });
  await pg.esperar();
  return pg;
}
const chamadasDe = (pg, nome) => pg.chamadas.filter((c) => c.caminho === `/dashboard/graficos/${nome}`);
const periodoDe = (c) => new URL(c.url).searchParams.get('periodo');

describe('página: os dois gráficos carregam com Mês e cada seletor só recarrega o seu', () => {
  test('ao abrir: uma consulta por gráfico, com periodo=MES, e os seletores em Mês', async () => {
    const pg = await abrir();
    assert.deepEqual(chamadasDe(pg, 'setores').map(periodoDe), ['MES']);
    assert.deepEqual(chamadasDe(pg, 'epis-entregues').map(periodoDe), ['MES']);
    assert.equal(pg.el('periodoSetores').value, 'MES');
    assert.equal(pg.el('periodoEntregas').value, 'MES');
    for (const id of ['periodoSetores', 'periodoEntregas']) {
      assert.deepEqual(pg.el(id).querySelectorAll('option').map((o) => [o.getAttribute('value'), o.textContent]), [['MES', 'Mês'], ['SEIS_MESES', '6 meses'], ['ANO', '1 ano']]);
    }
  });

  test('setores: rosca e legenda com rótulo, quantidade e proporção do total; o texto do período vem do servidor', async () => {
    const pg = await abrir();
    const barras = pg.consulta('#graficoSetores [data-setor]');
    assert.deepEqual(barras.map((b) => b.getAttribute('data-setor')), ['Produção', 'Manutenção', 'Sem setor']);
    assert.deepEqual(barras.map((b) => b.querySelector('.gr-rosca-quantidade').textContent), ['3', '2', '1']);
    assert.deepEqual(barras.map((b) => b.querySelector('.gr-rosca-percentual').textContent), ['50%', '33,3%', '16,7%']);
    assert.equal(pg.consulta('.gr-rosca-total')[0].textContent, '6');
    assert.equal(pg.consulta('#graficoSetores .gr-rosca-segmento').length, 3);
    assert.match(pg.el('resumoSetores').textContent, /6 funcionários ativos cadastrados/);
    assert.match(pg.el('resumoSetores').textContent, /01\/10\/2026 a 31\/10\/2026/);
    assert.equal(pg.el('graficoSetores').querySelectorAll('.estado-integracao').length, 0);
  });

  test('produtos: rosca acumulada por material, legenda proporcional e destaque por foco', async () => {
    const pg = await abrir();
    const arcos = pg.consulta('#graficoEntregas .gr-rosca-segmento');
    assert.deepEqual(arcos.map(e => e.getAttribute('data-material-id')), ['7', '9']);
    const legenda = pg.consulta('#legendaEntregas [data-material-id]');
    assert.deepEqual(legenda.map(l => [l.getAttribute('data-material-id'), l.querySelector('.gr-rosca-nome').textContent]), [['7', 'Luva'], ['9', 'Botina']]);
    assert.equal(pg.consulta('#graficoEntregas .gr-rosca-total')[0].textContent, '26');
    assert.deepEqual(pg.consulta('#graficoEntregas .gr-rosca-percentual').map(e => e.textContent), ['76,9%', '23,1%']);
    assert.equal(legenda[0].querySelector('.gr-rosca-cor').style.background, arcos[0].getAttribute('stroke'));
    await arcos[0].disparar('focus');
    assert.equal(legenda[0].querySelector('button').classList.contains('is-ativo'), true);
    assert.match(arcos[0].getAttribute('aria-label'), /Luva \(material 7\): 20 unidades entregues/);
    assert.match(pg.el('resumoEntregas').textContent, /26 unidades entregues/);
  });

  test('trocar o período dos setores consulta SÓ os setores com o novo período; o de produtos idem', async () => {
    const pg = await abrir({ setores: (c) => ({ ...SETORES, periodo: periodoDe(c), setores: periodoDe(c) === 'ANO' ? [{ setor: 'Logística', quantidade: 9 }] : SETORES.setores, total: periodoDe(c) === 'ANO' ? 9 : 6 }) });
    pg.el('periodoSetores').value = 'ANO';
    await pg.el('periodoSetores').disparar('change');
    await pg.esperar();
    assert.deepEqual(chamadasDe(pg, 'setores').map(periodoDe), ['MES', 'ANO']);
    assert.deepEqual(chamadasDe(pg, 'epis-entregues').map(periodoDe), ['MES'], 'o outro gráfico não é consultado');
    assert.deepEqual(pg.consulta('#graficoSetores [data-setor]').map((b) => b.getAttribute('data-setor')), ['Logística']);
    assert.equal(pg.chamadas.filter((c) => c.caminho === '/dashboard/indicadores').length, 1, 'os cartões não são recarregados');
    pg.el('periodoEntregas').value = 'SEIS_MESES';
    await pg.el('periodoEntregas').disparar('change');
    await pg.esperar();
    assert.deepEqual(chamadasDe(pg, 'epis-entregues').map(periodoDe), ['MES', 'SEIS_MESES']);
    assert.deepEqual(chamadasDe(pg, 'setores').map(periodoDe), ['MES', 'ANO']);
  });

  test('resposta atrasada de um período anterior é descartada: vale a última seleção', async () => {
    const pendentes = [];
    const pg = await abrir({ setores: (c) => (periodoDe(c) === 'SEIS_MESES' ? new Promise((r) => pendentes.push(() => r({ ...SETORES, setores: [{ setor: 'ATRASADA', quantidade: 1 }], total: 1 }))) : { ...SETORES, setores: [{ setor: periodoDe(c), quantidade: 2 }], total: 2 }) });
    pg.el('periodoSetores').value = 'SEIS_MESES';
    await pg.el('periodoSetores').disparar('change');
    pg.el('periodoSetores').value = 'ANO';
    await pg.el('periodoSetores').disparar('change');
    await pg.esperar();
    assert.deepEqual(pg.consulta('#graficoSetores [data-setor]').map((b) => b.getAttribute('data-setor')), ['ANO']);
    pendentes.forEach((r) => r());
    await pg.esperar();
    assert.deepEqual(pg.consulta('#graficoSetores [data-setor]').map((b) => b.getAttribute('data-setor')), ['ANO'], 'a resposta antiga não sobrescreve');
  });

  test('sem permissão da fonte: o painel mostra "sem permissão", sem barras, seletor desabilitado; o outro gráfico segue normal', async () => {
    const pg = await abrir({ setores: () => ({ permitido: false }) });
    assert.equal(pg.consulta('#graficoSetores [data-setor]').length, 0);
    assert.match(pg.el('graficoSetores').textContent, /sem permissão/i);
    assert.equal(pg.el('periodoSetores').disabled, true);
    assert.equal(pg.consulta('#graficoEntregas .gr-rosca-segmento').length, 2);
    assert.equal(pg.el('periodoEntregas').disabled, false);
  });

  test('vazio e erro: estado discreto no próprio painel, nunca um gráfico inventado; 401 encerra a sessão', async () => {
    const vazio = await abrir({ entregas: () => ({ ...ENTREGAS, total: 0, produtos: [], series: ENTREGAS.series.map((s) => ({ chave: s.chave, quantidades: [] })) }) });
    assert.equal(vazio.consulta('#graficoEntregas [data-chave]').length, 0);
    assert.match(vazio.el('graficoEntregas').textContent, /nenhuma entrega/i);
    const erro = await abrir({ setores: () => ({ status: 500, corpo: { status: 'error', codigo: 'ERRO' } }) });
    assert.equal(erro.consulta('#graficoSetores [data-setor]').length, 0);
    assert.match(erro.el('graficoSetores').textContent, /não foi possível/i);
    assert.equal(erro.el('periodoSetores').disabled, false, 'pode tentar outro período');
    const expirada = await abrir({ entregas: () => ({ status: 401, corpo: { status: 'error', codigo: 'SESSAO_INVALIDA' } }) });
    assert.ok(expirada.navegacoes.some((n) => /portal/.test(n)), 'sessão encerrada: volta ao Portal'); // sessaoEncerrada() navega ao login do Portal
  });

  test('os 15 cartões continuam como estavam: visíveis, com link e sem ouvintes novos', async () => {
    const pg = await abrir();
    assert.equal(pg.consulta('.kpi-card').length, 15);
    assert.equal(pg.el('linkEpisEntregues').getAttribute('href'), 'reports.html?de=2026-10-01&ate=2026-10-31#reportDelivered');
    // O único armazenamento da página é o cache de aparência de js/tema.js; os gráficos não guardam período nem dado.
    assert.deepEqual(pg.storage.filter((s) => s.storage !== 'cookie' && !/aparencia|epi-session-user/.test(String(s.chave))), []); // (a limpeza da chave legada é da sessão)
  });
});
