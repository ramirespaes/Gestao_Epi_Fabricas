'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers/totem-i');

/**
 * Etapa I — I-G3: testes NOVOS de isolamento entre funcionários, respostas atrasadas, barreira de requisições, encerramento
 * incerto e perda de autorização. Tudo TESTADO COM MOCKS: o servidor é o falso do helper.
 *
 * Duas camadas, que estes testes distinguem:
 *  - ESTADO DA PÁGINA (geração, descarte de resposta antiga, tela limpa): o que o mock consegue provar;
 *  - COOKIE DO ATENDIMENTO (HttpOnly): o servidor falso NÃO o modela. A proteção testada aqui é a ORDEM: nenhuma identificação
 *    nova sai enquanto uma requisição que poderia definir, reemitir ou remover o cookie estiver pendente ou sem resposta.
 *    Que o navegador real processe (ou não) o Set-Cookie de uma requisição abortada ou descarregada NÃO é demonstrado por mock.
 */

const { TEXTOS, FUNCIONARIOS } = H;
const [ANA, BRUNO] = FUNCIONARIOS;
const IDENT = `POST ${H.BASE}/atendimento`;
const ENCERRAR = `POST ${H.BASE}/atendimento/encerrar`;
const ATIV = `POST ${H.BASE}/atendimento/atividade`;
const G = `GET ${H.BASE}/atendimento/solicitacoes`;
const CATALOGO = `GET ${H.BASE}/atendimento/catalogo`;
const MARCA = 'Material do Anterior';
const dadosDeAna = (t) => ['Ana', 'Beatriz', 'Sobrenome', ANA.cpf, ANA.matricula, MARCA].filter((s) => t.textoDoDom().includes(s));
const erro500 = { status: 500, codigo: 'ERRO_INTERNO' };

const SEM_ABORTO = `window.AbortController = function () { this.signal = { aborted: false, addEventListener: function () {}, removeEventListener: function () {} }; this.abort = function () {}; };\n`;
const semAborto = (relativo, fonte) => (relativo === 'totem/totem.js' ? SEM_ABORTO + fonte : fonte);
const abrir = (servidor, abortoReal = true) => H.abrirTotem({ servidor, transformar: abortoReal ? null : semAborto });
const identificarB = (t) => t.identificar({ tipo: 'MATRICULA', valor: BRUNO.matricula });

describe('[G3-A] encerramento que não chega ou cuja resposta se perde: a próxima identificação fica barrada', () => {
  test('[G3-01] cenário A: o encerramento falha antes de chegar; a tela limpa na hora, nenhuma identificação nova é enviada, nem com o passar do tempo', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirIdentificado({ servidor });
    servidor.falhar(ENCERRAR, 'rede');
    await t.clicarTexto('Sair');
    assert.deepEqual(dadosDeAna(t), []);
    await identificarB(t);
    assert.equal(servidor.contar(IDENT), 1, 'nenhuma segunda identificação');
    assert.ok(t.textoVisivel().includes(TEXTOS.comunicacao));
    assert.equal(servidor.atendimentoAberto(), true, 'limitação do contrato D: o servidor só encerra pelos 60 s');
    await t.passar(10 * 60 * 1000, 30000);
    await t.clicarTexto('Continuar');
    assert.equal(servidor.contar(IDENT), 1, 'um tempo fixo não libera a transição');
    assert.equal(servidor.tablet, 'ativo');
  });

  test('[G3-02] cenário B: o servidor encerra e a resposta se perde; o resultado é desconhecido, então a transição também fica barrada', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirIdentificado({ servidor });
    servidor.falhar(ENCERRAR, 'perdida');
    await t.clicarTexto('Sair');
    assert.equal(servidor.atendimentoAberto(), false, 'o servidor de fato encerrou');
    await identificarB(t);
    assert.equal(servidor.contar(IDENT), 1, 'a página não pode saber que encerrou');
    assert.ok(t.textoVisivel().includes(TEXTOS.comunicacao));
  });

  test('[G3-03] o recarregamento descarta a proteção em memória: a sessão deixada aberta é encerrada pelo INICIO e a identificação passa (NÃO é solução comprovada contra resposta tardia)', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirIdentificado({ servidor });
    servidor.falhar(ENCERRAR, 'rede');
    await t.clicarTexto('Sair');
    const recarregada = await H.abrirTotem({ servidor });
    assert.equal(servidor.atendimentoAberto(), false);
    await identificarB(recarregada);
    assert.ok(recarregada.textoVisivel().includes('Olá, Bruno'));
    assert.ok(t);
  });

  test('[G3-04] cenário J: encerramento ainda sem resposta: nenhuma identificação enquanto estiver pendente; a resposta recebida libera', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirIdentificado({ servidor });
    servidor.falhar(ENCERRAR, 'segurar');
    await t.clicarTexto('Sair');
    await identificarB(t);
    assert.equal(servidor.contar(IDENT), 1, 'barrado enquanto o encerramento está pendente');
    servidor.liberarSegurados();
    await t.passar(1000);
    await t.clicarTexto('Limpar');
    await identificarB(t);
    assert.equal(servidor.contar(IDENT), 2, 'com a resposta do encerramento recebida a transição é liberada');
    assert.ok(t.textoVisivel().includes('Olá, Bruno'));
  });

  test('[G3-05] cenário G: encerramento respondido com erro de servidor (resposta recebida) libera a transição e o novo atendimento SUBSTITUI o anterior no servidor', async () => {
    const servidor = H.criarServidor();
    const a = await H.abrirIdentificado({ servidor });
    servidor.falhar(ENCERRAR, 'status', erro500);
    const b = await H.abrirTotem({ servidor });
    assert.equal(servidor.atendimentoAberto(), true, 'o encerramento do INICIO falhou no servidor');
    await identificarB(b);
    assert.ok(b.textoVisivel().includes('Olá, Bruno'));
    assert.equal(servidor.atendimentos[0].encerrado, 'SUBSTITUIDO');
    assert.equal(servidor.atendimentos.length, 2);
    assert.ok(a);
  });

  for (const [rotulo, falha] of [['429', { status: 429, codigo: 'LIMITE_REQUISICOES_EXCEDIDO' }], ['5xx', erro500]]) {
    test(`[G3-06] resposta conclusiva (${rotulo}) do encerramento não bloqueia: a requisição terminou; o encerramento não foi confirmado, e a identificação seguinte substitui o atendimento`, async () => {
      const servidor = H.criarServidor();
      const t = await H.abrirIdentificado({ servidor });
      servidor.falhar(ENCERRAR, 'status', falha);
      await t.clicarTexto('Sair');
      assert.equal(servidor.atendimentoAberto(), true, 'o encerramento não aconteceu');
      await identificarB(t);
      assert.ok(t.textoVisivel().includes('Olá, Bruno'));
      assert.equal(servidor.atendimentos[0].encerrado, 'SUBSTITUIDO');
    });
  }
});

describe('[G3-B] requisições em voo de A: a identificação de B espera e a resposta antiga é descartada', () => {
  test('[G3-10] cenário C: a identificação de A está pendente quando a página reinicia (pageshow); B é barrado, e a resposta tardia de A é descartada, com o atendimento que abriu encerrado', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirTotem({ servidor });
    servidor.falhar(IDENT, 'segurar');
    await t.identificar({ tipo: 'CPF', valor: ANA.cpf });
    await t.eventoDaJanela('pageshow', { persisted: true });
    await t.passar(1000);
    await identificarB(t);
    assert.equal(servidor.contar(IDENT), 1, 'a identificação cancelada na tela continua em voo para o servidor: B espera');
    assert.ok(t.textoVisivel().includes(TEXTOS.comunicacao));
    servidor.liberarSegurados();
    await t.passar(2000);
    assert.deepEqual(t.telaAtual(), ['telaAcesso']);
    assert.deepEqual(dadosDeAna(t), []);
    assert.equal(t.visivel('sessao'), false);
    assert.equal(servidor.atendimentoAberto(), false, 'o atendimento que a resposta tardia abriu foi encerrado');
    await identificarB(t);
    assert.equal(servidor.contar(IDENT), 2);
    assert.ok(t.textoVisivel().includes('Olá, Bruno'));
  });

  test('[G3-11] cenário D: a consulta G de A está em voo; B espera; a resposta de A (200, atendimento ainda aberto) é descartada e nada dela aparece para B', async () => {
    const servidor = H.criarServidor();
    servidor.falhar(G, 'segurar');
    const t = await H.abrirIdentificado({ servidor });
    servidor.falhar(ENCERRAR, 'status', erro500);
    await t.clicarTexto('Sair');
    await identificarB(t);
    assert.equal(servidor.contar(IDENT), 1, 'B espera a consulta de A terminar');
    servidor.solicitacoes = [{ materialId: 11, nome: MARCA, tamanho: '40', situacao: 'DISPONIVEL_PARA_RETIRADA', quantidade: 1 }];
    servidor.liberarSegurados();
    await t.passar(1000);
    assert.deepEqual(t.telaAtual(), ['telaAcesso'], 'a resposta antiga não restaurou a sessão de A');
    assert.deepEqual(dadosDeAna(t), []);
    servidor.solicitacoes = [];
    await identificarB(t);
    assert.ok(t.textoVisivel().includes('Olá, Bruno'));
    assert.deepEqual(dadosDeAna(t), []);
    assert.equal(t.consulta('#listaDisponiveis li').length, 0);
    assert.equal(servidor.atendimentos[0].encerrado, 'SUBSTITUIDO');
  });

  test('[G3-12] cenário E: o catálogo de A está em voo; B espera; a resposta de A (200) é descartada e o catálogo de B não é misturado', async () => {
    const servidor = H.criarServidor();
    servidor.falhar(CATALOGO, 'segurar');
    const t = await H.abrirIdentificado({ servidor });
    servidor.falhar(ENCERRAR, 'status', erro500);
    await t.clicarTexto('Sair');
    await identificarB(t);
    assert.equal(servidor.contar(IDENT), 1);
    servidor.materiais = [{ ...H.CATALOGO[0], id: 99, nome: MARCA }];
    servidor.liberarSegurados();
    await t.passar(1000);
    assert.deepEqual(t.produtos(), []);
    servidor.materiais = H.CATALOGO.map((m) => ({ ...m }));
    await identificarB(t);
    assert.deepEqual(t.produtos(), H.CATALOGO.map((m) => m.nome));
    assert.deepEqual(dadosDeAna(t), []);
  });

  for (const [rotulo, encerrarFalha] of [['401 (o servidor remove o cookie)', false], ['200 (o servidor reemite o cookie do atendimento antigo)', true]]) {
    test(`[G3-13] cenário F: renovação de A tardia, ${rotulo}: B só começa depois de a resposta chegar e a sessão de A não é reativada`, async () => {
      const servidor = H.criarServidor();
      const t = await H.abrirIdentificado({ servidor });
      if (encerrarFalha) servidor.falhar(ENCERRAR, 'status', erro500);
      servidor.falhar(ATIV, 'segurar');
      await t.abrirProduto('Capacete');
      await t.clicarTexto('Sair');
      await identificarB(t);
      assert.equal(servidor.contar(IDENT), 1, 'B espera a renovação de A');
      const marco = servidor.chamadas.length;
      servidor.liberarSegurados();
      await t.passar(1000);
      assert.equal(servidor.atendimentoAberto(), encerrarFalha, 'a resposta tardia foi 200 (A ainda aberto) ou 401 (A fechado)');
      assert.deepEqual(t.telaAtual(), ['telaAcesso']);
      assert.equal(t.visivel('sessao'), false);
      assert.equal(t.texto('quem').trim(), '');
      await identificarB(t);
      const ordem = servidor.chamadas.slice(marco).map((c) => c.chave);
      assert.ok(ordem.indexOf(IDENT) !== -1, 'B se identificou depois da resposta tardia');
      assert.ok(t.textoVisivel().includes('Olá, Bruno'));
      await t.passar(70000, 5000);
      assert.deepEqual(t.telaAtual(), ['telaAcesso'], 'nenhum contador de uma sessão antiga volta a agir');
    });
  }

  for (const abortoReal of [true, false]) {
    const quando = abortoReal ? 'com aborto' : 'abortar NÃO cancela';

    test(`[G3-14] cenário I (${quando}): a sessão expira com a consulta pendente; o tempo limite NÃO libera a transição; resposta tardia não muda nada`, async () => {
      const servidor = H.criarServidor();
      servidor.falhar(CATALOGO, 'segurar');
      const t = await abrir(servidor, abortoReal);
      await t.identificar({ tipo: 'CPF', valor: ANA.cpf });
      await t.passar(61000, 1000);
      assert.deepEqual(t.telaAtual(), ['telaAcesso']);
      assert.ok(t.textoVisivel().includes(TEXTOS.expirada));
      assert.deepEqual(dadosDeAna(t), []);
      await identificarB(t);
      assert.equal(servidor.contar(IDENT), 1, 'sem resposta da consulta: a transição segue barrada, passados mais de 10 s');
      servidor.liberarSegurados();
      await t.passar(2000);
      assert.deepEqual(t.telaAtual(), ['telaAcesso']);
      assert.deepEqual(t.produtos(), []);
      await identificarB(t);
      // Com aborto real o fetch terminou SEM resposta (incerto): só o recarregamento encerra o bloqueio, sem garantia comprovada.
      // Se o aborto não tiver efeito, a resposta que enfim chega é conclusiva e libera.
      assert.equal(servidor.contar(IDENT), abortoReal ? 1 : 2);
    });

    test(`[G3-16] (${quando}) tempo limite de uma consulta G de A, depois da saída: B continua barrado, com ou sem a resposta chegar depois`, async () => {
      const servidor = H.criarServidor();
      servidor.falhar(G, 'segurar');
      const t = await abrir(servidor, abortoReal);
      await t.identificar({ tipo: 'CPF', valor: ANA.cpf });
      await t.clicarTexto('Sair');
      await t.passar(30000, 5000);
      await identificarB(t);
      assert.equal(servidor.contar(IDENT), 1);
      servidor.liberarSegurados();
      await t.passar(2000);
      await identificarB(t);
      assert.equal(servidor.contar(IDENT), abortoReal ? 1 : 2, 'sem resposta (incerto) segue barrado; com a resposta enfim recebida, libera');
    });

    test(`[G3-17] (${quando}) identificação de A sem resposta (tempo esgotado): nenhum atendimento presumido, nenhuma repetição e B barrado`, async () => {
      const servidor = H.criarServidor();
      const t = await abrir(servidor, abortoReal);
      servidor.falhar(IDENT, 'pendente');
      await t.identificar({ tipo: 'CPF', valor: ANA.cpf });
      await t.passar(15000, 1000);
      // Com aborto real o tempo limite vira "sem resposta"; se o aborto não tiver efeito, a página continua esperando (nada presumido).
      if (abortoReal) assert.ok(t.textoVisivel().includes(TEXTOS.comunicacao));
      assert.equal(t.visivel('sessao'), false);
      await identificarB(t);
      assert.equal(servidor.contar(IDENT), 1);
    });
  }

  test('[G3-15] a lista da retirada (em memória) de A não passa para B', async () => {
    const t = await H.abrirNoCatalogo();
    await t.adicionarItem('Capacete');
    assert.equal(t.consulta('#resumo .chip').length, 1);
    await t.clicarTexto('Sair');
    await identificarB(t);
    assert.equal(t.consulta('#resumo .chip').length, 0);
    assert.equal(t.texto('resumo').trim(), '');
  });
});

describe('[G3-C] perda de autorização durante o atendimento (cenários E e H)', () => {
  for (const [rota, rotulo] of [[G, 'a consulta G'], [CATALOGO, 'o catálogo']]) {
    test(`[G3-20] 401 de atendimento em ${rotulo} (o servidor remove o cookie): limpeza imediata e aviso de sessão encerrada`, async () => {
      const servidor = H.criarServidor();
      servidor.falhar(rota, 'status', { status: 401, codigo: 'ATENDIMENTO_INVALIDO' });
      const t = await H.abrirIdentificado({ servidor });
      assert.deepEqual(t.telaAtual(), ['telaAcesso']);
      assert.ok(t.textoVisivel().includes(TEXTOS.expirada));
      assert.deepEqual(dadosDeAna(t), []);
      assert.equal(t.visivel('sessao'), false);
    });

    test(`[G3-21] 403 em ${rotulo}: tela de rede, dados limpos, o tablet não é tocado`, async () => {
      const servidor = H.criarServidor();
      servidor.falhar(rota, 'status', { status: 403, codigo: 'REDE_NAO_AUTORIZADA' });
      const t = await H.abrirIdentificado({ servidor });
      assert.deepEqual(t.telaAtual(), ['telaRede']);
      assert.deepEqual(dadosDeAna(t), []);
      assert.equal(t.cookiesEscritos.length, 0);
      assert.equal(servidor.tablet, 'ativo');
    });

    test(`[G3-22] 401 do dispositivo em ${rotulo}: tela de não autorizado, dados limpos`, async () => {
      const servidor = H.criarServidor();
      servidor.falhar(rota, 'status', { status: 401, codigo: 'DISPOSITIVO_NAO_AUTORIZADO' });
      const t = await H.abrirIdentificado({ servidor });
      assert.deepEqual(t.telaAtual(), ['telaNaoAutorizado']);
      assert.deepEqual(dadosDeAna(t), []);
    });
  }

  test('[G3-23] depois de uma perda de autorização o contador antigo e a renovação não agem mais', async () => {
    const servidor = H.criarServidor();
    servidor.falhar(CATALOGO, 'status', { status: 401, codigo: 'ATENDIMENTO_INVALIDO' });
    const t = await H.abrirIdentificado({ servidor });
    const antes = servidor.chamadas.length;
    await t.passar(120000, 5000);
    assert.equal(servidor.chamadas.length, antes);
    assert.equal(servidor.atividades, 0);
  });
});

describe('[G3-D] consulta G e catálogo E: o que a tela mostra e o que não pede', () => {
  test('[G3-30] consulta e catálogo são GET sem parâmetros, depois da identificação, uma vez cada, e não renovam a sessão', async () => {
    const servidor = H.criarServidor({ solicitacoes: [{ materialId: 13, nome: 'Camiseta', tamanho: 'M', situacao: 'AGUARDANDO_APROVACAO', quantidade: 1 }] });
    await H.abrirIdentificado({ servidor });
    assert.equal(servidor.contar(G), 1);
    assert.equal(servidor.contar(CATALOGO), 1);
    assert.equal(servidor.atividades, 0);
    assert.deepEqual(servidor.violacoes, []);
    for (const c of [...servidor.chamadasDe(G), ...servidor.chamadasDe(CATALOGO)]) assert.equal(c.corpo, null);
  });

  test('[G3-31] a consulta G com falha de comunicação mostra o texto próprio e não segue com o catálogo', async () => {
    const servidor = H.criarServidor();
    servidor.falhar(G, 'rede');
    const t = await H.abrirIdentificado({ servidor });
    assert.ok(t.textoVisivel().includes(TEXTOS.comunicacao));
    assert.equal(servidor.contar(CATALOGO), 0);
    assert.deepEqual(t.produtos(), []);
  });

  test('[G3-32] itens fora do contrato (id inválido, nome vazio, situação desconhecida) não aparecem', async () => {
    const solicitacoes = [
      { materialId: 'x', nome: 'Invalido', tamanho: null, situacao: 'AGUARDANDO_APROVACAO', quantidade: 1 },
      { materialId: 13, nome: '', tamanho: null, situacao: 'AGUARDANDO_APROVACAO', quantidade: 1 },
      { materialId: 14, nome: 'Situacao Estranha', tamanho: null, situacao: 'OUTRA', quantidade: 1 },
    ];
    const t = await H.abrirIdentificado({ servidor: H.criarServidor({ solicitacoes }) });
    assert.deepEqual(t.telaAtual(), ['telaProdutos']);
    assert.ok(!t.textoDoDom().includes('Invalido'));
    assert.ok(!t.textoDoDom().includes('Situacao Estranha'));
  });

  test('[G3-33] materiais fora do contrato do catálogo (sem id, nome vazio, tamanho obrigatório sem tamanhos válidos) não viram opção', async () => {
    const materiais = [
      { ...H.CATALOGO[1], id: 0, nome: 'Sem Id' },
      { ...H.CATALOGO[1], id: 5, nome: '   ' },
      { ...H.CATALOGO[0], id: 6, nome: 'Tamanho Estranho', tamanhos: [1, 2] },
      H.CATALOGO[3],
    ];
    const t = await H.abrirIdentificado({ servidor: H.criarServidor({ materiais }) });
    assert.deepEqual(t.produtos(), ['Capacete']);
  });

  test('[G3-34] a imagem "disponível" que o contrato futuro poderia trazer nunca vira <img> nem requisição externa; o placeholder segue', async () => {
    const materiais = H.CATALOGO.map((m) => ({ ...m, imagem: { disponivel: true, url: 'https://externo.invalido/x.png' } }));
    const t = await H.abrirIdentificado({ servidor: H.criarServidor({ materiais }) });
    assert.equal(t.consulta('img').length, 0);
    assert.deepEqual(t.externas, []);
    assert.equal(t.consulta('#grade .vazio').length, H.CATALOGO.length);
  });
});

describe('[G3-E] renovação: política e limites verificáveis', () => {
  test('[G3-40] ações explícitas (toque em produto, tamanho, voltar) renovam; digitar na identificação, mover e rolar não', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirTotem({ servidor });
    await t.escolherTipo('CPF');
    await t.digitar('5299');
    await t.passar(5000);
    assert.equal(servidor.atividades, 0);
    await t.clicarTexto('Limpar');
    await t.identificar({ tipo: 'CPF', valor: ANA.cpf });
    await t.abrirProduto('Botina de Segurança');
    await t.passar(1500);
    assert.ok(servidor.atividades >= 1);
  });

  test('[G3-41] a renovação seguinte a uma rajada sai até 1 s depois da última ação e a sessão acaba no máximo 1 s depois dos 60 s ociosos', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirNoCatalogo({ servidor });
    await t.abrirProduto('Capacete');
    await t.clicarTexto('Voltar aos produtos');
    await t.passar(1500);
    assert.equal(servidor.contar(ATIV), 2, 'uma imediata e uma de fechamento da rajada');
    assert.ok(servidor.restanteMs() <= 60000 && servidor.restanteMs() > 58000);
    await t.passar(61000, 1000);
    assert.deepEqual(t.telaAtual(), ['telaAcesso']);
  });

  test('[G3-42] 429 na renovação não é confirmação: sem nova tentativa durante o Retry-After, mesmo com ações', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirNoCatalogo({ servidor });
    servidor.falhar(ATIV, '429', { retryAfter: 20, vezes: 1 });
    await t.abrirProduto('Capacete');
    await t.passar(1000);
    for (let i = 0; i < 5; i += 1) { await t.clicarTexto('Voltar aos produtos'); await t.abrirProduto('Capacete'); await t.passar(1000); }
    assert.equal(servidor.contar(ATIV), 1, 'durante o Retry-After nenhuma tentativa');
    await t.passar(20000, 1000);
    await t.clicarTexto('Voltar aos produtos');
    assert.ok(servidor.contar(ATIV) >= 2);
  });

  test('[G3-43] o vencimento local parte do instante de ENVIO: com resposta demorada o contador nunca passa do horário do servidor', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirTotem({ servidor });
    servidor.falhar(IDENT, 'segurar');
    await t.identificar({ tipo: 'CPF', valor: ANA.cpf });
    await t.passar(4000, 1000);
    servidor.liberarSegurados();
    await t.passar(500);
    const c = t.segundosNoContador();
    assert.ok(c <= 56, `contagem ${c}: deveria descontar os 4 s de espera (60 − 4)`);
  });

  test('[G3-44] uma renovação pendente que a sessão não espera mais não é reenviada nem reativa o atendimento (fechamento de rajada só nasce de ação)', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirNoCatalogo({ servidor });
    await t.abrirProduto('Capacete');
    await t.clicarTexto('Voltar aos produtos');
    await t.clicarTexto('Sair');
    await t.passar(5000, 500);
    assert.equal(servidor.contar(ATIV), 1, 'só a renovação imediata; a de fechamento de rajada morreu com a sessão');
  });
});
