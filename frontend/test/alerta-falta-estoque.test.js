'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { abrirPagina } = require('./helpers/dom-pagina');
const { estiloComputado, token } = require('./helpers/estilo-computado');

/**
 * 12G-6 — "Gerar alerta" na tela Entregas por solicitação: alerta MANUAL de
 * falta de estoque do pedido aberto no detalhe, para quem movimenta o estoque
 * (o servidor escolhe quem). O botão existente deixa de ser "Em integração":
 * só aparece para quem tem REALIZAR_ENTREGA e só funciona com um pedido aberto
 * que tem item aguardando estoque. POST /alertas-estoque/falta com só o
 * pedido; o resultado vai para o aviso do alerta, nunca mexe na entrega.
 */

const RAIZ = path.join(__dirname, '..');
const PAGINA = 'pages/stock-requests.html';
const ROTA = 'POST /alertas-estoque/falta';

function modulo() {
  assert.ok(fs.existsSync(path.join(RAIZ, 'js/alerta-falta-estoque.js')), 'comportamento ausente: js/alerta-falta-estoque.js não existe');
  require('../js/solicitacoes-epi'); // eslint-disable-line global-require
  require('../js/epi-ficha'); // eslint-disable-line global-require
  require('../js/entregas-solicitacao'); // eslint-disable-line global-require
  return require('../js/alerta-falta-estoque'); // eslint-disable-line global-require
}

const NENHUMA = { visualizar: false, criar: false, editar: false, excluir: false };
const area = (v) => ({ consultar: v, alterar: v });
const permissoes = (acoes) => ({
  status: 'ok', empresaId: 3, usuarioId: 7, perfil: 'ADMINISTRADOR', recursos: { request: NENHUMA }, acoes,
  administracao: {
    gruposAcesso: area(false), permissoesGrupo: area(false), vinculosGrupo: area(false), usuarios: area(false),
    autorizacoesIndividuais: { consultar: true, concederDireta: false, delegar: false }, vinculosSst: area(false),
  },
});
const linha = (id, numero) => ({
  id, numero, status: 'APROVADA', situacaoOperacional: 'AGUARDANDO_ESTOQUE', solicitanteUsuarioId: 9,
  funcionario: { id: 11, nome: 'Ana Sintética', matricula: 'M-011', ativo: true }, quantidadeItens: 1,
  quantidades: { solicitada: 3, aprovada: 3, entregue: 0, restante: 3 }, criadaEm: '2026-10-02T13:05:00.000Z', decididaEm: '2026-10-03T12:00:00.000Z', canceladaEm: null, entregueEm: null,
});
const item = (extra) => ({
  id: 11, materialId: 30, tamanho: '40', quantidade: 3, motivo: 'ADMISSAO', justificativa: null, previstoNoGhe: true,
  decisao: 'APROVADO', quantidadeAprovada: 3, justificativaDecisao: null, quantidadeEntregue: 0, quantidadePendente: 3, situacao: 'AGUARDANDO_ESTOQUE',
  cobertura: { coberta: 0, semCobertura: 3, acumuladoAnterior: 0, fisicoUtilizavel: 0 },
  posicao: { fisicoUtilizavel: 0, demandaPendente: 3, comprometido: 0, saldoLivre: 0, semCobertura: 3 },
  material: { nome: 'Botina de segurança', unidade: 'par' },
  ...extra,
});
const detalhe = (id, numero, itens, status = 'APROVADA') => ({
  status: 'ok',
  solicitacao: {
    id, numero, status, origemSolicitacao: 'USUARIO_INTERNO', solicitanteUsuarioId: 9, funcionarioId: 11, gheId: 2, quantidadeItens: itens.length,
    observacao: null, criadaEm: '2026-10-02T13:05:00.000Z', decisao: { decididaPor: 5, decididaEm: '2026-10-03T12:00:00.000Z' },
    cancelamento: null, entregueEm: null, encerramento: null, situacaoOperacional: 'AGUARDANDO_ESTOQUE',
    quantidades: { solicitada: 3, aprovada: 3, entregue: 0, restante: 3 },
    funcionario: { id: 11, nome: 'Ana Sintética', matricula: 'M-011', ativo: true },
  },
  itens,
});
const COBERTO = item({ id: 21, quantidadePendente: 1, quantidadeAprovada: 1, quantidade: 1, situacao: 'PRONTA_PARA_ENTREGA', cobertura: { coberta: 1, semCobertura: 0, acumuladoAnterior: 0, fisicoUtilizavel: 4 } });
const SUSPENSO = item({ id: 31, situacao: 'SUSPENSA', cobertura: null });

async function abrir({ acoes = { REALIZAR_ENTREGA: true }, alertar = null } = {}) {
  modulo();
  const s = { alertar };
  const corpo = (status, c) => ({ status, corpo: c });
  const rotas = {
    'GET /auth/me': () => corpo(200, { status: 'ok', usuario: { id: 7, nome: 'Eva', email: 'eva@example.invalid', perfil: 'ADMINISTRADOR' }, empresa: { id: 3, nome: 'Empresa Teste', cnpj: '00000000000000' } }),
    'GET /auth/global/me': () => corpo(200, { status: 'ok', empresas: [{ id: 3 }] }),
    'GET /auth/permissoes': () => corpo(200, permissoes(acoes)),
    'GET /solicitacoes-epi/entregaveis': () => corpo(200, { status: 'ok', solicitacoes: [linha(301, 41), linha(302, 42), linha(303, 43)], total: 3, pagina: 1, limite: 20 }),
    'GET /solicitacoes-epi/encerraveis': () => corpo(200, { status: 'ok', solicitacoes: [linha(301, 41)], total: 1, pagina: 1, limite: 20 }),
    'GET /solicitacoes-epi/301': () => corpo(200, detalhe(301, 41, [item()])),
    'GET /solicitacoes-epi/302': () => corpo(200, detalhe(302, 42, [COBERTO])),
    'GET /solicitacoes-epi/303': () => corpo(200, detalhe(303, 43, [SUSPENSO])),
    [ROTA]: (c) => (s.alertar ? s.alertar(c) : corpo(200, { status: 'ok', alerta: { destinatarios: 3 } })),
  };
  const pg = abrirPagina(PAGINA, { rotas });
  await pg.esperar();
  return { pg, s };
}
async function abrirDetalhe(pg, id) {
  const b = pg.consulta(`#listaEntregas [data-solicitacao-id="${id}"]`)[0];
  assert.ok(b, `pedido ${id} na lista`);
  await b.disparar('click');
  await pg.esperar();
}
const alertas = (pg) => pg.chamadas.filter((c) => c.chave === ROTA);
const avisoAlerta = (pg) => pg.el('avisoAlerta').textContent;
async function gerar(pg) { await pg.clicar('botaoGerarAlerta'); await pg.esperar(); }

describe('quem vê o botão', () => {
  test('com REALIZAR_ENTREGA: aparece, ainda desabilitado, sem "Em integração" e com a dica de abrir um pedido', async () => {
    const { pg } = await abrir();
    const b = pg.el('botaoGerarAlerta');
    assert.equal(pg.visivelNo(b), true);
    assert.equal(b.disabled, true);
    assert.equal(/Em integração/.test(b.textContent), false);
    assert.match(b.getAttribute('title'), /Abra um pedido com item aguardando estoque/);
  });

  for (const tema of ['light', 'dark']) {
    test(`desabilitado parece desabilitado (tema ${tema}): cinza, sem o azul de ação, com cursor de bloqueio, também sob o mouse — mesmo fora do conteúdo protegido`, async () => {
      const { pg } = await abrir();
      pg.documento.documentElement.setAttribute('data-theme', tema);
      const b = pg.el('botaoGerarAlerta');
      assert.equal(b.disabled, true);
      const tk = (nome) => token(pg, PAGINA, nome);
      const azul = tk('--primary').toLowerCase();
      for (const hover of [false, true]) {
        const e = estiloComputado(pg, PAGINA, b, ['opacity', 'cursor', 'color', 'background', 'border'], { hover });
        const onde = `${tema}${hover ? ' (mouse em cima)' : ''}: ${JSON.stringify(e)}`;
        assert.ok(Number(e.opacity) <= 0.6, onde);
        assert.equal(e.cursor, 'not-allowed', onde);
        assert.deepEqual([e.color, e.background], [tk('--on-surface-variant'), tk('--surface-container-high')], onde);
        for (const p of ['color', 'background', 'border']) assert.equal(String(e[p]).toLowerCase().includes(azul), false, `${onde} — ${p}`);
      }
    });
  }

  test('só com ENCERRAR_SOLICITACAO: o botão não é oferecido', async () => {
    const { pg } = await abrir({ acoes: { ENCERRAR_SOLICITACAO: true } });
    assert.equal(pg.visivelNo(pg.el('botaoGerarAlerta')), false);
    assert.equal(pg.el('botaoGerarAlerta').disabled, true);
  });
});

describe('o pedido aberto decide se há o que alertar', () => {
  test('pedido com item aguardando estoque: o botão habilita; com tudo coberto ou só suspenso, não', async () => {
    const { pg } = await abrir();
    await abrirDetalhe(pg, 301);
    assert.equal(pg.el('botaoGerarAlerta').disabled, false);
    await abrirDetalhe(pg, 302);
    assert.equal(pg.el('botaoGerarAlerta').disabled, true);
    await abrirDetalhe(pg, 303);
    assert.equal(pg.el('botaoGerarAlerta').disabled, true);
  });

  test('voltar à lista desabilita de novo', async () => {
    const { pg } = await abrir();
    await abrirDetalhe(pg, 301);
    await pg.clicar('botaoFecharDetalhe');
    await pg.esperar();
    assert.equal(pg.el('botaoGerarAlerta').disabled, true);
  });
});

describe('o envio', () => {
  test('manda só o pedido (nada de empresa, destinatários ou texto) e mostra quantos receberam', async () => {
    const { pg } = await abrir();
    await abrirDetalhe(pg, 301);
    await gerar(pg);
    assert.equal(alertas(pg).length, 1);
    assert.deepEqual(alertas(pg)[0].corpo, { solicitacaoId: 301 });
    assert.match(avisoAlerta(pg), /Alerta de falta do pedido nº 41 enviado a 3 pessoas que movimentam o estoque/);
  });

  test('enquanto envia, um segundo clique não manda de novo', async () => {
    let liberar;
    const { pg } = await abrir({ alertar: () => new Promise((r) => { liberar = () => r({ status: 200, corpo: { status: 'ok', alerta: { destinatarios: 1 } } }); }) });
    await abrirDetalhe(pg, 301);
    const primeiro = pg.el('botaoGerarAlerta').disparar('click');
    await pg.esperar();
    const segundo = pg.el('botaoGerarAlerta').disparar('click');
    await pg.esperar();
    assert.equal(pg.el('botaoGerarAlerta').disabled, true);
    liberar();
    await Promise.all([primeiro, segundo]);
    await pg.esperar();
    assert.equal(alertas(pg).length, 1);
    assert.match(avisoAlerta(pg), /enviado a 1 pessoa que movimenta o estoque/);
  });

  const casos = [
    [429, 'ALERTA_FALTA_RECENTE', /já enviou um alerta deste pedido há pouco/],
    [409, 'ALERTA_SEM_DESTINATARIO', /Nenhum usuário com permissão para movimentar o estoque tem e-mail/],
    [409, 'SEM_FALTA_DE_ESTOQUE', /não tem item aguardando estoque/],
    [409, 'SOLICITACAO_NAO_ENTREGAVEL', /não está mais aprovado para entrega/],
    [503, 'ALERTA_NAO_ENVIADO', /Não foi possível enviar o alerta agora/],
    [403, 'PERMISSAO_NEGADA', /autorização "Realizar entrega"/],
  ];
  for (const [status, codigo, texto] of casos) {
    test(`${status} ${codigo}: texto próprio da tela, nunca a mensagem do servidor`, async () => {
      const { pg } = await abrir({ alertar: () => ({ status, corpo: { status: 'error', codigo, message: 'mensagem interna do servidor' } }) });
      await abrirDetalhe(pg, 301);
      await gerar(pg);
      assert.match(avisoAlerta(pg), texto);
      assert.equal(avisoAlerta(pg).includes('mensagem interna do servidor'), false);
    });
  }

  test('a falha do alerta não mexe no detalhe nem na entrega: o pedido continua aberto e "Preparar entrega" não muda', async () => {
    const { pg } = await abrir({ alertar: () => ({ status: 503, corpo: { status: 'error', codigo: 'ALERTA_NAO_ENVIADO', message: 'x' } }) });
    await abrirDetalhe(pg, 301);
    const antes = [pg.el('detalheTitulo').textContent, pg.el('botaoPrepararEntrega').disabled, pg.el('avisoDetalhe').textContent];
    await gerar(pg);
    assert.deepEqual([pg.el('detalheTitulo').textContent, pg.el('botaoPrepararEntrega').disabled, pg.el('avisoDetalhe').textContent], antes);
    assert.equal(pg.chamadas.filter((c) => /entregas|encerramento/.test(c.chave)).length, 0);
  });

  test('401: a sessão é encerrada como no resto da tela', async () => {
    const { pg } = await abrir({ alertar: () => ({ status: 401, corpo: { status: 'error', codigo: 'NAO_AUTENTICADO', message: 'x' } }) });
    await abrirDetalhe(pg, 301);
    await gerar(pg);
    assert.equal(pg.visivel('conteudoProtegido'), false);
    assert.equal(pg.visivelNo(pg.el('botaoGerarAlerta')), false);
  });

  test('trocar de pedido limpa o aviso do alerta anterior', async () => {
    const { pg } = await abrir();
    await abrirDetalhe(pg, 301);
    await gerar(pg);
    assert.notEqual(avisoAlerta(pg), '');
    await abrirDetalhe(pg, 302);
    assert.equal(avisoAlerta(pg), '');
  });

  test('nada em innerHTML nem no armazenamento do navegador', async () => {
    const { pg } = await abrir();
    await abrirDetalhe(pg, 301);
    await gerar(pg);
    assert.deepEqual(pg.documento.usosDeInnerHTML, []);
    // Só o cache de pintura da aparência (js/tema.js, Configurações) toca o armazenamento; nada da página.
    assert.deepEqual(pg.storage.filter((x) => !(x.operacao === 'removeItem' || x.storage === 'cookie' || x.chave === 'safework-aparencia')), []);
  });
});

describe('a página', () => {
  const bruto = fs.readFileSync(path.join(RAIZ, PAGINA), 'utf8');
  const html = bruto.replace(/<!--[\s\S]*?-->/g, '');

  test('o botão existente: mesmo lugar, id próprio, nasce oculto e desabilitado, sem "Em integração"; o aviso fica dentro do conteúdo protegido', () => {
    const gerar = html.match(/<button [^>]*id="botaoGerarAlerta"[^>]*>[\s\S]*?<\/button>/)[0];
    assert.match(gerar, /Gerar alerta/);
    assert.equal((html.match(/<button[^>]*>(?:(?!<\/button>)[\s\S])*Gerar alerta/g) || []).length, 1, 'um botão só');
    assert.match(gerar, /\sdisabled[\s>]/);
    assert.match(gerar, /style="display:none"/);
    assert.equal(/botao-em-integracao|Em integração/.test(gerar), false);
    assert.ok(html.indexOf('id="avisoAlerta"') > html.indexOf('id="conteudoProtegido"'));
    assert.ok(html.indexOf('id="botaoGerarAlerta"') < html.indexOf('id="estadoPagina"'), 'continua no cabeçalho da página');
  });

  test('o módulo é carregado depois da tela de Entregas e está na publicação', () => {
    const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
    assert.ok(scripts.indexOf('../js/alerta-falta-estoque.js') > scripts.indexOf('../js/entregas-solicitacao.js'));
    const { arquivos } = JSON.parse(fs.readFileSync(path.join(RAIZ, 'publicacao/allowlist.json'), 'utf8'));
    assert.ok(arquivos.includes('js/alerta-falta-estoque.js'));
  });

  test('a regra futura do protótipo continua preservada em comentário', () => {
    assert.match(bruto, /<!--[\s\S]*Quando um funcionário solicitar um material sem estoque, o item deve aparecer nesta lista e gerar alerta para compras\/almoxarifado[\s\S]*-->/);
  });
});
