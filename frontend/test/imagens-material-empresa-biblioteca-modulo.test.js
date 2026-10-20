'use strict';

const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const E = require('./helpers/imagens-material-empresa');
const EpiHttp = require('../js/api-http');
const schemas = require('../../backend/src/schemas/imagem-material.schema');

/**
 * Unidade 5C-7 (RED do frontend) — o que o módulo js/imagens-material.js (EpiImagensMaterial) PRECISA GANHAR na 5C-8 para enxergar também a biblioteca da empresa:
 * o caminho da listagem com origem, estado e página, a miniatura da origem EMPRESA, os caminhos e as ações de gerenciar (renomear, inativar, reativar, excluir), o
 * carregamento de TODAS as páginas e os textos das falhas. Tudo o que o módulo já faz com a Biblioteca Padrão (5B) está nos testes da 5B e não se repete aqui; o transporte
 * continua sendo o EpiHttp (JSON). Sem DOM, sem PostgreSQL e sem API 3300: `fetch` simulado.
 *
 * Contratos lidos no backend: GET /imagens-material (materials.visualizar; origem TODAS|PADRAO|EMPRESA, estado ATIVA|INATIVA|TODAS, pagina 1 a 10000, limite 1 a 100, busca até
 * 100; chave desconhecida = 400); PATCH /imagens-material/empresa/:id { nome }; POST …/:id/inativar e …/:id/reativar com corpo {}; DELETE …/:id { confirmacao: true }
 * (as quatro exigem materials.editar); 404 IMAGEM_NAO_ENCONTRADA para inexistente, de outra empresa ou (na associação) inativa; 409 IMAGEM_EM_USO ao inativar ou excluir
 * imagem usada por material. O id da imagem é BIGINT em texto decimal canônico.
 */

const BASE = 'http://localhost:3000/api';
const imagemEmpresa = { origem: 'EMPRESA', id: '7001', versao: 2, nome: 'Luva da empresa' };
afterEach(() => EpiHttp.configurar({ baseUrl: BASE, fetch: null }));

const preparar = (roteiro) => {
  const r = E.fetchRoteirizado(roteiro);
  EpiHttp.configurar({ baseUrl: BASE, fetch: r.fetch });
  return r.estado;
};
/** Roda `fn` e, se ela faltar ou lançar, falha com o marcador de funcionalidade ausente. */
const exigirQue = (descricao, fn) => {
  try { return fn(); } catch (falha) { return assert.fail(`${E.MARCA} ${descricao} (${falha.name}: ${falha.message})`); }
};
const caminhos = () => E.biblioteca().caminhos;
const acao = (nome, para) => E.exigirFuncao(E.biblioteca().acoes, nome, `EpiImagensMaterial.acoes.${nome} (${para})`);
const listaCom = (opcoes) => exigirQue('caminhos.lista aceita opções (origem, estado, pagina, limite, busca)', () => {
  const saida = caminhos().lista(opcoes);
  assert.ok(saida.includes(`origem=${opcoes.origem ?? 'PADRAO'}`), `a listagem ignorou as opções: ${saida}`);
  return saida;
});
const consulta = (caminho) => Object.fromEntries(new URLSearchParams(caminho.split('?')[1]).entries());

// ─────────────────────────────────────────────────────────────────────
describe('5C-7 BI — caminho da listagem com origem, estado, página e busca', () => {
  test('BI-01 com origem TODAS, PADRAO ou EMPRESA (e estado, página, limite e busca opcionais) monta a consulta na ordem origem, estado, página, limite, busca; sem opções a 5B segue igual', () => {
    assert.equal(listaCom({ origem: 'TODAS' }), '/imagens-material?origem=TODAS&pagina=1&limite=100');
    assert.equal(caminhos().lista(), '/imagens-material?origem=PADRAO&pagina=1&limite=100', 'sem opções: a listagem da Biblioteca Padrão da 5B');
    assert.equal(listaCom({ origem: 'EMPRESA', pagina: 3 }), '/imagens-material?origem=EMPRESA&pagina=3&limite=100');
    assert.equal(listaCom({ origem: 'EMPRESA', estado: 'INATIVA', limite: 50 }), '/imagens-material?origem=EMPRESA&estado=INATIVA&pagina=1&limite=50');
    assert.equal(listaCom({ origem: 'TODAS', pagina: 2, busca: ' luva de raspa ' }), '/imagens-material?origem=TODAS&pagina=2&limite=100&busca=luva%20de%20raspa');
    assert.equal(listaCom({ origem: 'TODAS', busca: '' }), '/imagens-material?origem=TODAS&pagina=1&limite=100', 'busca vazia não vai');
  });

  test('BI-02 opção fora do contrato é TypeError antes de montar o endereço: origem, estado, página, limite, busca acima de 100 e chave desconhecida', () => {
    listaCom({ origem: 'TODAS' });
    const lista = caminhos().lista;
    for (const opcoes of [{ origem: 'OUTRA' }, { origem: 'todas' }, { origem: 5 }, { origem: 'TODAS', estado: 'ZZZ' }, { origem: 'TODAS', pagina: 0 }, { origem: 'TODAS', pagina: 10001 },
      { origem: 'TODAS', pagina: 1.5 }, { origem: 'TODAS', pagina: '2' }, { origem: 'TODAS', limite: 0 }, { origem: 'TODAS', limite: 101 }, { origem: 'TODAS', busca: 'x'.repeat(101) },
      { origem: 'TODAS', tipoNome: 'Luva' }, { origem: 'TODAS', empresaId: '3' }, null, 'TODAS']) {
      assert.throws(() => lista(opcoes), TypeError, JSON.stringify(opcoes));
    }
  });

  test('BI-03 a consulta montada é aceita pelo schema REAL do backend (nenhuma chave a mais, valores no intervalo)', () => {
    for (const opcoes of [{ origem: 'TODAS' }, { origem: 'EMPRESA', estado: 'TODAS', pagina: 10000, limite: 100 }, { origem: 'PADRAO', busca: 'óculos & máscara' }, { origem: 'EMPRESA', estado: 'INATIVA', limite: 1 }]) {
      const saida = listaCom(opcoes);
      assert.equal(schemas.listar.query.safeParse(consulta(saida)).success, true, saida);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('5C-7 BI — miniatura da origem EMPRESA', () => {
  test('BI-04 caminhos.miniatura e urlMiniatura aceitam EMPRESA: /imagens-material/empresa/<id>/miniatura?v=<versão>, com o id BIGINT como texto', () => {
    const { caminhos: c, urlMiniatura } = E.biblioteca();
    exigirQue('miniatura da origem EMPRESA', () => c.miniatura(imagemEmpresa));
    assert.equal(c.miniatura(imagemEmpresa), '/imagens-material/empresa/7001/miniatura?v=2');
    assert.equal(c.miniatura({ origem: 'EMPRESA', id: E.ID_GRANDE_EMPRESA, versao: 1 }), `/imagens-material/empresa/${E.ID_GRANDE_EMPRESA}/miniatura?v=1`);
    assert.equal(urlMiniatura(imagemEmpresa, `${BASE}/`), `${BASE}/imagens-material/empresa/7001/miniatura?v=2`);
    assert.equal(c.miniatura({ origem: 'PADRAO', id: '1001', versao: 1 }), '/imagens-material/padrao/1001/miniatura?v=1', 'a padrão não muda');
  });

  test('BI-05 id, versão ou origem fora do formato continuam TypeError, também para EMPRESA; ids iguais em origens diferentes dão endereços diferentes', () => {
    const { caminhos: c } = E.biblioteca();
    exigirQue('miniatura da origem EMPRESA', () => c.miniatura(imagemEmpresa));
    for (const id of ['', '0', '01', '-1', '1.5', '1/2', '../1', '1?x=1', ' 1', 'abc', 1001, null, undefined]) assert.throws(() => c.miniatura({ origem: 'EMPRESA', id, versao: 1 }), TypeError, `id ${JSON.stringify(id)}`);
    for (const versao of [0, -1, 1.5, '1', null, undefined, 2147483648]) assert.throws(() => c.miniatura({ origem: 'EMPRESA', id: '7', versao }), TypeError, `versão ${String(versao)}`);
    assert.notEqual(c.miniatura({ origem: 'EMPRESA', id: '7', versao: 1 }), c.miniatura({ origem: 'PADRAO', id: '7', versao: 1 }));
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('5C-7 BI — caminhos de gerenciar a biblioteca da empresa', () => {
  test('BI-06 caminhos.empresa, inativar e reativar apontam para as rotas do backend e exigem id canônico', () => {
    const c = exigirQue('caminhos de gerenciamento (empresa, inativar, reativar)', () => {
      const x = caminhos();
      assert.equal(typeof x.empresa, 'function');
      assert.equal(typeof x.inativar, 'function');
      assert.equal(typeof x.reativar, 'function');
      return x;
    });
    assert.equal(c.empresa('7001'), '/imagens-material/empresa/7001');
    assert.equal(c.inativar('7001'), '/imagens-material/empresa/7001/inativar');
    assert.equal(c.reativar('7001'), '/imagens-material/empresa/7001/reativar');
    assert.equal(c.empresa(E.ID_GRANDE_EMPRESA), `/imagens-material/empresa/${E.ID_GRANDE_EMPRESA}`);
    for (const id of ['', '0', '01', '-1', '1.5', '1/2', '../1', ' 1', 'abc', 7001, null, undefined]) {
      for (const nome of ['empresa', 'inativar', 'reativar']) assert.throws(() => c[nome](id), TypeError, `${nome}(${JSON.stringify(id)})`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('5C-7 BI — ações pelo transporte do projeto (EpiHttp, JSON)', () => {
  test('BI-07 acoes.listar faz um GET com cookie de sessão, sem corpo, na consulta de caminhos.lista, e devolve o envelope do EpiHttp; listarPadrao da 5B continua (guarda)', async () => {
    assert.equal(typeof E.biblioteca().acoes.listarPadrao, 'function');
    const estado = preparar([E.resposta(200, { status: 'ok', imagens: [], total: 0, pagina: 2, limite: 100 })]);
    const r = await acao('listar', 'listagem com origem e página')({ origem: 'EMPRESA', estado: 'TODAS', pagina: 2 });
    assert.equal(estado.chamadas.length, 1);
    assert.equal(estado.chamadas[0].url, `${BASE}/imagens-material?origem=EMPRESA&estado=TODAS&pagina=2&limite=100`);
    assert.deepEqual([estado.chamadas[0].opcoes.method, estado.chamadas[0].opcoes.credentials, estado.chamadas[0].opcoes.body], ['GET', 'include', undefined]);
    assert.equal(r.ok, true);
    assert.equal(r.dados.pagina, 2);
  });

  test('BI-08 acoes.renomear: PATCH /imagens-material/empresa/<id> com { nome } aparado e normalizado, JSON, cookie de sessão; nome inválido ou id ruim é TypeError antes da rede', async () => {
    const estado = preparar([E.resposta(200, { status: 'ok', imagem: { ...imagemEmpresa, nome: 'Novo nome', estado: 'ATIVA' }, alterado: true })]);
    const renomear = acao('renomear', 'renomear imagem da empresa');
    const r = await renomear('7001', '  Novo nome  ');
    const { url, opcoes } = estado.chamadas[0];
    assert.equal(url, `${BASE}/imagens-material/empresa/7001`);
    assert.deepEqual([opcoes.method, opcoes.credentials, opcoes.headers['Content-Type']], ['PATCH', 'include', 'application/json']);
    assert.deepEqual(JSON.parse(opcoes.body), { nome: 'Novo nome' });
    assert.equal(schemas.renomear.body.safeParse(JSON.parse(opcoes.body)).success, true);
    assert.equal(r.dados.alterado, true);
    for (const [id, nome] of [['7001', ''], ['7001', '   '], ['7001', 'x'.repeat(101)], ['7001', 'a\u0007b'], ['7001', 5], ['07', 'ok'], [7001, 'ok'], [null, 'ok']]) {
      let erro = null;
      try { await renomear(id, nome); } catch (falha) { erro = falha; }
      assert.ok(erro instanceof TypeError, `renomear(${JSON.stringify(id)}, ${JSON.stringify(nome)})`);
    }
    assert.equal(estado.chamadas.length, 1);
  });

  test('BI-09 acoes.inativar e acoes.reativar: POST com corpo {} (o backend exige objeto vazio), JSON, cookie de sessão, no endereço certo', async () => {
    const estado = preparar([E.resposta(200, { status: 'ok', imagem: { ...imagemEmpresa, estado: 'INATIVA' }, alterado: true }), E.resposta(200, { status: 'ok', imagem: { ...imagemEmpresa, estado: 'ATIVA' }, alterado: true })]);
    await acao('inativar', 'inativar imagem da empresa')('7001');
    await acao('reativar', 'reativar imagem da empresa')('7001');
    assert.deepEqual(estado.chamadas.map((c) => c.url), [`${BASE}/imagens-material/empresa/7001/inativar`, `${BASE}/imagens-material/empresa/7001/reativar`]);
    for (const { opcoes } of estado.chamadas) {
      assert.deepEqual([opcoes.method, opcoes.credentials, opcoes.headers['Content-Type'], opcoes.body], ['POST', 'include', 'application/json', '{}']);
      assert.equal(schemas.inativar.body.safeParse(JSON.parse(opcoes.body)).success, true);
    }
  });

  test('BI-10 acoes.excluir NUNCA exclui sem confirmação explícita: sem { confirmado: true } é TypeError e nada sai; com ela, DELETE com { confirmacao: true }', async () => {
    const estado = preparar([E.resposta(200, { status: 'ok', excluida: true, imagemId: '7001' })]);
    const excluir = acao('excluir', 'excluir imagem da empresa');
    for (const argumentos of [['7001'], ['7001', {}], ['7001', { confirmado: false }], ['7001', { confirmado: 'true' }], ['7001', { confirmado: 1 }], ['7001', null]]) {
      let erro = null;
      try { await excluir(...argumentos); } catch (falha) { erro = falha; }
      assert.ok(erro instanceof TypeError, `excluir(${JSON.stringify(argumentos)}) sem confirmação`);
    }
    assert.equal(estado.chamadas.length, 0);
    const r = await excluir('7001', { confirmado: true });
    const { url, opcoes } = estado.chamadas[0];
    assert.equal(url, `${BASE}/imagens-material/empresa/7001`);
    assert.deepEqual([opcoes.method, opcoes.credentials, opcoes.headers['Content-Type']], ['DELETE', 'include', 'application/json']);
    assert.deepEqual(JSON.parse(opcoes.body), { confirmacao: true });
    assert.equal(schemas.excluir.body.safeParse(JSON.parse(opcoes.body)).success, true);
    assert.equal(r.dados.excluida, true);
  });

  test('BI-11 as ações devolvem o envelope do EpiHttp também nas falhas (404, 409, 403, rede), sem lançar', async () => {
    preparar([E.erroDoServidor(404, 'IMAGEM_NAO_ENCONTRADA'), E.erroDoServidor(409, 'IMAGEM_EM_USO'), E.erroDoServidor(403, 'SEM_PERMISSAO'), new TypeError('Failed to fetch')]);
    const a = E.biblioteca().acoes;
    exigirQue('ações de gerenciamento', () => ['renomear', 'inativar', 'reativar', 'excluir'].forEach((n) => assert.equal(typeof a[n], 'function')));
    const r1 = await a.renomear('7001', 'x');
    const r2 = await a.inativar('7001');
    const r3 = await a.reativar('7001');
    const r4 = await a.excluir('7001', { confirmado: true });
    assert.deepEqual([r1.status, r1.codigo, r2.status, r2.codigo, r3.status, r4.status], [404, 'IMAGEM_NAO_ENCONTRADA', 409, 'IMAGEM_EM_USO', 403, 0]);
    assert.equal(EpiHttp.ehFalhaDeRede(r4), true);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('5C-7 BI — carregar a biblioteca inteira: todas as páginas, sem perder nem repetir imagem (FE-01)', () => {
  const pagina = (n, quantas, total, origem = 'EMPRESA', inicio = 1) => E.resposta(200, {
    status: 'ok', total, pagina: n, limite: 100,
    imagens: Array.from({ length: quantas }, (_, i) => ({ origem, id: String(inicio + i), nome: `Imagem ${inicio + i}`, versao: 1, emUso: 0 })),
  });

  test('BI-12 acoes.listarTodas pede a página 1, 2, 3… em sequência (limite 100) até chegar ao total, junta as imagens na ordem da API e diz que a lista está completa', async () => {
    const estado = preparar([pagina(1, 100, 230), pagina(2, 100, 230, 'EMPRESA', 101), pagina(3, 30, 230, 'EMPRESA', 201)]);
    const r = await acao('listarTodas', 'carregar todas as páginas da biblioteca')({ origem: 'TODAS' });
    assert.deepEqual(estado.chamadas.map((c) => consulta(c.url.replace(BASE, ''))), [
      { origem: 'TODAS', pagina: '1', limite: '100' }, { origem: 'TODAS', pagina: '2', limite: '100' }, { origem: 'TODAS', pagina: '3', limite: '100' }]);
    assert.equal(estado.maxEmVoo, 1, 'uma página por vez');
    assert.equal(r.ok, true);
    assert.equal(r.dados.imagens.length, 230);
    assert.deepEqual(r.dados.imagens.map((i) => i.id).slice(0, 3), ['1', '2', '3']);
    assert.equal(r.dados.imagens[229].id, '230');
    assert.deepEqual([r.dados.total, r.dados.completa], [230, true]);
  });

  test('BI-13 uma página só (total ≤ limite) faz uma única consulta; total 0 devolve lista vazia completa', async () => {
    const listarTodas = acao('listarTodas', 'carregar todas as páginas da biblioteca');
    let estado = preparar([pagina(1, 30, 30, 'PADRAO', 1001)]);
    let r = await listarTodas({ origem: 'TODAS' });
    assert.deepEqual([estado.chamadas.length, r.dados.imagens.length, r.dados.completa], [1, 30, true]);
    estado = preparar([pagina(1, 0, 0)]);
    r = await listarTodas({ origem: 'TODAS' });
    assert.deepEqual([estado.chamadas.length, r.dados.imagens.length, r.dados.completa], [1, 0, true]);
  });

  test('BI-14 a falha da PRIMEIRA página é a falha da operação (envelope de erro, nenhuma imagem); a de uma página seguinte mantém o que já veio e marca completa=false com a falha', async () => {
    const listarTodas = acao('listarTodas', 'carregar todas as páginas da biblioteca');
    let estado = preparar([E.erroDoServidor(503, 'IMAGENS_INDISPONIVEL')]);
    let r = await listarTodas({ origem: 'TODAS' });
    assert.deepEqual([estado.chamadas.length, r.ok, r.status, r.codigo], [1, false, 503, 'IMAGENS_INDISPONIVEL']);
    estado = preparar([pagina(1, 100, 230), new TypeError('Failed to fetch')]);
    r = await listarTodas({ origem: 'TODAS' });
    assert.equal(estado.chamadas.length, 2, 'não insiste');
    assert.equal(r.ok, true);
    assert.equal(r.dados.imagens.length, 100);
    assert.equal(r.dados.completa, false);
    assert.equal(r.dados.falha.status, 0);
  });

  test('BI-15 se a lista muda entre as páginas (item repetido), cada (origem, id) aparece uma vez; página vazia antes do total encerra sem laço', async () => {
    const listarTodas = acao('listarTodas', 'carregar todas as páginas da biblioteca');
    preparar([pagina(1, 100, 150), pagina(2, 60, 150, 'EMPRESA', 91)]);
    let r = await listarTodas({ origem: 'EMPRESA' });
    assert.equal(new Set(r.dados.imagens.map((i) => `${i.origem}:${i.id}`)).size, r.dados.imagens.length);
    assert.equal(r.dados.imagens.length, 150);
    const estado = preparar([pagina(1, 100, 500), pagina(2, 0, 500), E.resposta(500)]);
    r = await listarTodas({ origem: 'EMPRESA' });
    assert.equal(estado.chamadas.length, 2, 'parou na página vazia');
    assert.equal(r.dados.completa, false);
  });

  test('BI-16 teto de páginas: nunca mais de 50 consultas, e a lista fica marcada como incompleta', async () => {
    const roteiro = Array.from({ length: 60 }, (_, i) => pagina(i + 1, 100, 100000, 'EMPRESA', (i * 100) + 1));
    const estado = preparar(roteiro);
    const r = await acao('listarTodas', 'carregar todas as páginas da biblioteca')({ origem: 'EMPRESA' });
    assert.equal(estado.chamadas.length, 50);
    assert.equal(r.dados.completa, false);
    assert.equal(r.dados.imagens.length, 5000);
  });

  test('BI-17 só aceita as opções do contrato: origem e estado; página e limite são do próprio carregamento (TypeError antes da rede)', async () => {
    const estado = preparar([pagina(1, 0, 0)]);
    const listarTodas = acao('listarTodas', 'carregar todas as páginas da biblioteca');
    for (const opcoes of [{ origem: 'OUTRA' }, { origem: 'TODAS', pagina: 2 }, { origem: 'TODAS', limite: 10 }, { origem: 'TODAS', x: 1 }, null]) {
      let erro = null;
      try { await listarTodas(opcoes); } catch (falha) { erro = falha; }
      assert.ok(erro instanceof TypeError, JSON.stringify(opcoes));
    }
    assert.equal(estado.chamadas.length, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('5C-7 BI — textos das falhas de gerenciar e de gravar com imagem da empresa', () => {
  const casos = [
    ['falha de rede', new TypeError('Failed to fetch'), /rede|conex/i],
    ['400 nome inválido', E.erroDoServidor(400, 'VALIDACAO', { corpo: { detalhes: [{ campo: 'body.nome', codigo: 'NOME_INVALIDO', mensagem: 'x' }] } }), /nome/i],
    ['401', E.erroDoServidor(401, 'NAO_AUTENTICADO'), /sess[ãa]o/i],
    ['403', E.erroDoServidor(403, 'SEM_PERMISSAO'), /permiss/i],
    ['404 imagem não encontrada', E.erroDoServidor(404, 'IMAGEM_NAO_ENCONTRADA'), /n[ãa]o (est[áa]|foi|existe).*(dispon[íi]vel|encontrad|mais)|n[ãa]o encontrad/i],
    ['409 imagem em uso por material', E.erroDoServidor(409, 'IMAGEM_EM_USO'), /(em uso|usada).*material|material.*(em uso|usa)/is],
    ['429', E.erroDoServidor(429, 'LIMITE_REQUISICOES_EXCEDIDO'), /muitas|aguarde|tentativas/i],
    ['503', E.erroDoServidor(503, 'IMAGENS_INDISPONIVEL'), /indispon/i],
    ['500', E.erroDoServidor(500, 'ERRO_INTERNO'), /n[ãa]o foi poss[íi]vel|tente novamente/i],
    ['409 de outro motivo', E.erroDoServidor(409, 'CONFLITO'), /n[ãa]o foi poss[íi]vel|tente novamente|conflit/i],
  ];
  for (const [nome, resposta, esperado] of casos) {
    test(`BI-18 mensagens.deGerenciamento — ${nome}`, async () => {
      const mensagens = exigirQue('mensagens.deGerenciamento', () => { const x = E.biblioteca().mensagens; assert.equal(typeof x.deGerenciamento, 'function'); return x; });
      preparar([resposta]);
      const r = await EpiHttp.requisitar('POST', '/imagens-material/empresa/7001/inativar', { corpo: {} });
      const texto = mensagens.deGerenciamento(r);
      assert.equal(typeof texto, 'string');
      assert.match(texto, esperado);
      assert.equal(texto.includes(E.TEXTO_DO_SERVIDOR), false, 'o texto do servidor não pode aparecer');
    });
  }

  test('BI-19 deGravacao recebe a origem da imagem escolhida: para EMPRESA o texto não diz "Biblioteca Padrão"; para PADRAO e sem origem segue o texto da 5B (guarda)', () => {
    const { deGravacao } = E.biblioteca().mensagens;
    const nao = { status: 404, codigo: 'IMAGEM_NAO_ENCONTRADA' };
    assert.match(deGravacao(nao), /A imagem escolhida não está mais disponível/);
    assert.match(deGravacao(nao), /Biblioteca Padrão/, 'sem a origem, o texto da 5B (guarda)');
    const daEmpresa = exigirQue('deGravacao(resposta, origem) com texto próprio para a origem EMPRESA', () => {
      const t = deGravacao(nao, 'EMPRESA');
      assert.doesNotMatch(t, /Biblioteca Padrão/);
      return t;
    });
    assert.match(daEmpresa, /A imagem escolhida não está mais disponível/);
    assert.match(deGravacao(nao, 'PADRAO'), /Biblioteca Padrão/);
    const recusada = { status: 400, codigo: 'VALIDACAO', detalhes: [{ campo: 'body.imagem.id', codigo: 'ID_INVALIDO' }] };
    assert.match(deGravacao(recusada, 'EMPRESA'), /O servidor não aceitou a imagem escolhida/);
    assert.equal(deGravacao({ status: 404, codigo: 'MATERIAL_NAO_ENCONTRADO' }, 'EMPRESA'), null);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('5C-7 BI — o módulo da seleção não ganha transporte próprio nem armazenamento (guardas, nascem verdes)', () => {
  test('BI-20 imagens-material.js continua sem innerHTML, sem armazenamento do navegador e sem fetch próprio', () => {
    const codigo = E.H.lerModuloSemComentarios();
    for (const padrao of [...E.H.PROIBIDOS_DE_DOM, ...E.H.PROIBIDOS_DE_ARMAZENAMENTO, ...E.H.PROIBIDOS_DE_TRANSPORTE]) assert.equal(padrao.test(codigo), false, `${padrao}`);
  });
});
