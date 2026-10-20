'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { abrirPagina } = require('./helpers/dom-pagina');
const H = require('./helpers/imagens-material');

// Página e módulos reais, respostas em memória: nenhum banco ou API real.
function tipos(n) {
  return Array.from({ length: n }, (_, i) => ({ id: i + 1, grupo: 'EPI', grupoProtecao: 'Proteção das mãos',
    nome: `Tipo ${String(i + 1).padStart(3, '0')}`, ativo: true, origem: 'MANUAL' }));
}
function resposta(lista, pagina, limite) {
  return { status: 200, corpo: { status: 'ok', tipos: lista.slice((pagina - 1) * limite, pagina * limite),
    total: lista.length, pagina, limite, vocabulario: H.servidor().rotas['GET /tipos-material']().corpo.vocabulario } };
}
async function abrir(n = 23, permissoes) {
  const { rotas } = H.servidor(permissoes ? { p: permissoes } : {});
  const estado = { tipos: tipos(n), responder: null };
  rotas['GET /tipos-material'] = (c) => {
    const p = new URL(c.url).searchParams;
    const pagina = Number(p.get('pagina')), limite = Number(p.get('limite'));
    const lista = estado.tipos.filter(t => (!p.get('grupo') || t.grupo === p.get('grupo'))
      && (!p.get('grupoProtecao') || t.grupoProtecao === p.get('grupoProtecao'))
      && (!p.has('ativo') || String(t.ativo) === p.get('ativo'))
      && (!p.get('busca') || t.nome.includes(p.get('busca'))));
    const r = resposta(lista, pagina, limite);
    return estado.responder ? estado.responder(c, r) : r;
  };
  for (let id = 1; id <= n; id += 1) {
    rotas[`POST /tipos-material/${id}/inativar`] = () => {
      const tipo = estado.tipos.find(t => t.id === id);
      tipo.ativo = false;
      return { status: 200, corpo: { status: 'ok', tipo, alterado: true } };
    };
  }
  const pg = abrirPagina('pages/materials.html', { rotas });
  await pg.esperar();
  return { pg, estado };
}
// O harness registra innerHTML sem interpretá-lo; inspecionamos o HTML
// realmente produzido pelo render, e os botões numerados são DOM real.
const htmlLinhas = pg => [...pg.documento.usosDeInnerHTML].reverse().find(u => u.id === 'catalogoCorpo')?.valor || '';
const linhas = pg => [...htmlLinhas(pg).matchAll(/<tr\b[^>]*>/g)];
const acoesLinhas = pg => [...htmlLinhas(pg).matchAll(/data-acao="([^"]+)" data-id="([^"]+)"/g)];
const consultas = pg => pg.chamadas.filter(c => c.chave === 'GET /tipos-material');
const paginaConsultada = pg => Number(new URL(consultas(pg).at(-1).url).searchParams.get('pagina'));
async function filtrar(pg, id, valor) {
  pg.el(id).value = valor;
  await pg.el(id).disparar('change');
  await pg.esperar();
}

test('5 por página, navegação numerada, limites e resumo; paginar só faz GET', async () => {
  const { pg } = await abrir();
  assert.equal(linhas(pg).length, 5);
  assert.match(htmlLinhas(pg), /Tipo 001/);
  assert.doesNotMatch(htmlLinhas(pg), /Tipo 006/);
  assert.equal(pg.el('catalogoAnterior').disabled, true);
  assert.equal(pg.el('catalogoPagina1').getAttribute('aria-current'), 'page');
  assert.match(pg.texto('catalogoResumo'), /1–5 de 23 tipos · Página 1 de 5/);
  await pg.clicar('catalogoPagina2');
  assert.equal(linhas(pg).length, 5);
  assert.match(htmlLinhas(pg), /Tipo 006/);
  assert.equal(pg.documento.activeElement.id, 'catalogoPagina2');
  await pg.clicar('catalogoProxima');
  assert.equal(paginaConsultada(pg), 3);
  assert.equal(linhas(pg).length, 5);
  await pg.clicar('catalogoPagina5');
  assert.equal(linhas(pg).length, 3);
  assert.equal(pg.el('catalogoProxima').disabled, true);
  assert.match(pg.texto('catalogoResumo'), /21–23 de 23 tipos · Página 5 de 5/);
  await pg.clicar('catalogoAnterior');
  assert.equal(paginaConsultada(pg), 4);
  assert.ok(consultas(pg).every(c => new URL(c.url).searchParams.get('limite') === '5'));
  assert.ok(pg.chamadas.every(c => c.metodo === 'GET'));
});

test('grupo, proteção, situação e busca reiniciam na página 1 e continuam na query', async () => {
  const { pg } = await abrir();
  for (const [id, valor, query] of [['catalogoGrupo', 'EPI', 'grupo'], ['catalogoProtecao', 'Proteção das mãos', 'grupoProtecao'],
    ['catalogoBusca', 'Tipo', 'busca'], ['catalogoSituacao', 'todos', null]]) {
    await pg.clicar('catalogoPagina3');
    await filtrar(pg, id, valor);
    assert.equal(paginaConsultada(pg), 1, id);
    const p = new URL(consultas(pg).at(-1).url).searchParams;
    if (query) assert.equal(p.get(query), valor);
    else assert.equal(p.has('ativo'), false);
    assert.equal(linhas(pg).length, 5);
  }
});

test('resultado vazio oculta a paginação e mantém a mensagem da tabela', async () => {
  const { pg } = await abrir();
  await filtrar(pg, 'catalogoBusca', 'inexistente');
  assert.equal(pg.el('paginacaoCatalogo').hidden, true);
  assert.equal(pg.texto('catalogoResumo'), '');
  assert.match(htmlLinhas(pg), /Nenhum tipo/);
  assert.match(pg.texto('catalogoStatus'), /Nenhum tipo/);
});

test('carregamento bloqueia cliques repetidos; falha oferece nova tentativa da mesma página', async () => {
  const { pg, estado } = await abrir();
  let liberar;
  estado.responder = () => new Promise(r => { liberar = r; });
  const pendente = pg.el('catalogoProxima').disparar('click');
  await pg.esperar();
  assert.equal(pg.el('catalogoCorpo').getAttribute('aria-busy'), 'true');
  assert.equal(pg.el('catalogoProxima').disabled, true);
  assert.equal(linhas(pg).length, 0);
  const antes = consultas(pg).length;
  await pg.clicar('catalogoProxima');
  assert.equal(consultas(pg).length, antes);
  liberar({ status: 500, corpo: { codigo: 'ERRO_INTERNO' } });
  await pendente;
  assert.equal(pg.el('catalogoCorpo').getAttribute('aria-busy'), null);
  assert.equal(pg.el('catalogoTentarNovamente').hidden, false);
  estado.responder = null;
  await pg.clicar('catalogoTentarNovamente');
  assert.equal(paginaConsultada(pg), 2);
  assert.match(pg.texto('catalogoResumo'), /6–10 de 23/);
});

test('uma resposta antiga de paginação não sobrescreve filtros mais recentes nem rouba foco', async () => {
  const { pg, estado } = await abrir();
  let liberar;
  estado.responder = (c, r) => new URL(c.url).searchParams.get('pagina') === '2'
    ? new Promise(resolve => { liberar = () => resolve(r); }) : r;
  const pendente = pg.el('catalogoProxima').disparar('click');
  await pg.esperar();
  pg.el('catalogoBusca').focus();
  await filtrar(pg, 'catalogoBusca', '023');
  liberar();
  await pendente;
  assert.match(htmlLinhas(pg), /Tipo 023/);
  assert.doesNotMatch(htmlLinhas(pg), /Tipo 006/);
  assert.match(pg.texto('catalogoResumo'), /1–1 de 1/);
  assert.equal(pg.documento.activeElement.id, 'catalogoBusca');
});

test('inativar a última linha da última página retorna à última página válida, sem alterar a ação', async () => {
  const { pg } = await abrir(21);
  await pg.clicar('catalogoPagina5');
  const acao = acoesLinhas(pg)[0];
  assert.ok(acao, 'o render oferece a ação na última página');
  const botao = pg.documento.createElement('button');
  botao.type = 'button';
  botao.setAttribute('data-acao', acao[1]);
  botao.setAttribute('data-id', acao[2]);
  pg.el('catalogoCorpo').appendChild(botao);
  await botao.disparar('click');
  await pg.esperar();
  assert.match(pg.texto('catalogoResumo'), /16–20 de 20 tipos · Página 4 de 4/);
  assert.equal(linhas(pg).length, 5);
  const escritas = pg.chamadas.filter(c => c.metodo !== 'GET');
  assert.equal(escritas.length, 1);
  assert.equal(escritas[0].chave, 'POST /tipos-material/21/inativar');
  assert.deepEqual(escritas[0].corpo, {});
});

test('sem editar, todas as páginas permanecem sem botões de situação', async () => {
  const { pg } = await abrir(23, H.permissoes({ materials: { visualizar: true, criar: false, editar: false, excluir: false } }));
  assert.equal(acoesLinhas(pg).length, 0);
  await pg.clicar('catalogoPagina2');
  assert.equal(linhas(pg).length, 5);
  assert.equal(acoesLinhas(pg).length, 0);
  assert.equal(pg.el('botaoNovoTipo').disabled, true);
});

test('401 oculta linhas e paginação e segue o redirecionamento existente ao Portal', async () => {
  const { pg, estado } = await abrir();
  estado.responder = () => ({ status: 401, corpo: { codigo: 'SESSAO_INVALIDA' } });
  await pg.clicar('catalogoProxima');
  assert.equal(pg.el('paginacaoCatalogo').hidden, true);
  assert.equal(linhas(pg).length, 0);
  assert.equal(pg.texto('catalogoResumo'), '');
  assert.ok(pg.navegacoes.some(url => url.endsWith('portal/index.html')));
});

test('catálogo grande usa primeira, última, vizinhas e reticências, sem centenas de botões', async () => {
  const { pg } = await abrir(1000);
  await pg.clicar('catalogoPagina200');
  assert.match(pg.texto('catalogoResumo'), /996–1000 de 1000/);
  assert.ok(pg.consulta('#catalogoPaginas button').length <= 7);
  assert.match(pg.texto('catalogoPaginas'), /…/);
  assert.equal(pg.el('catalogoPagina200').getAttribute('aria-current'), 'page');
});
