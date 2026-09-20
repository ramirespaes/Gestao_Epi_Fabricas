'use strict';

const { describe, test, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { z } = require('zod');
const { validar, detalhesDePoliticaSenha, MENSAGENS_VALIDACAO } = require('../../src/middleware/validar');
const authSchema = require('../../src/schemas/auth.schema');
const usuarioSchema = require('../../src/schemas/usuario.schema');
const { validarPoliticaSenha } = require('../../src/security/password-policy');
const { criarAppTeste } = require('../helpers/app-teste');
const { assertSemSensiveis } = require('../helpers/sensiveis');

const SENHA = 'MinhaSenha#2026';
const EMAIL = 'luis@empresa.com';
const CNPJ = '12345678000195';
const TOKEN = 'tokenSecretoXYZ987';
const VALOR_EXTRA = 'valorExtraSensivel555';
const SENSIVEIS = [SENHA, EMAIL, CNPJ, TOKEN, VALOR_EXTRA, 'Bearer'];
const CABECALHOS = { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN, cookie: 'gepi_sessao=' + TOKEN };
const LOGIN = { cnpj: '12.345.678/0001-95', email: ' Luis@Empresa.COM ', senha: '  ' + SENHA + '  ' };

let observado;
const eco = (req, res) => {
  observado = { temValidado: Object.hasOwn(req, 'validado'), validado: req.validado, body: req.body, query: { ...req.query }, params: { ...req.params } };
  res.json({ ok: true, validado: req.validado });
};

const app = criarAppTeste((a) => {
  a.post('/login', validar(authSchema.login), eco);
  a.post('/troca', validar(authSchema.trocaSenha), eco);
  a.post('/usuarios', validar(usuarioSchema.criar), eco);
  a.patch('/usuarios/:id', validar(usuarioSchema.editar), eco);
  a.get('/usuarios', validar(usuarioSchema.listar), eco);
  a.patch('/usuarios/:id/inativar', validar(usuarioSchema.acaoPorId), eco);
  a.post('/tres/:id', validar({
    params: usuarioSchema.porId.params,
    query: z.strictObject({ limite: z.string().max(2) }),
    body: z.strictObject({ nome: z.string().min(3), codigo: z.string().regex(/^[a-z]+$/).optional(), lista: z.array(z.string()).optional() }),
  }), eco);
  a.post('/reatribuir', validar(authSchema.login), (req, res) => { req.validado = {}; res.json({ ok: true }); });
  a.use((err, req, res, next) => { observado = { temValidado: Object.hasOwn(req, 'validado'), validado: req.validado }; next(err); });
});

const cods = (r) => r.body.detalhes.map((d) => `${d.campo}:${d.codigo}`);
const post = (caminho, corpo) => request(app).post(caminho).set(CABECALHOS).send(corpo);

let logs;
beforeEach(() => {
  observado = null;
  logs = [];
  mock.method(console, 'error', (...args) => logs.push(args.map(String).join(' ')));
});
afterEach(() => mock.restoreAll());

describe('configuração do middleware', () => {
  test('configuração incorreta lança TypeError na montagem', () => {
    for (const ruim of [undefined, null, {}, [], 'x', { headers: z.object({}) }, { body: {} }, { body: null }, { body: z.string(), cookies: z.string() }]) {
      assert.throws(() => validar(ruim), TypeError);
    }
    assert.equal(typeof validar({ body: z.strictObject({}) }), 'function');
  });
});

describe('sucesso', () => {
  test('body transformado em req.validado; req.body intacto; só as origens declaradas', async () => {
    const r = await post('/login', LOGIN);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.validado, { body: { cnpj: CNPJ, email: EMAIL, senha: '  ' + SENHA + '  ' } });
    assert.deepEqual(observado.body, LOGIN);
    assert.deepEqual(Object.keys(observado.validado), ['body']);
  });

  test('query transformada; req.query intacto', async () => {
    const r = await request(app).get('/usuarios?pagina=2&ativo=true&busca=%20Jo%C3%A3o%20');
    assert.deepEqual(r.body.validado, { query: { pagina: 2, limite: 20, ativo: true, busca: 'João' } });
    assert.deepEqual(observado.query, { pagina: '2', ativo: 'true', busca: ' João ' });
  });

  test('params e body juntos; req.params intacto; corpo vazio nas ações', async () => {
    const r = await request(app).patch('/usuarios/42').send({ nome: ' Ana ' });
    assert.deepEqual(r.body.validado, { params: { id: 42 }, body: { nome: 'Ana' } });
    assert.deepEqual(observado.params, { id: '42' });
    const a = await request(app).patch('/usuarios/7/inativar');
    assert.deepEqual(a.body.validado, { params: { id: 7 }, body: {} });
  });

  test('req.validado e suas partes são congelados; a propriedade não é gravável', async () => {
    await post('/tres/42?limite=ab', { nome: 'abc' });
    assert.equal(Object.isFrozen(observado.validado), true);
    for (const parte of ['params', 'query', 'body']) {
      assert.equal(Object.isFrozen(observado.validado[parte]), true, parte);
    }
    const r = await post('/reatribuir', LOGIN);
    assert.deepEqual([r.status, r.body.codigo], [500, 'ERRO_INTERNO']);
    assert.equal(logs.length, 1);
    assertSemSensiveis(logs[0], SENSIVEIS, 'log');
  });
});

describe('atomicidade e ordem', () => {
  test('falha em uma origem: req.validado nunca é criado', async () => {
    const r = await post('/tres/42?limite=ab', { nome: 'ab' });
    assert.equal(r.status, 400);
    assert.equal(observado.temValidado, false);
    assert.equal(observado.validado, undefined);
    assert.deepEqual(cods(r), ['body.nome:TAMANHO_MINIMO']);
    assert.deepEqual(r.body.detalhes[0], { campo: 'body.nome', codigo: 'TAMANHO_MINIMO', mensagem: 'Valor abaixo do limite permitido', limite: 3 });
  });

  test('as três origens inválidas: detalhes na ordem params, query, body', async () => {
    const r = await post('/tres/007?limite=abc', { nome: 1, codigo: 'ABC', lista: ['a', 2] });
    assert.deepEqual(cods(r), ['params.id:ID_INVALIDO', 'query.limite:TAMANHO_MAXIMO', 'body.nome:TIPO_INVALIDO', 'body.codigo:FORMATO_INVALIDO', 'body.lista.1:TIPO_INVALIDO']);
    assert.equal(observado.temValidado, false);
    assert.equal(r.body.detalhes[1].limite, 2);
    assert.equal(r.body.detalhes[1].mensagem, 'Valor acima do limite permitido');
  });

  test('as três origens válidas: todas presentes', async () => {
    const r = await post('/tres/42?limite=ab', { nome: 'abc' });
    assert.deepEqual(r.body.validado, { params: { id: 42 }, query: { limite: 'ab' }, body: { nome: 'abc' } });
  });
});

describe('formato público e corpo', () => {
  test('corpo ausente aponta cada campo obrigatório; código de topo VALIDACAO', async () => {
    const r = await request(app).post('/login').set(CABECALHOS);
    assert.deepEqual([r.status, r.body.status, r.body.codigo, r.body.message], [400, 'error', 'VALIDACAO', 'Dados inválidos']);
    assert.deepEqual(cods(r), ['body.cnpj:CAMPO_OBRIGATORIO', 'body.email:CAMPO_OBRIGATORIO', 'body.senha:CAMPO_OBRIGATORIO']);
  });

  test('array na raiz é CORPO_INVALIDO; JSON malformado segue como JSON_INVALIDO', async () => {
    const r = await post('/login', '[]');
    assert.deepEqual(r.body.detalhes, [{ campo: 'body', codigo: 'CORPO_INVALIDO', mensagem: MENSAGENS_VALIDACAO.CORPO_INVALIDO }]);
    assert.equal(observado.temValidado, false);
    for (const corpo of ['"texto"', 'null', '42']) {
      const j = await post('/login', corpo);
      assert.deepEqual([j.status, j.body.codigo, 'detalhes' in j.body], [400, 'JSON_INVALIDO', false]);
    }
    const m = await post('/login', '{bad');
    assert.deepEqual(m.body, { status: 'error', codigo: 'JSON_INVALIDO', message: 'JSON inválido' });
  });

  test('null, string e número entregues diretamente ao middleware: CORPO_INVALIDO; params não objeto: ENTRADA_INVALIDA', () => {
    const middleware = validar(authSchema.login);
    for (const corpo of [null, 'texto', 42]) {
      let erro;
      middleware({ body: corpo }, {}, (e) => { erro = e; });
      assert.deepEqual(erro.detalhes, [{ campo: 'body', codigo: 'CORPO_INVALIDO', mensagem: MENSAGENS_VALIDACAO.CORPO_INVALIDO }]);
    }
    let erro;
    validar(usuarioSchema.porId)({ params: 'texto' }, {}, (e) => { erro = e; });
    assert.deepEqual(erro.detalhes, [{ campo: 'params', codigo: 'ENTRADA_INVALIDA', mensagem: MENSAGENS_VALIDACAO.ENTRADA_INVALIDA }]);
  });

  test('campo obrigatório versus tipo inválido pela existência da propriedade', async () => {
    assert.deepEqual(cods(await post('/login', { cnpj: CNPJ, email: EMAIL })), ['body.senha:CAMPO_OBRIGATORIO']);
    assert.deepEqual(cods(await post('/login', { cnpj: CNPJ, email: EMAIL, senha: 123 })), ['body.senha:TIPO_INVALIDO']);
    assert.deepEqual(cods(await post('/login', { cnpj: CNPJ, email: EMAIL, senha: null })), ['body.senha:TIPO_INVALIDO']);
  });

  test('query repetida chega como array: código nativo mapeado', async () => {
    const a = await request(app).get('/usuarios?ativo=true&ativo=false');
    assert.deepEqual(cods(a), ['query.ativo:VALOR_NAO_PERMITIDO']);
    assert.equal(a.body.detalhes[0].mensagem, 'Valor não permitido');
    assert.deepEqual(cods(await request(app).get('/usuarios?pagina=1&pagina=2')), ['query.pagina:TIPO_INVALIDO']);
  });

  test('códigos customizados com caminhos públicos', async () => {
    const l = await post('/login', { ...LOGIN, email: 'josé@x.com', senha: '' });
    assert.deepEqual(cods(l), ['body.email:EMAIL_INVALIDO', 'body.senha:SENHA_VAZIA']);
    assert.equal(l.body.detalhes[0].mensagem, 'E-mail inválido');
    const e = await request(app).patch('/usuarios/5').send({});
    assert.deepEqual(e.body.detalhes, [{ campo: 'body', codigo: 'NENHUM_CAMPO', mensagem: 'Informe ao menos um campo para atualizar' }]);
    assert.deepEqual(cods(await post('/troca', { senhaAtual: 'a', novaSenha: 'b', confirmacaoNovaSenha: 'c' })), ['body.confirmacaoNovaSenha:SENHAS_NAO_CONFEREM']);
    assert.deepEqual(cods(await request(app).patch('/usuarios/0').send({ nome: 'Ana' })), ['params.id:ID_INVALIDO']);
    assert.deepEqual(cods(await request(app).get('/usuarios?limite=101')), ['query.limite:FORA_DO_INTERVALO']);
  });
});

describe('chaves desconhecidas', () => {
  test('nome seguro aparece no campo; valor nunca', async () => {
    const r = await request(app).get(`/usuarios?limte=${VALOR_EXTRA}`);
    assert.deepEqual(r.body.detalhes, [{ campo: 'query.limte', codigo: 'CAMPO_NAO_PERMITIDO', mensagem: 'Campo não permitido' }]);
    assertSemSensiveis(r.text, SENSIVEIS, 'resposta');
    const u = await post('/usuarios', { nome: 'Ana', email: EMAIL, senha: SENHA, perfil: 'USUARIO', empresa_id: 1, senha_hash: TOKEN, ativo: false });
    assert.deepEqual(cods(u), ['body.empresa_id:CAMPO_NAO_PERMITIDO', 'body.senha_hash:CAMPO_NAO_PERMITIDO', 'body.ativo:CAMPO_NAO_PERMITIDO']);
    assertSemSensiveis(u.text, SENSIVEIS, 'resposta');
  });

  test('nome estranho vira detalhe genérico da origem, sem o nome', async () => {
    for (const chave of ['a b', 'x'.repeat(200), '<script>', 'a.b', '__proto__x$', '1abc', 'ç']) {
      const r = await post('/login', { ...LOGIN, [chave]: VALOR_EXTRA });
      assert.deepEqual(r.body.detalhes, [{ campo: 'body', codigo: 'CAMPO_NAO_PERMITIDO', mensagem: 'Campo não permitido' }], chave);
      assert.equal(r.text.includes(chave.slice(0, 8)), false, 'nome inseguro exposto: ' + chave);
      assertSemSensiveis(r.text, SENSIVEIS, 'resposta');
    }
  });

  test('mais de cinco chaves: cinco nomeadas e uma genérica; corte global em 20 detalhes', async () => {
    const extras = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`extra${i}`, VALOR_EXTRA]));
    const r = await post('/login', { ...LOGIN, ...extras });
    assert.equal(r.body.detalhes.length, 6);
    assert.deepEqual(r.body.detalhes.slice(0, 5).map((d) => d.campo), ['body.extra0', 'body.extra1', 'body.extra2', 'body.extra3', 'body.extra4']);
    assert.equal(r.body.detalhes[5].campo, 'body');
    assertSemSensiveis(r.text, SENSIVEIS, 'resposta');
    const muitos = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, i]));
    const c = await post('/tres/0?limite=abc', { nome: 1, ...muitos });
    assert.ok(c.body.detalhes.length <= 20);
  });
});

describe('dados sensíveis e helper de política', () => {
  test('respostas de erro nunca contêm senha, e-mail, CNPJ, token, cookie ou Authorization; sem log', async () => {
    const casos = [
      post('/login', { ...LOGIN, senha: '' }),
      post('/troca', { senhaAtual: SENHA, novaSenha: SENHA, confirmacaoNovaSenha: SENHA }),
      post('/usuarios', { nome: '', email: EMAIL, senha: SENHA, perfil: 'x', token: TOKEN }),
      request(app).get(`/usuarios?busca=${encodeURIComponent(SENHA)}&limte=${encodeURIComponent(TOKEN)}`).set(CABECALHOS),
    ];
    for (const r of await Promise.all(casos)) {
      assert.equal(r.status, 400);
      assertSemSensiveis(r.text, SENSIVEIS, 'resposta');
      for (const d of r.body.detalhes) {
        assert.deepEqual(Object.keys(d).sort(), ['campo', 'codigo', 'mensagem']);
      }
    }
    assert.deepEqual(logs, []);
  });

  test('detalhesDePoliticaSenha só reformata o resultado da política', () => {
    const resultado = validarPoliticaSenha('senha', { email: EMAIL });
    const detalhes = detalhesDePoliticaSenha(resultado);
    assert.ok(detalhes.length > 0);
    assert.deepEqual(detalhes.map((d) => d.campo), detalhes.map(() => 'body.novaSenha'));
    assert.deepEqual(detalhes.map((d) => d.codigo), resultado.erros.map((e) => e.codigo));
    assert.deepEqual(detalhesDePoliticaSenha({ ok: true, erros: [] }, 'body.senha'), []);
  });
});
