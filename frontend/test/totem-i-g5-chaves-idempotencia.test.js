'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers/totem-i');

/**
 * Etapa I — I-G5: independência das chaves de idempotência (Etapa F). TESTADO COM MOCKS.
 *
 * Regra de referência: uma TENTATIVA LÓGICA de pedido tem uma chave própria; uma tentativa independente (outro atendimento, outro
 * funcionário) recebe OUTRA chave, mesmo com materiais, tamanhos, quantidades e motivos idênticos. Dentro da mesma tentativa a
 * chave e o conteúdo se mantêm na recuperação e num reenvio autorizado. O Q6-A2 e o Q8-44 não bastam: o primeiro troca o conteúdo
 * entre os pedidos e o segundo só prova que conteúdo novo gera chave nova; aqui o conteúdo é IDÊNTICO onde a independência é exigida.
 */

const { TEXTOS, FUNCIONARIOS } = H;
const [ANA, BRUNO] = FUNCIONARIOS;
const PEDIDO = `POST ${H.BASE}/atendimento/pedido`;
const ehResultado = (c) => c.chave.startsWith(`GET ${H.BASE}/atendimento/pedidos/`);
const CARRINHO = [['Botina de Segurança', '40'], ['Capacete', null]];
const chaves = (t) => t.pedidosPost().map((c) => c.corpo.chaveIdempotencia);
const itens = (t) => t.pedidosPost().map((c) => H.plano(c.corpo.itens));

/** Dentro de um atendimento já identificado: monta CARRINHO com o mesmo motivo e envia. */
async function pedirCarrinhoIdentico(t, motivo = 'DESGASTE_DANO') {
  await t.irAoCatalogo();
  await t.irARevisao(CARRINHO);
  await t.motivoParaTodos(motivo);
  await t.enviar();
}

describe('[G5-A] chaves independentes entre tentativas, atendimentos e funcionários', () => {
  test('[G5-01] cenário A: o MESMO funcionário, em dois atendimentos, com carrinho IDÊNTICO, usa chaves UUID diferentes', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirIdentificado({ servidor, funcionario: ANA });
    await pedirCarrinhoIdentico(t);
    assert.deepEqual(t.telaAtual(), ['telaConfirma']);
    await t.clicarTexto(TEXTOS.concluir);
    await t.identificar({ tipo: 'CPF', valor: ANA.cpf });
    await pedirCarrinhoIdentico(t);
    assert.deepEqual(t.telaAtual(), ['telaConfirma']);
    const [k1, k2] = chaves(t);
    assert.equal(chaves(t).length, 2);
    assert.match(k1, H.UUID);
    assert.match(k2, H.UUID);
    assert.notEqual(k1, k2);
    const [i1, i2] = itens(t);
    assert.deepEqual(i1, i2, 'o conteúdo foi idêntico: só a chave mudou');
    assert.equal(servidor.pedidos.size, 2);
    assert.equal(servidor.atendimentos.length, 2);
  });

  test('[G5-02] cenário B: dois funcionários diferentes com carrinhos idênticos usam chaves diferentes', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirIdentificado({ servidor, funcionario: ANA });
    await pedirCarrinhoIdentico(t);
    await t.clicarTexto(TEXTOS.concluir);
    await t.identificar({ tipo: 'MATRICULA', valor: BRUNO.matricula });
    await pedirCarrinhoIdentico(t);
    const [k1, k2] = chaves(t);
    assert.notEqual(k1, k2);
    assert.deepEqual(itens(t)[0], itens(t)[1]);
    assert.equal(servidor.pedidos.size, 2);
  });

  test('[G5-03] dez atendimentos seguidos do mesmo funcionário com o mesmo carrinho geram dez chaves distintas', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirIdentificado({ servidor, funcionario: ANA });
    for (let i = 0; i < 10; i += 1) {
      await pedirCarrinhoIdentico(t);
      assert.deepEqual(t.telaAtual(), ['telaConfirma'], `pedido ${i + 1}`);
      await t.clicarTexto(TEXTOS.concluir);
      if (i < 9) await t.identificar({ tipo: 'CPF', valor: ANA.cpf });
    }
    assert.equal(new Set(chaves(t)).size, 10);
    assert.equal(servidor.pedidos.size, 10);
  });

  test('[G5-04] a chave de um atendimento encerrado SEM pedido (saída) não é reaproveitada no atendimento seguinte', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirIdentificado({ servidor, funcionario: ANA });
    await t.irAoCatalogo();
    await t.irARevisao(CARRINHO);
    await t.motivoParaTodos('DESGASTE_DANO');
    servidor.falhar(PEDIDO, 'status', { status: 409, codigo: 'ITEM_NAO_AUTORIZADO', detalhes: [] });
    await t.enviar();
    const primeira = chaves(t)[0];
    assert.match(primeira, H.UUID);
    await t.clicarTexto('Sair');
    await t.identificar({ tipo: 'CPF', valor: ANA.cpf });
    await pedirCarrinhoIdentico(t);
    assert.equal(chaves(t).length, 2);
    assert.notEqual(chaves(t)[1], primeira, 'mesmo funcionário, mesmo conteúdo, outro atendimento: outra chave');
  });
});

describe('[G5-B] a mesma tentativa lógica mantém a chave e o conteúdo', () => {
  test('[G5-05] cenário C/D: resultado incerto, consulta (404) e reenvio manual usam a MESMA chave e os MESMOS itens, sem nova tentativa automática', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirIdentificado({ servidor, funcionario: ANA });
    await t.irAoCatalogo();
    await t.irARevisao(CARRINHO);
    await t.motivoParaTodos('PERDA_EXTRAVIO');
    servidor.falhar(PEDIDO, 'rede');
    await t.enviar();
    await t.passar(40000, 5000);
    assert.equal(chaves(t).length, 1, 'nenhum reenvio automático');
    await t.clicarTexto(TEXTOS.verificar);
    const consulta = servidor.chamadas.filter(ehResultado);
    assert.equal(consulta.length, 1);
    assert.ok(consulta[0].url.endsWith(`/pedidos/${chaves(t)[0]}`), 'a consulta usa a chave do envio');
    await t.passar(10000, 5000);
    assert.equal(chaves(t).length, 1, 'nem depois do 404');
    await t.clicarTexto(TEXTOS.reenviar);
    assert.equal(chaves(t).length, 2);
    assert.equal(chaves(t)[1], chaves(t)[0]);
    assert.deepEqual(itens(t)[1], itens(t)[0]);
    assert.equal(servidor.pedidos.size, 1);
    assert.deepEqual(t.telaAtual(), ['telaConfirma']);
  });

  test('[G5-06] cenário E: resposta perdida com o pedido gravado: não gera chave nova, não reenvia, e a consulta o confirma sem duplicar', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirPronto({ servidor });
    servidor.falhar(PEDIDO, 'perdida');
    await t.enviar();
    await t.passar(30000, 5000);
    assert.equal(chaves(t).length, 1);
    await t.clicarTexto(TEXTOS.verificar);
    assert.deepEqual(t.telaAtual(), ['telaConfirma']);
    assert.equal(chaves(t).length, 1);
    assert.equal(servidor.pedidos.size, 1);
  });

  test('[G5-07] o original que chega DEPOIS do reenvio não duplica o pedido (um pedido por atendimento, mesma chave)', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirIdentificado({ servidor, funcionario: ANA });
    await t.irAoCatalogo();
    await t.irARevisao(CARRINHO);
    await t.motivoParaTodos('DESGASTE_DANO');
    servidor.falhar(PEDIDO, 'pendente');
    await t.enviar();
    await t.passar(15000, 1000);
    assert.deepEqual(t.telaAtual(), ['telaIncerto']);
    await t.clicarTexto(TEXTOS.verificar);
    await t.clicarTexto(TEXTOS.reenviar);
    assert.deepEqual(t.telaAtual(), ['telaConfirma']);
    assert.equal(servidor.pedidos.size, 1);
    assert.equal(chaves(t)[0], chaves(t)[1]);
  });

  test('[G5-08] cenário G: conteúdo alterado depois de uma rejeição conclusiva usa chave NOVA; conteúdo igual mantém a mesma', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirIdentificado({ servidor, funcionario: ANA });
    await t.irAoCatalogo();
    await t.irARevisao([['Botina de Segurança', '40']]);
    await t.motivoParaTodos('DESGASTE_DANO');
    servidor.falhar(PEDIDO, '429', { retryAfter: 3, vezes: 2 });
    await t.enviar();
    await t.passar(4000, 1000);
    await t.enviar();
    assert.equal(chaves(t)[1], chaves(t)[0], 'mesmo conteúdo depois de uma rejeição conclusiva: mesma chave');
    await t.passar(4000, 1000);
    await t.clicarTexto('Voltar aos produtos');
    await t.adicionarItem('Capacete');
    await t.clicarTexto(TEXTOS.revisar);
    await t.motivoParaTodos('DESGASTE_DANO');
    await t.enviar();
    assert.equal(chaves(t).length, 3);
    assert.notEqual(chaves(t)[2], chaves(t)[0], 'conteúdo novo: outra chave');
  });

  test('[G5-09] durante o resultado incerto o conteúdo não pode ser alterado para reaproveitar a chave: nada muda no carrinho', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirPronto({ servidor });
    servidor.falhar(PEDIDO, 'rede');
    await t.enviar();
    const chips = t.consulta('#resumo .chip').length;
    await t.abrirProduto('Capacete');
    await t.clicarEl(t.el('btnSolicitar'));
    assert.equal(t.consulta('#resumo .chip').length, chips);
    assert.deepEqual(t.telaAtual(), ['telaIncerto']);
  });
});

describe('[G5-C] limpeza da chave e conflitos', () => {
  test('[G5-10] cenário F: depois da confirmação e depois da saída a chave não está em lugar nenhum observável e o atendimento seguinte começa sem ela', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirIdentificado({ servidor, funcionario: ANA });
    await pedirCarrinhoIdentico(t);
    const k1 = chaves(t)[0];
    assert.deepEqual(H.vazamentos(t, { k1 }), []);
    await t.clicarTexto(TEXTOS.concluir);
    await t.identificar({ tipo: 'MATRICULA', valor: BRUNO.matricula });
    assert.deepEqual(H.vazamentos(t, { k1 }), []);
    await t.irAoCatalogo();
    assert.equal(t.consulta('#resumo .chip').length, 0);
    assert.equal(t.pedidosPost().length, 1, 'nenhum envio automático no atendimento seguinte');
    assert.equal(t.storage.length, 0);
    assert.deepEqual(t.consoleChamadas, []);
  });

  test('[G5-11] a chave de uma tentativa incerta some com a sessão: sessão acabada, saída e novo atendimento nunca a reaproveitam', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirIdentificado({ servidor, funcionario: ANA });
    await t.irAoCatalogo();
    await t.irARevisao(CARRINHO);
    await t.motivoParaTodos('DESGASTE_DANO');
    servidor.falhar(PEDIDO, 'status', { status: 502, codigo: 'ERRO' });
    await t.enviar();
    const k1 = chaves(t)[0];
    await t.passar(61000, 1000);
    assert.deepEqual(t.telaAtual(), ['telaAcesso']);
    assert.deepEqual(H.vazamentos(t, { k1 }), []);
    await t.identificar({ tipo: 'CPF', valor: ANA.cpf });
    await pedirCarrinhoIdentico(t);
    assert.equal(chaves(t).length, 2);
    assert.notEqual(chaves(t)[1], k1);
  });

  test('[G5-12] 409 de idempotência nunca troca a chave sozinho nem cria pedido: indeterminado, mesma chave, nenhuma nova tentativa', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirPronto({ servidor });
    servidor.falhar(PEDIDO, 'status', { status: 409, codigo: 'IDEMPOTENCIA_CONFLITO' });
    await t.enviar();
    await t.passar(30000, 5000);
    assert.equal(chaves(t).length, 1);
    assert.equal(servidor.pedidos.size, 0);
    assert.deepEqual(t.telaAtual(), ['telaIncerto']);
  });
});
