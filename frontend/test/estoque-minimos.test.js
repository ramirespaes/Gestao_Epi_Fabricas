'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const EpiHttp = require('../js/api-http');

/**
 * 12D-3 — Mínimo de estoque por tamanho: módulo js/estoque-minimos.js com `fetch`
 * injetado. Contrato do servidor (12D-2):
 *   GET    /materiais/:id/minimos            -> { status, materialId, estoqueMinimoPadrao, exigeTamanho, overrides: [{ tamanho, minimo }] }
 *   PUT    /materiais/:id/minimos/:tamanho   body { minimo } -> 201 criado | 200, com o mesmo estado + { criado, alterado }
 *   DELETE /materiais/:id/minimos/:tamanho   -> 200 { alterado, ...estado }
 *   409 MATERIAL_NAO_EXIGE_TAMANHO, 409 MATERIAL_TAMANHO_NAO_CLASSIFICADO, 404 MATERIAL_NAO_ENCONTRADO.
 * O mínimo próprio 0 é válido e vale mais que o padrão; sem linha própria o tamanho herda o padrão.
 * A tela com este módulo é testada em test/materiais.test.js ("12D-3 — mínimo por tamanho").
 */

const BASE = 'http://localhost:3000/api';
const RAIZ = path.join(__dirname, '..');
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
const semComentarios = (s) => s.replace(/<!--[\s\S]*?-->/g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
const modulo = () => require('../js/estoque-minimos'); // eslint-disable-line global-require
const resposta = (status, corpo) => ({ status, ok: status >= 200 && status < 300, text: async () => (corpo === undefined ? '' : JSON.stringify(corpo)) });
// O servidor limita o tamanho a 20 caracteres; o ataque cabe nesse limite.
const ATAQUE = '<b onclick=x>';
const ESCAPADO = '&lt;b onclick=x&gt;';
const marcacoes = (html) => [...String(html).matchAll(/<\s*([a-zA-Z][\w-]*)([^>]*)>/g)].map((m) => ({ nome: m[1].toLowerCase(), atributos: m[2] }));
const nomesDeAtributo = (a) => [...a.replace(/"[^"]*"|'[^']*'/g, '""').matchAll(/([^\s="'/]+)\s*=/g)].map((m) => m[1].toLowerCase());
const semElementoInjetado = (html) => {
  for (const m of marcacoes(html)) {
    assert.notEqual(m.nome, 'b', html);
    assert.equal(nomesDeAtributo(m.atributos).some((n) => n.startsWith('on')), false, `atributo de evento em <${m.nome}>`);
  }
};

let chamadas;
function servidor(responder) {
  chamadas = [];
  EpiHttp.configurar({
    baseUrl: BASE,
    fetch: async (url, opcoes) => {
      const u = new URL(url);
      chamadas.push({ metodo: opcoes.method, caminho: u.pathname + u.search, corpo: opcoes && opcoes.body ? JSON.parse(opcoes.body) : undefined });
      const r = responder(opcoes.method, u);
      if (r instanceof Error) throw r;
      return r;
    },
  });
}

const ESTADO = (extra = {}) => ({ status: 'ok', materialId: 77, estoqueMinimoPadrao: 5, exigeTamanho: true, overrides: [], ...extra });
const CHAVES_DO_ESTADO = ['estoqueMinimoPadrao', 'exigeTamanho', 'overrides'];

describe('acoes — URLs, método e corpo exatos', () => {
  test('consultar: GET /materiais/:id/minimos, sem corpo, sem empresa nem usuário', async () => {
    servidor(() => resposta(200, ESTADO()));
    const r = await modulo().acoes.consultar(77);
    assert.equal(r.ok, true);
    assert.deepEqual(chamadas, [{ metodo: 'GET', caminho: '/api/materiais/77/minimos', corpo: undefined }]);
  });

  test('definir: PUT com o corpo { minimo } e nada mais (nem chave de idempotência, nem empresa); o zero é enviado como zero', async () => {
    servidor(() => resposta(201, ESTADO({ criado: true, alterado: true })));
    await modulo().acoes.definir(77, '42', 8);
    await modulo().acoes.definir(77, '40', 0);
    assert.deepEqual(chamadas, [
      { metodo: 'PUT', caminho: '/api/materiais/77/minimos/42', corpo: { minimo: 8 } },
      { metodo: 'PUT', caminho: '/api/materiais/77/minimos/40', corpo: { minimo: 0 } },
    ]);
  });

  test('remover: DELETE sem corpo; o tamanho vai codificado na URL', async () => {
    servidor(() => resposta(200, ESTADO({ alterado: true })));
    await modulo().acoes.remover(77, 'G/XG 2');
    assert.deepEqual(chamadas, [{ metodo: 'DELETE', caminho: '/api/materiais/77/minimos/G%2FXG%202', corpo: undefined }]);
  });

  test('identificador ou tamanho fora do formato: nada é enviado e a recusa é local', async () => {
    servidor(() => resposta(200, ESTADO()));
    const A = modulo().acoes;
    for (const id of [0, -1, 1.5, '77', null, undefined]) assert.equal((await A.consultar(id)).ok, false, String(id));
    for (const tamanho of ['', '  ', null, undefined, 'x'.repeat(21)]) {
      assert.equal((await A.definir(77, tamanho, 1)).ok, false, String(tamanho));
      assert.equal((await A.remover(77, tamanho)).ok, false, String(tamanho));
    }
    for (const minimo of [-1, 1.5, '3', null, undefined, NaN, 2147483648]) assert.equal((await A.definir(77, '42', minimo)).ok, false, String(minimo));
    assert.deepEqual(chamadas, []);
  });
});

describe('validar — campos digitados', () => {
  test('mínimo: inteiro de 0 a 2147483647; o zero é válido; texto aparado; resto recusado com mensagem', () => {
    const V = modulo().validar;
    assert.deepEqual(V.minimo('8'), { ok: true, valor: 8 });
    assert.deepEqual(V.minimo(' 0 '), { ok: true, valor: 0 });
    assert.deepEqual(V.minimo('2147483647'), { ok: true, valor: 2147483647 });
    for (const ruim of ['', '   ', '-1', '1.5', '1,5', 'abc', '1e3', '2147483648', '+3', null, undefined]) {
      const r = V.minimo(ruim);
      assert.equal(r.ok, false, String(ruim));
      assert.match(r.mensagem, /mínimo/i);
    }
  });

  test('tamanho: texto de 1 a 20 caracteres, aparado, sem caractere de controle', () => {
    const V = modulo().validar;
    assert.deepEqual(V.tamanho('  42 '), { ok: true, tamanho: '42' });
    assert.deepEqual(V.tamanho('x'.repeat(20)), { ok: true, tamanho: 'x'.repeat(20) });
    for (const ruim of ['', '   ', 'x'.repeat(21), 'a\nb', 'a\u0000b', null, undefined]) {
      const r = V.tamanho(ruim);
      assert.equal(r.ok, false, JSON.stringify(ruim));
      assert.match(r.mensagem, /tamanho/i);
    }
  });
});

describe('painel — o que a tela mostra, a partir do estado do servidor e dos tamanhos dos lotes', () => {
  test('material com tamanhos: uma linha por tamanho conhecido (lotes e sobrescritas), em ordem natural; o zero próprio vence o padrão; sem linha própria herda', () => {
    const P = modulo().painel.montar(ESTADO({ overrides: [{ tamanho: '42', minimo: 8 }, { tamanho: '40', minimo: 0 }, { tamanho: '44', minimo: 2 }] }), ['41', '40', '42', '42', null, '', '9']);
    assert.equal(P.modo, 'TAMANHOS');
    assert.equal(P.padrao, 5);
    assert.deepEqual(P.linhas.map((l) => [l.tamanho, l.proprio, l.efetivo, l.origem]), [
      ['9', null, 5, 'PADRAO'],
      ['40', 0, 0, 'PROPRIO'],
      ['41', null, 5, 'PADRAO'],
      ['42', 8, 8, 'PROPRIO'],
      ['44', 2, 2, 'PROPRIO'],
    ]);
  });

  test('sem lotes e sem sobrescritas: painel vazio, nada é inventado para "todos os tamanhos"', () => {
    const P = modulo().painel.montar(ESTADO(), []);
    assert.deepEqual([P.modo, P.linhas], ['TAMANHOS', []]);
  });

  test('tamanho único (exigeTamanho false): modo UNICO, sem linhas, mesmo que os lotes tenham tamanho; só o padrão', () => {
    const P = modulo().painel.montar(ESTADO({ exigeTamanho: false }), ['40']);
    assert.deepEqual([P.modo, P.linhas, P.padrao], ['UNICO', [], 5]);
  });

  test('não classificado (exigeTamanho nulo): modo NAO_CLASSIFICADO, sem linhas e sem sobrescritas, mesmo que o servidor mande alguma', () => {
    const P = modulo().painel.montar(ESTADO({ exigeTamanho: null, overrides: [{ tamanho: '42', minimo: 8 }] }), ['42']);
    assert.deepEqual([P.modo, P.linhas], ['NAO_CLASSIFICADO', []]);
  });

  test('resposta malformada vira INDISPONIVEL, nunca um painel com números inventados', () => {
    for (const ruim of [null, undefined, {}, { exigeTamanho: true }, { exigeTamanho: true, estoqueMinimoPadrao: 'x', overrides: [] }, { exigeTamanho: true, estoqueMinimoPadrao: 5, overrides: 'x' }]) {
      assert.equal(modulo().painel.montar(ruim, ['40']).modo, 'INDISPONIVEL', JSON.stringify(ruim));
    }
    const comLinhaRuim = modulo().painel.montar(ESTADO({ overrides: [{ tamanho: '42', minimo: 'x' }, { tamanho: '', minimo: 3 }, null, { tamanho: '43', minimo: 4 }] }), []);
    assert.deepEqual(comLinhaRuim.linhas.map((l) => l.tamanho), ['43'], 'só a sobrescrita bem formada entra');
  });

  test('contrato: o painel lê só as chaves do estado do servidor (padrão, exigeTamanho, sobrescritas) e, nelas, tamanho e minimo', () => {
    const lidas = new Set();
    const lidasLinha = new Set();
    const linha = new Proxy({ tamanho: '42', minimo: 8 }, { get(a, n) { if (typeof n === 'string') lidasLinha.add(n); return a[n]; } });
    const estado = new Proxy(ESTADO({ overrides: [linha] }), { get(a, n) { if (typeof n === 'string') lidas.add(n); return a[n]; } });
    modulo().painel.montar(estado, []);
    assert.deepEqual([...lidas].sort(), CHAVES_DO_ESTADO);
    assert.deepEqual([...lidasLinha].sort(), ['minimo', 'tamanho']);
  });
});

describe('render — tabela do painel, HTML sempre escapado', () => {
  const celulas = (linhaHtml) => [...linhaHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
  const linhasDe = (html) => html.split('</tr>').filter((l) => l.includes('<td'));
  const painelCom = (overrides, lotes = []) => modulo().painel.montar(ESTADO({ overrides }), lotes);

  test('colunas: tamanho, mínimo próprio, mínimo efetivo e origem; "0 próprio" é diferente de "herdando padrão"', () => {
    const html = modulo().render.linhas(painelCom([{ tamanho: '40', minimo: 0 }, { tamanho: '42', minimo: 8 }], ['41']), { podeEditar: false });
    const [c40, c41, c42] = linhasDe(html).map(celulas);
    assert.deepEqual(c40.slice(0, 4), ['40', '0 próprio', '0', 'Próprio']);
    assert.deepEqual(c41.slice(0, 4), ['41', 'herdando padrão', '5', 'Padrão']);
    assert.deepEqual(c42.slice(0, 4), ['42', '8 próprio', '8', 'Próprio']);
  });

  test('só leitura (sem permissão de editar): nenhuma linha traz botão de ação', () => {
    const html = modulo().render.linhas(painelCom([{ tamanho: '42', minimo: 8 }], ['41']), { podeEditar: false });
    assert.equal(/<button/.test(html), false);
  });

  test('com permissão: sobrescrita traz Alterar e Remover; tamanho que herda traz só Definir; a ação e o tamanho vão em data-', () => {
    const html = modulo().render.linhas(painelCom([{ tamanho: '42', minimo: 8 }], ['41']), { podeEditar: true });
    const [c41, c42] = linhasDe(html);
    assert.deepEqual([...c41.matchAll(/data-acao="([a-z]+)" data-tamanho="([^"]*)"/g)].map((m) => [m[1], m[2]]), [['definir', '41']]);
    assert.deepEqual([...c42.matchAll(/data-acao="([a-z]+)" data-tamanho="([^"]*)"/g)].map((m) => [m[1], m[2]]), [['alterar', '42'], ['remover', '42']]);
  });

  test('XSS: o tamanho vindo do servidor sai escapado no texto e no atributo', () => {
    const html = modulo().render.linhas(painelCom([{ tamanho: ATAQUE, minimo: 1 }], []), { podeEditar: true });
    assert.ok(html.includes(ESCAPADO));
    semElementoInjetado(html);
  });

  test('sem linhas: render devolve texto vazio (a página mostra a explicação do modo)', () => {
    assert.equal(modulo().render.linhas(modulo().painel.montar(ESTADO(), []), { podeEditar: true }), '');
    assert.equal(modulo().render.linhas(modulo().painel.montar(ESTADO({ exigeTamanho: false }), ['40']), { podeEditar: true }), '');
  });

  test('opções do campo de tamanho: os tamanhos já listados, escapados', () => {
    const html = modulo().render.opcoesTamanhos(painelCom([{ tamanho: ATAQUE, minimo: 1 }], ['41']));
    assert.ok(html.includes(ESCAPADO));
    assert.match(html, /<option value="41">/);
    semElementoInjetado(html);
  });

  test('texto de cada modo: único, não classificado e indisponível explicam sem número inventado', () => {
    const M = modulo().mensagens;
    assert.match(M.aviso(modulo().painel.montar(ESTADO({ exigeTamanho: false }), [])), /não usa tamanho.*mínimo padrão.*5/i);
    assert.match(M.aviso(modulo().painel.montar(ESTADO({ exigeTamanho: null }), [])), /Defina no cadastro/i);
    assert.match(M.aviso(modulo().painel.montar(null, [])), /não foi possível/i);
    assert.match(M.aviso(modulo().painel.montar(ESTADO(), [])), /nenhum tamanho/i);
    assert.match(M.aviso(modulo().painel.montar(ESTADO({ overrides: [{ tamanho: '42', minimo: 8 }] }), [])), /mínimo padrão.*5/i);
  });
});

describe('mensagens — texto próprio, sem repetir o servidor', () => {
  const SEGREDO = { ok: false, status: 409, codigo: 'X', mensagem: 'SEGREDO-INTERNO', detalhes: [{ caminho: 'body.minimo', valor: 'SEGREDO-9' }] };

  test('consulta: 401, 403, 404, 5xx e rede, cada um com texto próprio', () => {
    const M = modulo().mensagens;
    assert.match(M.erroConsulta({ ok: false, status: 401 }), /sessão/i);
    assert.match(M.erroConsulta({ ok: false, status: 403 }), /perfil/i);
    assert.match(M.erroConsulta({ ok: false, status: 404, codigo: 'MATERIAL_NAO_ENCONTRADO' }), /não encontrado/i);
    assert.match(M.erroConsulta({ ok: false, status: 500 }), /Não foi possível/);
    assert.match(M.erroConsulta({ ok: false, status: 0 }), /rede/i);
    assert.equal(M.exigeNovoLogin({ status: 401 }), true);
    assert.equal(M.exigeNovoLogin({ status: 403 }), false);
  });

  test('gravação: os 409 do servidor viram orientação (não usa tamanho; não classificado), sem contornar', () => {
    const M = modulo().mensagens;
    assert.match(M.erroGravacao({ ok: false, status: 409, codigo: 'MATERIAL_NAO_EXIGE_TAMANHO' }), /não usa tamanho.*mínimo padrão/i);
    assert.match(M.erroGravacao({ ok: false, status: 409, codigo: 'MATERIAL_TAMANHO_NAO_CLASSIFICADO' }), /Defina no cadastro/i);
    assert.match(M.erroGravacao({ ok: false, status: 404, codigo: 'MATERIAL_NAO_ENCONTRADO' }), /não encontrado/i);
    assert.match(M.erroGravacao({ ok: false, status: 403 }), /não pode editar materiais/i);
    assert.match(M.erroGravacao({ ok: false, status: 400 }), /recusados/i);
    assert.match(M.erroGravacao({ ok: false, status: 401 }), /sessão/i);
  });

  test('falha de rede ou 5xx na gravação: resultado não confirmado, com a orientação de recarregar o painel', () => {
    const M = modulo().mensagens;
    for (const r of [{ ok: false, status: 0 }, { ok: false, status: 503 }]) assert.match(M.erroGravacao(r), /não foi possível confirmar.*Recarregue o painel/i);
  });

  test('nada do corpo da resposta vaza para a tela', () => {
    const M = modulo().mensagens;
    for (const r of [SEGREDO, { ...SEGREDO, status: 400 }, { ...SEGREDO, status: 500 }, { ...SEGREDO, status: 404 }]) {
      assert.equal(/SEGREDO/.test(M.erroGravacao(r)), false);
      assert.equal(/SEGREDO/.test(M.erroConsulta(r)), false);
    }
  });

  test('sucesso: definir (novo, alterado, igual) e remover (removido, já herdava) com o tamanho e o valor; remover volta ao padrão', () => {
    const M = modulo().mensagens;
    assert.equal(M.sucessoDefinir({ criado: true, alterado: true }, '42', 8), 'Mínimo do tamanho 42 definido: 8.');
    assert.equal(M.sucessoDefinir({ criado: false, alterado: true }, '42', 8), 'Mínimo do tamanho 42 alterado para 8.');
    assert.equal(M.sucessoDefinir({ criado: false, alterado: false }, '42', 8), 'O tamanho 42 já tinha o mínimo 8; nada foi alterado.');
    assert.equal(M.sucessoDefinir({ criado: true, alterado: true }, '40', 0), 'Mínimo do tamanho 40 definido: 0.');
    assert.equal(M.sucessoRemover({ alterado: true, estoqueMinimoPadrao: 5 }, '42'), 'Mínimo próprio do tamanho 42 removido: o tamanho volta a usar o mínimo padrão (5).');
    assert.equal(M.sucessoRemover({ alterado: false, estoqueMinimoPadrao: 5 }, '42'), 'O tamanho 42 já usava o mínimo padrão (5); nada foi alterado.');
  });
});

describe('inspeção estática do módulo', () => {
  const codigo = semComentarios(ler('js/estoque-minimos.js'));

  test('só fala com /materiais/:id/minimos; nenhum armazenamento do navegador; nenhum eval', () => {
    assert.match(codigo, /\/materiais\//);
    for (const proibido of [/localStorage/, /sessionStorage/, /document\.cookie/, /\beval\(/, /new Function/, /\/estoque\//, /\/solicitacoes/]) assert.equal(proibido.test(codigo), false, String(proibido));
  });

  test('as três escritas existentes são GET, PUT e DELETE; nenhum POST nem PATCH', () => {
    assert.deepEqual([...new Set([...codigo.matchAll(/requisitar\('([A-Z]+)'/g)].map((m) => m[1]))].sort(), ['DELETE', 'GET', 'PUT']);
  });

  test('a publicação inclui o módulo, uma vez, em ordem', () => {
    const arquivos = JSON.parse(ler('publicacao/allowlist.json')).arquivos;
    assert.equal(arquivos.filter((a) => a === 'js/estoque-minimos.js').length, 1);
    assert.deepEqual(arquivos, [...arquivos].sort());
  });
});
