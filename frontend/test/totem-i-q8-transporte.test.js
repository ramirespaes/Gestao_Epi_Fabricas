'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers/totem-i');

/**
 * Etapa I (RED) — Q8: transporte HTTP seguro do Totem, idempotência e resultado incerto (Etapa F, D-F6). O servidor falso
 * registra cada violação do contrato (credenciais, cabeçalhos, query, corpo). Atenção especial: GET /pedidos/:chave leva a
 * chave de idempotência NO CAMINHO — a interface não pode deixá-la em log, armazenamento, histórico ou tela. A cobertura de
 * logs de servidor e de proxy fica registrada (ver [Q8-30]/[Q8-31]); nenhuma baseline é alterada.
 */

const { TEXTOS } = H;
const PEDIDO = `POST ${H.BASE}/atendimento/pedido`;
const RESULTADO = new RegExp(`^GET ${H.BASE}/atendimento/pedidos/`);
const resultados = (s) => s.chamadas.filter((c) => RESULTADO.test(c.chave));

describe('[Q8] credenciais e ausência de autenticação paralela', () => {
  test('[Q8-01] todas as requisições do fluxo usam credentials: "include" e só os cabeçalhos do contrato', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirPronto({ servidor });
    await t.enviar();
    assert.ok(servidor.chamadas.length >= 4);
    assert.deepEqual(servidor.violacoes, []);
    for (const c of servidor.chamadas) assert.equal(c.credentials, 'include', c.chave);
    assert.deepEqual(t.externas, [], 'nenhuma requisição fora da API');
  });

  test('[Q8-02] nenhuma credencial própria: sem Authorization, sem cookie escrito, sem token em URL, corpo ou storage', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirPronto({ servidor });
    await t.enviar();
    for (const c of servidor.chamadas) {
      for (const k of Object.keys(c.cabecalhos ?? {})) assert.ok(['content-type', 'accept'].includes(k.toLowerCase()), `cabeçalho ${k} em ${c.chave}`);
      // O prefixo da rota ("/atendimento-token/") contém a palavra "token" e não é credencial: só o que vem DEPOIS dele é examinado.
      assert.ok(!/token|credencial|bearer|senha/i.test(c.url.replace('/atendimento-token/', '/') + JSON.stringify(c.corpo ?? {})), c.chave);
    }
    assert.equal(t.cookiesEscritos.length, 0);
    assert.equal(t.storage.length, 0);
  });

  test('[Q8-03] o endereço da API vem da origem da própria página (mesma origem em produção), sem host fixo, e o Totem não usa o EpiHttp', () => {
    const { semComentarios, html } = H.corpus();
    assert.match(semComentarios, /SAFEWORK_PORTAL_API_BASE_URL|resolverApiBaseUrl|location\.origin/);
    assert.ok(!/https?:\/\/[A-Za-z0-9.-]+(?::\d+)?\/api/.test(semComentarios), 'sem host de API fixo no código');
    assert.ok(!/EpiHttp/.test(semComentarios), 'o EpiHttp registra o caminho das requisições e não expõe Retry-After');
    assert.ok(!/js\/api-http\.js/.test(html));
  });

  test('[Q8-04] a página não escreve nada no console (kiosque compartilhado): sem console.* no código do Totem', () => {
    const { semComentarios } = H.corpus();
    assert.ok(!/console\.(log|info|warn|error|debug|trace)/.test(semComentarios));
  });
});

describe('[Q8] segredos fora de logs, histórico, armazenamento e telas', () => {
  test('[Q8-10] em todo o fluxo (incluindo envio incerto e verificação) nenhum segredo vai a console, storage, histórico, URL ou cookie', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirPronto({ servidor });
    servidor.falhar(PEDIDO, 'perdida');
    await t.enviar();
    await t.clicarTexto(TEXTOS.verificar);
    const chave = t.chaveDoPedido();
    assert.match(chave, H.UUID);
    const achados = H.vazamentos(t, { chave, cpf: H.FUNCIONARIOS[0].cpf, matricula: H.FUNCIONARIOS[0].matricula, cookieTablet: 'gepi_tablet', cookieAtendimento: 'gepi_atendimento', bearer: 'Bearer' })
      .filter((x) => !x.endsWith('em dom'));
    assert.deepEqual(achados, []);
    assert.deepEqual(t.consoleChamadas, []);
  });

  test('[Q8-11] mensagens de erro na tela nunca contêm segredo nem a mensagem do servidor, em cada código de erro', async () => {
    for (const [chave, modo] of [[PEDIDO, { status: 500, codigo: 'ERRO_INTERNO' }], [PEDIDO, { status: 409, codigo: 'IDEMPOTENCIA_CONFLITO' }], [PEDIDO, { status: 401, codigo: 'ATENDIMENTO_INVALIDO' }], [PEDIDO, { status: 429, codigo: 'LIMITE_REQUISICOES_EXCEDIDO' }]]) {
      const servidor = H.criarServidor();
      const t = await H.abrirPronto({ servidor });
      servidor.falhar(chave, 'status', modo);
      await t.enviar();
      const dom = t.textoDoDom();
      assert.ok(!dom.includes(H.SENTINELA), `mensagem do servidor exibida em ${modo.codigo}`);
      assert.ok(!dom.includes(H.FUNCIONARIOS[0].cpf) && !dom.includes('gepi_'), modo.codigo);
    }
  });

  test('[Q8-12] a chave do caminho de GET /pedidos/:chave existe só na requisição: não fica em armazenamento, histórico, URL da página, console nem tela', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirPronto({ servidor });
    servidor.falhar(PEDIDO, 'rede');
    await t.enviar();
    const chave = t.chaveDoPedido();
    await t.clicarTexto(TEXTOS.verificar);
    const [chamada] = resultados(servidor);
    assert.ok(chamada.url.endsWith(`/pedidos/${chave}`), chamada.url);
    assert.equal(chamada.corpo, null);
    assert.equal(chamada.chave.includes('?'), false);
    assert.deepEqual(H.vazamentos(t, { chave }), []);
  });
});

describe('[Q8] timeout, 429 e Retry-After', () => {
  test('[Q8-20] uma requisição sem resposta não trava a tela: depois de um tempo limite aparece a mensagem de comunicação', async () => {
    const servidor = H.criarServidor();
    servidor.falhar(`GET ${H.BASE}/atendimento/catalogo`, 'pendente');
    const t = await H.abrirIdentificado({ servidor });
    await t.passar(45000);
    assert.ok(t.textoVisivel().includes(TEXTOS.comunicacao) || t.textoVisivel().includes(TEXTOS.expirada), t.textoVisivel());
    assert.deepEqual(t.produtos(), []);
  });

  test('[Q8-21] 429 com Retry-After no envio: texto de limite, carrinho mantido, nenhuma repetição automática; depois do prazo o novo envio usa a MESMA chave', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirPronto({ servidor });
    servidor.falhar(PEDIDO, '429', { retryAfter: 7 });
    await t.enviar();
    assert.ok(t.textoVisivel().includes(TEXTOS.limite));
    assert.deepEqual(t.telaAtual(), ['telaRevisao']);
    assert.equal(t.itensDaRevisao().length, 2, 'o carrinho foi mantido');
    await t.passar(20000);
    assert.equal(t.pedidosPost().length, 1, 'sem repetição automática');
    await t.enviar();
    assert.equal(t.pedidosPost().length, 2);
    assert.equal(t.pedidosPost()[1].corpo.chaveIdempotencia, t.pedidosPost()[0].corpo.chaveIdempotencia, 'o pedido rejeitado não foi persistido: a chave continua a do mesmo conteúdo');
    assert.deepEqual(t.telaAtual(), ['telaConfirma']);
  });
});

describe('[Q8] falha antes do envio × resultado incerto', () => {
  test('[Q8-30] antes do envio: sem motivos ou carrinho inválido nada é transmitido e não se fala em incerteza', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirNoCatalogo({ servidor });
    await t.irARevisao();
    const b = t.botao(TEXTOS.enviar);
    assert.ok(b);
    await t.clicarEl(b);
    assert.equal(servidor.contar(PEDIDO), 0);
    assert.notDeepEqual(t.telaAtual(), ['telaIncerto']);
    assert.ok(!t.textoVisivel().includes(TEXTOS.incerto));
  });

  test('[Q8-31] depois da transmissão sem resposta (rede, resposta perdida): estado incerto, NUNCA sucesso nem falha presumidos', async () => {
    for (const modo of ['rede', 'perdida']) {
      const servidor = H.criarServidor();
      const t = await H.abrirPronto({ servidor });
      servidor.falhar(PEDIDO, modo);
      await t.enviar();
      assert.deepEqual(t.telaAtual(), ['telaIncerto'], modo);
      const texto = t.textoVisivel();
      assert.ok(texto.includes(TEXTOS.incerto));
      assert.ok(!texto.includes(TEXTOS.confirmacao1), 'não afirma sucesso');
      assert.ok(!/não foi enviado|falha ao enviar|não enviamos|tente novamente enviar/i.test(texto), 'não presume falha transacional');
    }
  });

  test('[Q8-32] 400 do servidor não é incerteza: o pedido foi recusado antes de ser gravado', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirPronto({ servidor });
    servidor.falhar(PEDIDO, 'status', { status: 400, codigo: 'VALIDACAO' });
    await t.enviar();
    assert.notDeepEqual(t.telaAtual(), ['telaIncerto']);
    assert.ok(!t.textoVisivel().includes(TEXTOS.confirmacao1));
    assert.equal(servidor.pedidos.size, 0);
  });
});

describe('[Q8] idempotência e recuperação', () => {
  test('[Q8-40] nunca gera outra chave depois do resultado incerto: verificação e reenvio usam a MESMA chave e o MESMO conteúdo', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirPronto({ servidor });
    servidor.falhar(PEDIDO, 'rede');
    await t.enviar();
    const primeira = t.pedidosPost()[0].corpo;
    await t.clicarTexto(TEXTOS.verificar);
    assert.ok(resultados(servidor)[0].chave.endsWith(primeira.chaveIdempotencia) || resultados(servidor)[0].url.endsWith(primeira.chaveIdempotencia));
    await t.clicarTexto(TEXTOS.reenviar);
    assert.equal(t.pedidosPost().length, 2);
    assert.equal(t.pedidosPost()[1].corpo.chaveIdempotencia, primeira.chaveIdempotencia);
    assert.deepEqual(H.plano(t.pedidosPost()[1].corpo.itens), H.plano(primeira.itens));
    assert.equal(servidor.pedidos.size, 1);
    assert.deepEqual(t.telaAtual(), ['telaConfirma']);
  });

  test('[Q8-41] resposta perdida com o pedido gravado: a verificação o encontra e confirma, sem duplicar', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirPronto({ servidor });
    servidor.falhar(PEDIDO, 'perdida');
    await t.enviar();
    assert.equal(servidor.pedidos.size, 1);
    await t.clicarTexto(TEXTOS.verificar);
    assert.deepEqual(t.telaAtual(), ['telaConfirma']);
    assert.equal(servidor.pedidos.size, 1);
    assert.equal(t.pedidosPost().length, 1, 'verificar não reenvia o pedido');
  });

  test('[Q8-42] recuperação só com autenticação válida: sem o cookie do atendimento a página manda identificar de novo e não tenta outra credencial', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirPronto({ servidor });
    servidor.falhar(PEDIDO, 'rede');
    await t.enviar();
    servidor.cookie = null;
    await t.clicarTexto(TEXTOS.verificar);
    assert.deepEqual(t.telaAtual(), ['telaAcesso']);
    assert.ok(t.textoVisivel().includes(TEXTOS.sessaoTerminou));
    assert.equal(resultados(servidor).length, 1);
    assert.deepEqual(servidor.violacoes, []);
    assert.deepEqual(H.vazamentos(t, { chave: t.chaveDoPedido() }), []);
  });

  test('[Q8-43] duplo toque em "Enviar pedido": no máximo o mesmo pedido, nunca dois pedidos', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirPronto({ servidor });
    const botao = t.botao(TEXTOS.enviar);
    await Promise.all([botao.disparar('click'), botao.disparar('click')]);
    await t.esperar();
    assert.equal(servidor.pedidos.size, 1);
    const chaves = new Set(t.pedidosPost().map((c) => c.corpo.chaveIdempotencia));
    assert.equal(chaves.size, 1);
  });

  test('[Q8-44] 409 ITEM_JA_SOLICITADO: atendimento e carrinho mantidos; ao remover o item e reenviar o conteúdo mudou, então a chave é outra e o pedido é criado', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirNoCatalogo({ servidor });
    await t.irARevisao([['Botina de Segurança', '40'], ['Camiseta', 'M']]);
    await t.motivoParaTodos('DESGASTE_DANO');
    servidor.solicitacoes.push({ materialId: 13, nome: 'Camiseta', tamanho: 'M', situacao: 'AGUARDANDO_ESTOQUE', quantidade: 1 });
    await t.enviar();
    assert.deepEqual(t.telaAtual(), ['telaRevisao']);
    assert.equal(servidor.atendimentoAberto(), true);
    const linha = t.itensDaRevisao()[1];
    await t.clicarEl(linha.querySelectorAll('button').find((b) => b.textContent.includes(TEXTOS.remover)));
    await t.motivoParaTodos('DESGASTE_DANO');
    await t.enviar();
    assert.equal(t.pedidosPost().length, 2);
    assert.notEqual(t.pedidosPost()[1].corpo.chaveIdempotencia, t.pedidosPost()[0].corpo.chaveIdempotencia);
    assert.equal(servidor.pedidos.size, 1);
    assert.deepEqual(t.telaAtual(), ['telaConfirma']);
  });
});

describe('[Q8] só há sucesso com confirmação válida do backend; encerramento e limpeza depois', () => {
  for (const [rotulo, modo] of [['200 sem pedido', { status: 200, corpo: { status: 'ok' } }], ['200 com número ausente', { status: 200, corpo: { status: 'ok', repetida: false, pedido: { status: 'PENDENTE' } } }], ['500', { status: 500, codigo: 'ERRO_INTERNO' }], ['resposta não JSON', { status: 200, bruto: '<html>proxy</html>' }]]) {
    test(`[Q8-50] ${rotulo}: a confirmação de sucesso NÃO aparece`, async () => {
      const servidor = H.criarServidor();
      const t = await H.abrirPronto({ servidor });
      servidor.falhar(PEDIDO, 'status', modo);
      await t.enviar();
      assert.ok(!t.textoVisivel().includes(TEXTOS.confirmacao1));
      assert.notDeepEqual(t.telaAtual(), ['telaConfirma']);
    });
  }

  test('[Q8-51] depois do 201 o atendimento termina: nenhuma renovação nem consulta nova e tudo é limpo', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirPronto({ servidor });
    await t.enviar();
    const antes = servidor.chamadas.length;
    const renovacoesAntes = servidor.atividades; // as ações do carrinho renovaram a sessão (Q7); depois do 201 não pode haver mais nenhuma
    await t.passar(30000);
    assert.equal(servidor.atividades, renovacoesAntes);
    assert.equal(servidor.chamadas.length, antes);
    assert.equal(servidor.atendimentoAberto(), false);
  });
});

describe('[Q8] riscos fora da interface (registro e mitigação futura)', () => {
  test.todo('[Q8-60] logs de acesso do proxy podem conter o caminho com a chave de GET /pedidos/:chave — BLOQUEADO: infraestrutura (proxy/AWS); mitigação futura: não registrar o caminho completo ou mascarar o segmento da chave; responsável: Etapa K (infraestrutura)');
  test.todo('[Q8-61] Origin, CORS e cookies de produção sob HTTPS e a mesma origem app.safeworkengenharia.com.br — BLOQUEADO: ambiente real; responsável: Etapa K');
});
