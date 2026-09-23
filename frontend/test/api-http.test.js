'use strict';

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const EpiHttp = require('../js/api-http');

/**
 * Testes do cliente HTTP real do frontend (Bloco 8, Incremento 8, Etapa
 * 5A, Subetapa 3R), com `fetch` injetado — sem rede e sem navegador.
 *
 * O contrato ponta a ponta contra o backend de verdade (login real,
 * cookie de sessão, 401/403 reais) é exercitado em
 * backend/test/integracao/frontend-cliente-http.integration.js, com
 * PostgreSQL real. Aqui se prova o que é responsabilidade exclusiva
 * desta camada: montagem da requisição, normalização da resposta e as
 * recusas que acontecem ANTES de qualquer rede.
 */

const BASE = 'http://localhost:3000/api';

/** Registra as chamadas e devolve a resposta programada. */
function fetchFalso(respostas) {
  const chamadas = [];
  const fila = Array.isArray(respostas) ? respostas.slice() : [respostas];
  const fn = async (url, opcoes) => {
    chamadas.push({ url, opcoes });
    const proxima = fila.length > 1 ? fila.shift() : fila[0];
    if (proxima instanceof Error) throw proxima;
    return proxima;
  };
  fn.chamadas = chamadas;
  return fn;
}

/**
 * @param {{texto?: string, erroNaLeitura?: Error}} opcoes `erroNaLeitura`
 *   simula a conexão caindo DURANTE a leitura do corpo: o servidor já
 *   respondeu (há status), mas `resposta.text()` rejeita.
 */
const resposta = (status, corpo, { texto, erroNaLeitura } = {}) => ({
  status,
  ok: status >= 200 && status < 300,
  text: async () => {
    if (erroNaLeitura) throw erroNaLeitura;
    return texto !== undefined ? texto : (corpo === undefined ? '' : JSON.stringify(corpo));
  },
});

beforeEach(() => {
  EpiHttp.configurar({ baseUrl: BASE, fetch: null });
});

describe('montagem da requisição', () => {
  test('anexa credentials:include em toda requisição — é o que faz o cookie de sessão viajar', async () => {
    const fetch = fetchFalso(resposta(200, { status: 'ok' }));
    EpiHttp.configurar({ fetch });

    await EpiHttp.requisitar('GET', '/grupos-acesso');
    await EpiHttp.requisitar('POST', '/grupos-acesso', { corpo: { nome: 'Almoxarifado' } });

    assert.equal(fetch.chamadas.length, 2);
    for (const chamada of fetch.chamadas) {
      assert.equal(chamada.opcoes.credentials, 'include');
    }
  });

  test('monta a URL a partir da baseUrl e envia o corpo como JSON com Content-Type', async () => {
    const fetch = fetchFalso(resposta(201, { status: 'ok', grupo: { id: 7 } }));
    EpiHttp.configurar({ fetch });

    await EpiHttp.requisitar('POST', '/grupos-acesso', { corpo: { nome: 'Gerência', descricao: null } });

    const [chamada] = fetch.chamadas;
    assert.equal(chamada.url, `${BASE}/grupos-acesso`);
    assert.equal(chamada.opcoes.method, 'POST');
    assert.equal(chamada.opcoes.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(chamada.opcoes.body), { nome: 'Gerência', descricao: null });
  });

  test('GET e DELETE sem corpo não enviam body nem Content-Type', async () => {
    const fetch = fetchFalso(resposta(200, { status: 'ok' }));
    EpiHttp.configurar({ fetch });

    await EpiHttp.requisitar('GET', '/grupos-acesso');
    await EpiHttp.requisitar('DELETE', '/usuarios/9/grupo-acesso');

    for (const chamada of fetch.chamadas) {
      assert.equal(chamada.opcoes.body, undefined);
      assert.deepEqual(chamada.opcoes.headers, {});
    }
  });

  test('NÃO tenta definir Origin: o navegador o envia sozinho, e é isso que dá valor à proteção CSRF do backend', async () => {
    const fetch = fetchFalso(resposta(200, { status: 'ok' }));
    EpiHttp.configurar({ fetch });

    await EpiHttp.requisitar('POST', '/auth/logout');

    const cabecalhos = Object.keys(fetch.chamadas[0].opcoes.headers).map((c) => c.toLowerCase());
    assert.equal(cabecalhos.includes('origin'), false);
    assert.equal(cabecalhos.includes('referer'), false);
  });

  test('caminho sem "/" inicial é erro de programação, antes de qualquer rede', async () => {
    const fetch = fetchFalso(resposta(200, {}));
    EpiHttp.configurar({ fetch });

    await assert.rejects(EpiHttp.requisitar('GET', 'grupos-acesso'), TypeError);
    assert.equal(fetch.chamadas.length, 0);
  });
});

describe('campos de autoridade nunca saem do navegador', () => {
  test('recusa corpo com empresaId, atorId, isMaster, perfil e afins — sem chegar à rede', async () => {
    const fetch = fetchFalso(resposta(200, {}));
    EpiHttp.configurar({ fetch });

    const proibidos = [
      { empresaId: 2 }, { empresa_id: 2 }, { atorId: 9 }, { ator_id: 9 },
      { isMaster: true }, { perfil: 'MASTER' }, { concedidoPor: 1 },
      { autorizadoPor: 1 }, { revogadoPor: 1 }, { criadoPor: 1 },
    ];

    for (const extra of proibidos) {
      await assert.rejects(
        EpiHttp.requisitar('POST', '/grupos-acesso', { corpo: { nome: 'X', ...extra } }),
        TypeError,
        `deveria recusar ${Object.keys(extra)[0]}`,
      );
    }

    assert.equal(fetch.chamadas.length, 0, 'nenhuma dessas tentativas chegou a sair');
  });

  test('usuarioId é permitido: em autorizações individuais ele é o beneficiário, não quem age', async () => {
    const fetch = fetchFalso(resposta(201, { status: 'ok', autorizacao: { id: 1 } }));
    EpiHttp.configurar({ fetch });

    const r = await EpiHttp.requisitar('POST', '/autorizacoes-individuais', {
      corpo: { tipo: 'DIRETA', usuarioId: 5, acaoCodigo: 'MOVIMENTAR_ESTOQUE' },
    });

    assert.equal(r.ok, true);
    assert.equal(JSON.parse(fetch.chamadas[0].opcoes.body).usuarioId, 5);
  });

  test('a lista de campos proibidos é exposta como cópia — alterá-la não afeta o cliente', () => {
    const copia = EpiHttp.CAMPOS_DE_AUTORIDADE_PROIBIDOS;
    copia.push('nome');
    assert.equal(EpiHttp.CAMPOS_DE_AUTORIDADE_PROIBIDOS.includes('nome'), false);
  });
});

describe('normalização da resposta', () => {
  test('sucesso devolve envelope ok com os dados do backend', async () => {
    EpiHttp.configurar({ fetch: fetchFalso(resposta(200, { status: 'ok', grupos: [{ id: 1 }] })) });

    const r = await EpiHttp.requisitar('GET', '/grupos-acesso');

    assert.equal(r.ok, true);
    assert.equal(r.status, 200);
    assert.deepEqual(r.dados.grupos, [{ id: 1 }]);
    assert.equal(r.codigo, null);
  });

  test('erros do backend preservam codigo, message e detalhes', async () => {
    EpiHttp.configurar({
      fetch: fetchFalso(resposta(400, {
        status: 'error', codigo: 'VALIDACAO', message: 'Dados inválidos',
        detalhes: [{ campo: 'body.nome', codigo: 'NOME_INVALIDO', mensagem: 'Nome do grupo inválido' }],
      })),
    });

    const r = await EpiHttp.requisitar('POST', '/grupos-acesso', { corpo: { nome: '' } });

    assert.equal(r.ok, false);
    assert.equal(r.status, 400);
    assert.equal(r.codigo, 'VALIDACAO');
    assert.equal(r.mensagem, 'Dados inválidos');
    assert.equal(r.detalhes[0].campo, 'body.nome');
    assert.equal(r.dados, null);
  });

  test('cada status da seção 4 é reconhecido por seu predicado, e só por ele', async () => {
    const casos = [
      [400, 'VALIDACAO', 'ehValidacao'],
      [401, 'SESSAO_INVALIDA', 'ehNaoAutenticado'],
      [403, 'GRUPO_NAO_AUTORIZADO', 'ehSemAutorizacao'],
      [404, 'GRUPO_NAO_ENCONTRADO', 'ehNaoEncontrado'],
      [409, 'GRUPO_NOME_EM_USO', 'ehConflito'],
    ];
    const predicados = ['ehValidacao', 'ehNaoAutenticado', 'ehSemAutorizacao', 'ehNaoEncontrado', 'ehConflito', 'ehFalhaDeRede'];

    for (const [status, codigo, predicadoEsperado] of casos) {
      EpiHttp.configurar({ fetch: fetchFalso(resposta(status, { status: 'error', codigo, message: 'm' })) });
      const r = await EpiHttp.requisitar('GET', '/grupos-acesso/1');

      assert.equal(r.codigo, codigo);
      for (const predicado of predicados) {
        assert.equal(
          EpiHttp[predicado](r), predicado === predicadoEsperado,
          `${status}: ${predicado} deveria ser ${predicado === predicadoEsperado}`,
        );
      }
    }
  });

  test('falha de rede vira envelope próprio (status 0), nunca uma exceção solta na tela', async () => {
    EpiHttp.configurar({ fetch: fetchFalso(new TypeError('Failed to fetch')) });

    const r = await EpiHttp.requisitar('GET', '/grupos-acesso');

    assert.equal(r.ok, false);
    assert.equal(r.status, 0);
    assert.equal(r.codigo, 'FALHA_DE_REDE');
    assert.equal(EpiHttp.ehFalhaDeRede(r), true);
    assert.match(r.mensagem, /servidor/i);
  });

  // Correção pós-auditoria da 3R: o fetch era protegido, a LEITURA do
  // corpo não. Se a conexão caísse no meio do corpo, resposta.text()
  // rejeitava e a Promise de requisitar() rejeitava junto, quebrando o
  // contrato de devolver sempre um envelope.
  test('conexão que cai DURANTE a leitura do corpo devolve FALHA_DE_REDE, sem rejeitar a Promise', async () => {
    EpiHttp.configurar({
      fetch: fetchFalso(resposta(200, undefined, { erroNaLeitura: new TypeError('terminated') })),
    });

    const r = await EpiHttp.requisitar('GET', '/grupos-acesso');

    assert.equal(r.ok, false);
    assert.equal(r.status, 0, 'a troca não se completou: o status recebido não descreve desfecho nenhum');
    assert.equal(r.codigo, 'FALHA_DE_REDE');
    assert.equal(EpiHttp.ehFalhaDeRede(r), true);
    assert.equal(r.dados, null);
    assert.match(r.mensagem, /servidor/i);
  });

  test('leitura interrompida é FALHA_DE_REDE em qualquer status, inclusive nos de erro', async () => {
    for (const status of [200, 201, 400, 401, 403, 500]) {
      EpiHttp.configurar({
        fetch: fetchFalso(resposta(status, undefined, { erroNaLeitura: new Error('connection reset') })),
      });

      const r = await EpiHttp.requisitar('POST', '/grupos-acesso', { corpo: { nome: 'X' } });

      assert.equal(EpiHttp.ehFalhaDeRede(r), true, `status ${status} deveria virar FALHA_DE_REDE`);
      assert.equal(r.status, 0);
    }
  });

  test('leitura interrompida e corpo não-JSON continuam sendo desfechos distintos', async () => {
    EpiHttp.configurar({ fetch: fetchFalso(resposta(502, undefined, { erroNaLeitura: new Error('terminated') })) });
    const interrompida = await EpiHttp.requisitar('GET', '/grupos-acesso');

    EpiHttp.configurar({ fetch: fetchFalso(resposta(502, undefined, { texto: '<html>Bad Gateway</html>' })) });
    const naoEhJson = await EpiHttp.requisitar('GET', '/grupos-acesso');

    assert.equal(interrompida.codigo, 'FALHA_DE_REDE');
    assert.equal(interrompida.status, 0);
    assert.equal(naoEhJson.codigo, 'RESPOSTA_INVALIDA');
    assert.equal(naoEhJson.status, 502, 'aqui a troca se completou: o status é real');
  });

  test('resposta não-JSON (ex.: HTML de proxy) vira RESPOSTA_INVALIDA sem vazar o conteúdo cru', async () => {
    EpiHttp.configurar({ fetch: fetchFalso(resposta(502, undefined, { texto: '<html>Bad Gateway</html>' })) });

    const r = await EpiHttp.requisitar('GET', '/grupos-acesso');

    assert.equal(r.ok, false);
    assert.equal(r.codigo, 'RESPOSTA_INVALIDA');
    assert.equal(JSON.stringify(r).includes('Bad Gateway'), false);
  });

  test('erro sem corpo recebe mensagem padrão do status, para a tela nunca ficar sem texto', async () => {
    EpiHttp.configurar({ fetch: fetchFalso(resposta(403, undefined, { texto: '' })) });

    const r = await EpiHttp.requisitar('GET', '/grupos-acesso');

    assert.equal(r.ok, false);
    assert.equal(r.status, 403);
    assert.ok(r.mensagem.length > 0);
  });
});

describe('configuração', () => {
  test('baseUrl com barra final é normalizada e valores inválidos são recusados', () => {
    assert.equal(EpiHttp.configurar({ baseUrl: 'http://x/api/' }).baseUrl, 'http://x/api');
    assert.throws(() => EpiHttp.configurar({ baseUrl: '' }), TypeError);
    assert.throws(() => EpiHttp.configurar({ fetch: 'nao-e-funcao' }), TypeError);
  });
});
