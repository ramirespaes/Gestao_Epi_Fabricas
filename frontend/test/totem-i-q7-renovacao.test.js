'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers/totem-i');

/**
 * Etapa I (RED) — Q7: renovação da sessão do atendimento. Testes orientados ao COMPORTAMENTO: 60 s deslizantes pelo
 * relógio do SERVIDOR, renovação só por ação explícita do funcionário, nunca por mousemove, scroll, GET/polling ou
 * temporizador, uma renovação por vez, sem rajadas, 401/403/429 tratados, tempo restante vindo do servidor. Os
 * parâmetros finos (intervalos, limiar) NÃO são requisitos aqui: só limites de sanidade bem abaixo do limite de 120/min.
 */

const { TEXTOS } = H;
const ATIV = `POST ${H.BASE}/atendimento/atividade`;
const GET_ATEND = `GET ${H.BASE}/atendimento`;

// Passivos (movimento e rolagem) entregues onde um ouvinte poderia estar: body, document e window.
const mover = async (t, tipos = ['mousemove']) => {
  for (const tipo of tipos) {
    for (const fn of (t.documento.body.ouvintes[tipo] ?? []).slice()) fn({ type: tipo });
    for (const fn of (t.documento.ouvintes[tipo] ?? []).slice()) fn({ type: tipo });
    await t.eventoDaJanela(tipo);
  }
};
// A consulta do atendimento aberto faz parte da INICIALIZAÇÃO (contrato D) e vem antes da identificação; polling é o que vem depois dela.
const consultasDepoisDeIdentificar = (servidor) => {
  const i = servidor.chamadas.findIndex((c) => c.chave === `POST ${H.BASE}/atendimento`);
  return servidor.chamadas.slice(i === -1 ? servidor.chamadas.length : i).filter((c) => c.chave === `GET ${H.BASE}/atendimento`).length;
};
/** Ação explícita do funcionário: abrir um produto e voltar à grade (dois toques em controles de trabalho). */
const acao = async (t) => { await t.abrirProduto('Capacete'); await t.clicarTexto('Voltar aos produtos'); };
const ativPorMinuto = (servidor) => {
  const baldes = {};
  for (const c of servidor.chamadasDe(ATIV)) baldes[Math.floor(c.em / 60000)] = (baldes[Math.floor(c.em / 60000)] ?? 0) + 1;
  return Math.max(0, ...Object.values(baldes));
};

describe('[Q7] a sessão é do servidor: 60 s deslizantes, sem teto absoluto', () => {
  test('[Q7-01] identificar abre os 60 s mas NÃO é renovação: nenhuma chamada de atividade nem de estado', async () => {
    const servidor = H.criarServidor();
    await H.abrirNoCatalogo({ servidor });
    assert.equal(servidor.contar(ATIV), 0);
    assert.equal(consultasDepoisDeIdentificar(servidor), 0);
  });

  test('[Q7-02] uma ação explícita renova o atendimento no servidor', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirNoCatalogo({ servidor });
    await t.passar(40000);
    await t.abrirProduto('Capacete');
    await t.passar(3000);
    assert.ok(servidor.contar(ATIV) >= 1, 'a ação não renovou');
    assert.ok(servidor.restanteMs() > 50000, `restante no servidor: ${servidor.restanteMs()} ms`);
  });

  test('[Q7-03] atividade legítima a poucos segundos do vencimento não é descartada: o atendimento segue vivo', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirNoCatalogo({ servidor });
    await t.passar(55000);
    await t.abrirProduto('Capacete');
    await t.passar(30000);
    assert.equal(servidor.atendimentoAberto(), true);
    assert.ok(!t.textoVisivel().includes(TEXTOS.expirada));
    assert.deepEqual(t.telaAtual(), ['telaTamanhos']);
  });

  test('[Q7-04] sem duração máxima absoluta: atividade contínua por 5 minutos mantém o atendimento', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirNoCatalogo({ servidor });
    for (let i = 0; i < 12; i += 1) { await t.passar(25000); await acao(t); }
    assert.equal(servidor.atendimentoAberto(), true);
    assert.deepEqual(t.telaAtual(), ['telaProdutos']);
    assert.ok(servidor.contar(ATIV) >= 8, 'a atividade contínua precisa ter sido renovada');
  });
});

describe('[Q7] o que NÃO renova', () => {
  for (const [rotulo, tipos] of [['mousemove', ['mousemove']], ['scroll', ['scroll']], ['mousemove e scroll juntos', ['mousemove', 'scroll']]]) {
    test(`[Q7-05] ${rotulo} não renova: nenhuma chamada e o atendimento expira no horário do servidor`, async () => {
      const servidor = H.criarServidor();
      const t = await H.abrirNoCatalogo({ servidor });
      for (let i = 0; i < 59; i += 1) { await mover(t, tipos); await t.passar(1000); }
      assert.equal(servidor.contar(ATIV), 0);
      await t.passar(2000);
      assert.deepEqual(t.telaAtual(), ['telaAcesso']);
      assert.ok(t.textoVisivel().includes(TEXTOS.expirada));
    });
  }

  test('[Q7-06] GET e polling não renovam: ocioso por quase 60 s não há consultas repetidas nem renovação', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirNoCatalogo({ servidor });
    await t.passar(59000);
    assert.equal(servidor.contar(ATIV), 0);
    assert.equal(consultasDepoisDeIdentificar(servidor), 0, 'consultar o estado do atendimento em laço seria polling');
    assert.ok(servidor.contar(`GET ${H.BASE}/atendimento/catalogo`) <= 1);
    assert.ok(servidor.contar(`GET ${H.BASE}/atendimento/solicitacoes`) <= 1);
    await t.passar(2000);
    assert.deepEqual(t.telaAtual(), ['telaAcesso']);
  });

  test('[Q7-07] nenhum temporizador renova sozinho: depois de uma ação e do silêncio, nada mais é enviado', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirNoCatalogo({ servidor });
    await acao(t);
    await t.passar(20000);
    const feitas = servidor.contar(ATIV);
    assert.ok(feitas >= 1);
    await t.passar(39000);
    assert.equal(servidor.contar(ATIV), feitas, 'renovação sem ação do funcionário');
  });

  test('[Q7-08] a identificação não tem sessão: digitar no teclado não chama o servidor', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirTotem({ servidor });
    await t.escolherTipo('CPF');
    await t.digitar('52998');
    await t.passar(10000);
    assert.equal(servidor.contar(ATIV), 0);
  });
});

describe('[Q7] controle de frequência do cliente (sem parâmetros rígidos)', () => {
  test('[Q7-09] no máximo uma renovação em andamento por vez, mesmo com muitas ações enquanto a resposta não chega', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirNoCatalogo({ servidor });
    servidor.falhar(ATIV, 'segurar', { vezes: 500 });
    for (let i = 0; i < 20; i += 1) await acao(t);
    assert.ok((servidor.maxEmVoo[ATIV] ?? 0) <= 1, `renovações simultâneas: ${servidor.maxEmVoo[ATIV]}`);
    servidor.liberarSegurados();
    await t.esperar();
    for (let i = 0; i < 10; i += 1) await acao(t);
    assert.ok((servidor.maxEmVoo[ATIV] ?? 0) <= 1);
  });

  test('[Q7-10] sem rajadas: 60 ações no mesmo instante geram poucas chamadas', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirNoCatalogo({ servidor });
    for (let i = 0; i < 30; i += 1) await acao(t);
    assert.ok(servidor.contar(ATIV) <= 3, `${servidor.contar(ATIV)} renovações no mesmo instante`);
  });

  test('[Q7-11] toques contínuos por um minuto (240 ações) ficam bem abaixo do limite do servidor de 120 por minuto, que é compartilhado com outras rotas', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirNoCatalogo({ servidor });
    for (let i = 0; i < 120; i += 1) { await acao(t); await t.passar(500); }
    // O teto é a METADE do limite compartilhado (a outra metade fica para identificação, consulta, catálogo e encerramento). O 20 anterior era arbitrário.
    assert.ok(ativPorMinuto(servidor) <= 60, `${ativPorMinuto(servidor)} renovações em um minuto`);
    assert.equal(servidor.atendimentoAberto(), true, 'e o atendimento continua vivo');
  });
});

describe('[Q7] o tempo restante vem do servidor', () => {
  test('[Q7-12] a contagem começa nos 60 s informados na identificação e decresce sem consultar o servidor', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirNoCatalogo({ servidor });
    const inicio = t.segundosNoContador();
    assert.ok(inicio >= 58 && inicio <= 60, `contagem inicial: ${inicio}`);
    await t.passar(10000);
    const depois = t.segundosNoContador();
    assert.ok(depois >= 48 && depois <= 51, `depois de 10 s: ${depois}`);
    assert.equal(consultasDepoisDeIdentificar(servidor), 0);
  });

  test('[Q7-13] depois de renovar, a contagem passa a ser o restante que o SERVIDOR devolveu (não o que o tablet supõe)', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirNoCatalogo({ servidor });
    servidor.restantePara.push(37);
    await t.passar(20000);
    await t.abrirProduto('Capacete');
    await t.passar(1000);
    const c = t.segundosNoContador();
    assert.ok(c >= 33 && c <= 37, `contagem: ${c}`);
    await t.passar(40000);
    assert.deepEqual(t.telaAtual(), ['telaAcesso'], 'o servidor concedeu só 37 s: a tela expira com ele');
  });
});

describe('[Q7] 401, 403 e 429 na renovação', () => {
  test('[Q7-14] 401: o atendimento acabou no servidor; limpeza imediata e aviso de sessão encerrada', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirNoCatalogo({ servidor });
    servidor.atendimentos[servidor.atendimentos.length - 1].encerrado = 'SUBSTITUIDO';
    await t.abrirProduto('Capacete');
    await t.passar(2000);
    assert.deepEqual(t.telaAtual(), ['telaAcesso']);
    assert.ok(t.textoVisivel().includes(TEXTOS.expirada));
  });

  test('[Q7-15] 403 (rede): para de renovar e mostra a tela de rede não autorizada', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirNoCatalogo({ servidor });
    servidor.falhar(ATIV, 'status', { status: 403, codigo: 'REDE_NAO_AUTORIZADA', vezes: 50 });
    await t.abrirProduto('Capacete');
    await t.passar(2000);
    assert.deepEqual(t.telaAtual(), ['telaRede']);
    const feitas = servidor.contar(ATIV);
    await t.passar(30000);
    assert.equal(servidor.contar(ATIV), feitas, 'sem novas tentativas');
  });

  test('[Q7-16] 429 NÃO é renovação: a contagem não volta a 60, a sessão segue o horário antigo e não há repetição sozinha', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirNoCatalogo({ servidor });
    await t.passar(30000);
    servidor.falhar(ATIV, '429', { retryAfter: 7, vezes: 1 });
    await t.abrirProduto('Capacete');
    await t.passar(1000);
    assert.equal(servidor.contar(ATIV), 1);
    assert.ok(t.segundosNoContador() <= 31, `a contagem foi reiniciada por uma resposta 429: ${t.segundosNoContador()}`);
    assert.ok(!t.textoVisivel().includes(TEXTOS.expirada), 'a tela não pode concluir que expirou');
    const feitas = servidor.contar(ATIV);
    await t.passar(20000);
    assert.equal(servidor.contar(ATIV), feitas, 'sem repetição automática');
    await t.clicarTexto('Voltar aos produtos');
    await t.passar(2000);
    assert.ok(servidor.contar(ATIV) > feitas, 'passado o Retry-After, uma nova ação volta a tentar');
  });
});

describe('[Q7] expiração durante uma ação e perda de conexão', () => {
  test('[Q7-17] expirou no servidor durante o envio: nenhuma confirmação, aviso de sessão encerrada e dados limpos', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirPronto({ servidor });
    servidor.avancar(61000);
    await t.enviar();
    assert.ok(!t.textoVisivel().includes(TEXTOS.confirmacao1));
    assert.notDeepEqual(t.telaAtual(), ['telaIncerto'], 'um 401 não é resultado incerto: o servidor não aceitou');
    assert.deepEqual(t.telaAtual(), ['telaAcesso']);
    assert.ok(t.textoVisivel().includes(TEXTOS.expirada));
    assert.equal(servidor.pedidos.size, 0);
  });

  test('[Q7-18] enviar perto do vencimento não é descartado indevidamente', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirPronto({ servidor });
    await t.passar(57000);
    await t.enviar();
    assert.deepEqual(t.telaAtual(), ['telaConfirma']);
    assert.equal(servidor.pedidos.size, 1);
  });

  test('[Q7-19] falha de rede na renovação não derruba nada: a próxima ação renova normalmente', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirNoCatalogo({ servidor });
    await t.passar(20000);
    servidor.falhar(ATIV, 'rede', { vezes: 1 });
    await t.abrirProduto('Capacete');
    await t.passar(1000);
    assert.equal(servidor.atividades, 0, 'a renovação falhou');
    assert.deepEqual(t.telaAtual(), ['telaTamanhos']);
    await t.passar(12000);
    await t.clicarTexto('Voltar aos produtos');
    await t.passar(2000);
    assert.equal(servidor.atividades, 1, 'a renovação seguinte funcionou');
    assert.ok(servidor.restanteMs() > 50000);
  });
});
