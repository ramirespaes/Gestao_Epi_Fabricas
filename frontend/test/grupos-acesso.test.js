'use strict';

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const EpiHttp = require('../js/api-http');
const EpiGrupos = require('../js/grupos-acesso');

const { acoes, mensagens, render } = EpiGrupos;

/**
 * Testes da tela de gestão de grupos (Bloco 8, Incremento 8, Etapa 5A,
 * Subetapa 3S), com `fetch` injetado — sem navegador e sem banco.
 *
 * Cobrem as três camadas puras do módulo: as chamadas aos contratos da
 * 3M, a tradução de cada desfecho em texto, e a montagem de HTML
 * escapado. O caminho ponta a ponta contra o backend real (login,
 * cookie, 403 da 3Q, 409 real) está em
 * backend/test/integracao/frontend-grupos-acesso.integration.js.
 */

const BASE = 'http://localhost:3000/api';

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

const resposta = (status, corpo) => ({
  status,
  ok: status >= 200 && status < 300,
  text: async () => (corpo === undefined ? '' : JSON.stringify(corpo)),
});

const erro = (status, codigo, message, detalhes) => resposta(status, { status: 'error', codigo, message, detalhes });

const GRUPO = { id: 7, empresaId: 1, nome: 'Almoxarifado', descricao: 'Equipe do estoque', ativo: true, criadoPor: 1 };

beforeEach(() => {
  EpiHttp.configurar({ baseUrl: BASE, fetch: fetchFalso(resposta(200, { status: 'ok' })) });
});

describe('ações — contratos reais da 3M', () => {
  test('listar sem filtro não envia query; com filtro envia ativo=true|false', async () => {
    const fetch = fetchFalso(resposta(200, { status: 'ok', grupos: [] }));
    EpiHttp.configurar({ fetch });

    await acoes.listar();
    await acoes.listar({ ativo: true });
    await acoes.listar({ ativo: false });

    assert.equal(fetch.chamadas[0].url, `${BASE}/grupos-acesso`);
    assert.equal(fetch.chamadas[1].url, `${BASE}/grupos-acesso?ativo=true`);
    assert.equal(fetch.chamadas[2].url, `${BASE}/grupos-acesso?ativo=false`);
    for (const chamada of fetch.chamadas) {
      assert.equal(chamada.opcoes.method, 'GET');
      assert.equal(chamada.opcoes.credentials, 'include');
    }
  });

  test('criar envia POST com nome; descrição vazia vira null (o serviço trata como "sem descrição")', async () => {
    const fetch = fetchFalso(resposta(201, { status: 'ok', grupo: GRUPO }));
    EpiHttp.configurar({ fetch });

    await acoes.criar({ nome: 'Gerência', descricao: '' });
    await acoes.criar({ nome: 'Manutenção', descricao: 'Equipe de manutenção' });

    assert.deepEqual(JSON.parse(fetch.chamadas[0].opcoes.body), { nome: 'Gerência', descricao: null });
    assert.deepEqual(JSON.parse(fetch.chamadas[1].opcoes.body), { nome: 'Manutenção', descricao: 'Equipe de manutenção' });
    assert.equal(fetch.chamadas[0].opcoes.method, 'POST');
  });

  test('alterar preserva a distinção AUSENTE x null: campo não informado não é enviado', async () => {
    const fetch = fetchFalso(resposta(200, { status: 'ok', grupo: GRUPO }));
    EpiHttp.configurar({ fetch });

    await acoes.alterar(7, { nome: 'Novo nome' });            // descrição intocada
    await acoes.alterar(7, { descricao: '' });                 // limpar descrição
    await acoes.alterar(7, { nome: 'A', descricao: 'B' });

    assert.deepEqual(JSON.parse(fetch.chamadas[0].opcoes.body), { nome: 'Novo nome' });
    assert.deepEqual(JSON.parse(fetch.chamadas[1].opcoes.body), { descricao: null });
    assert.deepEqual(JSON.parse(fetch.chamadas[2].opcoes.body), { nome: 'A', descricao: 'B' });
    assert.equal(fetch.chamadas[0].opcoes.method, 'PATCH');
    assert.equal(fetch.chamadas[0].url, `${BASE}/grupos-acesso/7`);
  });

  test('alterar nunca envia `ativo`: situação só muda pelas rotas próprias (decisão da 3J)', async () => {
    const fetch = fetchFalso(resposta(200, { status: 'ok', grupo: GRUPO }));
    EpiHttp.configurar({ fetch });

    await acoes.alterar(7, { nome: 'X', ativo: true, id: 99 });

    assert.deepEqual(JSON.parse(fetch.chamadas[0].opcoes.body), { nome: 'X' });
  });

  test('inativar e reativar usam rotas próprias e NÃO enviam corpo', async () => {
    const fetch = fetchFalso(resposta(200, { status: 'ok', grupo: GRUPO, alterado: true }));
    EpiHttp.configurar({ fetch });

    await acoes.inativar(7);
    await acoes.reativar(7);

    assert.equal(fetch.chamadas[0].url, `${BASE}/grupos-acesso/7/inativar`);
    assert.equal(fetch.chamadas[1].url, `${BASE}/grupos-acesso/7/reativar`);
    for (const chamada of fetch.chamadas) {
      assert.equal(chamada.opcoes.method, 'POST');
      assert.equal(chamada.opcoes.body, undefined, 'o schema da 3M aceita corpo ausente e recusa qualquer campo');
      assert.deepEqual(chamada.opcoes.headers, {});
    }
  });

  test('NÃO existe exclusão física: o módulo não expõe nenhuma ação de DELETE', async () => {
    assert.equal(Object.keys(acoes).sort().join(','), 'alterar,buscar,criar,inativar,listar,reativar');
    assert.equal(typeof acoes.excluir, 'undefined');
    assert.equal(typeof acoes.remover, 'undefined');

    const fetch = fetchFalso(resposta(200, { status: 'ok' }));
    EpiHttp.configurar({ fetch });
    await acoes.listar(); await acoes.buscar(1); await acoes.criar({ nome: 'X' });
    await acoes.alterar(1, { nome: 'Y' }); await acoes.inativar(1); await acoes.reativar(1);

    assert.equal(fetch.chamadas.some((c) => c.opcoes.method === 'DELETE'), false);
  });

  test('DUAS barreiras contra campo de autoridade: a lista branca do módulo e o guard da 3R', async () => {
    const fetch = fetchFalso(resposta(201, { status: 'ok', grupo: GRUPO }));
    EpiHttp.configurar({ fetch });

    // Barreira 1 — criar/alterar montam o corpo por lista branca (nome e
    // descrição). Qualquer outra chave é descartada e NUNCA sai.
    await acoes.criar({ nome: 'X', empresaId: 2, isMaster: true, criadoPor: 9 });
    await acoes.alterar(7, { nome: 'Y', atorId: 3, perfil: 'MASTER' });

    assert.deepEqual(JSON.parse(fetch.chamadas[0].opcoes.body), { nome: 'X' });
    assert.deepEqual(JSON.parse(fetch.chamadas[1].opcoes.body), { nome: 'Y' });

    // Barreira 2 — quem contornar o módulo e chamar o cliente direto
    // ainda é recusado com TypeError, antes da rede (camada da 3R).
    const antes = fetch.chamadas.length;
    await assert.rejects(
      EpiHttp.requisitar('POST', '/grupos-acesso', { corpo: { nome: 'X', empresaId: 2 } }),
      TypeError,
    );
    assert.equal(fetch.chamadas.length, antes, 'nada saiu nessa tentativa');
  });
});

describe('mensagens — cada desfecho vira texto para a pessoa', () => {
  test('401, 403, 404 e 409 recebem texto próprio, sem jargão de backend', () => {
    assert.match(mensagens.deErro(EpiHttp.ehNaoAutenticado ? { ok: false, status: 401, codigo: 'SESSAO_INVALIDA' } : {}), /sess(ã|a)o expirou/i);
    assert.match(mensagens.deErro({ ok: false, status: 403, codigo: 'GRUPO_NAO_AUTORIZADO' }), /n(ã|a)o tem autoriza(ç|c)(ã|a)o/i);
    assert.match(mensagens.deErro({ ok: false, status: 404, codigo: 'GRUPO_NAO_ENCONTRADO' }), /n(ã|a)o existe mais/i);
    assert.match(mensagens.deErro({ ok: false, status: 409, codigo: 'GRUPO_NOME_EM_USO' }), /j(á|a) existe um grupo/i);
  });

  test('400 de validação prefere o detalhe do campo — é o que diz o que corrigir', () => {
    const comDetalhe = {
      ok: false, status: 400, codigo: 'VALIDACAO', mensagem: 'Dados inválidos',
      detalhes: [{ campo: 'body.nome', codigo: 'NOME_INVALIDO', mensagem: 'Nome do grupo inválido' }],
    };
    assert.equal(mensagens.deErro(comDetalhe), 'Nome do grupo inválido');

    const codigoConhecido = {
      ok: false, status: 400, codigo: 'VALIDACAO',
      detalhes: [{ campo: 'body.nome', codigo: 'GRUPO_NOME_INVALIDO' }],
    };
    assert.match(mensagens.deErro(codigoConhecido), /nome de grupo v(á|a)lido/i);
  });

  test('400 de regra de negócio (sem detalhes) usa o código do backend', () => {
    assert.match(mensagens.deErro({ ok: false, status: 400, codigo: 'GRUPO_SEM_ALTERACAO' }), /Altere o nome ou a descri/i);
  });

  test('falha de rede e resposta inválida têm texto próprio', () => {
    assert.match(mensagens.deErro({ ok: false, status: 0, codigo: 'FALHA_DE_REDE' }), /servidor/i);
    assert.match(mensagens.deErro({ ok: false, status: 502, codigo: 'RESPOSTA_INVALIDA' }), /inesperada/i);
  });

  test('código desconhecido cai na mensagem pública do backend, e sucesso não gera texto de erro', () => {
    assert.equal(mensagens.deErro({ ok: false, status: 418, codigo: 'ALGO_NOVO', mensagem: 'Mensagem do backend' }), 'Mensagem do backend');
    assert.equal(mensagens.deErro({ ok: true, status: 200 }), '');
  });

  test('só o 401 exige novo login', () => {
    assert.equal(mensagens.exigeNovoLogin({ ok: false, status: 401 }), true);
    for (const status of [0, 400, 403, 404, 409, 500]) {
      assert.equal(mensagens.exigeNovoLogin({ ok: false, status }), false, `status ${status}`);
    }
    assert.equal(mensagens.exigeNovoLogin({ ok: true, status: 200 }), false);
  });

  test('a mensagem de inativar explica que nada é excluído, e a de reativar explica o efeito', () => {
    assert.match(mensagens.deSucesso('inativar', GRUPO), /continua existindo/i);
    assert.match(mensagens.deSucesso('reativar', GRUPO), /voltam a valer/i);
    assert.match(mensagens.deSucesso('criar', GRUPO), /Almoxarifado/);
  });
});

describe('render — HTML sempre escapado', () => {
  test('nome e descrição maliciosos NÃO viram HTML executável', () => {
    const html = render.linha({
      id: 3, ativo: true,
      nome: '<img src=x onerror="alert(1)">',
      descricao: "</td><script>alert('xss')</script>",
    });

    assert.equal(html.includes('<img'), false);
    assert.equal(html.includes('<script>'), false);
    assert.equal(html.includes('onerror="alert'), false);
    assert.ok(html.includes('&lt;img'), 'o texto aparece escapado, não interpretado');
    assert.ok(html.includes('&lt;script&gt;'));
  });

  test('escaparHtml cobre os cinco caracteres perigosos e trata null/undefined', () => {
    assert.equal(render.escaparHtml('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
    assert.equal(render.escaparHtml(null), '');
    assert.equal(render.escaparHtml(undefined), '');
    assert.equal(render.escaparHtml(42), '42');
  });

  test('o id usado nos data-atributos é numérico: não há caminho para injeção por ele', () => {
    const html = render.linha({ id: '5" onclick="roubar()', ativo: true, nome: 'X', descricao: null });
    assert.equal(html.includes('onclick='), false);
    assert.ok(html.includes('data-id="NaN"') || html.includes('data-id="5"'));
  });

  test('grupo ativo mostra selo de ativo e ação de inativar; inativo mostra o contrário', () => {
    const ativo = render.linha({ id: 1, nome: 'A', descricao: null, ativo: true });
    const inativo = render.linha({ id: 2, nome: 'B', descricao: null, ativo: false });

    assert.ok(ativo.includes('Ativo') && ativo.includes('badge-ok'));
    assert.ok(ativo.includes('data-acao="inativar"'));
    assert.equal(ativo.includes('data-acao="reativar"'), false);

    assert.ok(inativo.includes('Inativo') && inativo.includes('badge-danger'));
    assert.ok(inativo.includes('data-acao="reativar"'));
    assert.equal(inativo.includes('data-acao="inativar"'), false);
  });

  test('nenhuma linha oferece exclusão física', () => {
    const html = render.tabela([
      { id: 1, nome: 'A', descricao: null, ativo: true },
      { id: 2, nome: 'B', descricao: 'b', ativo: false },
    ]);
    assert.equal(/excluir|apagar|remover|delete/i.test(html), false);
    assert.ok(html.includes('<table>') && html.includes('table-wrap'));
  });

  test('descrição ausente vira travessão, não "null"', () => {
    const html = render.linha({ id: 1, nome: 'A', descricao: null, ativo: true });
    assert.equal(html.includes('null'), false);
    assert.ok(html.includes('—'));
  });

  test('estados de carregando, lista vazia e falha têm texto próprio; a falha escapa a mensagem', () => {
    assert.match(render.carregando(), /Carregando/i);
    assert.match(render.vazia(), /Nenhum grupo/i);

    const falha = render.falha('<script>x</script>');
    assert.equal(falha.includes('<script>'), false);
    assert.ok(falha.includes('notice'));
  });
});
