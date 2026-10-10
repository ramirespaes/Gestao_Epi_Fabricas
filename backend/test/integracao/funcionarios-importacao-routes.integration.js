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
 * Bloco 9, Etapa C, Parte C4 — funcionários: importação em lote, CPF exato
 * e data de admissão, com PostgreSQL real em schema temporário exclusivo
 * com TODAS as migrations (000–040).
 */

// Schema atual do sistema (inclui a 083, que a leitura de GHE projeta).
const TODAS_AS_MIGRATIONS = todasAsMigrations();
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

// 12G-9: a coluna GHE é obrigatória e traz o NOME exato de um GHE da empresa.
const GHE = { ativoA: 'GHE Produção', inativoA: 'GHE Antigo', ativoB: 'GHE Beta' };
const linhaImp = (linha, cpf, extra = {}) => ({
  linha, nome: `Funcionário C4 ${linha}`, cpf, matricula: `C4-${linha}`, situacao: 'Ativo', dataAdmissao: '2020-06-01',
  dataNascimento: '1990-03-15', setor: 'Produção', funcao: 'Operador', telefone: '(47) 99999-0001', ghe: GHE.ativoA, ...extra,
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
  const ghe = {};

  async function sessao(email) {
    const login = await request(app).post('/api/auth/global/login').send({ email, senha: SENHA, turnstileToken: TOKEN_TURNSTILE_TESTE });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    const c = cookiesDe(login);
    return `${C_GLOBAL}=${c[C_GLOBAL]}; ${C_EMPRESA}=${c[C_EMPRESA]}`;
  }
  const importar = (quem, corpo) => request(app).post(ROTA).set('Cookie', cookie[quem]).send(corpo);
  const funcionariosDe = async (empresaId) => (await pool.query(
    "SELECT matricula, nome, cpf, ativo, to_char(data_admissao, 'YYYY-MM-DD') AS admissao, grupo_homogeneo_id AS ghe, atualizado_em FROM funcionarios WHERE empresa_id = $1 ORDER BY id", [empresaId],
  )).rows;
  const totalGhes = async () => (await pool.query('SELECT count(*)::int AS n FROM grupos_homogeneos_exposicao')).rows[0].n;

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
    await q("INSERT INTO funcionarios (empresa_id, matricula, nome, cpf, situacao) VALUES ($1, 'EXISTENTE-1', 'Existente Inativo', $2, 'INATIVO')", [empresa.A, gerarCpf(900)]);
    // GHEs (12G-9): um ativo e um inativo em A; um ativo em B, cujo nome não vale em A.
    const criarGhe = async (empresaId, nome, ativo) => (await q('INSERT INTO grupos_homogeneos_exposicao (empresa_id, nome, ativo) VALUES ($1, $2, $3) RETURNING id', [empresaId, nome, ativo])).rows[0].id;
    ghe.ativoA = await criarGhe(empresa.A, GHE.ativoA, true);
    ghe.inativoA = await criarGhe(empresa.A, GHE.inativoA, false);
    ghe.ativoB = await criarGhe(empresa.B, GHE.ativoB, true);

    const semLimite = () => criarLimitador({ limite: 100000, janelaSegundos: 60 });
    const exigirSessao = criarExigirSessao({ pool });
    app = criarAppTeste((a) => {
      a.use(
        '/api',
        criarAuthGlobalRoutes({ controller: criarAuthGlobalController({ pool }), limitador: semLimite(), exigirSessaoGlobal: criarExigirSessaoGlobal({ pool }), ...turnstileDeTeste() }),
        criarFuncionarioRoutes({ controller: criarFuncionarioController({ pool }), exigirSessao, pool }),
      );
    });
    for (const k of Object.keys(EMAILS)) cookie[k] = await sessao(EMAILS[k]);
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  test('lote misto: um resultado por linha; linha inválida, já cadastrada (inclusive existente inativo) e repetida no lote não desfazem as demais; GHE vinculado pelo nome', async () => {
    const antes = await funcionariosDe(empresa.A);
    const existenteAntes = antes.find((f) => f.matricula === 'EXISTENTE-1');
    const r = await importar('masterA', lote([
      linhaImp(2, gerarCpf(1)),
      linhaImp(3, '52998224726'), // DV inválido
      linhaImp(4, gerarCpf(900)), // CPF do existente inativo: já cadastrado, com divergências
      linhaImp(5, gerarCpf(1), { matricula: 'C4-5B' }), // CPF repetido no mesmo lote: já cadastrado pela linha 2
      linhaImp(6, gerarCpf(2), { dataAdmissao: '1985-01-01' }), // admissão antes do nascimento
      linhaImp(7, gerarCpf(3), { setor: null }), // setor obrigatório na planilha
      linhaImp(8, gerarCpf(4), { dataNascimento: null, telefone: null }),
    ]));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.linhas.map((l) => [l.linha, l.situacao, l.codigo ?? null]), [
      [2, 'CADASTRADO', null],
      [3, 'RECUSADO', 'FUNCIONARIO_CPF_INVALIDO'],
      [4, 'JA_CADASTRADO', 'FUNCIONARIO_JA_CADASTRADO_DIVERGENTE'],
      [5, 'JA_CADASTRADO', 'FUNCIONARIO_JA_CADASTRADO_DIVERGENTE'],
      [6, 'RECUSADO', 'FUNCIONARIO_DATA_ADMISSAO_INVALIDA'],
      [7, 'RECUSADO', 'FUNCIONARIO_DADOS_INVALIDOS'],
      [8, 'CADASTRADO', null],
    ]);
    assert.deepEqual(r.body.resumo, { cadastrados: 2, jaCadastrados: 0, divergentes: 2, duplicados: 0, recusados: 3, erros: 0 });
    // Divergências: campo e valor ATUAL do sistema (nunca CPF; nascimento e telefone só sinalizados); o valor da planilha não é ecoado.
    assert.equal(r.body.linhas[2].ativo, false);
    assert.deepEqual(r.body.linhas[2].divergencias, [
      { campo: 'matricula', atual: 'EXISTENTE-1' }, { campo: 'nome', atual: 'Existente Inativo' }, { campo: 'setor', atual: null }, { campo: 'funcao', atual: null },
      { campo: 'dataAdmissao', atual: null }, { campo: 'dataNascimento' }, { campo: 'telefone' }, { campo: 'ghe', atual: null },
    ]);
    assert.deepEqual(r.body.linhas[3].divergencias, [{ campo: 'matricula', atual: 'C4-2' }, { campo: 'nome', atual: 'Funcionário C4 2' }]);
    assert.doesNotMatch(JSON.stringify(r.body), new RegExp(`${gerarCpf(1)}|${gerarCpf(900)}|Funcionário C4 [45]|C4-5B|99999-0001|1990-03-15`), 'a resposta não ecoa CPF, telefone, nascimento nem os valores da planilha');

    const depois = await funcionariosDe(empresa.A);
    assert.equal(depois.length, antes.length + 2);
    assert.deepEqual(depois.find((f) => f.matricula === 'EXISTENTE-1'), existenteAntes, 'existente intocado (inclusive atualizado_em) e não reativado');
    assert.deepEqual(depois.filter((f) => f.matricula.startsWith('C4-')).map((f) => [f.matricula, f.cpf, f.admissao, f.ativo, f.ghe]),
      [['C4-2', gerarCpf(1), '2020-06-01', true, ghe.ativoA], ['C4-8', gerarCpf(4), '2020-06-01', true, ghe.ativoA]]);
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
    assert.deepEqual(
      [l.contexto.cadastrados, l.contexto.jaCadastrados, l.contexto.divergentes, l.contexto.duplicados, l.contexto.recusados, l.contexto.erros, l.contexto.linhasNoLote],
      [2, 0, 2, 0, 3, 0, 7],
    );
    // 12G-9: resultado compacto por linha no evento do lote — situação, código, funcionário e campos; nenhum valor.
    assert.deepEqual(l.contexto.linhas.map((x) => [x.linha, x.situacao, x.codigo, x.funcionarioId !== null, x.campos]), [
      [2, 'CADASTRADO', null, true, []],
      [3, 'RECUSADO', 'FUNCIONARIO_CPF_INVALIDO', false, ['cpf']],
      [4, 'JA_CADASTRADO', 'FUNCIONARIO_JA_CADASTRADO_DIVERGENTE', true, ['matricula', 'nome', 'setor', 'funcao', 'dataAdmissao', 'dataNascimento', 'telefone', 'ghe']],
      [5, 'JA_CADASTRADO', 'FUNCIONARIO_JA_CADASTRADO_DIVERGENTE', true, ['matricula', 'nome']],
      [6, 'RECUSADO', 'FUNCIONARIO_DATA_ADMISSAO_INVALIDA', false, ['dataAdmissao']],
      [7, 'RECUSADO', 'FUNCIONARIO_DADOS_INVALIDOS', false, ['setor']],
      [8, 'CADASTRADO', null, true, []],
    ]);
    const todo = JSON.stringify((await pool.query('SELECT contexto, dados_anteriores, dados_novos FROM logs_auditoria WHERE empresa_id = $1', [empresa.A])).rows);
    assert.doesNotMatch(todo, new RegExp(`${gerarCpf(1)}|${gerarCpf(4)}|${gerarCpf(900)}|99999-0001|1990-03-15|Existente Inativo|C4-5B|${GHE.ativoA}`), 'nenhum dado pessoal nem valor de linha em toda a auditoria da empresa');
  });

  test('reenvio do mesmo lote (ex.: após resultado incerto): nada é criado em dobro — os já gravados voltam como JA_CADASTRADO sem alterações, e o banco não muda', async () => {
    const antes = await funcionariosDe(empresa.A);
    const r = await importar('masterA', lote([linhaImp(2, gerarCpf(1)), linhaImp(8, gerarCpf(4), { dataNascimento: null, telefone: null })]));
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.linhas.map((l) => [l.situacao, l.codigo, l.ativo, 'divergencias' in l]), [
      ['JA_CADASTRADO', 'FUNCIONARIO_JA_CADASTRADO', true, false], ['JA_CADASTRADO', 'FUNCIONARIO_JA_CADASTRADO', true, false],
    ]);
    assert.deepEqual(r.body.resumo, { cadastrados: 0, jaCadastrados: 2, divergentes: 0, duplicados: 0, recusados: 0, erros: 0 });
    assert.deepEqual(await funcionariosDe(empresa.A), antes);
  });

  test('12G-9 existente com dados diferentes: JA_CADASTRADO_DIVERGENTE lista campo e valor atual, nada é alterado (nem auditoria de alteração); opcional vazio na planilha não diverge', async () => {
    const antes = await funcionariosDe(empresa.A);
    const alteracoesAntes = (await pool.query("SELECT count(*)::int AS n FROM logs_auditoria WHERE empresa_id = $1 AND acao IN ('FUNCIONARIO_ALTERADO', 'FUNCIONARIO_REATIVADO', 'FUNCIONARIO_INATIVADO')", [empresa.A])).rows[0].n;
    const r = await importar('masterA', lote([
      linhaImp(2, gerarCpf(1), { setor: 'Qualidade', ghe: GHE.inativoA, telefone: '(47) 98888-0002', dataAdmissao: '2021-01-01' }),
      linhaImp(8, gerarCpf(4), { dataNascimento: null, telefone: null, ghe: 'GHE Que Não Existe' }),
      linhaImp(9, gerarCpf(4), { nome: 'Funcionário C4 8', matricula: 'C4-8', dataNascimento: null, telefone: null }),
    ]));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.linhas.map((l) => [l.linha, l.situacao, l.codigo]), [
      [2, 'JA_CADASTRADO', 'FUNCIONARIO_JA_CADASTRADO_DIVERGENTE'], [8, 'JA_CADASTRADO', 'FUNCIONARIO_JA_CADASTRADO_DIVERGENTE'], [9, 'JA_CADASTRADO', 'FUNCIONARIO_JA_CADASTRADO'],
    ]);
    assert.deepEqual(r.body.linhas[0].divergencias, [
      { campo: 'setor', atual: 'Produção' }, { campo: 'dataAdmissao', atual: '2020-06-01' }, { campo: 'telefone' }, { campo: 'ghe', atual: GHE.ativoA },
    ]);
    assert.deepEqual(r.body.linhas[1].divergencias, [{ campo: 'ghe', atual: GHE.ativoA }]);
    assert.doesNotMatch(JSON.stringify(r.body), /99999-0001|98888-0002|Qualidade|2021-01-01|GHE Que Não Existe|GHE Antigo/);
    assert.deepEqual(await funcionariosDe(empresa.A), antes, 'nenhuma coluna de nenhum funcionário mudou');
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM logs_auditoria WHERE empresa_id = $1 AND acao IN ('FUNCIONARIO_ALTERADO', 'FUNCIONARIO_REATIVADO', 'FUNCIONARIO_INATIVADO')", [empresa.A])).rows[0].n, alteracoesAntes);
  });

  test('12G-9 GHE: ausente, vazio, inexistente, inativo e o nome do GHE de outra empresa recusam só a linha; ativo vincula; nenhum GHE é criado; linhas inválidas entre válidas não bloqueiam', async () => {
    const antes = await funcionariosDe(empresa.A);
    const ghesAntes = await totalGhes();
    const semGhe = linhaImp(60, gerarCpf(60));
    delete semGhe.ghe;
    const r = await importar('masterA', lote([
      semGhe,
      linhaImp(61, gerarCpf(61), { ghe: '' }),
      linhaImp(62, gerarCpf(62)),
      linhaImp(63, gerarCpf(63), { ghe: 'GHE Que Não Existe' }),
      linhaImp(64, gerarCpf(64), { ghe: GHE.inativoA }),
      linhaImp(65, gerarCpf(65), { ghe: GHE.ativoB }),
      linhaImp(66, gerarCpf(66), { ghe: ` ${GHE.ativoA} ` }),
      linhaImp(67, gerarCpf(67), { ghe: GHE.ativoA.toUpperCase() }),
    ]));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.linhas.map((l) => [l.linha, l.situacao, l.codigo ?? null, l.campos ?? null]), [
      [60, 'RECUSADO', 'FUNCIONARIO_GHE_NAO_INFORMADO', ['ghe']],
      [61, 'RECUSADO', 'FUNCIONARIO_GHE_NAO_INFORMADO', ['ghe']],
      [62, 'CADASTRADO', null, null],
      [63, 'RECUSADO', 'FUNCIONARIO_GHE_INEXISTENTE', ['ghe']],
      [64, 'RECUSADO', 'FUNCIONARIO_GHE_INATIVO', ['ghe']],
      [65, 'RECUSADO', 'FUNCIONARIO_GHE_INEXISTENTE', ['ghe']],
      [66, 'CADASTRADO', null, null],
      [67, 'RECUSADO', 'FUNCIONARIO_GHE_INEXISTENTE', ['ghe']],
    ]);
    for (const l of r.body.linhas.filter((x) => x.situacao === 'RECUSADO')) assert.match(l.motivo, /GHE/);
    assert.doesNotMatch(JSON.stringify(r.body), /GHE Que Não Existe|GHE Beta|GHE Antigo/, 'o GHE informado não é ecoado');
    assert.deepEqual(r.body.resumo, { cadastrados: 2, jaCadastrados: 0, divergentes: 0, duplicados: 0, recusados: 6, erros: 0 });
    const depois = await funcionariosDe(empresa.A);
    assert.deepEqual(depois.slice(antes.length).map((f) => [f.matricula, f.ghe]), [['C4-62', ghe.ativoA], ['C4-66', ghe.ativoA]]);
    assert.equal(await totalGhes(), ghesAntes, 'nenhum GHE criado');
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

  test('isolamento: o mesmo CPF e a mesma matrícula na empresa B são cadastrados em B (com o GHE de B); o GHE de A não existe em B; A continua igual', async () => {
    const antesA = await funcionariosDe(empresa.A);
    const r = await importar('masterB', lote([linhaImp(2, gerarCpf(1), { ghe: GHE.ativoB }), linhaImp(3, gerarCpf(3))]));
    assert.deepEqual(r.body.linhas.map((l) => [l.situacao, l.codigo ?? null]), [['CADASTRADO', null], ['RECUSADO', 'FUNCIONARIO_GHE_INEXISTENTE']]);
    assert.deepEqual(await funcionariosDe(empresa.A), antesA);
    assert.deepEqual((await funcionariosDe(empresa.B)).map((f) => [f.cpf, f.ghe]), [[gerarCpf(1), ghe.ativoB]]);
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

  test('concorrência: dois lotes simultâneos com o mesmo CPF — um cadastra; o outro recebe DUPLICADO (corrida no INSERT) ou JA_CADASTRADO (leu o já gravado); uma única linha no banco', async () => {
    const cpf = gerarCpf(40);
    const [r1, r2] = await Promise.all([
      importar('masterA', lote([linhaImp(40, cpf, { matricula: 'C4-CONC-1' })])),
      importar('masterA', lote([linhaImp(40, cpf, { matricula: 'C4-CONC-2' })])),
    ]);
    const situacoes = [r1.body.linhas[0].situacao, r2.body.linhas[0].situacao].sort();
    assert.equal(situacoes[0], 'CADASTRADO');
    assert.ok(['DUPLICADO', 'JA_CADASTRADO'].includes(situacoes[1]), situacoes[1]);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM funcionarios WHERE empresa_id = $1 AND cpf = $2', [empresa.A, cpf])).rows[0].n, 1);
  });

  test('busca por CPF: só completo, igualdade exata, restrita à empresa; parcial ou inválido → 400; independente da busca por nome/matrícula', async () => {
    const buscar = (quem, query) => request(app).get(`/api/funcionarios${query}`).set('Cookie', cookie[quem]);
    // SEC-008: CPF completo só no corpo de POST /funcionarios/consulta-cpf.
    const porCpf = (quem, valor) => request(app).post('/api/funcionarios/consulta-cpf').set('Cookie', cookie[quem]).send({ cpf: valor });
    const cpf = gerarCpf(1);
    const mascarado = `${cpf.slice(0, 3)}.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-${cpf.slice(9)}`;
    const a = await porCpf('masterA', mascarado);
    assert.equal(a.status, 200);
    assert.deepEqual(a.body.funcionarios.map((f) => [f.matricula, f.empresaId]), [['C4-2', empresa.A]]);
    assert.equal(a.body.total, 1);
    const b = await porCpf('masterB', cpf);
    assert.deepEqual(b.body.funcionarios.map((f) => f.empresaId), [empresa.B], 'mesmo CPF, só o da própria empresa');
    for (const parcial of [cpf.slice(0, 6), `${cpf.slice(0, 10)}0`]) {
      assert.equal((await porCpf('masterA', parcial)).status, 400, parcial);
    }
    assert.equal((await porCpf('masterA', gerarCpf(777))).body.total, 0, 'CPF válido inexistente: nenhum resultado');
    assert.equal((await buscar('masterA', `?cpf=${cpf}`)).status, 400, 'CPF na query é recusado');
    assert.equal((await buscar('masterA', '?busca=C4-2')).body.funcionarios[0].matricula, 'C4-2', 'busca livre continua por nome/matrícula');
    assert.equal((await buscar('masterA', `?busca=${cpf.slice(0, 5)}`)).body.total, 0, 'a busca livre nunca encontra por CPF');
  });

  test('datas AAAA-MM-DD sem fuso: POST/GET/PATCH em São Paulo, UTC, Tóquio e Berlim; PATCH omitido preserva, informado atualiza, null limpa; admissão ≤ nascimento → 400', async () => {
    const original = process.env.TZ;
    try {
      // S4: o cadastro individual exige setor, função e GHE; e a admissão não pode ser futura (as datas daqui ficaram no passado).
      const obrigatorios = { setor: 'Qualidade', funcao: 'Inspetor', grupoHomogeneoId: ghe.ativoA };
      const post = await request(app).post('/api/funcionarios').set('Cookie', cookie.masterA)
        .send({ matricula: 'C4-DATAS', nome: 'Datas C4', cpf: gerarCpf(50), dataNascimento: '1990-10-15', dataAdmissao: '2020-10-15', ...obrigatorios });
      assert.equal(post.status, 201, JSON.stringify(post.body));
      const id = post.body.funcionario.id;
      for (const fuso of ['America/Sao_Paulo', 'UTC', 'Asia/Tokyo', 'Europe/Berlin']) {
        process.env.TZ = fuso;
        const g = await request(app).get(`/api/funcionarios/${id}`).set('Cookie', cookie.masterA);
        assert.deepEqual([g.body.funcionario.dataNascimento, g.body.funcionario.dataAdmissao], ['1990-10-15', '2020-10-15'], fuso);
      }
      process.env.TZ = 'Asia/Tokyo';
      const omitido = await request(app).patch(`/api/funcionarios/${id}`).set('Cookie', cookie.masterA).send({ setor: 'Qualidade' });
      assert.deepEqual([omitido.status, omitido.body.funcionario.dataAdmissao], [200, '2020-10-15'], 'omitido: preservado');
      const informado = await request(app).patch(`/api/funcionarios/${id}`).set('Cookie', cookie.masterA).send({ dataAdmissao: '2021-01-05' });
      assert.equal(informado.body.funcionario.dataAdmissao, '2021-01-05');
      const limpo = await request(app).patch(`/api/funcionarios/${id}`).set('Cookie', cookie.masterA).send({ dataAdmissao: null });
      assert.equal(limpo.body.funcionario.dataAdmissao, null);
      const invalido = await request(app).patch(`/api/funcionarios/${id}`).set('Cookie', cookie.masterA).send({ dataAdmissao: '1990-10-15' });
      assert.deepEqual([invalido.status, invalido.body.codigo], [400, 'FUNCIONARIO_DATA_ADMISSAO_INVALIDA']);
      const antes1900 = await request(app).post('/api/funcionarios').set('Cookie', cookie.masterA)
        .send({ matricula: 'C4-1899', nome: 'Antigo', cpf: gerarCpf(51), dataAdmissao: '1899-12-31', ...obrigatorios });
      assert.deepEqual([antes1900.status, antes1900.body.codigo], [400, 'FUNCIONARIO_DATA_ADMISSAO_INVALIDA']);
      const futura = await request(app).post('/api/funcionarios').set('Cookie', cookie.masterA)
        .send({ matricula: 'C4-FUTURA', nome: 'Futura', cpf: gerarCpf(52), dataAdmissao: '2099-01-01', ...obrigatorios });
      assert.deepEqual([futura.status, futura.body.codigo], [400, 'FUNCIONARIO_DATA_ADMISSAO_INVALIDA'], 'S4: admissão futura é recusada (antes era permitida)');
      const semData = await request(app).post('/api/funcionarios').set('Cookie', cookie.masterA)
        .send({ matricula: 'C4-SEM', nome: 'Sem data', cpf: gerarCpf(53), ...obrigatorios });
      assert.equal(semData.status, 400, 'S4: a admissão passou a ser obrigatória no cadastro individual (antes: retrocompatível, sem o campo)');
      assert.ok(semData.body.detalhes.some((d) => d.campo === 'body.dataAdmissao'));
    } finally {
      if (original === undefined) delete process.env.TZ; else process.env.TZ = original;
    }
  });
});
