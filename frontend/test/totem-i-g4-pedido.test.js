'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers/totem-i');

/**
 * Etapa I — I-G4: testes NOVOS do carrinho, da revisão, do envio pelo contrato F, da idempotência, do HTTP 409, do resultado
 * incerto e das requisições F na barreira de cookies. TESTADO COM MOCKS.
 *
 * Dois problemas independentes, que estes testes mantêm separados:
 *  - RESULTADO TRANSACIONAL: o pedido foi ou não criado (sucesso confirmado, rejeição conclusiva, resultado indeterminado);
 *  - SEGURANÇA DA TRANSIÇÃO: uma requisição anterior ainda pode mexer no cookie do atendimento seguinte (barreira).
 * O servidor falso NÃO modela o cookie HttpOnly nem o Set-Cookie de remoção; o que se prova é a ORDEM das requisições e o descarte
 * do estado da página, nunca o processamento real de cookies no navegador.
 */

const { TEXTOS, FUNCIONARIOS } = H;
const [ANA, BRUNO] = FUNCIONARIOS;
const PEDIDO = `POST ${H.BASE}/atendimento/pedido`;
const RESULTADO = `GET ${H.BASE}/atendimento/pedidos/:chave`;
const IDENT = `POST ${H.BASE}/atendimento`;
const ENCERRAR = `POST ${H.BASE}/atendimento/encerrar`;
const ATIV = `POST ${H.BASE}/atendimento/atividade`;
const erro500 = { status: 500, codigo: 'ERRO_INTERNO' };
const ehResultado = (c) => c.chave.startsWith(`GET ${H.BASE}/atendimento/pedidos/`);
const resultados = (s) => s.chamadas.filter(ehResultado);
const dadosDeAna = (t) => ['Ana', 'Beatriz', 'Sobrenome', ANA.cpf, ANA.matricula].filter((s) => t.textoDoDom().includes(s));
const identificarB = (t) => t.identificar({ tipo: 'MATRICULA', valor: BRUNO.matricula });
const materiais = (n) => Array.from({ length: n }, (_, i) => ({ ...H.CATALOGO[1], id: 200 + i, nome: `Material ${String(i + 1).padStart(2, '0')}` }));

describe('[G4-A] carrinho, motivo por item e revisão', () => {
  test('[G4-01] carrinho vazio: não há como revisar nem enviar, e nada vai ao servidor', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirNoCatalogo({ servidor });
    assert.equal(t.visivel('blocoRevisar'), false);
    await t.clicarEl(t.el('btnRevisar'));
    assert.deepEqual(t.telaAtual(), ['telaProdutos']);
    assert.equal(servidor.contar(PEDIDO), 0);
  });

  test('[G4-02] abrir a revisão e escolher motivos não envia nada: o POST só sai no toque em "Enviar pedido"', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirNoCatalogo({ servidor });
    await t.irARevisao();
    await t.motivoParaTodos('DESGASTE_DANO');
    assert.deepEqual(t.telaAtual(), ['telaRevisao']);
    assert.equal(servidor.contar(PEDIDO), 0);
    assert.equal(t.botao(TEXTOS.enviar).disabled, false);
  });

  test('[G4-03] remover um item leva o motivo dele junto e não passa o motivo para o vizinho', async () => {
    const t = await H.abrirNoCatalogo();
    await t.irARevisao([['Botina de Segurança', '40'], ['Protetor Auricular', null], ['Capacete', null]]);
    await t.escolherMotivo(0, 'SUBSTITUICAO_PRAZO');
    await t.escolherMotivo(1, 'DESGASTE_DANO');
    await t.escolherMotivo(2, 'PERDA_EXTRAVIO');
    await t.clicarEl(t.itensDaRevisao()[0].querySelectorAll('button').find((b) => b.textContent.includes(TEXTOS.remover)));
    assert.equal(t.itensDaRevisao().length, 2);
    await t.enviar();
    const porId = Object.fromEntries(H.plano(t.pedidosPost()[0].corpo.itens).map((i) => [i.materialId, i.motivo]));
    assert.deepEqual(porId, { 12: 'DESGASTE_DANO', 14: 'PERDA_EXTRAVIO' });
  });

  test('[G4-04] o mesmo material adicionado de novo depois de removido volta SEM motivo (nenhum motivo antigo reaparece)', async () => {
    const t = await H.abrirNoCatalogo();
    await t.irARevisao([['Capacete', null]]);
    await t.escolherMotivo(0, 'PERDA_EXTRAVIO');
    await t.clicarEl(t.itensDaRevisao()[0].querySelectorAll('button').find((b) => b.textContent.includes(TEXTOS.remover)));
    assert.deepEqual(t.telaAtual(), ['telaProdutos'], 'carrinho vazio volta aos produtos');
    await t.adicionarItem('Capacete');
    await t.clicarTexto(TEXTOS.revisar);
    assert.equal(t.botao(TEXTOS.enviar).disabled, true);
    assert.equal(t.consulta('#telaRevisao [data-motivo].sel').length, 0);
  });

  test('[G4-05] o 21º item não entra: o pedido sai com 20 itens distintos, cada um com seu motivo', async () => {
    const lista = materiais(21);
    const servidor = H.criarServidor({ materiais: lista });
    const t = await H.abrirNoCatalogo({ servidor });
    for (const m of lista) await t.adicionarItem(m.nome);
    assert.equal(t.consulta('#resumo .chip').length, 20);
    assert.ok(t.textoVisivel().includes(TEXTOS.limite20));
    await t.clicarTexto('Voltar aos produtos');
    await t.clicarTexto(TEXTOS.revisar);
    await t.motivoParaTodos('DESGASTE_DANO');
    await t.enviar();
    const itens = H.plano(t.pedidosPost()[0].corpo.itens);
    assert.equal(itens.length, 20);
    assert.equal(new Set(itens.map((i) => i.materialId)).size, 20);
    assert.ok(itens.every((i) => i.quantidade === 1 && i.motivo === 'DESGASTE_DANO'));
  });

  test('[G4-06] envio confirmado: um único POST com chave UUID e itens só com materialId, tamanho (quando há), quantidade 1 e motivo; sem violação de contrato', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirPronto({ servidor });
    await t.enviar();
    assert.equal(servidor.contar(PEDIDO), 1);
    const corpo = H.plano(t.pedidosPost()[0].corpo);
    assert.deepEqual(Object.keys(corpo).sort(), ['chaveIdempotencia', 'itens']);
    assert.match(corpo.chaveIdempotencia, H.UUID);
    for (const i of corpo.itens) assert.ok(Object.keys(i).every((k) => ['materialId', 'tamanho', 'quantidade', 'motivo'].includes(k)));
    assert.deepEqual(servidor.violacoes, []);
    assert.deepEqual(t.telaAtual(), ['telaConfirma']);
  });
});

describe('[G4-B] 409, rejeições e idempotência', () => {
  test('[G4-10] 409 ITEM_NAO_AUTORIZADO: texto "liberado" no item apontado; carrinho e atendimento mantidos; nada de sucesso nem de incerteza', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirPronto({ servidor });
    servidor.materiais = servidor.materiais.filter((m) => m.id !== 11);
    await t.enviar();
    assert.deepEqual(t.telaAtual(), ['telaRevisao']);
    assert.ok(t.itensDaRevisao()[0].textContent.includes(TEXTOS.naoLiberado));
    assert.equal(t.itensDaRevisao().length, 2);
    assert.equal(servidor.atendimentoAberto(), true);
    assert.equal(servidor.pedidos.size, 0);
  });

  test('[G4-11] 409 IDEMPOTENCIA_CONFLITO: não é sucesso nem falha conclusiva: resultado indeterminado, mesma chave, sem reenvio nem botão de reenviar', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirPronto({ servidor });
    servidor.falhar(PEDIDO, 'status', { status: 409, codigo: 'IDEMPOTENCIA_CONFLITO' });
    await t.enviar();
    assert.deepEqual(t.telaAtual(), ['telaIncerto']);
    assert.ok(!t.textoVisivel().includes(TEXTOS.confirmacao1));
    assert.equal(t.botao(TEXTOS.reenviar), null);
    await t.passar(60000, 5000);
    assert.equal(servidor.contar(PEDIDO), 1, 'nenhum reenvio automático, nenhuma chave nova');
  });

  test('[G4-12] 409 com código que o contrato não descreve: também indeterminado, nunca sucesso', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirPronto({ servidor });
    servidor.falhar(PEDIDO, 'status', { status: 409, codigo: 'OUTRO_CONFLITO' });
    await t.enviar();
    assert.deepEqual(t.telaAtual(), ['telaIncerto']);
    assert.ok(!t.textoVisivel().includes(TEXTOS.confirmacao1));
    assert.ok(!t.textoDoDom().includes(H.SENTINELA));
  });

  test('[G4-13] 409 de item já solicitado e envio de novo SEM mudar o conteúdo: a chave é a mesma (nada foi aceito), nunca outra para escapar do conflito', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirNoCatalogo({ servidor });
    await t.irARevisao([['Botina de Segurança', '40'], ['Camiseta', 'M']]);
    await t.motivoParaTodos('DESGASTE_DANO');
    servidor.solicitacoes.push({ materialId: 13, nome: 'Camiseta', tamanho: 'M', situacao: 'AGUARDANDO_APROVACAO', quantidade: 1 });
    await t.enviar();
    await t.enviar();
    assert.equal(t.pedidosPost().length, 2);
    assert.equal(t.pedidosPost()[1].corpo.chaveIdempotencia, t.pedidosPost()[0].corpo.chaveIdempotencia);
    assert.deepEqual(H.plano(t.pedidosPost()[1].corpo.itens), H.plano(t.pedidosPost()[0].corpo.itens));
  });

  test('[G4-14] resposta sem retorno: incerto, sem reenvio automático; "Enviar novamente" só depois de a consulta dizer que não existe, com a MESMA chave e os MESMOS itens', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirPronto({ servidor });
    servidor.falhar(PEDIDO, 'rede');
    await t.enviar();
    const original = H.plano(t.pedidosPost()[0].corpo);
    assert.deepEqual(t.telaAtual(), ['telaIncerto']);
    await t.passar(50000, 5000); // dentro dos 60 s da sessão
    assert.equal(servidor.contar(PEDIDO), 1);
    assert.equal(t.botao(TEXTOS.reenviar), null, 'antes da consulta não se oferece o reenvio');
    await t.clicarTexto(TEXTOS.verificar);
    assert.ok(t.botao(TEXTOS.reenviar));
    await t.clicarTexto(TEXTOS.reenviar);
    assert.deepEqual(H.plano(t.pedidosPost()[1].corpo), original);
    assert.deepEqual(t.telaAtual(), ['telaConfirma']);
    assert.equal(servidor.pedidos.size, 1);
  });

  test('[G4-15] duplo toque em "Enviar novamente" gera um só reenvio', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirPronto({ servidor });
    servidor.falhar(PEDIDO, 'rede');
    await t.enviar();
    await t.clicarTexto(TEXTOS.verificar);
    const botao = t.botao(TEXTOS.reenviar);
    await Promise.all([botao.disparar('click'), botao.disparar('click')]);
    await t.esperar();
    assert.equal(servidor.contar(PEDIDO), 2);
    assert.equal(servidor.pedidos.size, 1);
  });

  test('[G4-16] durante o resultado incerto o carrinho não muda: não se abre produto, não se adiciona, não se volta', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirPronto({ servidor });
    servidor.falhar(PEDIDO, 'rede');
    await t.enviar();
    const chips = t.consulta('#resumo .chip').length;
    await t.abrirProduto('Capacete');
    await t.clicarEl(t.el('btnSolicitar'));
    await t.clicarEl(t.el('btnVoltarProdutos'));
    await t.clicarEl(t.el('btnRevisar'));
    assert.deepEqual(t.telaAtual(), ['telaIncerto']);
    assert.equal(t.consulta('#resumo .chip').length, chips);
  });

  test('[G4-17] 2xx fora do contrato e 5xx são resultado indeterminado: sem sucesso, sem falha presumida, sem reenvio automático', async () => {
    for (const modo of [{ status: 200, corpo: { status: 'ok' } }, erro500, { status: 502, codigo: 'ERRO' }]) {
      const servidor = H.criarServidor();
      const t = await H.abrirPronto({ servidor });
      servidor.falhar(PEDIDO, 'status', modo);
      await t.enviar();
      assert.deepEqual(t.telaAtual(), ['telaIncerto'], JSON.stringify(modo));
      assert.ok(!t.textoVisivel().includes(TEXTOS.confirmacao1));
      await t.passar(30000, 5000);
      assert.equal(servidor.contar(PEDIDO), 1);
    }
  });

  test('[G4-18] a consulta com 401 não prova nada: texto de sessão encerrada, sem afirmar que o pedido existe ou não, e tudo limpo', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirPronto({ servidor });
    servidor.falhar(PEDIDO, 'rede');
    await t.enviar();
    const chave = t.chaveDoPedido();
    servidor.cookie = null;
    await t.clicarTexto(TEXTOS.verificar);
    const texto = t.textoVisivel();
    assert.deepEqual(t.telaAtual(), ['telaAcesso']);
    assert.ok(texto.includes(TEXTOS.sessaoTerminou));
    assert.ok(!/não foi criado|não existe|não foi enviado|falhou|foi criado|foi enviado/i.test(texto));
    assert.deepEqual(dadosDeAna(t), []);
    assert.deepEqual(H.vazamentos(t, { chave }), []);
    assert.equal(servidor.contar(PEDIDO), 1, 'a página não cria nova tentativa');
  });

  test('[G4-19] 401 no PRIMEIRO envio é sessão expirada; 401 num REENVIO (depois de resultado desconhecido) não afirma nada sobre o pedido', async () => {
    const s1 = H.criarServidor();
    const t1 = await H.abrirPronto({ servidor: s1 });
    s1.avancar(61000);
    await t1.enviar();
    assert.ok(t1.textoVisivel().includes(TEXTOS.expirada));

    const s2 = H.criarServidor();
    const t2 = await H.abrirPronto({ servidor: s2 });
    s2.falhar(PEDIDO, 'rede');
    await t2.enviar();
    await t2.clicarTexto(TEXTOS.verificar);
    s2.atendimentos[s2.atendimentos.length - 1].encerrado = 'SAIDA';
    await t2.clicarTexto(TEXTOS.reenviar);
    const texto = t2.textoVisivel();
    assert.deepEqual(t2.telaAtual(), ['telaAcesso']);
    assert.ok(texto.includes(TEXTOS.sessaoTerminou));
    assert.ok(!texto.includes(TEXTOS.expirada));
  });

  test('[G4-20] a sessão acaba (60 s locais) com o resultado ainda incerto: tudo limpo, texto neutro de sessão encerrada e nenhuma chamada nova', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirPronto({ servidor });
    servidor.falhar(PEDIDO, 'rede');
    await t.enviar();
    const chave = t.chaveDoPedido();
    const antes = servidor.chamadas.length;
    await t.passar(61000, 1000);
    assert.deepEqual(t.telaAtual(), ['telaAcesso']);
    assert.ok(t.textoVisivel().includes(TEXTOS.sessaoTerminou));
    assert.equal(servidor.chamadas.length, antes);
    assert.deepEqual(dadosDeAna(t), []);
    assert.deepEqual(H.vazamentos(t, { chave }), []);
  });

  test('[G4-21] com o pedido em envio ou incerto a sessão não é renovada: uma renovação que estava em voo e responde 401 não apaga a tentativa', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirNoCatalogo({ servidor });
    servidor.falhar(ATIV, 'segurar');
    await t.adicionarItem('Capacete');
    await t.clicarTexto(TEXTOS.revisar);
    await t.motivoParaTodos('DESGASTE_DANO');
    servidor.falhar(PEDIDO, 'rede');
    await t.enviar();
    assert.deepEqual(t.telaAtual(), ['telaIncerto']);
    const renovacoes = servidor.atividades;
    servidor.atendimentos[servidor.atendimentos.length - 1].encerrado = 'PEDIDO_ENVIADO';
    servidor.liberarSegurados();
    await t.passar(3000, 1000);
    assert.deepEqual(t.telaAtual(), ['telaIncerto'], 'a resposta da renovação não decide nada');
    await t.abrirProduto('Botina de Segurança');
    assert.equal(servidor.atividades, renovacoes, 'nenhuma renovação nova com o pedido em aberto');
  });
});

describe('[G4-C] requisições F na barreira de cookies', () => {
  test('[G4-30] POST do pedido ainda sem resposta e saída: B é barrado; a resposta tardia (201) de A é descartada e não vira confirmação para B', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirPronto({ servidor });
    servidor.falhar(ENCERRAR, 'status', erro500);
    servidor.falhar(PEDIDO, 'segurar');
    await t.enviar();
    await t.clicarTexto('Sair');
    await identificarB(t);
    assert.equal(servidor.contar(IDENT), 1, 'B espera a requisição de pedido de A terminar');
    servidor.liberarSegurados();
    await t.passar(1000);
    assert.deepEqual(t.telaAtual(), ['telaAcesso'], 'a resposta antiga não mostra confirmação nem restaura A');
    assert.ok(!t.textoVisivel().includes(TEXTOS.confirmacao1));
    assert.deepEqual(dadosDeAna(t), []);
    assert.equal(servidor.pedidos.size, 1, 'o servidor aceitou o pedido de A: a saída não o desfaz (a tela só não o confirma)');
    await identificarB(t);
    assert.equal(servidor.contar(IDENT), 2);
    assert.ok(t.textoVisivel().includes('Olá, Bruno'));
  });

  test('[G4-31] GET de recuperação ainda sem resposta e saída: B é barrado até a resposta chegar; ela é descartada', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirPronto({ servidor });
    servidor.falhar(PEDIDO, 'status', erro500);
    await t.enviar();
    assert.deepEqual(t.telaAtual(), ['telaIncerto']);
    servidor.falhar(RESULTADO, 'segurar');
    await t.clicarTexto(TEXTOS.verificar);
    await t.clicarTexto('Sair');
    await identificarB(t);
    assert.equal(servidor.contar(IDENT), 1);
    servidor.liberarSegurados();
    await t.passar(1000);
    assert.deepEqual(dadosDeAna(t), []);
    await identificarB(t);
    assert.equal(servidor.contar(IDENT), 2, 'com a resposta recebida a transição é liberada');
  });

  test('[G4-32] POST sem resposta mantém a transição bloqueada MESMO depois de a consulta confirmar o pedido (são problemas distintos)', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirPronto({ servidor });
    servidor.falhar(PEDIDO, 'perdida');
    await t.enviar();
    await t.clicarTexto(TEXTOS.verificar);
    assert.deepEqual(t.telaAtual(), ['telaConfirma'], 'o pedido está confirmado');
    await t.passar(20000, 1000);
    assert.deepEqual(t.telaAtual(), ['telaAcesso']);
    await identificarB(t);
    assert.equal(servidor.contar(IDENT), 1, 'a requisição de envio ficou sem resposta: a transição segue barrada');
    const recarregada = await H.abrirTotem({ servidor });
    await identificarB(recarregada);
    assert.ok(recarregada.textoVisivel().includes('Olá, Bruno'), 'só o recarregamento libera, sem garantia comprovada contra resposta tardia');
  });

  test('[G4-33] 401 de POST com remoção de cookie não é tratado como cookie do atendimento seguinte: o retorno para a identificação é só de tela e a barreira libera com a resposta recebida', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirPronto({ servidor });
    servidor.avancar(61000);
    await t.enviar();
    assert.deepEqual(t.telaAtual(), ['telaAcesso']);
    await identificarB(t);
    assert.ok(t.textoVisivel().includes('Olá, Bruno'));
  });
});

describe('[G4-D] confirmação neutra, limpeza e retorno', () => {
  test('[G4-40] a confirmação por consulta (resposta perdida) também é neutra: sem número, nome, material, tamanho nem chave', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirPronto({ servidor });
    servidor.falhar(PEDIDO, 'perdida');
    await t.enviar();
    const chave = t.chaveDoPedido();
    const numero = [...servidor.pedidos.values()][0].visao.numero;
    await t.clicarTexto(TEXTOS.verificar);
    const dom = t.textoDoDom();
    for (const proibido of [numero, 'PED-', 'Botina', 'Protetor', 'Ana', 'Beatriz', chave]) assert.ok(!dom.includes(proibido), proibido);
    assert.ok(t.textoVisivel().includes(TEXTOS.confirmacao1));
    assert.equal(t.visivel('sessao'), false);
  });

  test('[G4-41] a confirmação dura no máximo 20 s; "Concluir e sair" a encerra antes e o temporizador não age depois', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirPronto({ servidor });
    await t.enviar();
    await t.passar(19000, 1000);
    assert.deepEqual(t.telaAtual(), ['telaConfirma']);
    await t.passar(1000, 1000);
    assert.deepEqual(t.telaAtual(), ['telaAcesso']);

    const s2 = H.criarServidor();
    const t2 = await H.abrirPronto({ servidor: s2 });
    await t2.enviar();
    await t2.clicarTexto(TEXTOS.concluir);
    const antes = s2.chamadas.length;
    await t2.passar(30000, 5000);
    assert.deepEqual(t2.telaAtual(), ['telaAcesso']);
    assert.equal(s2.chamadas.length, antes);
  });

  test('[G4-42] o retorno visual não abre a identificação por conta própria: com a barreira ocupada a tela volta, mas B não é identificado', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirPronto({ servidor });
    servidor.falhar(PEDIDO, 'rede');
    await t.enviar();
    await t.clicarTexto(TEXTOS.verificar);
    await t.clicarTexto(TEXTOS.reenviar);
    assert.deepEqual(t.telaAtual(), ['telaConfirma']);
    await t.passar(20000, 1000);
    assert.deepEqual(t.telaAtual(), ['telaAcesso']);
    await identificarB(t);
    assert.equal(servidor.contar(IDENT), 1, 'o primeiro POST ficou sem resposta: a transição segue barrada apesar da confirmação');
  });
});
