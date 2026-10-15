'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers/totem-i');

/**
 * Etapa I (RED) — Q4 e Q5: identificação por CPF ou matrícula (Etapa D), catálogo por GHE (Etapa E) e carrinho de pedido
 * multi-item com motivo por item e quantidade unitária (Etapa F). O backend não é tocado: o servidor falso reproduz o
 * contrato real e registra violações cometidas pela página (`servidor.violacoes`).
 */

const { TEXTOS, FUNCIONARIOS } = H;
const [ANA, BRUNO, CARLA, DANIEL] = FUNCIONARIOS;
const IDENT = `POST ${H.BASE}/atendimento`;
const PEDIDO = `POST ${H.BASE}/atendimento/pedido`;

describe('[Q4] identificação: escolha explícita entre CPF e matrícula, comparação exata', () => {
  test('[Q45-01] há seletor CPF/Matrícula e UM único campo de entrada: sem PIN, nascimento ou autenticação adicional', async () => {
    const t = await H.abrirTotem();
    assert.ok(t.existe('tipoCpf') && t.existe('tipoMatricula'), 'seletor #tipoCpf/#tipoMatricula ausente');
    assert.ok(t.visivel('tipoCpf') && t.visivel('tipoMatricula'));
    const entradas = t.consulta('input').filter(t.visivelNo).filter((i) => !['button', 'hidden'].includes(i.type));
    assert.equal(entradas.length, 1);
    assert.ok(!/nascimento|pin|senha|data de/i.test(t.textoVisivel()));
  });

  test('[Q45-02] sem escolher o tipo não há identificação: nada é enviado e a tela é a mesma', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirTotem({ servidor });
    await t.digitar(ANA.cpf);
    await t.clicarTexto('Continuar');
    assert.equal(servidor.contar(IDENT), 0, 'o tipo nunca é inferido do formato');
    assert.deepEqual(t.telaAtual(), ['telaAcesso']);
  });

  test('[Q45-03] CPF: corpo { tipo: "CPF", valor } só com os 11 dígitos, com credenciais, e a saudação usa só o primeiro nome', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirTotem({ servidor });
    await t.identificar({ tipo: 'CPF', valor: ANA.cpf });
    const [chamada] = servidor.chamadasDe(IDENT);
    assert.deepEqual(H.plano(chamada.corpo), { tipo: 'CPF', valor: ANA.cpf });
    assert.equal(chamada.credentials, 'include');
    assert.deepEqual(servidor.violacoes, []);
    const texto = t.textoVisivel();
    assert.ok(texto.includes('Olá, Ana'));
    for (const proibido of ['Beatriz', 'Sobrenome', ANA.cpf, ANA.matricula]) assert.ok(!texto.includes(proibido), `exposto após a identificação: ${proibido}`);
    assert.equal(t.texto('quem').trim(), 'Ana');
  });

  test('[Q45-04] matrícula: correspondência EXATA e sensível a caixa; o valor segue como foi digitado', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirTotem({ servidor });
    await t.identificar({ tipo: 'MATRICULA', valor: 'MAT-0045' });
    assert.ok(t.textoVisivel().includes(TEXTOS.naoEncontrado), 'MAT-0045 não é mat-0045');
    assert.deepEqual(H.plano(servidor.chamadasDe(IDENT)[0].corpo), { tipo: 'MATRICULA', valor: 'MAT-0045' });
    await t.clicarTexto('Limpar');
    await t.identificar({ tipo: 'MATRICULA', valor: 'mat-0045' });
    assert.deepEqual(H.plano(servidor.chamadasDe(IDENT)[1].corpo), { tipo: 'MATRICULA', valor: 'mat-0045' });
    assert.ok(t.textoVisivel().includes('Olá, Bruno'));
  });

  test('[Q45-05] zeros à esquerda preservados: "0123", "123" e "000123" são três matrículas diferentes', async () => {
    for (const [valor, nome] of [['0123', 'Carla'], ['123', 'Daniel'], ['000123', 'Ana']]) {
      const servidor = H.criarServidor();
      const t = await H.abrirTotem({ servidor });
      await t.identificar({ tipo: 'MATRICULA', valor });
      assert.equal(servidor.chamadasDe(IDENT)[0].corpo.valor, valor, 'nenhum zero pode ser removido ou convertido em número');
      assert.ok(t.textoVisivel().includes(`Olá, ${nome}`), `${valor} deveria identificar ${nome}`);
    }
  });

  test('[Q45-06] sem correspondência parcial nem completar matrícula: "45", "mat" e "00045" não identificam ninguém', async () => {
    for (const valor of ['45', 'mat', '00045', 'mat-004']) {
      const servidor = H.criarServidor();
      const t = await H.abrirTotem({ servidor });
      await t.identificar({ tipo: 'MATRICULA', valor });
      assert.equal(servidor.chamadasDe(IDENT)[0].corpo.valor, valor);
      assert.ok(t.textoVisivel().includes(TEXTOS.naoEncontrado), valor);
      assert.deepEqual(t.telaAtual(), ['telaAcesso']);
    }
  });

  test('[Q45-07] funcionário inativo e inexistente recebem a MESMA mensagem; nada indica a diferença', async () => {
    const textos = [];
    for (const [tipo, valor] of [['MATRICULA', 'inativa-1'], ['MATRICULA', 'nao-existe'], ['CPF', '99999999999']]) {
      const t = await H.abrirTotem();
      await t.identificar({ tipo, valor });
      textos.push(t.textoVisivel());
      assert.ok(textos[textos.length - 1].includes(TEXTOS.naoEncontrado));
    }
    assert.equal(new Set(textos.map((x) => x.replace(/\s+/g, ' '))).size, 1);
  });

  test('[Q45-08] nada do que foi digitado permanece depois da identificação', async () => {
    const t = await H.abrirIdentificado();
    assert.equal(t.el('doc').value, '');
    assert.deepEqual(H.vazamentos(t, { cpf: ANA.cpf, matricula: ANA.matricula, sobrenome: 'Sobrenome' }), []);
  });

  test('[Q45-09] atendimento isolado: ao trocar de funcionário nada do anterior aparece, e o anterior foi encerrado no servidor', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirIdentificado({ servidor });
    await t.clicarTexto('Sair');
    assert.deepEqual(t.telaAtual(), ['telaAcesso']);
    await t.identificar({ tipo: 'MATRICULA', valor: BRUNO.matricula });
    const texto = t.textoVisivel();
    assert.ok(texto.includes('Olá, Bruno'));
    assert.ok(!texto.includes('Ana'));
    assert.equal(servidor.atendimentos[0].encerrado, 'SAIDA');
    assert.equal(servidor.atendimentos.length, 2);
  });

  test('[Q45-10] depois de identificar: uma consulta G e depois o catálogo, nessa ordem, sem parâmetros', async () => {
    const servidor = H.criarServidor();
    await H.abrirIdentificado({ servidor });
    // A sequência de inicialização (estado e consulta do atendimento aberto) é contratual e anterior à identificação.
    const rotas = servidor.chamadas.map((c) => c.chave).filter((c) => c !== `GET ${H.BASE}/estado` && c !== `GET ${H.BASE}/atendimento`);
    assert.deepEqual(rotas, [IDENT, `GET ${H.BASE}/atendimento/solicitacoes`, `GET ${H.BASE}/atendimento/catalogo`]);
    assert.deepEqual(servidor.violacoes, []);
    for (const c of servidor.chamadas.filter((x) => x.chave.startsWith('GET'))) assert.equal(c.corpo, null);
  });
});

describe('[Q4] catálogo por GHE, tamanhos reais e ausência de saldo', () => {
  test('[Q45-20] só os materiais do catálogo do servidor, sem pedir GHE, saldo ou estoque, e sem mostrar saldo', async () => {
    const t = await H.abrirNoCatalogo();
    assert.deepEqual(t.produtos(), H.CATALOGO.map((m) => m.nome));
    const texto = t.textoVisivel().toLowerCase();
    for (const proibido of ['estoque', 'saldo', 'em falta', 'sem estoque']) assert.ok(!texto.includes(proibido), proibido);
  });

  test('[Q45-21] material elegível com estoque zerado aparece como qualquer outro (o servidor não envia saldo e a tela não o infere)', async () => {
    const materiais = H.CATALOGO.map((m) => ({ ...m }));
    materiais[0] = { ...materiais[0], nome: 'Botina Sem Saldo' };
    const t = await H.abrirNoCatalogo({ servidor: H.criarServidor({ materiais }) });
    assert.ok(t.produtos().includes('Botina Sem Saldo'));
    await t.abrirProduto('Botina Sem Saldo');
    assert.deepEqual(t.tamanhos(), ['38', '39', '40', '41', '42']);
    assert.ok(!t.consulta('#tams .tam').some((b) => /\b(falta|pouco|ok)\b/.test(b.className)));
  });

  test('[Q45-22] material com tamanho: o tamanho é obrigatório e só os da grade do servidor podem ser escolhidos', async () => {
    const t = await H.abrirNoCatalogo();
    await t.abrirProduto('Camiseta');
    assert.deepEqual(t.tamanhos(), ['P', 'M', 'G']);
    assert.equal(t.el('btnSolicitar').disabled, true, 'sem tamanho não se adiciona');
    await t.escolherTamanho('M');
    assert.equal(t.el('btnSolicitar').disabled, false);
    assert.ok(t.consulta('#tams .tam').some((b) => /\bsel\b/.test(b.className)), 'o tamanho escolhido fica marcado');
  });

  test('[Q45-23] material sem tamanho (tamanho único): não há botões de tamanho, adiciona direto e envia tamanho nulo', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirNoCatalogo({ servidor });
    await t.abrirProduto('Protetor Auricular');
    assert.equal(t.tamanhos().length, 0);
    assert.equal(t.el('btnSolicitar').disabled, false);
    await t.adicionar();
    await t.clicarTexto(TEXTOS.revisar);
    await t.motivoParaTodos('DESGASTE_DANO');
    await t.enviar();
    const [item] = t.pedidosPost()[0].corpo.itens;
    assert.equal(item.materialId, 12);
    assert.ok(item.tamanho === null || item.tamanho === undefined, 'tamanho null quando o material não usa tamanho');
    assert.deepEqual(servidor.violacoes, []);
  });

  test('[Q45-24] material de grade com tamanho escolhido envia o tamanho exato', async () => {
    const t = await H.abrirNoCatalogo();
    await t.irARevisao([['Botina de Segurança', '41']]);
    await t.motivoParaTodos('SUBSTITUICAO_PRAZO');
    await t.enviar();
    assert.deepEqual(H.plano(t.pedidosPost()[0].corpo.itens[0]), { materialId: 11, tamanho: '41', quantidade: 1, motivo: 'SUBSTITUICAO_PRAZO' });
  });

  test('[Q45-25] itens já em aberto na Etapa G aparecem marcados "✓ Solicitado" e o mesmo material + tamanho não pode ser incluído de novo', async () => {
    const solicitacoes = [{ materialId: 13, nome: 'Camiseta', tamanho: 'M', situacao: 'AGUARDANDO_APROVACAO', quantidade: 1 }];
    const t = await H.abrirIdentificado({ servidor: H.criarServidor({ solicitacoes }) });
    await t.irAoCatalogo();
    const cartaoCamiseta = t.consulta('#grade .prod').find((c) => c.querySelector('.prod-nome')?.textContent.trim() === 'Camiseta');
    assert.ok(cartaoCamiseta.textContent.includes(TEXTOS.solicitado), 'selo ✓ Solicitado');
    assert.ok(!t.consulta('#grade .prod').filter((c) => c !== cartaoCamiseta).some((c) => c.textContent.includes(TEXTOS.solicitado)));
    await t.adicionarItem('Camiseta', 'M');
    assert.equal(t.consulta('#resumo .chip').length, 0, 'M já está em aberto');
    assert.ok(t.textoVisivel().includes(TEXTOS.jaSolicitouNestaRetirada));
    await t.adicionarItem('Camiseta', 'P');
    assert.equal(t.consulta('#resumo .chip').length, 1, 'outro tamanho do mesmo material é permitido');
  });
});

describe('[Q5] carrinho multi-item, motivo por item, uma unidade por item', () => {
  test('[Q45-30] o carrinho existe só em memória: nenhum armazenamento do navegador em todo o fluxo', async () => {
    const t = await H.abrirPronto();
    await t.enviar();
    assert.equal(t.storage.length, 0, JSON.stringify(t.storage));
    assert.equal(t.cookiesEscritos.length, 0);
  });

  test('[Q45-31] vários itens no mesmo pedido: um único POST com todos os itens', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirNoCatalogo({ servidor });
    await t.irARevisao([['Botina de Segurança', '40'], ['Camiseta', 'G'], ['Protetor Auricular', null], ['Capacete', null]]);
    await t.motivoParaTodos('DESGASTE_DANO');
    await t.enviar();
    assert.equal(t.pedidosPost().length, 1);
    const itens = H.plano(t.pedidosPost()[0].corpo.itens);
    assert.deepEqual(itens.map((i) => i.materialId).sort(), [11, 12, 13, 14]);
    assert.equal(servidor.pedidos.size, 1);
    assert.deepEqual(servidor.violacoes, []);
  });

  test('[Q45-32] quantidade fixa de UMA unidade por item e nenhum controle de quantidade na interface', async () => {
    const t = await H.abrirPronto();
    for (const campo of t.consulta('input')) assert.notEqual(campo.type, 'number');
    for (const rotulo of t.botoesVisiveis()) assert.ok(!/^[+−-]$|incrementar|aumentar|diminuir|quantidade/i.test(rotulo), `controle de quantidade: ${rotulo}`);
    await t.enviar();
    for (const item of t.pedidosPost()[0].corpo.itens) assert.equal(item.quantidade, 1);
  });

  test('[Q45-33] o motivo é escolhido por item e vai no próprio item', async () => {
    const t = await H.abrirNoCatalogo();
    await t.irARevisao([['Botina de Segurança', '38'], ['Camiseta', 'P'], ['Capacete', null]]);
    await t.escolherMotivo(0, 'SUBSTITUICAO_PRAZO');
    await t.escolherMotivo(1, 'DESGASTE_DANO');
    await t.escolherMotivo(2, 'PERDA_EXTRAVIO');
    await t.enviar();
    const porId = Object.fromEntries(H.plano(t.pedidosPost()[0].corpo.itens).map((i) => [i.materialId, i.motivo]));
    assert.deepEqual(porId, { 11: 'SUBSTITUICAO_PRAZO', 13: 'DESGASTE_DANO', 14: 'PERDA_EXTRAVIO' });
    assert.ok(!Object.hasOwn(t.pedidosPost()[0].corpo, 'motivo'), 'não existe motivo do pedido inteiro');
  });

  test('[Q45-34] cada item oferece exatamente os três motivos autorizados e nenhum outro', async () => {
    const t = await H.abrirNoCatalogo();
    await t.irARevisao();
    for (const linha of t.itensDaRevisao()) {
      const valores = linha.querySelectorAll('button').map((b) => b.getAttribute('data-motivo')).filter(Boolean).sort();
      assert.deepEqual(valores, [...H.MOTIVOS].sort());
    }
  });

  test('[Q45-35] "Enviar pedido" só habilita quando TODOS os itens têm motivo', async () => {
    const t = await H.abrirNoCatalogo();
    await t.irARevisao();
    const botaoEnviar = () => t.botao(TEXTOS.enviar);
    assert.ok(botaoEnviar().disabled, 'sem motivos');
    await t.escolherMotivo(0, 'DESGASTE_DANO');
    assert.ok(botaoEnviar().disabled, 'falta o motivo do segundo item');
    await t.escolherMotivo(1, 'DESGASTE_DANO');
    assert.equal(botaoEnviar().disabled, false);
    assert.equal(t.servidor.contar(PEDIDO), 0, 'nada é enviado antes do toque');
  });

  test('[Q45-36] remover um item da revisão o tira do pedido enviado', async () => {
    const t = await H.abrirNoCatalogo();
    await t.irARevisao([['Botina de Segurança', '40'], ['Capacete', null]]);
    const linha = t.itensDaRevisao()[0];
    await t.clicarEl(linha.querySelectorAll('button').find((b) => b.textContent.includes(TEXTOS.remover)));
    assert.equal(t.itensDaRevisao().length, 1);
    await t.motivoParaTodos('PERDA_EXTRAVIO');
    await t.enviar();
    assert.deepEqual(H.plano(t.pedidosPost()[0].corpo.itens).map((i) => i.materialId), [14]);
  });

  test('[Q45-37] não existe "Reservar" em nenhuma tela do fluxo', async () => {
    const t = await H.abrirNoCatalogo();
    const rotulos = new Set(t.botoesVisiveis());
    await t.abrirProduto('Botina de Segurança');
    t.botoesVisiveis().forEach((r) => rotulos.add(r));
    await t.escolherTamanho('40');
    await t.adicionar();
    await t.clicarTexto(TEXTOS.revisar);
    t.botoesVisiveis().forEach((r) => rotulos.add(r));
    for (const r of rotulos) assert.ok(!/reserv/i.test(r), r);
    assert.ok(!/reserv/i.test(t.textoVisivel()));
  });

  test('[Q45-38] pedido de 20 itens é aceito em um único envio (limite do contrato)', async () => {
    const materiais = Array.from({ length: 20 }, (_, i) => ({ ...H.CATALOGO[1], id: 300 + i, nome: `Material ${String(i + 1).padStart(2, '0')}` }));
    const servidor = H.criarServidor({ materiais });
    const t = await H.abrirNoCatalogo({ servidor });
    await t.irARevisao(materiais.map((m) => [m.nome, null]));
    await t.motivoParaTodos('DESGASTE_DANO');
    await t.enviar();
    assert.equal(t.pedidosPost()[0].corpo.itens.length, 20);
    assert.equal(servidor.pedidos.size, 1);
  });

  test('[Q45-39] ao terminar o atendimento o carrinho some: o funcionário seguinte começa vazio', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirPronto({ servidor });
    await t.enviar();
    await t.clicarTexto(TEXTOS.concluir);
    await t.identificar({ tipo: 'MATRICULA', valor: BRUNO.matricula });
    await t.irAoCatalogo();
    assert.equal(t.consulta('#resumo .chip').length, 0);
    assert.ok(!/Botina|Protetor/.test(t.consulta('#resumo')[0]?.textContent ?? ''));
  });
});
