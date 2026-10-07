'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { exigirModulo } = require('../helpers/exigir-modulo');

/**
 * 12G-6 — e-mails dos alertas de estoque, no mesmo layout transacional:
 *   DISPONIBILIDADE_ESTOQUE_ENTREGA  aviso operacional consolidado para quem
 *     entrega: por EPI + tamanho, a quantidade disponível agora e quantos
 *     pedidos; nenhum trabalhador, matrícula, CPF nem número de pedido (o
 *     detalhe é da tela Entregas por solicitação);
 *   FALTA_ESTOQUE_ENTREGA            alerta manual de falta para quem movimenta
 *     o estoque (pedido, EPI, tamanho, pendente e sem cobertura; nenhum dado do
 *     trabalhador).
 * Assunto constante, texto do banco escapado, nunca CPF, link só o recebido
 * (montado da URL pública configurada).
 */

const templates = () => exigirModulo('src/email/templates');
const links = () => exigirModulo('src/email/links');
const SUPORTE = 'suporte@safeworkengenharia.com.br';
const render = (tipo, dados) => templates().renderizar(tipo, dados, { suporte: SUPORTE });
const URLS = Object.freeze({ portal: 'https://app.exemplo-cliente.test', painel: 'https://admin.exemplo-cliente.test' });
const LINK_ENTREGAS = 'https://app.exemplo-cliente.test/pages/stock-requests.html';
const LINK_MATERIAIS = 'https://app.exemplo-cliente.test/pages/materials.html';

const DISPONIBILIDADE = Object.freeze({
  empresa: 'Empresa Fictícia Ltda',
  pares: [
    { material: 'Botina de segurança', tamanho: '40', quantidade: 5, pedidos: 3 },
    { material: 'Capacete', tamanho: null, quantidade: 1, pedidos: 1 },
    { material: 'Luva de raspa', tamanho: 'G', quantidade: 2, pedidos: 1 },
  ],
  restantes: 0,
  link: LINK_ENTREGAS,
});

const FALTA = Object.freeze({
  empresa: 'Empresa Fictícia Ltda',
  numero: 41,
  itens: [
    { material: 'Botina de segurança', tamanho: '40', pendente: 3, semCobertura: 2 },
    { material: 'Capacete', tamanho: null, pendente: 1, semCobertura: 1 },
  ],
  link: LINK_MATERIAIS,
});

describe('tipos dos alertas de estoque', () => {
  test('os dois tipos existem, com assunto constante e sem dado vindo do banco', () => {
    const { TIPOS } = templates();
    assert.equal(TIPOS.DISPONIBILIDADE_ESTOQUE_ENTREGA, 'DISPONIBILIDADE_ESTOQUE_ENTREGA');
    assert.equal(TIPOS.FALTA_ESTOQUE_ENTREGA, 'FALTA_ESTOQUE_ENTREGA');
    const a = render('DISPONIBILIDADE_ESTOQUE_ENTREGA', DISPONIBILIDADE);
    const b = render('DISPONIBILIDADE_ESTOQUE_ENTREGA', { ...DISPONIBILIDADE, empresa: 'Outra\r\nBcc: x@y.test' });
    assert.equal(a.assunto, 'EPIs disponíveis para entrega — SafeWork Engenharia');
    assert.equal(b.assunto, a.assunto);
    const f = render('FALTA_ESTOQUE_ENTREGA', FALTA);
    assert.equal(f.assunto, 'Falta de estoque para entrega de EPI — SafeWork Engenharia');
    for (const r of [a, b, f]) assert.deepEqual(Object.keys(r).sort(), ['assunto', 'html', 'texto']);
  });
});

describe('aviso de disponibilidade (automático)', () => {
  test('uma linha por EPI + tamanho, na ordem recebida, com a quantidade disponível agora e quantos pedidos; nenhum dado de trabalhador nem número de pedido', () => {
    const { texto, html } = render('DISPONIBILIDADE_ESTOQUE_ENTREGA', DISPONIBILIDADE);
    const linhas = texto.split('\n');
    const esperadas = [
      'Botina de segurança, tamanho 40: 5 unidades disponíveis para 3 pedidos',
      'Capacete: 1 unidade disponível para 1 pedido',
      'Luva de raspa, tamanho G: 2 unidades disponíveis para 1 pedido',
    ];
    let posicao = -1;
    for (const esperada of esperadas) {
      const aqui = linhas.indexOf(esperada);
      assert.ok(aqui > posicao, `"${esperada}" em linha própria e na ordem`);
      posicao = aqui;
    }
    assert.doesNotMatch(texto, /Pedido nº|matrícula|trabalhador/i);
    assert.doesNotMatch(html, /Pedido nº|matrícula/i);
    assert.ok(texto.includes('Empresa Fictícia Ltda'));
    assert.ok(linhas.includes(LINK_ENTREGAS), 'link em linha própria');
    assert.match(texto, /Entregas por solicitação/);
    assert.match(texto, /podem mudar até a entrega/);
  });

  test('o contrato não aceita dado de trabalhador, dado médico nem pedido individual', () => {
    const extras = [{ nome: 'Ana' }, { matricula: 'M-1' }, { numero: 41 }, { cpf: '52998224725' }, { restricaoMedica: 'Alergia ao látex' }, { cid: 'L23' }, { grau: '-1,50' }];
    for (const extra of extras) {
      assert.throws(() => render('DISPONIBILIDADE_ESTOQUE_ENTREGA', { ...DISPONIBILIDADE, pares: [{ ...DISPONIBILIDADE.pares[0], ...extra }] }), TypeError, JSON.stringify(extra));
      assert.throws(() => render('DISPONIBILIDADE_ESTOQUE_ENTREGA', { ...DISPONIBILIDADE, ...extra }), TypeError, JSON.stringify(extra));
    }
    assert.throws(() => render('DISPONIBILIDADE_ESTOQUE_ENTREGA', { ...DISPONIBILIDADE, trabalhadores: [] }), TypeError);
  });

  test('o que passou do limite de linhas vira uma contagem, nunca uma lista sem fim', () => {
    const { texto } = render('DISPONIBILIDADE_ESTOQUE_ENTREGA', { ...DISPONIBILIDADE, restantes: 7 });
    assert.match(texto, /mais 7 EPIs e tamanhos disponíveis/);
  });

  test('sem link: a mensagem sai sem botão e sem endereço', () => {
    const { texto, html } = render('DISPONIBILIDADE_ESTOQUE_ENTREGA', { ...DISPONIBILIDADE, link: null });
    assert.doesNotMatch(texto, /https?:\/\//);
    assert.doesNotMatch(html, /<a[^>]*href=/);
  });

  test('dado do banco é escapado no HTML e não quebra linha no texto', () => {
    const ataque = '<img src=x onerror=alert(1)>';
    const dados = {
      ...DISPONIBILIDADE,
      empresa: `Empresa\r\nBcc: x@y.test ${ataque}`,
      pares: [{ material: `Botina\r\nBcc: x@y.test ${ataque}`, tamanho: '40"', quantidade: 1, pedidos: 1 }],
    };
    const { texto, html } = render('DISPONIBILIDADE_ESTOQUE_ENTREGA', dados);
    assert.doesNotMatch(texto, /^Bcc:/m);
    assert.doesNotMatch(html, /<img src=x/);
    assert.equal((html.match(/<img\b/g) || []).length, 1, 'só a marca');
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  });

  test('dados fora do contrato são erro de programação (nunca um e-mail vazio)', () => {
    for (const ruim of [
      { ...DISPONIBILIDADE, pares: [] },
      { ...DISPONIBILIDADE, pares: [{ material: 'X', tamanho: null, quantidade: 0, pedidos: 1 }] },
      { ...DISPONIBILIDADE, pares: [{ material: 'X', tamanho: null, quantidade: 1, pedidos: 0 }] },
      { ...DISPONIBILIDADE, restantes: -1 },
      { ...DISPONIBILIDADE, link: 'javascript:alert(1)' },
    ]) {
      assert.throws(() => render('DISPONIBILIDADE_ESTOQUE_ENTREGA', ruim), TypeError);
    }
  });
});

describe('alerta de falta de estoque (manual)', () => {
  test('pedido, EPI, tamanho, pendente e sem cobertura; nenhum dado de trabalhador', () => {
    const { texto, html } = render('FALTA_ESTOQUE_ENTREGA', FALTA);
    assert.match(texto, /Pedido nº 41/);
    assert.match(texto, /Botina de segurança, tamanho 40: 3 pendentes, 2 sem cobertura/);
    assert.match(texto, /Capacete: 1 pendente, 1 sem cobertura/);
    assert.doesNotMatch(texto, /trabalhador|matrícula|CPF/i);
    assert.ok(texto.split('\n').includes(LINK_MATERIAIS));
    assert.ok(html.includes('Empresa Fictícia Ltda'));
  });

  test('dados fora do contrato são erro de programação', () => {
    for (const ruim of [
      { ...FALTA, itens: [] },
      { ...FALTA, numero: 0 },
      { ...FALTA, itens: [{ material: 'X', tamanho: null, pendente: 1, semCobertura: 0 }] },
      { ...FALTA, itens: [{ material: 'X', tamanho: null, pendente: 1, semCobertura: 2 }] },
    ]) {
      assert.throws(() => render('FALTA_ESTOQUE_ENTREGA', ruim), TypeError);
    }
  });
});

describe('links das telas', () => {
  test('montados só da URL pública do Portal configurada, sem token e sem host fixo', () => {
    const { linkEntregasPorSolicitacao, linkMateriais } = links();
    assert.equal(linkEntregasPorSolicitacao(URLS), LINK_ENTREGAS);
    assert.equal(linkMateriais(URLS), LINK_MATERIAIS);
    assert.equal(linkEntregasPorSolicitacao({ portal: 'https://outro.test' }), 'https://outro.test/pages/stock-requests.html');
  });
});
