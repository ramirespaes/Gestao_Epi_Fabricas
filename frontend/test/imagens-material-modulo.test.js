'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers/imagens-material');
const EpiHttp = require('../js/api-http');

/**
 * Unidade 5B-1 (RED) — contrato do módulo NOVO js/imagens-material.js (EpiImagensMaterial): a única fonte dos caminhos da Biblioteca Padrão no
 * navegador, a URL da miniatura, a tradução das falhas da listagem e as proibições de segurança do código. Ele ainda não existe: cada teste abaixo
 * falha com "comportamento ausente" e passa a valer na 5B-2. Funções puras e transporte pelo EpiHttp com `fetch` simulado, sem DOM, sem PostgreSQL
 * e sem a API 3300. O comportamento na tela é testado em imagens-material-pagina.test.js. Persistência (POST/PATCH com `imagem`) fica para a 5B-3.
 */

const BASE = 'http://localhost:3000/api';
const modulo = () => {
  H.exigirModulo('módulo da seleção de imagens da Biblioteca Padrão');
  return require('../js/imagens-material'); // eslint-disable-line global-require
};
const imagem = { origem: 'PADRAO', id: '1001', versao: 1 };
const resposta = (status, corpo) => ({ status, ok: status >= 200 && status < 300, text: async () => (corpo === undefined ? '' : JSON.stringify(corpo)) });

// ─────────────────────────────────────────────────────────────────────
describe('5B — módulo js/imagens-material.js: existência e forma', () => {
  test('o arquivo existe, carrega no Node sem DOM e se expõe como EpiImagensMaterial (global e module.exports)', () => {
    const m = modulo();
    assert.equal(typeof m, 'object');
    assert.equal(globalThis.EpiImagensMaterial, m);
    for (const parte of ['caminhos', 'urlMiniatura', 'acoes', 'mensagens']) assert.ok(parte in m, `falta EpiImagensMaterial.${parte}`);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('5B — módulo: caminhos e URL da miniatura (única fonte)', () => {
  test('a listagem é GET /imagens-material?origem=PADRAO&pagina=1&limite=100 (as 30 imagens cabem numa página)', () => {
    assert.equal(modulo().caminhos.lista(), '/imagens-material?origem=PADRAO&pagina=1&limite=100');
  });

  test('a miniatura é /imagens-material/padrao/<id>/miniatura?v=<versão>, com o id BIGINT sempre como texto', () => {
    const { caminhos } = modulo();
    assert.equal(caminhos.miniatura(imagem), '/imagens-material/padrao/1001/miniatura?v=1');
    assert.equal(caminhos.miniatura({ origem: 'PADRAO', id: H.ID_GRANDE, versao: 3 }), `/imagens-material/padrao/${H.ID_GRANDE}/miniatura?v=3`);
    assert.equal(caminhos.miniatura({ origem: 'PADRAO', id: '1002', versao: 2147483647 }), '/imagens-material/padrao/1002/miniatura?v=2147483647');
  });

  test('id, versão ou origem fora do formato é TypeError antes de montar qualquer endereço', () => {
    const { caminhos } = modulo();
    for (const id of ['', '0', '01', '-1', '1.5', '1/2', '../1', '1?x=1', ' 1', '1 ', 'abc', 1001, null, undefined, {}]) {
      assert.throws(() => caminhos.miniatura({ origem: 'PADRAO', id, versao: 1 }), TypeError, `id ${JSON.stringify(id)}`);
    }
    for (const versao of [0, -1, 1.5, '1', null, undefined, Number.NaN, Infinity, 2147483648, 2 ** 53]) {
      assert.throws(() => caminhos.miniatura({ origem: 'PADRAO', id: '1001', versao }), TypeError, `versão ${String(versao)}`);
    }
    for (const origem of [undefined, null, '', 'OUTRA', 123]) {
      assert.throws(() => caminhos.miniatura({ origem, id: '1001', versao: 1 }), TypeError, `origem ${String(origem)}`);
    }
    assert.throws(() => caminhos.miniatura(null), TypeError);
  });

  test('urlMiniatura junta a base da API ao caminho sem barra duplicada', () => {
    const { urlMiniatura } = modulo();
    assert.equal(urlMiniatura(imagem, BASE), `${BASE}/imagens-material/padrao/1001/miniatura?v=1`);
    assert.equal(urlMiniatura(imagem, `${BASE}/`), `${BASE}/imagens-material/padrao/1001/miniatura?v=1`);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('5B — módulo: listagem pelo transporte EpiHttp', () => {
  test('acoes.listarPadrao faz um único GET com cookie de sessão e devolve o envelope do EpiHttp', async () => {
    const chamadas = [];
    EpiHttp.configurar({
      baseUrl: BASE,
      fetch: async (url, opcoes) => {
        chamadas.push({ url, opcoes });
        return resposta(200, { status: 'ok', imagens: H.imagensPadrao(), total: 30, pagina: 1, limite: 100 });
      },
    });
    const r = await modulo().acoes.listarPadrao();
    assert.equal(chamadas.length, 1);
    assert.equal(chamadas[0].url, `${BASE}/imagens-material?origem=PADRAO&pagina=1&limite=100`);
    assert.equal(chamadas[0].opcoes.method, 'GET');
    assert.equal(chamadas[0].opcoes.credentials, 'include');
    assert.equal(chamadas[0].opcoes.body, undefined);
    assert.equal(r.ok, true);
    assert.equal(r.dados.imagens.length, 30);
    assert.equal(r.dados.imagens[29].id, H.ID_GRANDE, 'o id grande chega como texto, sem passar por Number');
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('5B — módulo: mensagens das falhas da listagem (texto próprio, nunca o do servidor)', () => {
  const envelope = (fetchFalso) => {
    EpiHttp.configurar({ baseUrl: BASE, fetch: fetchFalso });
    return EpiHttp.requisitar('GET', '/imagens-material?origem=PADRAO&pagina=1&limite=100');
  };
  const api = (status, codigo) => async () => resposta(status, { status: 'error', codigo, message: H.TEXTO_DO_SERVIDOR });
  const casos = [
    ['sessão encerrada (401)', api(401, 'NAO_AUTENTICADO'), /sess/i],
    ['sem permissão (403)', api(403, 'SEM_PERMISSAO'), /permiss/i],
    ['armazenamento de imagens indisponível (503)', api(503, 'IMAGENS_INDISPONIVEL'), /indispon/i],
    ['falha de rede', async () => { throw new TypeError('Failed to fetch'); }, /rede|conex/i],
    ['erro interno (500)', api(500, 'ERRO_INTERNO'), /n[ãa]o foi poss[íi]vel|tente novamente/i],
    ['resposta que não é JSON (502 de proxy)', async () => ({ status: 502, ok: false, text: async () => '<html>Bad Gateway</html>' }), /n[ãa]o foi poss[íi]vel|tente novamente/i],
  ];
  for (const [nome, fetchFalso, esperado] of casos) {
    test(`mensagens.deLista — ${nome}`, async () => {
      const texto = modulo().mensagens.deLista(await envelope(fetchFalso));
      assert.equal(typeof texto, 'string');
      assert.match(texto, esperado);
      assert.equal(texto.includes(H.TEXTO_DO_SERVIDOR), false, 'o texto do servidor não pode aparecer');
      assert.equal(/SQL|relation|imagens_padrao/i.test(texto), false);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────
describe('5B — módulo: proibições de segurança do código', () => {
  test('não monta HTML por texto nem executa código dinâmico: sem innerHTML, outerHTML, insertAdjacentHTML, document.write, eval ou new Function', () => {
    H.exigirModulo('verificação do código-fonte');
    const codigo = H.lerModuloSemComentarios();
    for (const padrao of H.PROIBIDOS_DE_DOM) assert.equal(padrao.test(codigo), false, `o módulo usa ${padrao}`);
  });

  test('não guarda nada no navegador: sem localStorage, sessionStorage, document.cookie ou indexedDB', () => {
    H.exigirModulo('verificação do código-fonte');
    const codigo = H.lerModuloSemComentarios();
    for (const padrao of H.PROIBIDOS_DE_ARMAZENAMENTO) assert.equal(padrao.test(codigo), false, `o módulo usa ${padrao}`);
  });

  test('fala com a API só pelo transporte do projeto (EpiHttp): sem fetch, XMLHttpRequest ou sendBeacon próprios', () => {
    H.exigirModulo('verificação do código-fonte');
    const codigo = H.lerModuloSemComentarios();
    for (const padrao of H.PROIBIDOS_DE_TRANSPORTE) assert.equal(padrao.test(codigo), false, `o módulo usa ${padrao}`);
    assert.match(codigo, /EpiHttp/);
  });
});
