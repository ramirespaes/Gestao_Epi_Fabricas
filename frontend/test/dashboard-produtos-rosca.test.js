'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { abrirPagina } = require('./helpers/dom-pagina');
const G = require('../js/dashboard-graficos');

const BASE = { permitido: true, periodo: 'MES', de: '2026-10-01', ate: '2026-10-31' };
async function abrir(produtos, total, entregas) {
  const grafico = { ...BASE, total, agrupamento: 'DIA', produtos, series: [] };
  const sem = { consultar: false, alterar: false };
  const rotas = {
    'GET /auth/me': () => ({ status: 200, corpo: { status: 'ok', usuario: { id: 7, nome: 'Exemplo', email: 'teste@example.invalid', perfil: 'ADMINISTRADOR' }, empresa: { id: 3, nome: 'Demonstração', cnpj: '00000000000000' } } }),
    'GET /auth/global/me': () => ({ status: 200, corpo: { status: 'ok', empresas: [{ id: 3 }] } }),
    'GET /auth/permissoes': () => ({ status: 200, corpo: { status: 'ok', empresaId: 3, usuarioId: 7, perfil: 'ADMINISTRADOR', recursos: { dashboard: { visualizar: true, criar: false, editar: false, excluir: false } }, acoes: {}, administracao: { gruposAcesso: sem, permissoesGrupo: sem, vinculosGrupo: sem, usuarios: sem, autorizacoesIndividuais: { consultar: false, concederDireta: false, delegar: false }, vinculosSst: sem } } }),
    'GET /dashboard/indicadores': () => ({ status: 200, corpo: { status: 'ok', indicadores: {} } }),
    'GET /dashboard/graficos/setores': () => ({ status: 200, corpo: { status: 'ok', grafico: { ...BASE, total: 3, setores: [{ setor: 'Produção', quantidade: 3 }] } } }),
    'GET /dashboard/graficos/epis-entregues': async c => { const g = entregas ? await entregas(c) : grafico; return g.status ? g : { status: 200, corpo: { status: 'ok', grafico: g } }; },
  };
  const pg = abrirPagina('pages/dashboard.html', { rotas, largura: 1440 });
  await pg.esperar();
  return pg;
}const produto = (materialId, total, nome = 'Produto ' + materialId) => ({ materialId, nome, total });
const arcos = pg => pg.consulta('#graficoEntregas .gr-rosca-segmento');
const itens = pg => pg.consulta('#legendaEntregas .gr-rosca-item');
const total = pg => pg.consulta('#graficoEntregas .gr-rosca-total')[0]?.textContent;
const shares = pg => arcos(pg).map(e => Number(e.getAttribute('stroke-dasharray').split(' ')[0]));
const checarCem = pg => assert.ok(Math.abs(shares(pg).reduce((s,n) => s+n,0)-100)<1e-10);

test('produtos/rosca: top 5 acumulado e diferença oficial como Outros, sem confundir com o ranking', async () => {
  const pg = await abrir([produto(1,30),produto(2,20),produto(3,15),produto(4,10),produto(5,5)],100);
  assert.equal(total(pg),'100');
  assert.equal(pg.consulta('#graficoEntregas .gr-rosca-descricao')[0].textContent,'Unidades entregues');
  assert.deepEqual(shares(pg),[30,20,15,10,5,20]);
  assert.match(pg.el('notaPercentuaisEntregas').textContent,/Percentuais arredondados/);
  assert.deepEqual(pg.consulta('#legendaEntregas [data-material-id]').map(e => e.getAttribute('data-material-id')),['1','2','3','4','5']);
  const outros=pg.consulta('#legendaEntregas [data-outros]')[0];
  assert.match(outros.textContent,/OutrosFora do top 5/);
  assert.equal(outros.querySelector('.gr-rosca-quantidade').textContent,'20');
  assert.match(arcos(pg)[5].getAttribute('aria-label'),/fora do top 5.*20 unidades entregues, 20%/);
  checarCem(pg);
});

test('produtos/rosca: soma igual ao total não cria Outros; uma unidade continua representada', async () => {
  const pg=await abrir([produto(8,2),produto(9,1)],3);
  assert.equal(pg.consulta('#graficoEntregas [data-outros]').length,0);
  assert.equal(arcos(pg).length,2);checarCem(pg);
  assert.deepEqual(pg.consulta('#graficoEntregas .gr-rosca-percentual').map(e=>e.textContent),['66,7%','33,3%']);
});

test('produtos/rosca: totais oficiais inconsistentes, IDs duplicados e precisão insegura ficam indisponíveis', async () => {
  for(const [produtos,t] of [[[produto(1,11)],10],[[produto(1,1),produto(1,1)],2],[[produto(1,Number.MAX_SAFE_INTEGER)],Number.MAX_SAFE_INTEGER+1]]) {
    const pg=await abrir(produtos,t);
    assert.equal(arcos(pg).length,0);assert.equal(total(pg),undefined);
    assert.match(pg.el('graficoEntregas').textContent,/dados indisponíveis/i);
  }
});

test('produtos/rosca: total zero usa estado vazio, nunca uma rosca fictícia', async () => {
  for(const produtos of [[],[produto(1,0)]]){
    const pg=await abrir(produtos,0);assert.equal(arcos(pg).length,0);
    assert.match(pg.el('graficoEntregas').textContent,/nenhuma entrega/i);
  }
});

test('produtos/rosca: ranking vazio com total positivo mantém o total da API como Outros', async () => {
  const pg=await abrir([],9);assert.equal(total(pg),'9');assert.equal(itens(pg).length,1);
  assert.equal(arcos(pg)[0].getAttribute('stroke-dasharray'),'100 0');
  assert.match(itens(pg)[0].textContent,/Fora do top 5/);checarCem(pg);
});

test('produtos/rosca: nomes iguais não agrupam materiais distintos; nomes não são HTML', async () => {
  const nome='<img src=x onerror=alert(1)>';
  const pg=await abrir([produto(7,2,nome),produto(9,1,nome)],3);
  assert.equal(itens(pg).length,2);
  assert.deepEqual(itens(pg).map(e=>e.querySelector('.gr-rosca-nota').textContent),['Material 7','Material 9']);
  assert.match(arcos(pg)[1].getAttribute('aria-label'),/material 9/);
  assert.equal(pg.consulta('#graficoEntregas img').length,0);
  assert.equal(itens(pg)[0].querySelector('.gr-rosca-nome').textContent,nome+'Material 7');
});

test('produtos/rosca: foco, hover e botão nativo destacam o mesmo material com descrição completa', async () => {
  const pg=await abrir([produto(1,3),produto(2,1)],5), a=arcos(pg), b=itens(pg).map(e=>e.querySelector('button'));
  assert.equal(a[0].getAttribute('tabindex'),'0');assert.equal(a[0].querySelector('title').textContent,a[0].getAttribute('aria-label'));assert.equal(a[0].getAttribute('role'),'img');
  assert.equal(b[0].getAttribute('type'),'button');
  await a[0].disparar('focus');assert.ok(b[0].classList.contains('is-ativo'));
  await b[1].disparar('mouseenter');assert.ok(a[1].classList.contains('is-ativo'));assert.ok(!a[0].classList.contains('is-ativo'));
  await b[1].disparar('mouseleave');assert.ok(!a[1].classList.contains('is-ativo'));
  await b[2].disparar('click');assert.ok(a[2].classList.contains('is-ativo'));
  assert.match(b[2].getAttribute('title'),/Outros.*1 unidade entregue, 20%/);
});

test('produtos/rosca: cor por material permanece ao mudar a ordem, com reflexo independente de setores', async () => {
  const pg=await abrir([produto(1,3),produto(2,1)],4), cor=arcos(pg)[0].getAttribute('stroke');
  const antes=pg.el('graficoSetores').textContent;
  const g=pg.janela.EpiDashboardGraficos;
  g.renderizar.episEntregues(pg.documento,{grafico:pg.el('graficoEntregas')},g.modelo.episEntregues({...BASE,total:4,agrupamento:'DIA',produtos:[produto(2,1),produto(1,3)],series:[]}));
  assert.equal(arcos(pg)[1].getAttribute('stroke'),cor);
  assert.equal(pg.el('graficoSetores').textContent,antes);
  assert.equal(pg.consulta('#graficoEntregas [id=gr-entregas-reflexo]')[0].getAttribute('id'),'gr-entregas-reflexo');
  assert.equal(pg.consulta('#graficoSetores [id=gr-setores-reflexo]')[0].getAttribute('id'),'gr-setores-reflexo');
});

test('produtos/rosca: total acumulado nos três períodos e seletores independentes, sem recarregar cartões', async () => {
  const pg=await abrir([],0,c=>{const periodo=new URL(c.url).searchParams.get('periodo'),t={MES:5,SEIS_MESES:50,ANO:500}[periodo];return {...BASE,periodo,total:t,agrupamento:periodo==='MES'?'DIA':'MES',produtos:[produto(1,t-1)],series:[]};});
  for(const [p,t] of [['MES','5'],['SEIS_MESES','50'],['ANO','500']]){
    if(p!=='MES'){pg.el('periodoEntregas').value=p;await pg.el('periodoEntregas').disparar('change');await pg.esperar();}
    assert.equal(total(pg),t);checarCem(pg);
  }
  assert.equal(pg.chamadas.filter(c=>c.caminho==='/dashboard/graficos/setores').length,1);
  assert.equal(pg.chamadas.filter(c=>c.caminho==='/dashboard/indicadores').length,1);
  assert.equal(pg.el('periodoSetores').value,'MES');
});

test('produtos/rosca: resposta de período anterior não substitui a última seleção', async () => {
  const pendentes=[];
  const pg=await abrir([],0,c=>{const periodo=new URL(c.url).searchParams.get('periodo');const g={...BASE,periodo,total:periodo==='ANO'?90:8,agrupamento:'DIA',produtos:[produto(1,3)],series:[]};return periodo==='SEIS_MESES'?new Promise(r=>pendentes.push(()=>r(g))):g;});
  pg.el('periodoEntregas').value='SEIS_MESES';await pg.el('periodoEntregas').disparar('change');
  pg.el('periodoEntregas').value='ANO';await pg.el('periodoEntregas').disparar('change');await pg.esperar();
  assert.equal(total(pg),'90');pendentes.forEach(r=>r());await pg.esperar();assert.equal(total(pg),'90');
});

test('produtos/rosca: fonte negada e erro não exibem números nem afetam setores', async () => {
  for(const resposta of [{permitido:false},{status:503,corpo:{status:'error'}}]){
    const pg=await abrir([],0,()=>resposta);assert.equal(arcos(pg).length,0);assert.equal(total(pg),undefined);
    assert.match(pg.el('graficoEntregas').textContent,/sem permissão|não foi possível/i);
    assert.equal(pg.consulta('#graficoSetores .gr-rosca-total')[0].textContent,'3');
  }
});


test('produtos/rosca: novos materiais entre períodos não reciclam as cores dos primeiros cinco', async () => {
  const pg=await abrir([produto(1,3)],3),cores=pg.janela.EpiDashboardGraficos.cores;
  const paleta=Array.from({length:12},(_,i)=>cores.de(i+1));
  assert.equal(new Set(paleta).size,12);
  assert.equal(cores.de(1),paleta[0]);
  assert.equal(cores.de(8),paleta[7]);
});
