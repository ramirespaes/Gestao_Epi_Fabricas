'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers/totem-i');

/**
 * Etapa I (RED) — Q6: privacidade e limpeza no tablet compartilhado. Tempo simulado (nenhuma espera real): o relógio
 * virtual do helper controla a página e o servidor. Os 20 s da confirmação neutra e os 30 s da identificação abandonada
 * são controles da INTERFACE e não alteram os 60 s do backend.
 */

const { TEXTOS, FUNCIONARIOS } = H;
const [ANA, BRUNO] = FUNCIONARIOS;
const ATIV = `POST ${H.BASE}/atendimento/atividade`;
const IDENT = `POST ${H.BASE}/atendimento`;

/** Tudo o que identificaria o funcionário ou o que ele pediu, em qualquer lugar do DOM (inclusive oculto). */
const SENSIVEIS = ['Ana', 'Beatriz', 'Sobrenome', ANA.cpf, ANA.matricula, 'Botina', 'Protetor', 'Substituição', 'Desgaste', 'PED-'];
const dados = (t) => SENSIVEIS.filter((s) => t.textoDoDom().includes(s));
const camposDeTrabalhoVazios = (t) => {
  for (const id of ['grade', 'tams', 'resumo', 'quem']) if (t.existe(id)) assert.equal(t.texto(id).trim(), '', `#${id} ainda tem dados`);
  assert.equal(t.itensDaRevisao().length, 0);
  assert.equal(t.el('doc').value, '');
};

describe('[Q6-A] encerramento, confirmação neutra e retorno', () => {
  test('[Q6-A1] ao confirmar o pedido, TODOS os dados do atendimento somem na hora (DOM completo, sem esperar nada)', async () => {
    const t = await H.abrirPronto();
    await t.enviar();
    assert.deepEqual(t.telaAtual(), ['telaConfirma']);
    camposDeTrabalhoVazios(t);
    assert.deepEqual(dados(t), [], 'restos de dados do funcionário ou do pedido no DOM');
    assert.equal(t.visivel('sessao'), false, 'o cabeçalho de sessão (nome e contagem) é ocultado');
  });

  test('[Q6-A2] a chave de idempotência é descartada: não sobra em lugar algum e o próximo pedido usa outra', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirPronto({ servidor });
    await t.enviar();
    const primeira = t.chaveDoPedido();
    assert.match(primeira, H.UUID);
    assert.deepEqual(H.vazamentos(t, { chave: primeira }), []);
    await t.clicarTexto(TEXTOS.concluir);
    await t.identificar({ tipo: 'MATRICULA', valor: BRUNO.matricula });
    await t.irAoCatalogo();
    await t.irARevisao([['Capacete', null]]);
    await t.motivoParaTodos('DESGASTE_DANO');
    await t.enviar();
    const segunda = t.pedidosPost()[1].corpo.chaveIdempotencia;
    assert.notEqual(segunda, primeira);
    assert.deepEqual(H.vazamentos(t, { primeira }), []);
  });

  test('[Q6-A3] a confirmação não mostra o código do pedido nem material, tamanho, motivo ou identificação (nem oculto)', async () => {
    const t = await H.abrirPronto();
    await t.enviar();
    const numero = [...t.servidor.pedidos.values()][0].visao.numero;
    const texto = t.textoDoDom();
    for (const proibido of [numero, 'PED-', 'Código do pedido', 'Botina', 'Protetor', '40', 'Desgaste', 'Ana']) {
      if (proibido === '40') assert.ok(!t.texto('telaConfirma').includes(proibido), 'tamanho na confirmação');
      else assert.ok(!texto.includes(proibido), `exposto: ${proibido}`);
    }
    assert.ok(t.texto('telaConfirma').includes(TEXTOS.confirmacao1));
  });

  test('[Q6-A4] a confirmação neutra permanece no máximo 20 segundos e volta à identificação sem falar com o servidor', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirPronto({ servidor });
    await t.enviar();
    const antes = servidor.chamadas.length;
    // As ações que montaram o pedido (abrir produto, escolher motivo) renovaram a sessão, como o Q7 exige: o total de renovações
    // não é zero. O que não pode haver é renovação DEPOIS da confirmação.
    const renovacoesAntes = servidor.atividades;
    await t.passar(20000);
    assert.deepEqual(t.telaAtual(), ['telaAcesso']);
    assert.equal(servidor.chamadas.length, antes, 'o retorno é só de interface: nenhuma chamada ao servidor');
    assert.equal(servidor.atividades, renovacoesAntes);
    camposDeTrabalhoVazios(t);
  });

  test('[Q6-A5] "Concluir e sair" volta à identificação imediatamente, por ação explícita', async () => {
    const t = await H.abrirPronto();
    await t.enviar();
    await t.clicarTexto(TEXTOS.concluir);
    assert.deepEqual(t.telaAtual(), ['telaAcesso']);
    assert.deepEqual(dados(t), []);
  });
});

describe('[Q6-B] identificação abandonada: 30 segundos sem digitação', () => {
  const digitarParcial = async (t, texto = '1234') => { await t.escolherTipo('CPF'); await t.digitar(texto); };

  test('[Q6-B1] depois de 30 s sem digitar o campo é limpo (e antes disso mantém o que foi digitado)', async () => {
    const t = await H.abrirTotem();
    await digitarParcial(t);
    assert.ok(t.el('doc').value.replace(/\D/g, '') === '1234');
    await t.passar(25000);
    assert.equal(t.el('doc').value.replace(/\D/g, ''), '1234', 'ainda dentro do prazo');
    await t.passar(6000);
    assert.equal(t.el('doc').value, '', 'a digitação abandonada precisa sumir');
    assert.deepEqual(t.telaAtual(), ['telaAcesso']);
  });

  test('[Q6-B2] cada nova digitação reinicia o prazo de 30 s', async () => {
    const t = await H.abrirTotem();
    await digitarParcial(t, '12');
    await t.passar(20000);
    await t.digitar('3');
    await t.passar(20000);
    assert.equal(t.el('doc').value.replace(/\D/g, ''), '123', '20 s depois da última digitação ainda vale');
    await t.passar(11000);
    assert.equal(t.el('doc').value, '');
  });

  test('[Q6-B3] os dígitos digitados nunca são gravados em armazenamento, console, histórico ou cookie', async () => {
    const t = await H.abrirTotem();
    await digitarParcial(t, '52998224725');
    await t.passar(40000);
    assert.equal(t.storage.length, 0);
    assert.deepEqual(H.vazamentos(t, { cpf: '52998224725' }).filter((x) => !x.endsWith('em dom')), []);
  });

  test('[Q6-B4] é independente dos 60 s do backend: não chama o servidor e não encerra nada; dentro do atendimento a regra não existe', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirTotem({ servidor });
    await digitarParcial(t);
    const antes = servidor.chamadas.length;
    await t.passar(40000);
    assert.equal(servidor.chamadas.length, antes);
    await t.identificar({ tipo: 'CPF', valor: ANA.cpf });
    await t.irAoCatalogo();
    await t.passar(35000);
    assert.deepEqual(t.telaAtual(), ['telaProdutos'], 'a limpeza de 30 s é só da identificação; a sessão segue os 60 s do servidor');
    assert.equal(servidor.atendimentoAberto(), true);
    assert.equal(servidor.contar(IDENT), 1);
  });
});

describe('[Q6-C] isolamento entre funcionários', () => {
  test('[Q6-C1] o funcionário seguinte não vê nada do anterior (DOM completo)', async () => {
    const t = await H.abrirPronto();
    await t.enviar();
    await t.clicarTexto(TEXTOS.concluir);
    await t.identificar({ tipo: 'MATRICULA', valor: BRUNO.matricula });
    await t.irAoCatalogo();
    // O catálogo do funcionário seguinte lista legitimamente os mesmos materiais ("Botina de Segurança", "Protetor Auricular"):
    // o que não pode haver é resto do pedido anterior (pessoa, motivo, número) nem item escolhido.
    assert.deepEqual(dados(t).filter((s) => !H.CATALOGO.some((m) => m.nome.includes(s))), []);
    assert.equal(t.consulta('#resumo .chip').length, 0);
    assert.equal(t.itensDaRevisao().length, 0);
    assert.ok(t.textoVisivel().includes('Olá, Bruno'));
  });

  test('[Q6-C2] recarregar a página não recupera dados pessoais e encerra no servidor o atendimento que ficou aberto', async () => {
    const servidor = H.criarServidor();
    const a = await H.abrirIdentificado({ servidor });
    await a.irAoCatalogo();
    await a.adicionarItem('Capacete');
    assert.equal(servidor.atendimentoAberto(), true);
    const recarregada = await H.abrirTotem({ servidor });
    assert.deepEqual(recarregada.telaAtual(), ['telaAcesso']);
    assert.deepEqual(dados(recarregada), []);
    assert.equal(servidor.atendimentoAberto(), false, 'a página encerra o atendimento que encontrou aberto');
    assert.equal(recarregada.storage.length, 0);
  });

  test('[Q6-C3] página restaurada do cache do navegador (pageshow persisted) volta à identificação limpa', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirNoCatalogo({ servidor });
    await t.adicionarItem('Capacete');
    await t.eventoDaJanela('pageshow', { persisted: true });
    assert.deepEqual(t.telaAtual(), ['telaAcesso']);
    assert.deepEqual(dados(t), []);
    camposDeTrabalhoVazios(t);
  });

  test('[Q6-C4] navegação de retorno não restaura carrinho nem pedidos e a página não cria entradas de histórico', async () => {
    const t = await H.abrirPronto();
    await t.enviar();
    await t.clicarTexto(TEXTOS.concluir);
    await t.eventoDaJanela('popstate', { state: null });
    assert.deepEqual(t.telaAtual(), ['telaAcesso']);
    assert.deepEqual(dados(t), []);
    assert.equal(t.historico.filter((h) => h.metodo === 'pushState').length, 0);
    assert.equal(t.navegacoes.length, 0);
  });

  test('[Q6-C5] a expiração remove imediatamente todos os dados e oculta o cabeçalho de sessão', async () => {
    const t = await H.abrirNoCatalogo();
    await t.adicionarItem('Botina de Segurança', '40');
    await t.passar(61000);
    assert.deepEqual(t.telaAtual(), ['telaAcesso']);
    assert.deepEqual(dados(t), []);
    camposDeTrabalhoVazios(t);
    assert.equal(t.visivel('sessao'), false);
  });

  test('[Q6-C6] 401 do atendimento durante uma ação limpa tudo na hora e volta à identificação', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirNoCatalogo({ servidor });
    servidor.atendimentos[servidor.atendimentos.length - 1].encerrado = 'SUBSTITUIDO';
    await t.irARevisao([['Capacete', null]]).catch(() => {});
    assert.deepEqual(t.telaAtual(), ['telaAcesso']);
    assert.deepEqual(dados(t), []);
    assert.ok(t.textoVisivel().includes(TEXTOS.expirada));
  });

  test('[Q6-C7] tablet revogado no meio do atendimento: tela de bloqueio, sem expor nada e sem tocar na credencial do tablet', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirNoCatalogo({ servidor });
    await t.adicionarItem('Capacete');
    servidor.tablet = 'nao_autorizado';
    await t.abrirProduto('Botina de Segurança').catch(() => {});
    await t.passar(2000);
    assert.deepEqual(t.telaAtual(), ['telaNaoAutorizado']);
    assert.ok(t.textoVisivel().includes(TEXTOS.naoAutorizado));
    assert.deepEqual(dados(t), []);
    assert.equal(t.cookiesEscritos.length, 0, 'a interface não mexe em cookies (a credencial do tablet é do backend)');
    assert.equal(t.storage.length, 0);
  });
});
