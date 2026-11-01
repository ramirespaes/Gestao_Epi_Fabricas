'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers/totem-i');

/**
 * Contrato REAL do número do pedido (Etapa F do backend × Etapa I do Totem). O backend numera as solicitações por empresa com INTEGER
 * (CHECK numero > 0) e devolve `pedido.numero` como INTEIRO JSON, no POST 201/200 e no GET 200 REGISTRADO. A tela só afirma sucesso diante de
 * uma confirmação válida do servidor; o número prova que o pedido foi gravado e NUNCA é exibido. Estes testes fixam o contrato: inteiro de 1 a
 * 2147483647 confirma; qualquer outro tipo ou valor continua sendo resultado incerto, sem sucesso presumido, sem reenvio e sem consulta automática.
 *
 * Antes da correção o Totem exigia `typeof numero === 'string'` (herdado do servidor falso, que devolvia `PED-1001`): o 201 real caía na tela
 * "Não conseguimos confirmar o envio do seu pedido." com o pedido já gravado e o cookie do atendimento já removido pela própria resposta.
 */

const { TEXTOS } = H;
const PEDIDO = `POST ${H.BASE}/atendimento/pedido`;
const RESULTADO = `GET ${H.BASE}/atendimento/pedidos/:chave`;
const ehResultado = (c) => c.chave.startsWith(`GET ${H.BASE}/atendimento/pedidos/`);
const consultas = (s) => s.chamadas.filter(ehResultado);
const MAXIMO = 2147483647;

const VALIDOS = [1, 2, 17, 1001, 704101, 2147483646, MAXIMO];
const INVALIDOS = [
  ['texto numérico', '12'], ['texto do servidor antigo', 'PED-1001'], ['texto vazio', ''], ['texto só com espaço', ' '], ['zero', 0], ['negativo', -1], ['decimal', 1.5],
  ['acima do INTEGER', MAXIMO + 1], ['notação científica fora da faixa', 1e10], ['acima do inteiro seguro', Number.MAX_SAFE_INTEGER + 2], ['nulo', null], ['booleano', true],
  ['objeto', {}], ['lista', [1]], ['NaN (vira nulo no JSON)', Number.NaN], ['infinito (vira nulo no JSON)', Number.POSITIVE_INFINITY],
];

const pedidoDe = (numero, extra = {}) => ({ numero, status: 'PENDENTE', quantidadeItens: 1, itens: [], ...extra });
const corpoDoPost = (numero, repetida = false) => ({ status: 'ok', repetida, pedido: pedidoDe(numero) });
const corpoDoGet = (numero) => ({ status: 'ok', pedido: { estado: 'REGISTRADO', numero, status: 'PENDENTE', quantidadeItens: 1 } });

describe('[NUM-A] o servidor falso segue o contrato real', () => {
  test('[NUM-01] o número que o servidor falso devolve é inteiro positivo dentro do INTEGER, nunca texto', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirPronto({ servidor });
    await t.enviar();
    const numero = [...servidor.pedidos.values()][0].visao.numero;
    assert.equal(Number.isInteger(numero), true);
    assert.ok(numero >= 1 && numero <= MAXIMO);
  });
});

describe('[NUM-B] POST com o pedido real: confirmação imediata', () => {
  test('[NUM-02] POST 201 com número inteiro: confirmação neutra na hora, um só POST, nenhuma consulta, nenhum encerramento pela página e tudo limpo', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirPronto({ servidor });
    await t.enviar();
    const numero = String([...servidor.pedidos.values()][0].visao.numero);
    assert.deepEqual(t.telaAtual(), ['telaConfirma']);
    assert.ok(t.textoVisivel().includes(TEXTOS.confirmacao1));
    assert.equal(servidor.contar(PEDIDO), 1);
    assert.equal(consultas(servidor).length, 0, 'depois de um 201 válido não há GET de recuperação');
    assert.equal(servidor.contar(`POST ${H.BASE}/atendimento/encerrar`), 0, 'o servidor já encerrou o atendimento; a página não chama o encerramento');
    assert.equal(servidor.pedidos.size, 1);
    assert.equal(t.visivel('sessao'), false);
    assert.ok(!t.textoDoDom().includes(numero), 'o número do pedido nunca aparece na tela');
    await t.passar(60000, 5000);
    assert.equal(servidor.contar(PEDIDO), 1, 'nenhum envio novo depois da confirmação');
    assert.equal(consultas(servidor).length, 0);
  });

  for (const numero of VALIDOS) {
    test(`[NUM-03] POST 201 com número ${numero}: confirma`, async () => {
      const servidor = H.criarServidor();
      const t = await H.abrirPronto({ servidor });
      servidor.falhar(PEDIDO, 'status', { status: 201, corpo: corpoDoPost(numero) });
      await t.enviar();
      assert.deepEqual(t.telaAtual(), ['telaConfirma']);
      assert.ok(t.textoVisivel().includes(TEXTOS.confirmacao1));
      assert.equal(servidor.contar(PEDIDO), 1);
      assert.equal(consultas(servidor).length, 0);
    });
  }

  test('[NUM-04] POST 200 idempotente (repetida:true) com número inteiro também confirma, sem novo POST', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirPronto({ servidor });
    servidor.falhar(PEDIDO, 'status', { status: 200, corpo: corpoDoPost(1001, true) });
    await t.enviar();
    assert.deepEqual(t.telaAtual(), ['telaConfirma']);
    assert.equal(servidor.contar(PEDIDO), 1);
    assert.equal(consultas(servidor).length, 0);
  });
});

describe('[NUM-C] POST com contrato inválido: resultado incerto, nunca sucesso presumido', () => {
  for (const [rotulo, numero] of INVALIDOS) {
    test(`[NUM-05] POST 201 com número ${rotulo}: tela de incerteza, sem confirmação e sem reenvio nem consulta automáticos`, async () => {
      const servidor = H.criarServidor();
      const t = await H.abrirPronto({ servidor });
      servidor.falhar(PEDIDO, 'status', { status: 201, corpo: corpoDoPost(numero) });
      await t.enviar();
      assert.deepEqual(t.telaAtual(), ['telaIncerto']);
      assert.ok(!t.textoVisivel().includes(TEXTOS.confirmacao1));
      await t.passar(30000, 5000);
      assert.equal(servidor.contar(PEDIDO), 1, 'nenhum reenvio automático');
      assert.equal(consultas(servidor).length, 0, 'nenhuma consulta automática');
    });
  }

  test('[NUM-06] número ausente, pedido ausente e quantidade de itens inválida continuam sendo resultado incerto', async () => {
    const casos = [
      { status: 'ok', repetida: false, pedido: { status: 'PENDENTE', quantidadeItens: 1 } },
      { status: 'ok', repetida: false },
      { status: 'ok', repetida: false, pedido: pedidoDe(1001, { quantidadeItens: '1' }) },
      { status: 'ok', repetida: false, pedido: pedidoDe(1001, { quantidadeItens: 1.5 }) },
      { status: 'erro', repetida: false, pedido: pedidoDe(1001) },
    ];
    for (const corpo of casos) {
      const servidor = H.criarServidor();
      const t = await H.abrirPronto({ servidor });
      servidor.falhar(PEDIDO, 'status', { status: 201, corpo });
      await t.enviar();
      assert.deepEqual(t.telaAtual(), ['telaIncerto'], JSON.stringify(corpo));
      assert.ok(!t.textoVisivel().includes(TEXTOS.confirmacao1));
    }
  });
});

describe('[NUM-D] GET de recuperação (resposta perdida, cookie ainda válido)', () => {
  test('[NUM-07] pedido gravado e resposta perdida: "Verificar" recebe REGISTRADO com número inteiro e confirma, sem novo POST', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirPronto({ servidor });
    servidor.falhar(PEDIDO, 'perdida');
    await t.enviar();
    assert.deepEqual(t.telaAtual(), ['telaIncerto']);
    assert.equal(consultas(servidor).length, 0, 'nada é consultado sozinho');
    await t.clicarTexto(TEXTOS.verificar);
    assert.deepEqual(t.telaAtual(), ['telaConfirma']);
    assert.ok(t.textoVisivel().includes(TEXTOS.confirmacao1));
    assert.equal(servidor.contar(PEDIDO), 1, 'a recuperação não cria segundo pedido');
    assert.equal(consultas(servidor).length, 1);
    assert.equal(servidor.pedidos.size, 1);
  });

  for (const numero of VALIDOS) {
    test(`[NUM-08] GET 200 REGISTRADO com número ${numero}: confirma`, async () => {
      const servidor = H.criarServidor();
      const t = await H.abrirPronto({ servidor });
      servidor.falhar(PEDIDO, 'perdida');
      servidor.falhar(RESULTADO, 'status', { status: 200, corpo: corpoDoGet(numero) });
      await t.enviar();
      await t.clicarTexto(TEXTOS.verificar);
      assert.deepEqual(t.telaAtual(), ['telaConfirma']);
      assert.equal(servidor.contar(PEDIDO), 1);
    });
  }

  for (const [rotulo, numero] of INVALIDOS) {
    test(`[NUM-09] GET 200 REGISTRADO com número ${rotulo}: não confirma, mostra a mensagem de comunicação e não cria pedido`, async () => {
      const servidor = H.criarServidor();
      const t = await H.abrirPronto({ servidor });
      servidor.falhar(PEDIDO, 'perdida');
      servidor.falhar(RESULTADO, 'status', { status: 200, corpo: corpoDoGet(numero) });
      await t.enviar();
      await t.clicarTexto(TEXTOS.verificar);
      assert.deepEqual(t.telaAtual(), ['telaIncerto']);
      assert.ok(!t.textoVisivel().includes(TEXTOS.confirmacao1));
      assert.ok(t.textoVisivel().includes(TEXTOS.comunicacao));
      assert.equal(servidor.contar(PEDIDO), 1);
    });
  }

  test('[NUM-10] o 401 da consulta depois de um sucesso legítimo continua sendo "sessão encerrada": a página não abre acesso nem afirma o pedido', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirPronto({ servidor });
    servidor.falhar(PEDIDO, 'perdida');
    await t.enviar();
    servidor.cookie = null; // o cookie do atendimento foi removido (como o servidor real faz ao registrar o pedido)
    await t.clicarTexto(TEXTOS.verificar);
    assert.deepEqual(t.telaAtual(), ['telaAcesso']);
    assert.ok(t.textoVisivel().includes(TEXTOS.sessaoTerminou));
    assert.ok(!t.textoVisivel().includes(TEXTOS.confirmacao1), 'sem acesso não se afirma sucesso');
    assert.equal(servidor.contar(PEDIDO), 1);
  });
});

describe('[NUM-E] mesma regra no código-fonte: um só predicado, inteiro de 1 a 2147483647', () => {
  const fonte = H.lerTotem('totem/totem.js');
  const semComentarios = fonte.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  test('[NUM-11] nenhum ponto do Totem exige texto no número do pedido', () => {
    assert.equal(/numero\s*===\s*'string'|typeof\s+\w+(\.\w+)*\.numero\s*===\s*'string'/.test(semComentarios), false);
  });

  test('[NUM-12] a confirmação do POST e a da consulta usam o mesmo predicado de inteiro positivo dentro do INTEGER', () => {
    assert.match(semComentarios, /function numeroDePedidoValido\(n\)\s*\{[^}]*Number\.isInteger\(n\)[^}]*n >= 1[^}]*2147483647/);
    assert.equal((semComentarios.match(/numeroDePedidoValido\(/g) || []).length, 3, 'definição e dois usos');
  });
});
