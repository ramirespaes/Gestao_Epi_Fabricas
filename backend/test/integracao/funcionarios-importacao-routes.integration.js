'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { abrirPoolTemporario } = require('./helpers/schema-temporario');
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
 * Bloco 9, Etapa C, Parte C4 — funcionários: importação em lote, CPF exato
 * e data de admissão, com PostgreSQL real em schema temporário exclusivo
 * com TODAS as migrations (000–040).
 */

const TODAS_AS_MIGRATIONS = Array.from({ length: 41 }, (_, i) => String(i).padStart(3, '0'));
const SENHA = 'senha-forte-da-parte-c4-2026';
const EMAILS = {
  masterA: 'master.a.c4@exemplo-cliente.com.br',
  leitorA: 'leitor.a.c4@exemplo-cliente.com.br', // employeeHistory.visualizar, SEM criar
  masterB: 'master.b.c4@exemplo-cliente.com.br',
};
const { cookieNome: C_EMPRESA, cookieNomeGlobal: C_GLOBAL } = authConfig.sessao;
const ROTA = '/api/funcionarios/importacao';

/** CPF válido a partir de 9 dígitos-base (dígitos verificadores calculados). */
function gerarCpf(n) {
  const base = String(100000000 + n).slice(-9).split('').map(Number);
  const dv = (digitos) => {
    const soma = digitos.reduce((s, d, i) => s + d * (digitos.length + 1 - i), 0);
    const r = (soma * 10) % 11;
    return r === 10 ? 0 : r;
  };
  const d1 = dv(base);
  const d2 = dv([...base, d1]);
  return [...base, d1, d2].join('');
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

const linhaImp = (linha, cpf, extra = {}) => ({
  linha, nome: `Funcionário C4 ${linha}`, cpf, matricula: `C4-${linha}`, dataAdmissao: '2020-06-01',
  dataNascimento: '1990-03-15', setor: 'Produção', funcao: 'Operador', telefone: '(47) 99999-0001', ...extra,
});
const lote = (linhas, extra = {}) => ({
  importacaoId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
  lote: { numero: 1, total: 1 },
  arquivo: { nome: 'funcionarios_c4.xlsx', formato: 'xlsx', totalLinhas: linhas.length },
  declaracaoLgpd: { versao: declaracao.VERSAO_ATUAL, confirmada: true },
  linhas,
  ...extra,
});

describe('C4 — funcionários: importação em lote, CPF exato e admissão (PostgreSQL real)', () => {
  let contexto;
  let pool;
  let app;
  const empresa = {};
  const u = {};
  const cookie = {};

  async function sessao(email) {
    const login = await request(app).post('/api/auth/global/login').send({ email, senha: SENHA });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    const c = cookiesDe(login);
    return `${C_GLOBAL}=${c[C_GLOBAL]}; ${C_EMPRESA}=${c[C_EMPRESA]}`;
  }
  const importar = (quem, corpo) => request(app).post(ROTA).set('Cookie', cookie[quem]).send(corpo);
  const funcionariosDe = async (empresaId) => (await pool.query(
    "SELECT matricula, nome, cpf, ativo, to_char(data_admissao, 'YYYY-MM-DD') AS admissao FROM funcionarios WHERE empresa_id = $1 ORDER BY id", [empresaId],
  )).rows;

  before(async () => {
    contexto = await abrirPoolTemporario(TODAS_AS_MIGRATIONS);
    pool = contexto.pool;
    const hash = await gerarHashSenha(SENHA);
    const q = (sql, params) => pool.query(sql, params);
    for (const [k, nome, cnpj] of [['A', 'Empresa Alfa C4', '11222333000181'], ['B', 'Empresa Beta C4', '22333444000100']]) {
      empresa[k] = (await q('INSERT INTO empresas (nome, cnpj) VALUES ($1, $2) RETURNING id', [nome, cnpj])).rows[0].id;
      await provisionamento.provisionar(pool, { empresaId: empresa[k], dryRun: false });
    }
    const vinculo = async (chave, empresaId, email, perfil) => {
      const id = (await q('INSERT INTO identidades (email, senha_hash) VALUES ($1, $2) RETURNING id', [email, hash])).rows[0].id;
      u[chave] = (await q('INSERT INTO usuarios (empresa_id, nome, email, senha_hash, perfil, identidade_id) VALUES ($1, $2, NULL, NULL, $3, $4) RETURNING id', [empresaId, chave, perfil, id])).rows[0].id;
    };
    await vinculo('masterA', empresa.A, EMAILS.masterA, 'MASTER');
    await vinculo('leitorA', empresa.A, EMAILS.leitorA, 'SUPERVISOR');
    await vinculo('masterB', empresa.B, EMAILS.masterB, 'MASTER');
    await q("INSERT INTO permissoes_recurso (empresa_id, perfil, recurso, pode_visualizar, pode_criar) VALUES ($1, 'SUPERVISOR', 'employeeHistory', true, false)", [empresa.A]);
    // Funcionário já existente e INATIVO na empresa A: a importação nunca o altera nem reativa.
    await q("INSERT INTO funcionarios (empresa_id, matricula, nome, cpf, ativo) VALUES ($1, 'EXISTENTE-1', 'Existente Inativo', $2, false)", [empresa.A, gerarCpf(900)]);

    const semLimite = () => criarLimitador({ limite: 100000, janelaSegundos: 60 });
    const exigirSessao = criarExigirSessao({ pool });
    app = criarAppTeste((a) => {
      a.use(
        '/api',
        criarAuthGlobalRoutes({ controller: criarAuthGlobalController({ pool }), limitador: semLimite(), exigirSessaoGlobal: criarExigirSessaoGlobal({ pool }) }),
        criarFuncionarioRoutes({ controller: criarFuncionarioController({ pool }), exigirSessao, pool }),
      );
    });
    for (const k of Object.keys(EMAILS)) cookie[k] = await sessao(EMAILS[k]);
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  test('lote misto: um resultado por linha; linha inválida, duplicada (inclusive existente inativo) e repetida no lote não desfazem as demais', async () => {
    const antes = await funcionariosDe(empresa.A);
    const r = await importar('masterA', lote([
      linhaImp(2, gerarCpf(1)),
      linhaImp(3, '52998224726'), // DV inválido
      linhaImp(4, gerarCpf(900)), // CPF do existente inativo
      linhaImp(5, gerarCpf(1), { matricula: 'C4-5B' }), // CPF repetido no mesmo lote
      linhaImp(6, gerarCpf(2), { dataAdmissao: '1985-01-01' }), // admissão antes do nascimento
      linhaImp(7, gerarCpf(3), { setor: null }), // setor obrigatório na planilha
      linhaImp(8, gerarCpf(4), { dataNascimento: null, telefone: null }),
    ]));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.linhas.map((l) => [l.linha, l.situacao, l.codigo ?? null]), [
      [2, 'CADASTRADO', null],
      [3, 'RECUSADO', 'FUNCIONARIO_CPF_INVALIDO'],
      [4, 'DUPLICADO', 'FUNCIONARIO_CPF_EM_USO'],
      [5, 'DUPLICADO', 'FUNCIONARIO_CPF_EM_USO'],
      [6, 'RECUSADO', 'FUNCIONARIO_DATA_ADMISSAO_INVALIDA'],
      [7, 'RECUSADO', 'FUNCIONARIO_DADOS_INVALIDOS'],
      [8, 'CADASTRADO', null],
    ]);
    assert.deepEqual(r.body.resumo, { cadastrados: 2, duplicados: 2, recusados: 3, erros: 0 });
    assert.doesNotMatch(JSON.stringify(r.body), new RegExp(`${gerarCpf(1)}|Funcionário C4|99999-0001|1990-03-15`), 'a resposta não ecoa dados pessoais');

    const depois = await funcionariosDe(empresa.A);
    assert.equal(depois.length, antes.length + 2);
    assert.deepEqual(depois.find((f) => f.matricula === 'EXISTENTE-1'), { matricula: 'EXISTENTE-1', nome: 'Existente Inativo', cpf: gerarCpf(900), ativo: false, admissao: null }, 'existente intocado e inativo');
    assert.deepEqual(depois.filter((f) => f.matricula.startsWith('C4-')).map((f) => [f.matricula, f.cpf, f.admissao, f.ativo]),
      [['C4-2', gerarCpf(1), '2020-06-01', true], ['C4-8', gerarCpf(4), '2020-06-01', true]]);
  });

  test('auditoria: FUNCIONARIO_CRIADO por linha criada (origem importação) e um evento do lote com a declaração (versão, hash), usuário e contadores — sem CPF, telefone ou nascimento', async () => {
    const criados = (await pool.query("SELECT contexto FROM logs_auditoria WHERE empresa_id = $1 AND acao = 'FUNCIONARIO_CRIADO' AND contexto->>'origem' = 'importacao' ORDER BY id", [empresa.A])).rows;
    assert.deepEqual(criados.map((c) => c.contexto.linha), [2, 8]);
    const lotes = (await pool.query("SELECT usuario_id, referencia, contexto, criado_em FROM logs_auditoria WHERE empresa_id = $1 AND acao = 'FUNCIONARIOS_IMPORTACAO_LOTE' ORDER BY id", [empresa.A])).rows;
    assert.equal(lotes.length, 1);
    const [l] = lotes;
    assert.deepEqual([l.usuario_id, l.referencia], [u.masterA, '7c9e6679-7425-40de-944b-e07fc1f90ae7']);
    assert.ok(l.criado_em instanceof Date);
    assert.deepEqual([l.contexto.versaoDeclaracao, l.contexto.hashTextoDeclaracao, l.contexto.declaracaoConfirmada],
      [declaracao.VERSAO_ATUAL, declaracao.hashDaVersao(declaracao.VERSAO_ATUAL), true]);
    assert.deepEqual([l.contexto.cadastrados, l.contexto.duplicados, l.contexto.recusados, l.contexto.erros, l.contexto.linhasNoLote], [2, 2, 3, 0, 7]);
    const todo = JSON.stringify((await pool.query('SELECT contexto, dados_anteriores, dados_novos FROM logs_auditoria WHERE empresa_id = $1', [empresa.A])).rows);
    assert.doesNotMatch(todo, new RegExp(`${gerarCpf(1)}|${gerarCpf(4)}|99999-0001|1990-03-15`), 'nenhum dado pessoal em toda a auditoria da empresa');
  });

  test('reenvio do mesmo lote (ex.: após resultado incerto): nada é criado em dobro — os já gravados voltam como DUPLICADO', async () => {
    const antes = await funcionariosDe(empresa.A);
    const r = await importar('masterA', lote([linhaImp(2, gerarCpf(1)), linhaImp(8, gerarCpf(4), { dataNascimento: null, telefone: null })]));
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.linhas.map((l) => l.situacao), ['DUPLICADO', 'DUPLICADO']);
    assert.deepEqual(await funcionariosDe(empresa.A), antes);
  });

  test('matrícula repetida com CPF novo também é DUPLICADO (por matrícula); nada é sobrescrito', async () => {
    const r = await importar('masterA', lote([linhaImp(2, gerarCpf(5))]));
    assert.deepEqual([r.body.linhas[0].situacao, r.body.linhas[0].codigo], ['DUPLICADO', 'FUNCIONARIO_MATRICULA_EM_USO']);
    assert.equal((await funcionariosDe(empresa.A)).find((f) => f.matricula === 'C4-2').cpf, gerarCpf(1));
  });

  test('RBAC: quem só visualiza funcionários recebe 403 na importação; sem sessão, 401; nada é gravado', async () => {
    const antes = await funcionariosDe(empresa.A);
    assert.equal((await importar('leitorA', lote([linhaImp(20, gerarCpf(20))]))).status, 403);
    assert.equal((await request(app).post(ROTA).send(lote([linhaImp(21, gerarCpf(21))]))).status, 401);
    assert.deepEqual(await funcionariosDe(empresa.A), antes);
  });

  test('isolamento: o mesmo CPF e a mesma matrícula na empresa B são cadastrados em B; A continua igual', async () => {
    const antesA = await funcionariosDe(empresa.A);
    const r = await importar('masterB', lote([linhaImp(2, gerarCpf(1))]));
    assert.deepEqual(r.body.linhas.map((l) => l.situacao), ['CADASTRADO']);
    assert.deepEqual(await funcionariosDe(empresa.A), antesA);
    assert.deepEqual((await funcionariosDe(empresa.B)).map((f) => f.cpf), [gerarCpf(1)]);
  });

  test('limites do lote: 101 linhas, declaração não confirmada, versão desconhecida, empresaId no corpo e formato xls → 400; corpo acima de 32 KB → 413; nada é gravado', async () => {
    const antes = await funcionariosDe(empresa.A);
    const cento1 = Array.from({ length: 101 }, (_, i) => linhaImp(100 + i, gerarCpf(100 + i)));
    const casos = [
      lote(cento1),
      lote([linhaImp(30, gerarCpf(30))], { declaracaoLgpd: { versao: declaracao.VERSAO_ATUAL, confirmada: false } }),
      lote([linhaImp(31, gerarCpf(31))], { empresaId: empresa.B }),
      lote([linhaImp(32, gerarCpf(32))], { arquivo: { nome: 'a.xls', formato: 'xls', totalLinhas: 1 } }),
    ];
    for (const corpo of casos) {
      const r = await importar('masterA', corpo);
      assert.equal(r.status, 400, JSON.stringify(r.body));
    }
    const versao = await importar('masterA', lote([linhaImp(33, gerarCpf(33))], { declaracaoLgpd: { versao: 'IMPORTACAO-FUNCIONARIOS-V0', confirmada: true } }));
    assert.deepEqual([versao.status, versao.body.codigo], [400, 'IMPORTACAO_DECLARACAO_LGPD_INVALIDA']);
    const grande = lote(Array.from({ length: 100 }, (_, i) => linhaImp(200 + i, gerarCpf(200 + i), { nome: 'N'.repeat(150), setor: 'S'.repeat(100), funcao: 'F'.repeat(100) })));
    assert.ok(Buffer.byteLength(JSON.stringify(grande)) > 32 * 1024);
    assert.equal((await importar('masterA', grande)).status, 413);
    assert.deepEqual(await funcionariosDe(empresa.A), antes);
  });

  test('concorrência: dois lotes simultâneos com o mesmo CPF — um cadastra, o outro recebe DUPLICADO; uma única linha no banco', async () => {
    const cpf = gerarCpf(40);
    const [r1, r2] = await Promise.all([
      importar('masterA', lote([linhaImp(40, cpf, { matricula: 'C4-CONC-1' })])),
      importar('masterA', lote([linhaImp(40, cpf, { matricula: 'C4-CONC-2' })])),
    ]);
    assert.deepEqual([r1.body.linhas[0].situacao, r2.body.linhas[0].situacao].sort(), ['CADASTRADO', 'DUPLICADO']);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM funcionarios WHERE empresa_id = $1 AND cpf = $2', [empresa.A, cpf])).rows[0].n, 1);
  });

  test('busca por CPF: só completo, igualdade exata, restrita à empresa; parcial ou inválido → 400; independente da busca por nome/matrícula', async () => {
    const buscar = (quem, query) => request(app).get(`/api/funcionarios${query}`).set('Cookie', cookie[quem]);
    const cpf = gerarCpf(1);
    const mascarado = `${cpf.slice(0, 3)}.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-${cpf.slice(9)}`;
    const a = await buscar('masterA', `?cpf=${encodeURIComponent(mascarado)}`);
    assert.equal(a.status, 200);
    assert.deepEqual(a.body.funcionarios.map((f) => [f.matricula, f.empresaId]), [['C4-2', empresa.A]]);
    assert.equal(a.body.total, 1);
    const b = await buscar('masterB', `?cpf=${cpf}`);
    assert.deepEqual(b.body.funcionarios.map((f) => f.empresaId), [empresa.B], 'mesmo CPF, só o da própria empresa');
    for (const parcial of [cpf.slice(0, 6), `${cpf.slice(0, 10)}0`]) {
      assert.equal((await buscar('masterA', `?cpf=${parcial}`)).status, 400, parcial);
    }
    assert.equal((await buscar('masterA', `?cpf=${gerarCpf(777)}`)).body.total, 0, 'CPF válido inexistente: nenhum resultado');
    assert.equal((await buscar('masterA', '?busca=C4-2')).body.funcionarios[0].matricula, 'C4-2', 'busca livre continua por nome/matrícula');
    assert.equal((await buscar('masterA', `?busca=${cpf.slice(0, 5)}`)).body.total, 0, 'a busca livre nunca encontra por CPF');
  });

  test('datas AAAA-MM-DD sem fuso: POST/GET/PATCH em São Paulo, UTC, Tóquio e Berlim; PATCH omitido preserva, informado atualiza, null limpa; admissão ≤ nascimento → 400', async () => {
    const original = process.env.TZ;
    try {
      const post = await request(app).post('/api/funcionarios').set('Cookie', cookie.masterA)
        .send({ matricula: 'C4-DATAS', nome: 'Datas C4', cpf: gerarCpf(50), dataNascimento: '1990-10-15', dataAdmissao: '2026-10-15' });
      assert.equal(post.status, 201, JSON.stringify(post.body));
      const id = post.body.funcionario.id;
      for (const fuso of ['America/Sao_Paulo', 'UTC', 'Asia/Tokyo', 'Europe/Berlin']) {
        process.env.TZ = fuso;
        const g = await request(app).get(`/api/funcionarios/${id}`).set('Cookie', cookie.masterA);
        assert.deepEqual([g.body.funcionario.dataNascimento, g.body.funcionario.dataAdmissao], ['1990-10-15', '2026-10-15'], fuso);
      }
      process.env.TZ = 'Asia/Tokyo';
      const omitido = await request(app).patch(`/api/funcionarios/${id}`).set('Cookie', cookie.masterA).send({ setor: 'Qualidade' });
      assert.deepEqual([omitido.status, omitido.body.funcionario.dataAdmissao], [200, '2026-10-15'], 'omitido: preservado');
      const informado = await request(app).patch(`/api/funcionarios/${id}`).set('Cookie', cookie.masterA).send({ dataAdmissao: '2027-01-05' });
      assert.equal(informado.body.funcionario.dataAdmissao, '2027-01-05');
      const limpo = await request(app).patch(`/api/funcionarios/${id}`).set('Cookie', cookie.masterA).send({ dataAdmissao: null });
      assert.equal(limpo.body.funcionario.dataAdmissao, null);
      const invalido = await request(app).patch(`/api/funcionarios/${id}`).set('Cookie', cookie.masterA).send({ dataAdmissao: '1990-10-15' });
      assert.deepEqual([invalido.status, invalido.body.codigo], [400, 'FUNCIONARIO_DATA_ADMISSAO_INVALIDA']);
      const antes1900 = await request(app).post('/api/funcionarios').set('Cookie', cookie.masterA)
        .send({ matricula: 'C4-1899', nome: 'Antigo', cpf: gerarCpf(51), dataAdmissao: '1899-12-31' });
      assert.deepEqual([antes1900.status, antes1900.body.codigo], [400, 'FUNCIONARIO_DATA_ADMISSAO_INVALIDA']);
      const futura = await request(app).post('/api/funcionarios').set('Cookie', cookie.masterA)
        .send({ matricula: 'C4-FUTURA', nome: 'Futura', cpf: gerarCpf(52), dataAdmissao: '2099-01-01' });
      assert.equal(futura.status, 201, 'admissão futura é permitida');
      const semData = await request(app).post('/api/funcionarios').set('Cookie', cookie.masterA)
        .send({ matricula: 'C4-SEM', nome: 'Sem data', cpf: gerarCpf(53) });
      assert.deepEqual([semData.status, semData.body.funcionario.dataAdmissao], [201, null], 'retrocompatível: sem o campo');
    } finally {
      if (original === undefined) delete process.env.TZ; else process.env.TZ = original;
    }
  });
});
