'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { exigirModulo } = require('../helpers/exigir-modulo');

const { criarImagemMaterialController } = require('../../src/controllers/imagem-material.controller');

/**
 * Controller da biblioteca de imagens de produto (Biblioteca de Imagens, Unidade 4): traduz requisição em chamada de serviço e resultado em
 * resposta HTTP. Empresa e ator só da sessão (req.empresa, req.usuario); o identificador da imagem só de req.validado.params, que chega como
 * texto decimal canônico (BIGINT) e nunca vira número; os campos de negócio, só de req.validado. O controller NUNCA lê req.body, req.params nem
 * req.query brutos: aqui os três devolvem valores hostis (outra empresa, outro ator, outra imagem) e registram o acesso, para o teste provar que
 * ninguém os tocou. Defesa em profundidade: pela rota real o schema estrito já recusa essas chaves antes de o controller existir.
 */

const servico = () => exigirModulo('src/services/imagem-material.service');
const respostaFalsa = () => ({ statusCode: 0, corpo: null, status(c) { this.statusCode = c; return this; }, json(b) { this.corpo = b; return this; } });

const ID_MAXIMO = '9223372036854775807';
const CONTEXTO = { empresaId: 3, atorId: 9, ip: '203.0.113.10', dispositivo: 'Navegador de teste' };
const IMAGEM = { id: ID_MAXIMO, origem: 'EMPRESA', nome: 'Luva nitrílica', estado: 'ATIVA' };
const HOSTIL = Object.freeze({
  empresaId: 999, atorId: 777, usuarioId: 777, id: '1', imagemId: '1', nome: 'nome hostil', confirmacao: false, origem: 'PADRAO', estado: 'TODAS', busca: 'hostil', tipoNome: 'hostil',
});

function requisicao(validado) {
  const acessos = [];
  const req = { empresa: { id: 3 }, usuario: { id: 9 }, ip: '203.0.113.10', headers: { 'user-agent': 'Navegador de teste' }, validado };
  for (const nome of ['body', 'params', 'query']) {
    Object.defineProperty(req, nome, { enumerable: true, get() { acessos.push(nome); return HOSTIL; } });
  }
  return { req, acessos };
}

describe('GET /imagens-material', () => {
  test('lê só da empresa da sessão, com o que o schema validou; busca e tipoNome ausentes viram null; responde 200 com a página do serviço', async (t) => {
    const chamada = {};
    const resultado = { imagens: [IMAGEM], total: 1, pagina: 2, limite: 25 };
    t.mock.method(servico(), 'listar', async (pool, dados) => { chamada.pool = pool; chamada.dados = dados; return resultado; });
    const pool = { marca: 'pool' };
    const { req, acessos } = requisicao({ query: { origem: 'EMPRESA', estado: 'ATIVA', pagina: 2, limite: 25 } });
    const res = respostaFalsa();
    await criarImagemMaterialController({ pool }).listar(req, res);
    assert.equal(chamada.pool, pool);
    assert.deepEqual(chamada.dados, { empresaId: 3, origem: 'EMPRESA', estado: 'ATIVA', busca: null, tipoNome: null, pagina: 2, limite: 25 });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.corpo, { status: 'ok', ...resultado });
    assert.deepEqual(acessos, []);
  });

  test('repassa busca e tipoNome quando vieram validados', async (t) => {
    const chamada = {};
    t.mock.method(servico(), 'listar', async (_pool, dados) => { chamada.dados = dados; return { imagens: [], total: 0, pagina: 1, limite: 20 }; });
    const { req, acessos } = requisicao({ query: { origem: 'TODAS', estado: 'TODAS', busca: 'luva', tipoNome: 'Luva', pagina: 1, limite: 20 } });
    await criarImagemMaterialController({ pool: {} }).listar(req, respostaFalsa());
    assert.deepEqual(chamada.dados, { empresaId: 3, origem: 'TODAS', estado: 'TODAS', busca: 'luva', tipoNome: 'Luva', pagina: 1, limite: 20 });
    assert.deepEqual(acessos, []);
  });
});

describe('PATCH /imagens-material/empresa/:id', () => {
  test('empresa e ator da sessão; imagem do caminho validado (texto BIGINT intacto); nome do corpo validado; ip e dispositivo da requisição', async (t) => {
    const chamada = {};
    t.mock.method(servico(), 'renomear', async (pool, dados) => { chamada.pool = pool; chamada.dados = dados; return { imagem: IMAGEM, alterado: true }; });
    const pool = { marca: 'pool' };
    const { req, acessos } = requisicao({ params: { id: ID_MAXIMO }, body: { nome: 'Luva nitrílica' } });
    const res = respostaFalsa();
    await criarImagemMaterialController({ pool }).renomear(req, res);
    assert.equal(chamada.pool, pool);
    assert.deepEqual(chamada.dados, { ...CONTEXTO, imagemId: ID_MAXIMO, nome: 'Luva nitrílica' });
    assert.equal(typeof chamada.dados.imagemId, 'string', 'o identificador BIGINT nunca vira número');
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.corpo, { status: 'ok', imagem: IMAGEM, alterado: true });
    assert.deepEqual(acessos, []);
  });
});

describe('POST /imagens-material/empresa/:id/inativar e /reativar', () => {
  test('inativar chama só inativar: empresa e ator da sessão, imagem do caminho validado; responde 200 com imagem e alterado', async (t) => {
    const chamada = {};
    t.mock.method(servico(), 'inativar', async (pool, dados) => { chamada.pool = pool; chamada.dados = dados; return { imagem: { ...IMAGEM, estado: 'INATIVA' }, alterado: true }; });
    const reativar = t.mock.method(servico(), 'reativar', async () => assert.fail('reativar não pode ser chamada'));
    const pool = { marca: 'pool' };
    const { req, acessos } = requisicao({ params: { id: ID_MAXIMO }, body: {} });
    const res = respostaFalsa();
    await criarImagemMaterialController({ pool }).inativar(req, res);
    assert.equal(chamada.pool, pool);
    assert.deepEqual(chamada.dados, { ...CONTEXTO, imagemId: ID_MAXIMO });
    assert.equal(reativar.mock.callCount(), 0);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.corpo, { status: 'ok', imagem: { ...IMAGEM, estado: 'INATIVA' }, alterado: true });
    assert.deepEqual(acessos, []);
  });

  test('reativar chama só reativar; repetir sem mudança continua 200 com alterado false', async (t) => {
    const chamada = {};
    t.mock.method(servico(), 'reativar', async (pool, dados) => { chamada.pool = pool; chamada.dados = dados; return { imagem: IMAGEM, alterado: false }; });
    const inativar = t.mock.method(servico(), 'inativar', async () => assert.fail('inativar não pode ser chamada'));
    const pool = { marca: 'pool' };
    const { req, acessos } = requisicao({ params: { id: ID_MAXIMO }, body: {} });
    const res = respostaFalsa();
    await criarImagemMaterialController({ pool }).reativar(req, res);
    assert.equal(chamada.pool, pool);
    assert.deepEqual(chamada.dados, { ...CONTEXTO, imagemId: ID_MAXIMO });
    assert.equal(inativar.mock.callCount(), 0);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.corpo, { status: 'ok', imagem: IMAGEM, alterado: false });
    assert.deepEqual(acessos, []);
  });
});

describe('DELETE /imagens-material/empresa/:id', () => {
  test('empresa e ator da sessão; imagem do caminho validado; confirmação do corpo validado; responde 200 com excluida e imagemId (nunca 201)', async (t) => {
    const chamada = {};
    t.mock.method(servico(), 'excluir', async (pool, dados) => { chamada.pool = pool; chamada.dados = dados; return { excluida: true, imagemId: ID_MAXIMO }; });
    const pool = { marca: 'pool' };
    const { req, acessos } = requisicao({ params: { id: ID_MAXIMO }, body: { confirmacao: true } });
    const res = respostaFalsa();
    await criarImagemMaterialController({ pool }).excluir(req, res);
    assert.equal(chamada.pool, pool);
    assert.deepEqual(chamada.dados, { ...CONTEXTO, imagemId: ID_MAXIMO, confirmacao: true });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.corpo, { status: 'ok', excluida: true, imagemId: ID_MAXIMO });
    assert.deepEqual(acessos, []);
  });
});

describe('erros do serviço', () => {
  test('a rejeição do serviço sobe como está (o errorHandler do Express 5 responde) e nenhuma resposta é escrita pelo controller', async (t) => {
    const erro = Object.assign(new Error('falha do serviço'), { statusCode: 409, codigo: 'IMAGEM_EM_USO' });
    t.mock.method(servico(), 'excluir', async () => { throw erro; });
    const { req } = requisicao({ params: { id: ID_MAXIMO }, body: { confirmacao: true } });
    const res = respostaFalsa();
    await assert.rejects(criarImagemMaterialController({ pool: {} }).excluir(req, res), (e) => e === erro);
    assert.equal(res.statusCode, 0);
    assert.equal(res.corpo, null);
  });
});
