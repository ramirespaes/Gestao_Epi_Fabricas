'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers/totem-i');

/**
 * Etapa I (RED) — Q1: ativação do tablet por QR HTTPS com o código no FRAGMENTO da URL.
 * Contrato (I-GOVERNANCA-Q0-Q8, Parte 1): `boot.js` é o primeiro recurso do <head>; lê o fragmento e o remove com
 * history.replaceState ANTES de qualquer rede; o código fica só em memória; o consumo é por toque explícito no endpoint
 * homologado da Etapa C (POST /atendimento-token/tablet/ativar); descarte após uso, erro definitivo ou expiração local.
 * A exceção à baseline H (conteudoQr da Central) é testada aqui apenas no módulo existente, sem modificá-lo.
 */

const T = require('../js/atendimento-token');

const ATIVAR = `POST ${H.BASE}/ativar`;
const novo = (estadoDoCodigo = 'valido', tablet = 'nao_autorizado') => {
  const codigo = H.novoToken();
  return { codigo, servidor: H.criarServidor({ tablet, codigos: { [codigo]: estadoDoCodigo } }) };
};
const abrirComFragmento = (codigo, servidor) => H.abrirTotem({ servidor, hash: `#ativar=${codigo}` });

describe('[Q1] boot.js e recursos da página (estático)', () => {
  test('[Q1-01] o script de inicialização é o primeiro do <head>, local e síncrono; nada externo vem antes dele', () => {
    const { html } = H.corpus();
    const head = /<head[^>]*>([\s\S]*?)<\/head>/i.exec(html)?.[1] ?? '';
    const tags = [...head.matchAll(/<(script|link)\b([^>]*)>/gi)].map((m) => ({ tag: m[1].toLowerCase(), attrs: m[2] }));
    const primeiroScript = tags.findIndex((x) => x.tag === 'script');
    assert.notEqual(primeiroScript, -1, 'o <head> não tem script');
    // P5: o nome do arquivo é livre; precisa ser um arquivo local (relativo), nunca um endereço externo nem script embutido.
    assert.match(tags[primeiroScript].attrs, /\bsrc="(?![a-z][a-z0-9+.-]*:|\/\/)[^"]+"/i, 'o primeiro script do <head> precisa ser um arquivo local');
    assert.ok(!/\b(async|defer)\b|type="module"/i.test(tags[primeiroScript].attrs), 'o boot.js precisa ser síncrono e clássico');
    for (const antes of tags.slice(0, primeiroScript)) assert.ok(!/(?:src|href)="(?:https?:)?\/\//i.test(antes.attrs), `recurso externo antes do boot.js: ${antes.attrs}`);
  });

  test('[Q1-02] a página não carrega nenhum recurso externo (script, folha, fonte, imagem)', () => {
    const { html, css } = H.corpus();
    const externos = [...html.matchAll(/\b(?:src|href)="((?:https?:)?\/\/[^"]+)"/gi)].map((m) => m[1]);
    assert.deepEqual(externos.filter((u) => !/^https?:\/\/www\.w3\.org\//.test(u)), []);
    assert.ok(!/@import\s+(?:url\()?["']?(?:https?:)?\/\//i.test(`${css}\n${html}`));
    assert.ok(!/url\(\s*["']?(?:https?:)?\/\//i.test(`${css}\n${html}`));
  });

  test('[Q1-03] a página não envia o endereço a terceiros (referrer: no-referrer)', () => {
    assert.match(H.corpus().html, /<meta[^>]+name="referrer"[^>]+content="no-referrer"|<meta[^>]+content="no-referrer"[^>]+name="referrer"/i);
  });

  test('[Q1-04] boot.js só lê o fragmento e o remove: sem rede, sem armazenamento, sem log, sem global com o código', () => {
    const { boot } = H.corpus();
    const codigo = boot.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.match(codigo, /replaceState/);
    for (const proibido of [/\bfetch\b/, /XMLHttpRequest/, /localStorage/, /sessionStorage/, /indexedDB/, /document\.cookie/, /window\.name/, /pushState/, /console\./, /\.hash\s*=[^=]/]) {
      assert.ok(!proibido.test(codigo), `boot.js não pode usar ${proibido}`);
    }
  });
});

describe('[Q1] leitura e remoção do fragmento', () => {
  test('[Q1-10] o fragmento válido é removido da URL com replaceState ANTES de qualquer requisição', async () => {
    const { codigo, servidor } = novo();
    const t = await abrirComFragmento(codigo, servidor);
    const iReplace = t.eventos.findIndex((e) => e.tipo === 'replaceState');
    const iFetch = t.eventos.findIndex((e) => e.tipo === 'fetch');
    assert.notEqual(iReplace, -1, 'o fragmento não foi removido com history.replaceState');
    assert.ok(iFetch === -1 || iReplace < iFetch, 'o fragmento precisa sair da URL antes da primeira requisição');
    assert.equal(t.location.hash, '');
    assert.ok(t.historico.filter((h) => h.metodo === 'replaceState').every((h) => !String(h.url).includes('ativar') && !String(h.url).includes(codigo)));
    assert.equal(t.historico.filter((h) => h.metodo === 'pushState').length, 0, 'sem entradas novas no histórico');
  });

  for (const [rotulo, fragmento] of [['curto', '#ativar=curto'], ['com sobra', `#ativar=${H.novoToken()}XX`], ['outra chave', `#codigo=${H.novoToken()}`], ['caracteres inválidos', '#ativar=@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@']]) {
    test(`[Q1-11] fragmento inválido (${rotulo}) também é removido, não é enviado ao servidor e vira falha de código`, async () => {
      const servidor = H.criarServidor({ tablet: 'nao_autorizado' });
      const t = await H.abrirTotem({ servidor, hash: fragmento });
      assert.equal(t.location.hash, '');
      assert.equal(servidor.contar(ATIVAR), 0);
      const b = t.botao(H.TEXTOS.ativacaoBotao);
      if (b) await t.clicarEl(b);
      assert.equal(servidor.contar(ATIVAR), 0, 'um fragmento inválido nunca é enviado');
      assert.ok(t.textoVisivel().includes(H.TEXTOS.ativacaoFalha));
    });
  }
});

describe('[Q1] consumo somente por ação explícita', () => {
  test('[Q1-12] com o fragmento, a tela de ativação aparece e NADA é consumido antes do toque', async () => {
    const { codigo, servidor } = novo();
    const t = await abrirComFragmento(codigo, servidor);
    assert.ok(t.telaAtual().includes('telaAtivacao'), JSON.stringify(t.telaAtual()));
    const texto = t.textoVisivel();
    assert.ok(texto.includes(H.TEXTOS.ativacaoTitulo));
    assert.ok(texto.includes(H.TEXTOS.ativacaoCorpo));
    assert.ok(t.botao(H.TEXTOS.ativacaoBotao));
    await t.passar(30000);
    assert.equal(servidor.contar(ATIVAR), 0);
    assert.equal(servidor.codigos.get(codigo), 'valido');
  });

  test('[Q1-13] o toque envia UM POST ao endpoint homologado, só com { codigo }, com credenciais, e leva à identificação', async () => {
    const { codigo, servidor } = novo();
    const t = await abrirComFragmento(codigo, servidor);
    await t.clicarTexto(H.TEXTOS.ativacaoBotao);
    const chamadas = servidor.chamadasDe(ATIVAR);
    assert.equal(chamadas.length, 1);
    assert.deepEqual(H.plano(chamadas[0].corpo), { codigo });
    assert.equal(chamadas[0].credentials, 'include');
    assert.equal(servidor.tablet, 'ativo');
    assert.deepEqual(t.telaAtual(), ['telaAcesso']);
    assert.deepEqual(servidor.violacoes, []);
  });

  test('[Q1-14] o código nunca aparece em armazenamento, console, histórico, URL, cookies, DOM nem em globais — antes e depois do toque', async () => {
    const { codigo, servidor } = novo();
    const t = await abrirComFragmento(codigo, servidor);
    assert.deepEqual(H.vazamentos(t, { codigo }), []);
    await t.clicarTexto(H.TEXTOS.ativacaoBotao);
    assert.deepEqual(H.vazamentos(t, { codigo }), []);
    const globais = Object.entries(t.janela).filter(([, v]) => typeof v === 'string' && v.includes(codigo)).map(([k]) => k);
    assert.deepEqual(globais, [], 'nenhuma propriedade global guarda o código');
    assert.equal(t.storage.length, 0, 'nenhum acesso a storage, cookie ou indexedDB');
  });
});

describe('[Q1] descarte do segredo e tratamento de erros', () => {
  test('[Q1-15] depois do consumo o código não é reutilizável: recarregar a página não o recupera nem reenvia', async () => {
    const { codigo, servidor } = novo();
    const t = await abrirComFragmento(codigo, servidor);
    await t.clicarTexto(H.TEXTOS.ativacaoBotao);
    const recarregada = await H.abrirTotem({ servidor });
    assert.equal(servidor.contar(ATIVAR), 1);
    assert.deepEqual(recarregada.telaAtual(), ['telaAcesso']);
  });

  for (const estado of ['usado', 'expirado', 'revogado', 'inexistente']) {
    test(`[Q1-16] código ${estado}: mensagem única, sem revelar a causa, e o código é descartado (nenhum segundo envio)`, async () => {
      const codigo = H.novoToken();
      const servidor = H.criarServidor({ tablet: 'nao_autorizado', codigos: estado === 'inexistente' ? {} : { [codigo]: estado } });
      const t = await abrirComFragmento(codigo, servidor);
      await t.clicarTexto(H.TEXTOS.ativacaoBotao);
      const texto = t.textoVisivel();
      assert.ok(texto.includes(H.TEXTOS.ativacaoFalha), texto);
      // O texto aprovado ("Código inválido ou expirado.") é o mesmo para todas as causas; só ele é retirado da busca pela causa.
      const semOAprovado = texto.replace(H.TEXTOS.ativacaoFalha, '');
      for (const causa of ['usado', 'expirado', 'revogado', 'inexistente']) assert.ok(!semOAprovado.toLowerCase().includes(causa), `não pode revelar a causa: ${causa}`);
      assert.ok(!texto.includes(H.SENTINELA), 'nunca a mensagem do servidor');
      const b = t.botao(H.TEXTOS.ativacaoBotao);
      if (b) await t.clicarEl(b);
      assert.equal(servidor.contar(ATIVAR), 1, 'erro definitivo: o código foi descartado');
      assert.deepEqual(H.vazamentos(t, { codigo }), []);
    });
  }

  test('[Q1-17] rede não autorizada (403): o código não foi consumido, a tela diz que o tablet está fora da rede e o código é descartado', async () => {
    const { codigo, servidor } = novo('valido', 'rede');
    const t = await abrirComFragmento(codigo, servidor);
    const inicial = t.textoVisivel();
    if (!t.botao(H.TEXTOS.ativacaoBotao)) assert.ok(inicial.includes(H.TEXTOS.foraDaRede), 'sem botão, a tela de rede já deve estar visível');
    else {
      await t.clicarTexto(H.TEXTOS.ativacaoBotao);
      assert.ok(t.textoVisivel().includes(H.TEXTOS.foraDaRede));
    }
    assert.equal(servidor.codigos.get(codigo), 'valido', 'o servidor não consumiu');
    const b = t.botao(H.TEXTOS.ativacaoBotao);
    if (b) await t.clicarEl(b);
    assert.ok(servidor.contar(ATIVAR) <= 1, 'a referência ao código é descartada; o QR é lido de novo');
    assert.deepEqual(H.vazamentos(t, { codigo }), []);
  });

  test('[Q1-18] falha de comunicação não é erro definitivo: o código é mantido e a nova tentativa reenvia o MESMO código', async () => {
    const { codigo, servidor } = novo();
    const t = await abrirComFragmento(codigo, servidor);
    servidor.falhar(ATIVAR, 'rede');
    await t.clicarTexto(H.TEXTOS.ativacaoBotao);
    assert.ok(t.textoVisivel().includes(H.TEXTOS.comunicacao));
    await t.clicarTexto(H.TEXTOS.ativacaoBotao);
    const chamadas = servidor.chamadasDe(ATIVAR);
    assert.equal(chamadas.length, 2);
    assert.equal(chamadas[1].corpo.codigo, codigo);
    assert.equal(servidor.tablet, 'ativo');
  });

  test('[Q1-19] depois de 10 minutos a página não envia mais o código (limite local; o prazo real é do servidor)', async () => {
    const { codigo, servidor } = novo();
    const t = await abrirComFragmento(codigo, servidor);
    await t.passar(10 * 60 * 1000 + 1000, 60000);
    const b = t.botao(H.TEXTOS.ativacaoBotao);
    if (b) await t.clicarEl(b);
    assert.equal(servidor.contar(ATIVAR), 0);
    assert.deepEqual(H.vazamentos(t, { codigo }), []);
  });

  test('[Q1-20] reativação: tablet já ativado que abre um novo QR mostra a ativação (não pula para a identificação) e usa o mesmo endpoint', async () => {
    const { codigo, servidor } = novo('valido', 'ativo');
    const t = await abrirComFragmento(codigo, servidor);
    assert.ok(t.telaAtual().includes('telaAtivacao'), JSON.stringify(t.telaAtual()));
    await t.clicarTexto(H.TEXTOS.ativacaoBotao);
    assert.equal(servidor.reativacoes, 1);
    assert.deepEqual(t.telaAtual(), ['telaAcesso']);
  });
});

describe('[Q1] dispositivo revogado e rede não autorizada ao abrir (sem fragmento)', () => {
  test('[Q1-21] tablet sem credencial válida (nunca ativado OU revogado: o backend não distingue): tela única, sem botão de ativar, sem chamada de ativação', async () => {
    const servidor = H.criarServidor({ tablet: 'nao_autorizado' });
    const t = await H.abrirTotem({ servidor });
    assert.deepEqual(t.telaAtual(), ['telaNaoAutorizado']);
    assert.ok(t.textoVisivel().includes(H.TEXTOS.naoAutorizado));
    assert.equal(t.botao(H.TEXTOS.ativacaoBotao), null);
    assert.equal(servidor.contar(ATIVAR), 0);
    assert.ok(!t.textoVisivel().includes(H.SENTINELA));
  });

  test('[Q1-22] rede não autorizada ao abrir: tela própria, sem expor mais nada', async () => {
    const servidor = H.criarServidor({ tablet: 'rede' });
    const t = await H.abrirTotem({ servidor });
    assert.deepEqual(t.telaAtual(), ['telaRede']);
    assert.ok(t.textoVisivel().includes(H.TEXTOS.foraDaRede));
    assert.equal(t.botao(H.TEXTOS.ativacaoBotao), null);
  });
});

describe('[Q1] QR da Central: URL HTTPS com o código no fragmento (exceção específica e controlada à baseline H)', () => {
  const ORIGEM = 'https://app.safeworkengenharia.com.br';
  const comOrigem = (fn) => {
    const anterior = Object.getOwnPropertyDescriptor(globalThis, 'location');
    Object.defineProperty(globalThis, 'location', { value: { origin: ORIGEM, protocol: 'https:', host: 'app.safeworkengenharia.com.br', hostname: 'app.safeworkengenharia.com.br' }, configurable: true, writable: true });
    try { return fn(); } finally { if (anterior) Object.defineProperty(globalThis, 'location', anterior); else delete globalThis.location; }
  };

  test('[Q1-30] conteudoQr(codigo) devolve https://<origem>/totem/#ativar=<codigo> (hoje devolve só o código)', () => {
    const codigo = H.novoToken();
    assert.equal(comOrigem(() => T.ativacao.conteudoQr(codigo)), `${ORIGEM}/totem/#ativar=${codigo}`);
  });

  test('[Q1-31] a URL do QR é HTTPS, tem o código só no fragmento (nunca na query ou no caminho) e cabe com folga no QR', () => {
    const codigo = H.novoToken();
    const url = comOrigem(() => T.ativacao.conteudoQr(codigo));
    assert.match(url, /^https:\/\/[^/#?]+\/totem\/#ativar=[A-Za-z0-9_-]{43}$/);
    assert.equal(url.split('#')[0].includes(codigo), false);
    assert.ok(url.length <= 120, `a URL tem ${url.length} caracteres`);
  });

  test('[Q1-32] o código segue sem ser escrito na página da Central nem em storage (contrato da H preservado)', () => {
    const codigo = H.novoToken();
    const antes = JSON.stringify(Object.keys(globalThis).sort());
    comOrigem(() => T.ativacao.conteudoQr(codigo));
    assert.equal(JSON.stringify(Object.keys(globalThis).sort()), antes);
  });
});
