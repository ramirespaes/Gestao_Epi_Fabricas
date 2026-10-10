'use strict';

const { describe, test, before, after, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { montarAmbienteSituacao, DISPOSITIVO } = require('./helpers/ambiente-funcionario-situacao');
const { sessaoDeTeste, CABECALHO } = require('./helpers/ambiente-http-12d2');
const { criarAppTeste } = require('../helpers/app-teste');
const { criarFuncionarioController } = require('../../src/controllers/funcionario.controller');
const { criarFuncionarioRoutes } = require('../../src/routes/funcionario.routes');
const rateLimit = require('../../src/middleware/rate-limit');
const auditoriaRepo = require('../../src/repositories/auditoria.repository');

/**
 * Revelação segura do CPF na edição (RED) contra PostgreSQL real (schema temporário de gestao_epi_teste_local):
 * `POST /api/funcionarios/:id/cpf/revelar`.
 *
 *   - autoridade employeeHistory.editar (só visualizar = 403); empresa e ator só da sessão; corpo vazio estrito;
 *   - outra empresa e inexistente: o MESMO 404, sem auditoria;
 *   - auditoria FUNCIONARIO_CPF_CONSULTADO na mesma transação, só metadados (nunca o CPF, formatado ou mascarado);
 *   - a auditoria falhando derruba a revelação sem devolver o CPF;
 *   - Cache-Control no-store; nenhum CPF em log, erro ou URL;
 *   - 10/min por ator + empresa (429 com Retry-After), contado depois da autorização;
 *   - as respostas comuns continuam sem `cpf` e o PATCH continua recusando `cpf`.
 */

// Uma instância NOVA por app (contador próprio). Enquanto a fábrica não existe, a rota também não: o RED falha pelas asserções HTTP.
const criarLimitadorRevelacaoCpf = () => (typeof rateLimit.criarLimitadorRevelacaoCpf === 'function' ? rateLimit.criarLimitadorRevelacaoCpf() : (req, res, next) => next());

const ROTA = (id) => `/api/funcionarios/${id}/cpf/revelar`;

describe('revelação do CPF — HTTP, autorização, tenancy, auditoria e privacidade', () => {
  let amb;
  let app;
  let logs;
  const mocks = [];
  before(async () => { amb = await montarAmbienteSituacao(); });
  after(async () => { if (amb) await amb.encerrar(); });
  beforeEach(() => {
    // App com limitador NOVO por teste (o contador de 10/min é do app): um teste não gasta o orçamento do outro.
    app = criarAppTeste((a) => {
      a.use('/api', criarFuncionarioRoutes({
        controller: criarFuncionarioController({ pool: amb.pool }), exigirSessao: sessaoDeTeste(amb.pool), pool: amb.pool, limitadorRevelacaoCpf: criarLimitadorRevelacaoCpf(),
      }));
    });
    logs = [];
    for (const metodo of ['log', 'error', 'warn', 'info']) mocks.push(mock.method(console, metodo, (...args) => logs.push(args.map(String).join(' '))));
  });
  afterEach(() => { mock.restoreAll(); mocks.length = 0; });

  const como = (usuarioId, ip) => ({
    post: (url, corpo = {}) => {
      const r = request(app).post(url).set(CABECALHO, String(usuarioId)).set('User-Agent', DISPOSITIVO);
      return ip ? r.set('X-Forwarded-For', ip).send(corpo) : r.send(corpo);
    },
    get: (url) => request(app).get(url).set(CABECALHO, String(usuarioId)).set('User-Agent', DISPOSITIVO),
    patch: (url, corpo) => request(app).patch(url).set(CABECALHO, String(usuarioId)).set('User-Agent', DISPOSITIVO).send(corpo),
  });
  const cpfDe = async (id) => (await amb.pool.query('SELECT cpf FROM funcionarios WHERE id = $1', [id])).rows[0].cpf;
  const linhasDeAuditoria = async (id) => (await amb.pool.query("SELECT * FROM logs_auditoria WHERE acao = 'FUNCIONARIO_CPF_CONSULTADO' AND referencia = $1 ORDER BY id", [String(id)])).rows;
  const totalDeAuditoria = async () => Number((await amb.pool.query("SELECT count(*) AS n FROM logs_auditoria WHERE acao = 'FUNCIONARIO_CPF_CONSULTADO'")).rows[0].n);
  const mascarado = (cpf) => `***.***.***-${cpf.slice(-2)}`;
  const formatos = (cpf) => [cpf, `${cpf.slice(0, 3)}.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-${cpf.slice(9)}`];

  describe('sucesso', () => {
    test('quem tem employeeHistory.editar recebe 200 com o CPF completo do funcionário, só por esta rota, com no-store', async () => {
      const id = await amb.trabalhador('ATIVO');
      const cpf = await cpfDe(id);
      const r = await como(amb.usuarios.comEditar).post(ROTA(id));
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(r.body, { status: 'ok', cpf });
      assert.match(r.headers['cache-control'] ?? '', /no-store/);
    });

    test('o MASTER também revela (autoridade pelo provisionamento padrão)', async () => {
      const id = await amb.trabalhador('AFASTADO');
      const r = await como(amb.usuarios.master).post(ROTA(id));
      assert.equal(r.status, 200);
      assert.equal(r.body.cpf, await cpfDe(id));
    });
  });

  describe('autorização e sessão', () => {
    test('sem sessão: 401, sem CPF e sem auditoria', async () => {
      const id = await amb.trabalhador('ATIVO');
      const antes = await totalDeAuditoria();
      const r = await request(app).post(ROTA(id)).send({});
      assert.equal(r.status, 401);
      assert.equal(JSON.stringify(r.body).includes(await cpfDe(id)), false);
      assert.equal(await totalDeAuditoria(), antes);
    });

    test('só visualizar ou sem permissão: 403, sem CPF e sem auditoria', async () => {
      const id = await amb.trabalhador('ATIVO');
      const cpf = await cpfDe(id);
      const antes = await totalDeAuditoria();
      for (const usuario of [amb.usuarios.soVisualizar, amb.usuarios.semPermissao]) {
        const r = await como(usuario).post(ROTA(id));
        assert.equal(r.status, 403, JSON.stringify(r.body));
        for (const f of formatos(cpf)) assert.equal(JSON.stringify(r.body).includes(f), false);
      }
      assert.equal(await totalDeAuditoria(), antes);
    });

    test('a autorização vem antes do limite: quem não pode revelar nunca recebe 429 (não consome o contador)', async () => {
      const id = await amb.trabalhador('ATIVO');
      for (let i = 0; i < 14; i += 1) assert.equal((await como(amb.usuarios.soVisualizar).post(ROTA(id))).status, 403);
    });
  });

  describe('multiempresa', () => {
    test('funcionário da outra empresa e funcionário inexistente: o MESMO 404, sem auditoria e sem CPF', async () => {
      const id = await amb.trabalhador('ATIVO');
      const cpf = await cpfDe(id);
      const antes = await totalDeAuditoria();
      const outraEmpresa = await como(amb.usuarios.masterB).post(ROTA(id));
      const inexistente = await como(amb.usuarios.master).post(ROTA(2147483000));
      assert.equal(outraEmpresa.status, 404);
      assert.equal(inexistente.status, 404);
      assert.deepEqual(outraEmpresa.body, inexistente.body, 'indistinguíveis');
      assert.equal(outraEmpresa.body.codigo, 'FUNCIONARIO_NAO_ENCONTRADO');
      for (const f of formatos(cpf)) assert.equal(JSON.stringify(outraEmpresa.body).includes(f), false);
      assert.equal(await totalDeAuditoria(), antes);
    });

    test('empresa, usuário e identidade nunca vêm do cliente: corpo ou query com esses campos é 400, sem auditoria', async () => {
      const id = await amb.trabalhador('ATIVO');
      const antes = await totalDeAuditoria();
      for (const corpo of [{ empresaId: 1 }, { usuarioId: 1 }, { identidadeId: 1 }, { funcionarioId: id }, { cpf: '52998224725' }, { outro: true }]) {
        const r = await como(amb.usuarios.comEditar).post(ROTA(id), corpo);
        assert.equal(r.status, 400, JSON.stringify(corpo));
        assert.equal(r.body.codigo, 'VALIDACAO');
      }
      const comQuery = await request(app).post(`${ROTA(id)}?empresaId=2&cpf=52998224725`).set(CABECALHO, String(amb.usuarios.comEditar)).send({});
      assert.equal(comQuery.status, 400, 'a query não define escopo nem aceita CPF');
      assert.equal(await totalDeAuditoria(), antes);
    });

    test('id inválido na URL é 400', async () => {
      for (const id of ['0', '-3', 'abc', '1.5']) {
        const r = await como(amb.usuarios.comEditar).post(ROTA(id));
        assert.equal(r.status, 400, id);
      }
    });
  });

  describe('auditoria', () => {
    test('uma linha por revelação: ator, empresa, funcionário, instante, finalidade EDICAO, IP e dispositivo — nunca o CPF', async () => {
      const id = await amb.trabalhador('ATIVO');
      const cpf = await cpfDe(id);
      assert.equal((await como(amb.usuarios.comEditar).post(ROTA(id))).status, 200);
      const linhas = await linhasDeAuditoria(id);
      assert.equal(linhas.length, 1);
      const [l] = linhas;
      assert.equal(l.acao, 'FUNCIONARIO_CPF_CONSULTADO');
      assert.equal(Number(l.empresa_id), amb.d.empresaA);
      assert.equal(Number(l.usuario_id), amb.usuarios.comEditar);
      assert.equal(l.referencia, String(id));
      assert.equal(l.dispositivo, DISPOSITIVO);
      assert.ok(l.ip, 'IP registrado pelo mecanismo existente');
      assert.deepEqual(l.contexto, { finalidade: 'EDICAO' });
      assert.equal(l.dados_anteriores, null);
      assert.equal(l.dados_novos, null);
      assert.ok(Math.abs(new Date(l.criado_em).getTime() - Date.now()) < 60_000, 'data/hora do servidor');
      const tudo = JSON.stringify(l);
      for (const proibido of [...formatos(cpf), mascarado(cpf), '***.***']) assert.equal(tudo.includes(proibido), false, `auditoria contém ${proibido}`);
    });

    test('cada revelação gera a sua linha (consultas repetidas não são agregadas)', async () => {
      const id = await amb.trabalhador('ATIVO');
      await como(amb.usuarios.comEditar).post(ROTA(id));
      await como(amb.usuarios.master).post(ROTA(id));
      const linhas = await linhasDeAuditoria(id);
      assert.deepEqual(linhas.map((x) => Number(x.usuario_id)), [amb.usuarios.comEditar, amb.usuarios.master]);
    });

    test('a auditoria falhando derruba a revelação: 500 genérico, nenhum CPF no corpo, nenhuma linha, nenhum vazamento em log', async () => {
      const id = await amb.trabalhador('ATIVO');
      const cpf = await cpfDe(id);
      const original = auditoriaRepo.registrar;
      mock.method(auditoriaRepo, 'registrar', async (executor, dados) => {
        if (dados.acao === 'FUNCIONARIO_CPF_CONSULTADO') throw new Error('falha simulada da auditoria');
        return original(executor, dados);
      });
      const r = await como(amb.usuarios.comEditar).post(ROTA(id));
      assert.equal(r.status, 500);
      for (const f of formatos(cpf)) assert.equal(JSON.stringify(r.body).includes(f), false);
      assert.equal((await linhasDeAuditoria(id)).length, 0);
      for (const f of formatos(cpf)) assert.equal(logs.join('\n').includes(f), false, 'nem nos logs técnicos');
    });
  });

  describe('privacidade', () => {
    test('nenhum CPF em log nem console durante a revelação, e a rota só existe como POST (GET não revela)', async () => {
      const id = await amb.trabalhador('ATIVO');
      const cpf = await cpfDe(id);
      await como(amb.usuarios.comEditar).post(ROTA(id));
      for (const f of formatos(cpf)) assert.equal(logs.join('\n').includes(f), false, `log contém ${f}`);
      const get = await como(amb.usuarios.comEditar).get(ROTA(id));
      assert.equal(get.status, 404, 'sem GET');
      assert.equal(JSON.stringify(get.body).includes(cpf), false);
    });

    test('as respostas comuns continuam sem CPF completo: GET, lista, consulta-cpf e PATCH', async () => {
      const id = await amb.trabalhador('ATIVO');
      // O CPF semeado pelo mundo de teste não tem dígitos verificadores válidos; a consulta por CPF exige um válido.
      await amb.pool.query("UPDATE funcionarios SET cpf = '39053344705' WHERE id = $1", [id]);
      const cpf = await cpfDe(id);
      const respostas = [
        await como(amb.usuarios.comEditar).get(`/api/funcionarios/${id}`),
        await como(amb.usuarios.comEditar).get('/api/funcionarios?limite=100'),
        await como(amb.usuarios.comEditar).post('/api/funcionarios/consulta-cpf', { cpf }),
        await como(amb.usuarios.comEditar).patch(`/api/funcionarios/${id}`, { setor: 'Qualquer setor' }),
      ];
      for (const r of respostas) {
        assert.equal(r.status, 200, JSON.stringify(r.body));
        const texto = JSON.stringify(r.body);
        for (const f of formatos(cpf)) assert.equal(texto.includes(f), false, `resposta comum contém ${f}`);
        assert.equal(/"cpf"\s*:/.test(texto), false, 'sem a chave cpf');
        assert.match(texto, /cpfMascarado/);
      }
    });

    test('o CPF continua imutável: PATCH com cpf é 400 e nada muda', async () => {
      const id = await amb.trabalhador('ATIVO');
      const antes = await cpfDe(id);
      const r = await como(amb.usuarios.comEditar).patch(`/api/funcionarios/${id}`, { cpf: '11144477735' });
      assert.equal(r.status, 400);
      assert.equal(await cpfDe(id), antes);
    });
  });
});

describe('revelação do CPF — limite de 10 por minuto por ator + empresa', () => {
  let amb;
  let app;
  before(async () => {
    amb = await montarAmbienteSituacao();
    app = criarAppTeste((a) => {
      a.use('/api', criarFuncionarioRoutes({
        controller: criarFuncionarioController({ pool: amb.pool }), exigirSessao: sessaoDeTeste(amb.pool), pool: amb.pool, limitadorRevelacaoCpf: criarLimitadorRevelacaoCpf(),
      }));
    });
  });
  after(async () => { if (amb) await amb.encerrar(); });

  const revelar = (usuario, id, ip = '203.0.113.5') => request(app).post(ROTA(id)).set(CABECALHO, String(usuario)).set('X-Forwarded-For', ip).send({});
  const total = async () => Number((await amb.pool.query("SELECT count(*) AS n FROM logs_auditoria WHERE acao = 'FUNCIONARIO_CPF_CONSULTADO'")).rows[0].n);

  test('10 revelações passam e a 11ª é 429 com Retry-After, sem CPF e SEM auditoria de revelação; outro ator da empresa segue livre', async () => {
    const id = await amb.trabalhador('ATIVO');
    const cpf = (await amb.pool.query('SELECT cpf FROM funcionarios WHERE id = $1', [id])).rows[0].cpf;
    for (let i = 0; i < 10; i += 1) assert.equal((await revelar(amb.usuarios.comEditar, id)).status, 200, `revelação ${i + 1}`);
    assert.equal(await total(), 10);
    const bloqueada = await revelar(amb.usuarios.comEditar, id);
    assert.equal(bloqueada.status, 429);
    assert.equal(bloqueada.body.codigo, 'LIMITE_REQUISICOES_EXCEDIDO');
    assert.ok(Number(bloqueada.headers['retry-after']) >= 1, 'Retry-After');
    assert.equal(JSON.stringify(bloqueada.body).includes(cpf), false);
    assert.equal(await total(), 10, 'o 429 não gera auditoria de revelação');
    const colega = await revelar(amb.usuarios.master, id);
    assert.equal(colega.status, 200, 'o IP é o mesmo; a chave é ator + empresa');
    assert.equal(await total(), 11);
  });
});
