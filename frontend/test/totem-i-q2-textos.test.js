'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers/totem-i');

/**
 * Etapa I (RED) — Q2: textos e experiência visual do Totem (catálogo I-GOVERNANCA-Q0-Q8/02-CATALOGO-DE-TEXTOS-E-APROVACAO.md).
 * A interface usa SOMENTE estes textos, escolhidos pelo `codigo` do erro; nunca a mensagem do servidor. Nenhum texto
 * expõe saldo, estoque, lote, número de pedido, situação que o backend oculta nem dados de outro funcionário.
 */

const { TEXTOS } = H;
const PEDIDO = `POST ${H.BASE}/atendimento/pedido`;
const folhas = (obj, prefixo = '') => Object.entries(obj).flatMap(([k, v]) => (typeof v === 'string' ? [[`${prefixo}${k}`, v]] : folhas(v, `${prefixo}${k}.`)));

describe('[Q2] catálogo de textos disponível na interface', () => {
  // P6 (resolvida em 13/10/2026): a prova principal é a APRESENTAÇÃO do texto na interface (testes de comportamento abaixo e dos
  // incrementos seguintes). Esta verificação de base aceita o texto no que a página APRESENTA (HTML, com entidades decodificadas,
  // inclusive telas ainda ocultas) ou em qualquer arquivo local do Totem, sem exigir um arquivo ou uma forma de código-fonte.
  for (const [chave, texto] of folhas(TEXTOS)) {
    test(`[Q2-01] texto "${chave}" está disponível na interface`, () => {
      const { textoDoHtml, js } = H.corpus();
      const noJs = js.replace(/\\u2014/g, '—').replace(/\\u2713/g, '✓').replace(/\s+/g, ' ');
      assert.ok(textoDoHtml.includes(texto.replace(/\s+/g, ' ')) || noJs.includes(texto.replace(/\s+/g, ' ')), `texto não está na interface: ${texto}`);
    });
  }
});

describe('[Q2] pedidos existentes e disponibilidade para retirada (Etapa G)', () => {
  const solicitacoes = [
    { materialId: 13, nome: 'Camiseta', tamanho: 'M', situacao: 'DISPONIVEL_PARA_RETIRADA', quantidade: 1 },
    { materialId: 11, nome: 'Botina de Segurança', tamanho: '40', situacao: 'AGUARDANDO_ESTOQUE', quantidade: 2 },
    { materialId: 12, nome: 'Protetor Auricular', tamanho: null, situacao: 'AGUARDANDO_APROVACAO', quantidade: 1 },
  ];

  test('[Q2-10] com itens disponíveis: aviso aprovado, orientação à SST, botão e seções das demais situações', async () => {
    const t = await H.abrirIdentificado({ servidor: H.criarServidor({ solicitacoes }) });
    assert.deepEqual(t.telaAtual(), ['telaAviso']);
    const texto = t.textoVisivel();
    for (const esperado of [TEXTOS.avisoDisponiveis, TEXTOS.avisoProcure, TEXTOS.aguardandoEstoque, TEXTOS.aguardandoAprovacao, 'Camiseta', 'Botina de Segurança', 'Protetor Auricular']) assert.ok(texto.includes(esperado), `falta: ${esperado}`);
    assert.ok(t.botao(TEXTOS.avisoOk));
    assert.ok(texto.indexOf(TEXTOS.avisoDisponiveis) < texto.indexOf(TEXTOS.aguardandoEstoque), 'os disponíveis vêm primeiro');
    assert.ok(!/PED-|\d{4,}/.test(texto), 'sem número de pedido, id ou data');
    assert.ok(!texto.includes(H.SENTINELA));
  });

  test('[Q2-11] aprovação sem estoque NUNCA aparece como retirada disponível', async () => {
    const t = await H.abrirIdentificado({ servidor: H.criarServidor({ solicitacoes: solicitacoes.slice(1) }) });
    const texto = t.textoVisivel();
    assert.ok(texto.includes(TEXTOS.aguardandoEstoque));
    assert.ok(!texto.includes(TEXTOS.avisoDisponiveis));
    assert.ok(!texto.includes(TEXTOS.avisoProcure));
  });

  test('[Q2-12] item temporariamente indisponível usa o texto próprio, sem sugerir disponibilidade', async () => {
    const t = await H.abrirIdentificado({ servidor: H.criarServidor({ solicitacoes: [{ materialId: 14, nome: 'Capacete', tamanho: null, situacao: 'INDISPONIVEL', quantidade: 1 }] }) });
    const texto = t.textoVisivel();
    assert.ok(texto.includes(TEXTOS.indisponivel));
    assert.ok(!texto.includes(TEXTOS.avisoDisponiveis));
  });

  test('[Q2-13] sem pedidos existentes não há aviso: vai direto ao catálogo, com uma única consulta G', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirIdentificado({ servidor });
    assert.deepEqual(t.telaAtual(), ['telaProdutos']);
    assert.equal(servidor.contar(`GET ${H.BASE}/atendimento/solicitacoes`), 1);
  });

  test('[Q2-14] "OK — Solicitar novos EPIs" é ação explícita e abre o catálogo autorizado', async () => {
    const t = await H.abrirIdentificado({ servidor: H.criarServidor({ solicitacoes }) });
    await t.clicarTexto(TEXTOS.avisoOk);
    assert.deepEqual(t.telaAtual(), ['telaProdutos']);
    assert.deepEqual(t.produtos(), H.CATALOGO.map((m) => m.nome));
  });
});

describe('[Q2] catálogo: estados vazios e ausência de status por estoque', () => {
  for (const [estado, chave] of [['SEM_GHE', 'semGhe'], ['GHE_INATIVO', 'gheInativo'], ['SEM_MATERIAIS', 'semMateriais']]) {
    test(`[Q2-15] catálogo ${estado}: texto próprio, sem produtos, sem catálogo geral`, async () => {
      const t = await H.abrirIdentificado({ servidor: H.criarServidor({ estadoCatalogo: estado }) });
      assert.ok(t.textoVisivel().includes(TEXTOS[chave]), t.textoVisivel());
      assert.deepEqual(t.produtos(), []);
    });
  }

  test('[Q2-16] produtos e tamanhos sem "Disponível", "Poucas unidades", "Reserve" nem legenda: só o rótulo do tamanho', async () => {
    const t = await H.abrirNoCatalogo();
    await t.abrirProduto('Botina de Segurança');
    assert.deepEqual(t.tamanhos(), ['38', '39', '40', '41', '42']);
    const texto = t.textoVisivel();
    for (const proibido of ['Disponível', 'Poucas unidades', 'Reserve', 'sem estoque', 'em falta']) assert.ok(!texto.includes(proibido), `texto de estoque na tela de tamanhos: ${proibido}`);
    for (const botao of t.consulta('#tams .tam')) assert.ok(!/\b(ok|pouco|falta)\b/.test(botao.className), `classe de status por saldo: ${botao.className}`);
  });

  test('[Q2-17] o texto aprovado do subtítulo dos produtos e o resumo "Nesta retirada" são preservados', async () => {
    const t = await H.abrirNoCatalogo();
    assert.ok(t.textoVisivel().includes(TEXTOS.produtosSubtitulo));
    await t.adicionarItem('Capacete');
    assert.ok(t.textoVisivel().includes(TEXTOS.nestaRetirada));
  });
});

describe('[Q2] identificação: textos aprovados e mensagens de erro', () => {
  test('[Q2-18] a tela de identificação mostra os textos aprovados e a nota de privacidade', async () => {
    const t = await H.abrirTotem();
    const texto = t.textoVisivel();
    for (const esperado of [TEXTOS.identifique, TEXTOS.subtituloIdentificacao, TEXTOS.privacidade]) assert.ok(texto.includes(esperado), `falta: ${esperado}`);
  });

  test('[Q2-19] campo vazio, CPF incompleto e CPF/matrícula não encontrado têm cada um o seu texto, sem chamar o servidor quando o erro é local', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirTotem({ servidor });
    await t.escolherTipo('CPF');
    await t.clicarTexto('Continuar');
    assert.ok(t.textoVisivel().includes(TEXTOS.campoVazio));
    await t.digitar('1234');
    await t.clicarTexto('Continuar');
    assert.ok(t.textoVisivel().includes(TEXTOS.cpfIncompleto));
    assert.equal(servidor.contar(`POST ${H.BASE}/atendimento`), 0);
    await t.clicarTexto('Limpar');
    await t.digitar('99999999999');
    await t.clicarTexto('Continuar');
    assert.ok(t.textoVisivel().includes(TEXTOS.naoEncontrado));
  });

  test('[Q2-20] limite de tentativas (429) usa o texto próprio', async () => {
    const servidor = H.criarServidor();
    servidor.identificacoes = Array(10).fill(0);
    const t = await H.abrirTotem({ servidor });
    await t.identificar({ tipo: 'CPF', valor: H.FUNCIONARIOS[0].cpf });
    assert.ok(t.textoVisivel().includes(TEXTOS.limite));
    assert.deepEqual(t.telaAtual(), ['telaAcesso']);
  });
});

describe('[Q2] carrinho, revisão, motivos e erros do pedido', () => {
  test('[Q2-21] o mesmo material e tamanho já no pedido mostra "Item já incluído no pedido." e não duplica', async () => {
    const t = await H.abrirNoCatalogo();
    await t.adicionarItem('Botina de Segurança', '40');
    await t.adicionarItem('Botina de Segurança', '40');
    assert.ok(t.textoVisivel().includes(TEXTOS.jaIncluido));
    assert.equal(t.consulta('#resumo .chip').length, 1);
  });

  test('[Q2-22] o 21º item mostra "Limite de 20 itens." e não entra no pedido', async () => {
    const materiais = Array.from({ length: 21 }, (_, i) => ({ ...H.CATALOGO[1], id: 200 + i, nome: `Material ${String(i + 1).padStart(2, '0')}` }));
    const t = await H.abrirNoCatalogo({ servidor: H.criarServidor({ materiais }) });
    for (let i = 0; i < 20; i += 1) await t.adicionarItem(`Material ${String(i + 1).padStart(2, '0')}`);
    assert.equal(t.consulta('#resumo .chip').length, 20);
    await t.adicionarItem('Material 21');
    assert.ok(t.textoVisivel().includes(TEXTOS.limite20));
    assert.equal(t.consulta('#resumo .chip').length, 20);
  });

  test('[Q2-23] revisão: títulos, "Remover", os três motivos com os rótulos aprovados e "Enviar pedido"', async () => {
    const t = await H.abrirNoCatalogo();
    await t.irARevisao();
    assert.deepEqual(t.telaAtual(), ['telaRevisao']);
    const texto = t.textoVisivel();
    for (const esperado of [TEXTOS.revise, TEXTOS.escolhaMotivo, TEXTOS.remover, ...Object.values(TEXTOS.motivos)]) assert.ok(texto.includes(esperado), `falta: ${esperado}`);
    assert.ok(t.botao(TEXTOS.enviar));
  });

  test('[Q2-24] 409 ITEM_JA_SOLICITADO: texto exato junto ao item apontado, sem revelar situação, atendimento e carrinho mantidos', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirNoCatalogo({ servidor });
    await t.irARevisao([['Botina de Segurança', '40'], ['Camiseta', 'M']]);
    await t.motivoParaTodos('DESGASTE_DANO');
    servidor.solicitacoes.push({ materialId: 13, nome: 'Camiseta', tamanho: 'M', situacao: 'AGUARDANDO_APROVACAO', quantidade: 1 });
    await t.enviar();
    const linha1 = t.consulta('#telaRevisao [data-item="1"]')[0];
    assert.ok(linha1, 'linha do item 1 ausente');
    assert.ok(linha1.textContent.includes(TEXTOS.duplicado), `a mensagem deve estar no item apontado: ${linha1.textContent}`);
    assert.ok(!t.consulta('#telaRevisao [data-item="0"]')[0].textContent.includes(TEXTOS.duplicado));
    const texto = t.textoVisivel();
    for (const proibido of ['andamento', 'aprovação', 'aprovad', 'pendente', 'PED-', H.SENTINELA]) assert.ok(!texto.includes(proibido), `revela algo que o backend não expõe: ${proibido}`);
    assert.deepEqual(t.telaAtual(), ['telaRevisao']);
    assert.equal(servidor.atendimentoAberto(), true);
    assert.equal(servidor.pedidos.size, 0);
  });

  test('[Q2-25] 409 ITEM_NAO_AUTORIZADO: "liberado" (nunca "disponível"), sem motivo, sem estoque', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirNoCatalogo({ servidor });
    await t.irARevisao([['Capacete', null]]);
    await t.motivoParaTodos('PERDA_EXTRAVIO');
    servidor.materiais = servidor.materiais.filter((m) => m.id !== 14);
    await t.enviar();
    const texto = t.textoVisivel();
    assert.ok(texto.includes(TEXTOS.naoLiberado));
    for (const proibido of ['disponível', 'estoque', H.SENTINELA]) assert.ok(!texto.includes(proibido), proibido);
  });

  test('[Q2-26] nenhuma mensagem do servidor é exibida em nenhum erro', async () => {
    const servidor = H.criarServidor();
    servidor.falhar(`GET ${H.BASE}/atendimento/catalogo`, 'status', { status: 500, codigo: 'ERRO_INTERNO' });
    const t = await H.abrirIdentificado({ servidor });
    assert.ok(!t.textoVisivel().includes(H.SENTINELA));
    assert.ok(!t.textoDoDom().includes(H.SENTINELA));
    const s2 = H.criarServidor();
    const t2 = await H.abrirTotem({ servidor: s2 });
    await t2.identificar({ tipo: 'CPF', valor: '99999999999' });
    assert.ok(!t2.textoDoDom().includes(H.SENTINELA));
  });
});

describe('[Q2] confirmação neutra, sessão expirada, falha de comunicação e envio incerto', () => {
  test('[Q2-30] confirmação neutra: só os textos aprovados; sem material, tamanho, motivo, número, nome ou identificação', async () => {
    const t = await H.abrirPronto();
    await t.enviar();
    assert.deepEqual(t.telaAtual(), ['telaConfirma']);
    const texto = t.textoVisivel();
    for (const esperado of [TEXTOS.confirmacao1, TEXTOS.confirmacao2, TEXTOS.concluir]) assert.ok(texto.includes(esperado), `falta: ${esperado}`);
    for (const proibido of ['Botina', 'Protetor', '40', 'Substituição', 'Desgaste', 'Perda', 'PED-', 'Código do pedido', 'Ana', 'Beatriz', H.FUNCIONARIOS[0].cpf, H.FUNCIONARIOS[0].matricula]) assert.ok(!texto.includes(proibido), `a confirmação expõe: ${proibido}`);
    assert.equal(t.existe('confCod') ? t.texto('confCod').trim() : '', '');
    assert.equal(t.existe('confTxt') ? t.texto('confTxt').trim() : '', '');
  });

  test('[Q2-31] sessão expirada: volta à identificação com "Sessão encerrada por inatividade."', async () => {
    const t = await H.abrirNoCatalogo();
    await t.passar(61000);
    assert.deepEqual(t.telaAtual(), ['telaAcesso']);
    assert.ok(t.textoVisivel().includes(TEXTOS.expirada));
  });

  test('[Q2-32] falha de comunicação ao carregar o catálogo: texto próprio, sem produtos e sem travar', async () => {
    const servidor = H.criarServidor();
    servidor.falhar(`GET ${H.BASE}/atendimento/catalogo`, 'rede');
    const t = await H.abrirIdentificado({ servidor });
    assert.ok(t.textoVisivel().includes(TEXTOS.comunicacao));
    assert.deepEqual(t.produtos(), []);
  });

  test('[Q2-33] resultado incerto: texto próprio e "Verificar"; 200 confirma; 202 pede nova verificação; 404 oferece "Enviar novamente"; 401 manda identificar de novo', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirPronto({ servidor });
    servidor.falhar(PEDIDO, 'perdida');
    await t.enviar();
    assert.deepEqual(t.telaAtual(), ['telaIncerto']);
    let texto = t.textoVisivel();
    assert.ok(texto.includes(TEXTOS.incerto));
    assert.ok(!/Botina|Protetor/.test(texto), 'a tela de incerteza não exibe os itens');
    assert.ok(!texto.includes(TEXTOS.confirmacao1), 'nunca afirma sucesso sem confirmação do backend');
    await t.clicarTexto(TEXTOS.verificar);
    assert.deepEqual(t.telaAtual(), ['telaConfirma']);
    assert.ok(t.textoVisivel().includes(TEXTOS.confirmacao1));

    const s2 = H.criarServidor();
    const t2 = await H.abrirPronto({ servidor: s2 });
    s2.falhar(PEDIDO, 'rede');
    await t2.enviar();
    s2.processando = t2.chaveDoPedido();
    await t2.clicarTexto(TEXTOS.verificar);
    assert.ok(t2.textoVisivel().includes(TEXTOS.processando));
    s2.processando = null;
    await t2.clicarTexto(TEXTOS.verificar);
    assert.ok(t2.botao(TEXTOS.reenviar), 'o pedido não existe: oferecer reenvio com a mesma chave');

    const s3 = H.criarServidor();
    const t3 = await H.abrirPronto({ servidor: s3 });
    s3.falhar(PEDIDO, 'rede');
    await t3.enviar();
    s3.cookie = null;
    await t3.clicarTexto(TEXTOS.verificar);
    assert.deepEqual(t3.telaAtual(), ['telaAcesso']);
    assert.ok(t3.textoVisivel().includes(TEXTOS.sessaoTerminou));
  });
});
