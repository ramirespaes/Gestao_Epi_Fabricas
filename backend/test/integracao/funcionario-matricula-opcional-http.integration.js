'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { abrirPoolTemporario } = require('./helpers/schema-temporario');
const { todasAsMigrations } = require('./helpers/entrega-epi');
const { turnstileDeTeste, TOKEN_TURNSTILE_TESTE } = require('./helpers/turnstile-teste');
const { criarAppTeste } = require('../helpers/app-teste');
const { criarAuthGlobalController } = require('../../src/controllers/auth-global.controller');
const { criarAuthGlobalRoutes } = require('../../src/routes/auth-global.routes');
const { criarFuncionarioController } = require('../../src/controllers/funcionario.controller');
const { criarFuncionarioRoutes } = require('../../src/routes/funcionario.routes');
const { criarExigirSessao } = require('../../src/middleware/autenticacao');
const { criarExigirSessaoGlobal } = require('../../src/middleware/autenticacao-global');
const { criarLimitador } = require('../../src/middleware/rate-limit');
const { gerarHashSenha } = require('../../src/security/password');
const { authConfig } = require('../../src/config/auth');
const provisionamento = require('../../src/services/provisionamento-permissoes.service');
const declaracao = require('../../src/services/declaracao-lgpd');

/**
 * 12K-E — matrícula OPCIONAL (CPF obrigatório) no cadastro manual e na importação, e Situação obrigatória
 * ("Ativo") na importação. PostgreSQL real em schema temporário com todas as migrations. Sem a migration 081
 * estes testes falham pelo motivo esperado: funcionarios.matricula ainda é NOT NULL e o contrato ainda a exige.
 * Dados sintéticos.
 */

const SENHA = 'senha-forte-da-12k-e-2026';
const EMAIL = 'master.12ke@exemplo-cliente.com.br';
const EMAIL_IMPORTADOR = 'importador.12ke@exemplo-cliente.com.br'; // só a ação IMPORTAR_FUNCIONARIOS, sem employeeGroups
const EMAIL_SEM_IMPORTAR = 'sem-importar.12ke@exemplo-cliente.com.br';
const { cookieNome: C_EMPRESA, cookieNomeGlobal: C_GLOBAL } = authConfig.sessao;

function gerarCpf(n) {
  const base = String(100000000 + n).slice(-9).split('').map(Number);
  const dv = (d) => { const r = (d.reduce((s, x, i) => s + x * (d.length + 1 - i), 0) * 10) % 11; return r === 10 ? 0 : r; };
  const d1 = dv(base);
  return [...base, d1, dv([...base, d1])].join('');
}
function cookiesDe(resposta) {
  const saida = {};
  for (const bruto of resposta.headers['set-cookie'] || []) {
    const [par] = bruto.split(';');
    const i = par.indexOf('=');
    saida[par.slice(0, i)] = par.slice(i + 1);
  }
  return saida;
}

const GHE = 'GHE Produção';
// Linha do layout oficial: sem matrícula, telefone nem nascimento; Situação sempre presente.
const linhaImp = (linha, cpf, extra = {}) => ({
  linha, nome: `Funcionário 12KE ${linha}`, cpf, dataAdmissao: '2020-06-01', setor: 'Produção', funcao: 'Operador', ghe: GHE, situacao: 'Ativo', ...extra,
});
const lote = (linhas, extra = {}) => ({
  importacaoId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
  lote: { numero: 1, total: 1 },
  arquivo: { nome: 'funcionarios.xlsx', formato: 'xlsx', totalLinhas: linhas.length },
  declaracaoLgpd: { versao: declaracao.VERSAO_ATUAL, confirmada: true },
  linhas,
  ...extra,
});
// S4: o cadastro individual também exige o GHE (criado no `before`).
let gheDoCadastro;
const cadastro = (cpf, extra = {}) => ({
  nome: 'Pessoa Manual', cpf, setor: 'Produção', funcao: 'Operador', dataAdmissao: '2020-06-01', grupoHomogeneoId: gheDoCadastro, ...extra,
});

describe('12K-E — matrícula opcional e Situação obrigatória (PostgreSQL real)', () => {
  let contexto;
  let pool;
  let app;
  let empresa;
  let cookie;
  let cookieImportador;
  let cookieSemImportar;

  // A importação responde 200 com um resultado por linha; qualquer outro status é a falha funcional, e o teste para aqui.
  const importar = async (corpo) => {
    const r = await request(app).post('/api/funcionarios/importacao').set('Cookie', cookie).send(corpo);
    assert.equal(r.status, 200, `importação esperada com 200: ${JSON.stringify(r.body)}`);
    return r;
  };
  const criarManual = async (corpo) => {
    const r = await request(app).post('/api/funcionarios').set('Cookie', cookie).send(corpo);
    assert.equal(r.status, 201, `cadastro esperado com 201: ${JSON.stringify(r.body)}`);
    return r;
  };
  const manual = (corpo) => request(app).post('/api/funcionarios').set('Cookie', cookie).send(corpo);
  const alterar = (id, corpo) => request(app).patch(`/api/funcionarios/${id}`).set('Cookie', cookie).send(corpo);
  const doBanco = async (cpf) => (await pool.query('SELECT id, matricula, ativo FROM funcionarios WHERE empresa_id = $1 AND cpf = $2', [empresa, cpf])).rows;

  before(async () => {
    contexto = await abrirPoolTemporario(todasAsMigrations());
    pool = contexto.pool;
    const hash = await gerarHashSenha(SENHA);
    empresa = (await pool.query("INSERT INTO empresas (nome, cnpj) VALUES ('Empresa 12KE', '11222333000181') RETURNING id")).rows[0].id;
    await provisionamento.provisionar(pool, { empresaId: empresa, dryRun: false });
    const idn = (await pool.query('INSERT INTO identidades (email, senha_hash) VALUES ($1, $2) RETURNING id', [EMAIL, hash])).rows[0].id;
    await pool.query("INSERT INTO usuarios (empresa_id, nome, email, senha_hash, perfil, identidade_id) VALUES ($1, 'Master', NULL, NULL, 'MASTER', $2)", [empresa, idn]);
    gheDoCadastro = (await pool.query('INSERT INTO grupos_homogeneos_exposicao (empresa_id, nome, ativo) VALUES ($1, $2, true) RETURNING id', [empresa, GHE])).rows[0].id;

    const novoUsuario = async (email, perfil) => {
      const id = (await pool.query('INSERT INTO identidades (email, senha_hash) VALUES ($1, $2) RETURNING id', [email, hash])).rows[0].id;
      await pool.query("INSERT INTO usuarios (empresa_id, nome, email, senha_hash, perfil, identidade_id) VALUES ($1, $2, NULL, NULL, $3, $4)", [empresa, email, perfil, id]);
    };
    await novoUsuario(EMAIL_IMPORTADOR, 'ADMINISTRADOR');
    await novoUsuario(EMAIL_SEM_IMPORTAR, 'SUPERVISOR');
    await pool.query("INSERT INTO permissoes_acao (empresa_id, perfil, acao_codigo, permitido) VALUES ($1, 'ADMINISTRADOR', 'IMPORTAR_FUNCIONARIOS', true)", [empresa]);
    const semLimite = () => criarLimitador({ limite: 100000, janelaSegundos: 60 });
    const exigirSessao = criarExigirSessao({ pool });
    app = criarAppTeste((a) => {
      a.use(
        '/api',
        criarAuthGlobalRoutes({ controller: criarAuthGlobalController({ pool }), limitador: semLimite(), exigirSessaoGlobal: criarExigirSessaoGlobal({ pool }), ...turnstileDeTeste() }),
        criarFuncionarioRoutes({ controller: criarFuncionarioController({ pool }), exigirSessao, pool }),
      );
    });
    const login = await request(app).post('/api/auth/global/login').send({ email: EMAIL, senha: SENHA, turnstileToken: TOKEN_TURNSTILE_TESTE });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    const c = cookiesDe(login);
    cookie = `${C_GLOBAL}=${c[C_GLOBAL]}; ${C_EMPRESA}=${c[C_EMPRESA]}`;
    const entrar = async (email) => {
      const l = await request(app).post('/api/auth/global/login').send({ email, senha: SENHA, turnstileToken: TOKEN_TURNSTILE_TESTE });
      assert.equal(l.status, 200, JSON.stringify(l.body));
      const k = cookiesDe(l);
      return `${C_GLOBAL}=${k[C_GLOBAL]}; ${C_EMPRESA}=${k[C_EMPRESA]}`;
    };
    cookieImportador = await entrar(EMAIL_IMPORTADOR);
    cookieSemImportar = await entrar(EMAIL_SEM_IMPORTAR);
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  describe('cadastro manual', () => {
    test('sem matrícula: cria, grava NULL e devolve matrícula nula; CPF continua obrigatório', async () => {
      const r = await manual(cadastro(gerarCpf(1)));
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.funcionario.matricula, null);
      assert.deepEqual((await doBanco(gerarCpf(1))).map((f) => f.matricula), [null]);
      const semCpf = await manual({ nome: 'Sem CPF', setor: 'Produção' });
      assert.equal(semCpf.status, 400);
    });

    test('matrícula null explícita também cria sem matrícula; string vazia NÃO substitui NULL', async () => {
      const nula = await manual(cadastro(gerarCpf(2), { matricula: null }));
      assert.equal(nula.status, 201, JSON.stringify(nula.body));
      assert.deepEqual((await doBanco(gerarCpf(2))).map((f) => f.matricula), [null]);
      const vazia = await manual(cadastro(gerarCpf(3), { matricula: '' }));
      assert.equal(vazia.status, 400);
      assert.deepEqual(await doBanco(gerarCpf(3)), []);
    });

    test('dois funcionários sem matrícula na mesma empresa convivem; matrícula informada continua única', async () => {
      assert.equal((await manual(cadastro(gerarCpf(4)))).status, 201);
      assert.equal((await manual(cadastro(gerarCpf(5)))).status, 201);
      assert.equal((await manual(cadastro(gerarCpf(6), { matricula: 'M-6' }))).status, 201);
      const duplicada = await manual(cadastro(gerarCpf(7), { matricula: 'M-6' }));
      assert.equal(duplicada.status, 409);
      assert.equal(duplicada.body.codigo, 'FUNCIONARIO_MATRICULA_EM_USO');
    });

    test('alteração: a matrícula pode ser preenchida e depois limpa (NULL, nunca string vazia); o CPF não muda', async () => {
      const id = (await criarManual(cadastro(gerarCpf(8)))).body.funcionario.id;
      const preenchida = await alterar(id, { matricula: 'M-8' });
      assert.equal(preenchida.status, 200, JSON.stringify(preenchida.body));
      assert.equal(preenchida.body.funcionario.matricula, 'M-8');
      const limpa = await alterar(id, { matricula: null });
      assert.equal(limpa.status, 200, JSON.stringify(limpa.body));
      assert.deepEqual((await doBanco(gerarCpf(8))).map((f) => f.matricula), [null]);
      assert.equal((await alterar(id, { matricula: '' })).status, 400);
      assert.equal((await alterar(id, { cpf: gerarCpf(9) })).status, 400, 'CPF segue imutável');
    });
  });

  describe('importação: matrícula opcional', () => {
    test('sem a chave matrícula: cadastra com NULL, sem matrícula sintética e sem CPF no lugar dela', async () => {
      const r = await importar(lote([linhaImp(2, gerarCpf(20))]));
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.linhas[0].situacao, 'CADASTRADO');
      const [f] = await doBanco(gerarCpf(20));
      assert.equal(f.matricula, null);
    });

    test('matrícula null explícita cadastra com NULL; string vazia é recusada (não vira NULL)', async () => {
      const r = await importar(lote([linhaImp(2, gerarCpf(21), { matricula: null }), linhaImp(3, gerarCpf(22), { matricula: '' })]));
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(r.body.linhas.map((l) => [l.situacao, l.codigo ?? null]), [['CADASTRADO', null], ['RECUSADO', 'FUNCIONARIO_MATRICULA_INVALIDA']]);
      assert.deepEqual((await doBanco(gerarCpf(21))).map((f) => f.matricula), [null]);
      assert.deepEqual(await doBanco(gerarCpf(22)), []);
    });

    test('duas linhas sem matrícula no mesmo lote e dois lotes concorrentes sem matrícula: todas cadastradas, nenhuma colisão', async () => {
      const dentro = await importar(lote([linhaImp(2, gerarCpf(23)), linhaImp(3, gerarCpf(24))]));
      assert.deepEqual(dentro.body.linhas.map((l) => l.situacao), ['CADASTRADO', 'CADASTRADO']);
      const [a, b] = await Promise.all([
        importar(lote([linhaImp(2, gerarCpf(25)), linhaImp(3, gerarCpf(26))])),
        importar(lote([linhaImp(2, gerarCpf(27)), linhaImp(3, gerarCpf(28))])),
      ]);
      assert.deepEqual([...a.body.linhas, ...b.body.linhas].map((l) => l.situacao), ['CADASTRADO', 'CADASTRADO', 'CADASTRADO', 'CADASTRADO']);
    });

    test('telefone opcional: ausente não bloqueia; preenchido e válido é salvo; inválido recusa só a linha', async () => {
      const r = await importar(lote([
        linhaImp(2, gerarCpf(50)), linhaImp(3, gerarCpf(51), { telefone: '(47) 99999-0001' }), linhaImp(4, gerarCpf(52), { telefone: 'x'.repeat(21) }),
      ]));
      assert.deepEqual(r.body.linhas.map((l) => l.situacao), ['CADASTRADO', 'CADASTRADO', 'RECUSADO']);
      const tel = async (n) => (await pool.query('SELECT telefone FROM funcionarios WHERE empresa_id = $1 AND cpf = $2', [empresa, gerarCpf(n)])).rows[0]?.telefone;
      assert.equal(await tel(50), null);
      assert.equal(await tel(51), '(47) 99999-0001');
      assert.equal(await tel(52), undefined);
    });

    test('matrícula preenchida é gravada; pertencente a outra pessoa recusa a linha com a mensagem clara', async () => {
      const ok = await importar(lote([linhaImp(2, gerarCpf(30), { matricula: 'M-30' })]));
      assert.equal(ok.body.linhas[0].situacao, 'CADASTRADO');
      assert.deepEqual((await doBanco(gerarCpf(30))).map((f) => f.matricula), ['M-30']);
      const outra = await importar(lote([linhaImp(2, gerarCpf(31), { matricula: 'M-30' })]));
      assert.equal(outra.body.linhas[0].situacao, 'DUPLICADO');
      assert.equal(outra.body.linhas[0].codigo, 'FUNCIONARIO_MATRICULA_EM_USO');
      assert.equal(outra.body.linhas[0].motivo, 'Matrícula já cadastrada para outro funcionário nesta empresa.');
      assert.deepEqual(await doBanco(gerarCpf(31)), []);
    });

    test('a mesma matrícula em duas importações simultâneas: exatamente uma cadastra', async () => {
      const [a, b] = await Promise.all([
        importar(lote([linhaImp(2, gerarCpf(32), { matricula: 'M-CONC' })])),
        importar(lote([linhaImp(2, gerarCpf(33), { matricula: 'M-CONC' })])),
      ]);
      const situacoes = [a.body.linhas[0].situacao, b.body.linhas[0].situacao].sort();
      assert.deepEqual(situacoes, ['CADASTRADO', 'DUPLICADO']);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM funcionarios WHERE matricula = 'M-CONC'")).rows[0].n, 1);
    });

    test('funcionário existente com matrícula + importação sem matrícula: já cadastrado, sem divergência de matrícula, nada apagado nem alterado', async () => {
      const cpf = gerarCpf(34);
      await importar(lote([linhaImp(2, cpf, { matricula: 'M-34' })]));
      const antes = (await pool.query('SELECT matricula, nome, atualizado_em FROM funcionarios WHERE cpf = $1', [cpf])).rows[0];
      const r = await importar(lote([linhaImp(2, cpf)]));
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual([r.body.linhas[0].situacao, r.body.linhas[0].codigo], ['JA_CADASTRADO', 'FUNCIONARIO_JA_CADASTRADO'], 'matrícula ausente na planilha não é divergência');
      assert.equal(r.body.linhas[0].divergencias, undefined);
      assert.deepEqual((await pool.query('SELECT matricula, nome, atualizado_em FROM funcionarios WHERE cpf = $1', [cpf])).rows[0], antes);
    });

    test('existente sem matrícula + planilha sem matrícula: já cadastrado sem alterações', async () => {
      const cpf = gerarCpf(35);
      await importar(lote([linhaImp(2, cpf)]));
      const r = await importar(lote([linhaImp(2, cpf)]));
      assert.deepEqual([r.body.linhas[0].situacao, r.body.linhas[0].codigo], ['JA_CADASTRADO', 'FUNCIONARIO_JA_CADASTRADO']);
    });
  });

  describe('importação: Nome GHE com quebra de linha e espaçamento (12K-E)', () => {
    const criarGhe = async (nome, ativo = true) => (await pool.query('INSERT INTO grupos_homogeneos_exposicao (empresa_id, nome, ativo) VALUES ($1, $2, $3) RETURNING id', [empresa, nome, ativo])).rows[0].id;
    const gheDe = async (n) => (await pool.query('SELECT grupo_homogeneo_id AS g FROM funcionarios WHERE empresa_id = $1 AND cpf = $2', [empresa, gerarCpf(n)])).rows[0]?.g;

    test('quebra de linha legítima no nome é aceita: CRLF e LF resolvem o mesmo GHE, cadastrado com quebra', async () => {
      const id = await criarGhe('LAMINAÇÃO\n(CATERPILLAR-FRESA)');
      const r = await importar(lote([
        linhaImp(2, gerarCpf(60), { ghe: 'LAMINAÇÃO\r\n(CATERPILLAR-FRESA)' }),
        linhaImp(3, gerarCpf(61), { ghe: 'LAMINAÇÃO\n(CATERPILLAR-FRESA)' }),
        linhaImp(4, gerarCpf(62), { ghe: 'LAMINAÇÃO (CATERPILLAR-FRESA)' }),
        linhaImp(5, gerarCpf(71), { ghe: 'LAMINAÇÃO\r(CATERPILLAR-FRESA)' }),
        linhaImp(6, gerarCpf(72), { ghe: 'LAMINAÇÃO\t(CATERPILLAR-FRESA)' }),
      ]));
      assert.deepEqual(r.body.linhas.map((l) => l.situacao), ['CADASTRADO', 'CADASTRADO', 'CADASTRADO', 'CADASTRADO', 'CADASTRADO']);
      assert.deepEqual([await gheDe(60), await gheDe(61), await gheDe(62), await gheDe(71), await gheDe(72)], [id, id, id, id, id]);
    });

    test('espaços repetidos e nas pontas não causam falsa rejeição, tanto na planilha quanto no nome cadastrado', async () => {
      const a = await criarGhe('ALMOXARIFADO - INFLAMAVEL');
      const b = await criarGhe('Gasosos liquefeitos  /   Inflamáveis (Armazenamento) ');
      const r = await importar(lote([
        linhaImp(2, gerarCpf(63), { ghe: '  ALMOXARIFADO   -  INFLAMAVEL  ' }),
        linhaImp(3, gerarCpf(64), { ghe: 'Gasosos liquefeitos / Inflamáveis (Armazenamento)' }),
      ]));
      assert.deepEqual(r.body.linhas.map((l) => l.situacao), ['CADASTRADO', 'CADASTRADO']);
      assert.deepEqual([await gheDe(63), await gheDe(64)], [a, b]);
    });

    test('inexistente continua recusado com "GHE não encontrado"; vazio continua "não informado"', async () => {
      const r = await importar(lote([linhaImp(2, gerarCpf(65), { ghe: 'GHE QUE NAO EXISTE' }), linhaImp(3, gerarCpf(66), { ghe: '  \r\n ' })]));
      assert.deepEqual(r.body.linhas.map((l) => [l.situacao, l.codigo, l.campos]), [
        ['RECUSADO', 'FUNCIONARIO_GHE_INEXISTENTE', ['ghe']], ['RECUSADO', 'FUNCIONARIO_GHE_NAO_INFORMADO', ['ghe']],
      ]);
      assert.match(r.body.linhas[0].motivo, /^GHE não encontrado/);
      assert.doesNotMatch(JSON.stringify(r.body), /QUE NAO EXISTE/, 'o valor da planilha não é ecoado');
    });

    test('ambiguidade nunca é resolvida em silêncio: dois GHEs com o mesmo nome normalizado recusam a linha', async () => {
      await criarGhe('AMBIGUO X');
      await criarGhe('AMBIGUO  X');
      const r = await importar(lote([linhaImp(2, gerarCpf(67), { ghe: 'AMBIGUO X' })]));
      assert.deepEqual([r.body.linhas[0].situacao, r.body.linhas[0].codigo, r.body.linhas[0].campos], ['RECUSADO', 'FUNCIONARIO_GHE_AMBIGUO', ['ghe']]);
      assert.match(r.body.linhas[0].motivo, /ambíguo/i);
      assert.deepEqual(await doBanco(gerarCpf(67)), []);
    });

    test('GHE inativo continua recusado mesmo achado pela normalização; caractere de controle (que não é quebra de linha) continua inválido', async () => {
      await criarGhe('GHE INATIVO\nQUEBRA', false);
      const r = await importar(lote([linhaImp(2, gerarCpf(68), { ghe: 'GHE INATIVO\r\nQUEBRA' }), linhaImp(3, gerarCpf(69), { ghe: 'GHE\u0007' })]));
      assert.deepEqual(r.body.linhas.map((l) => [l.situacao, l.codigo, l.campos]), [['RECUSADO', 'FUNCIONARIO_GHE_INATIVO', ['ghe']], ['RECUSADO', 'FUNCIONARIO_GHE_INVALIDO', ['ghe']]]);
    });

    test('classificação: vazio/só whitespace = não informado; controle proibido = inválido (nunca "não informado"); ausente = não informado', async () => {
      const semGhe = linhaImp(4, gerarCpf(73));
      delete semGhe.ghe;
      const r = await importar(lote([
        linhaImp(2, gerarCpf(74), { ghe: '' }), linhaImp(3, gerarCpf(75), { ghe: ' \t\r\n ' }), semGhe, linhaImp(5, gerarCpf(76), { ghe: 'GHE\u0001X' }), linhaImp(6, gerarCpf(77), { ghe: 'GHE\u0007' }),
      ]));
      assert.deepEqual(r.body.linhas.map((l) => l.codigo), [
        'FUNCIONARIO_GHE_NAO_INFORMADO', 'FUNCIONARIO_GHE_NAO_INFORMADO', 'FUNCIONARIO_GHE_NAO_INFORMADO', 'FUNCIONARIO_GHE_INVALIDO', 'FUNCIONARIO_GHE_INVALIDO',
      ]);
      assert.match(r.body.linhas[3].motivo, /^GHE inválido/);
    });

    test('GHE escolhido na prévia (gheId): o servidor revalida empresa, existência e estado ativo; ambíguo por nome resolve pelo id', async () => {
      const a = await criarGhe('SELECIONADO A');
      const b = await criarGhe('AMBIGUO Y');
      const c = await criarGhe('AMBIGUO  Y');
      const inativo = await criarGhe('SELECIONADO INATIVO', false);
      const outraEmpresa = (await pool.query("INSERT INTO empresas (nome, cnpj) VALUES ('Outra 12KE', '99888777000166') RETURNING id")).rows[0].id;
      const gheOutra = (await pool.query('INSERT INTO grupos_homogeneos_exposicao (empresa_id, nome, ativo) VALUES ($1, $2, true) RETURNING id', [outraEmpresa, 'GHE DE OUTRA'])).rows[0].id;
      const comId = (linha, n, gheId) => { const l = linhaImp(linha, gerarCpf(n)); delete l.ghe; return { ...l, gheId }; };
      const r = await importar(lote([
        comId(2, 78, a), comId(3, 79, c), comId(4, 80, inativo), comId(5, 81, gheOutra), comId(6, 82, 99999999),
        { ...linhaImp(7, gerarCpf(83), { ghe: 'AMBIGUO Y' }) },
      ]));
      assert.deepEqual(r.body.linhas.map((l) => [l.situacao, l.codigo ?? null]), [
        ['CADASTRADO', null], ['CADASTRADO', null], ['RECUSADO', 'FUNCIONARIO_GHE_INATIVO'], ['RECUSADO', 'FUNCIONARIO_GHE_INEXISTENTE'],
        ['RECUSADO', 'FUNCIONARIO_GHE_INEXISTENTE'], ['RECUSADO', 'FUNCIONARIO_GHE_AMBIGUO'],
      ]);
      assert.deepEqual([await gheDe(78), await gheDe(79)], [a, c], 'o id escolhido é o que vincula');
      for (const n of [80, 81, 82, 83]) assert.deepEqual(await doBanco(gerarCpf(n)), []);
      assert.ok(b !== c);
    });

    test('a normalização do JavaScript e a da consulta SQL têm a mesma semântica (mesma tabela de casos)', async () => {
      const { normalizarNomeGhe } = require('../../src/utils/normalizacao'); // eslint-disable-line global-require
      assert.equal(typeof normalizarNomeGhe, 'function', 'normalizarNomeGhe deve existir em utils/normalizacao');
      const casos = ['A B', ' A  B ', 'A\nB', 'A\r\nB', 'A\rB', 'A\tB', 'A \r\n \t B', '\r\nA\r\n', 'Á  É', 'A\u00a0B', 'A  -  B', '(A)\n(B)', 'a  B', ''];
      for (const caso of casos) {
        // eslint-disable-next-line no-await-in-loop
        const { rows } = await pool.query("SELECT btrim(regexp_replace($1::text, '[ \t\r\n]+', ' ', 'g'), ' ') AS n", [caso]);
        assert.equal(normalizarNomeGhe(caso), rows[0].n, JSON.stringify(caso));
      }
      assert.equal(normalizarNomeGhe('a  B'), 'a B', 'maiúsculas não mudam');
      assert.equal(normalizarNomeGhe('Á  É'), 'Á É', 'acentos não mudam');
    });

    test('funcionário já cadastrado: GHE equivalente por normalização não é divergência', async () => {
      await criarGhe('EXISTENTE\nGHE');
      await importar(lote([linhaImp(2, gerarCpf(70), { ghe: 'EXISTENTE\nGHE' })]));
      const r = await importar(lote([linhaImp(2, gerarCpf(70), { ghe: 'EXISTENTE\r\nGHE' })]));
      assert.deepEqual([r.body.linhas[0].situacao, r.body.linhas[0].codigo], ['JA_CADASTRADO', 'FUNCIONARIO_JA_CADASTRADO']);
    });
  });

  describe('GET /funcionarios/importacao/ghes — opções do seletor (12K-E)', () => {
    const ROTA_GHES = '/api/funcionarios/importacao/ghes';
    const ler = (c) => request(app).get(ROTA_GHES).set('Cookie', c);

    test('quem importa lista os GHEs ATIVOS da empresa, só com id e nome, sem precisar de employeeGroups.visualizar', async () => {
      await pool.query('INSERT INTO grupos_homogeneos_exposicao (empresa_id, nome, ativo) VALUES ($1, $2, true), ($1, $3, false)', [empresa, 'SELETOR ATIVO', 'SELETOR INATIVO']);
      const outra = (await pool.query("INSERT INTO empresas (nome, cnpj) VALUES ('Outra Seletor', '88777666000155') RETURNING id")).rows[0].id;
      await pool.query("INSERT INTO grupos_homogeneos_exposicao (empresa_id, nome, ativo) VALUES ($1, 'GHE OUTRA EMPRESA', true)", [outra]);
      const permissaoGrupos = await request(app).get('/api/grupos-homogeneos').set('Cookie', cookieImportador);
      for (const c of [cookie, cookieImportador]) {
        const r = await ler(c);
        assert.equal(r.status, 200, JSON.stringify(r.body));
        const nomes = r.body.ghes.map((g) => g.nome);
        assert.ok(nomes.includes('SELETOR ATIVO'));
        assert.equal(nomes.includes('SELETOR INATIVO'), false);
        assert.equal(nomes.includes('GHE OUTRA EMPRESA'), false);
        for (const g of r.body.ghes) assert.deepEqual(Object.keys(g).sort(), ['id', 'nome']);
      }
      assert.notEqual(permissaoGrupos.status, 200, 'o importador não ganhou a Gestão de GHE (employeeGroups.visualizar)');
    });

    test('sem a ação IMPORTAR_FUNCIONARIOS: 403; sem sessão: 401; a empresa não vem do cliente (query extra é recusada)', async () => {
      assert.equal((await ler(cookieSemImportar)).status, 403);
      assert.equal((await request(app).get(ROTA_GHES)).status, 401);
      const extra = await request(app).get(`${ROTA_GHES}?empresaId=999`).set('Cookie', cookie);
      assert.equal(extra.status, 400);
    });

    test('a rota só lê: POST/PATCH/DELETE não existem para criar, editar ou inativar GHE por aqui', async () => {
      for (const metodo of ['post', 'patch', 'delete', 'put']) {
        const r = await request(app)[metodo](ROTA_GHES).set('Cookie', cookie).send({ nome: 'X' });
        assert.ok([404, 405].includes(r.status) || (metodo === 'post' && r.status === 400), `${metodo}: ${r.status}`);
      }
    });
  });

  describe('importação: Situação obrigatória no servidor', () => {
    test('"Ativo" com variação de caixa e espaços é aceita e cadastra ativo', async () => {
      const r = await importar(lote([
        linhaImp(2, gerarCpf(40), { situacao: 'Ativo' }), linhaImp(3, gerarCpf(41), { situacao: ' ativo ' }), linhaImp(4, gerarCpf(42), { situacao: 'ATIVO' }),
      ]));
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(r.body.linhas.map((l) => l.situacao), ['CADASTRADO', 'CADASTRADO', 'CADASTRADO']);
      assert.deepEqual((await doBanco(gerarCpf(41))).map((f) => f.ativo), [true]);
    });

    test('Situação ausente, vazia ou só espaços: a linha é recusada pelo servidor e nada é gravado', async () => {
      const ausente = linhaImp(2, gerarCpf(43));
      delete ausente.situacao;
      const r = await importar(lote([ausente, linhaImp(3, gerarCpf(44), { situacao: '' }), linhaImp(4, gerarCpf(45), { situacao: '   ' })]));
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(r.body.linhas.map((l) => [l.situacao, l.campos]), [['RECUSADO', ['situacao']], ['RECUSADO', ['situacao']], ['RECUSADO', ['situacao']]]);
      for (const n of [43, 44, 45]) assert.deepEqual(await doBanco(gerarCpf(n)), []);
    });

    test('qualquer outro valor é recusado com o código próprio, sem conversão silenciosa e sem ecoar o valor', async () => {
      const r = await importar(lote([linhaImp(2, gerarCpf(46), { situacao: 'Inativo' }), linhaImp(3, gerarCpf(47), { situacao: 'Afastado' })]));
      assert.deepEqual(r.body.linhas.map((l) => [l.situacao, l.codigo, l.campos]), [
        ['RECUSADO', 'FUNCIONARIO_SITUACAO_NAO_RECONHECIDA', ['situacao']], ['RECUSADO', 'FUNCIONARIO_SITUACAO_NAO_RECONHECIDA', ['situacao']],
      ]);
      assert.doesNotMatch(JSON.stringify(r.body), /Inativo|Afastado/);
      assert.deepEqual(await doBanco(gerarCpf(46)), []);
    });
  });
});
