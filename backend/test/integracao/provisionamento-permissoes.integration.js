'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { abrirPoolTemporario, inserirEmpresa } = require('./helpers/schema-temporario');
const { criarAppTeste } = require('../helpers/app-teste');
const { criarAuthController } = require('../../src/controllers/auth.controller');
const { criarAuthRoutes } = require('../../src/routes/auth.routes');
const { criarMaterialController } = require('../../src/controllers/material.controller');
const { criarMaterialRoutes } = require('../../src/routes/material.routes');
const { criarEstoqueController } = require('../../src/controllers/estoque.controller');
const { criarEstoqueRoutes } = require('../../src/routes/estoque.routes');
const { criarGrupoHomogeneoExposicaoController } = require('../../src/controllers/grupo-homogeneo-exposicao.controller');
const { criarGrupoHomogeneoExposicaoRoutes } = require('../../src/routes/grupo-homogeneo-exposicao.routes');
const { criarFuncionarioController } = require('../../src/controllers/funcionario.controller');
const { criarFuncionarioRoutes } = require('../../src/routes/funcionario.routes');
const { criarExigirSessao } = require('../../src/middleware/autenticacao');
const { criarLimitador } = require('../../src/middleware/rate-limit');
const { gerarHashSenha } = require('../../src/security/password');
const provisionamento = require('../../src/services/provisionamento-permissoes.service');
const provisionamentoRepo = require('../../src/repositories/permissao-provisionamento.repository');
const script = require('../../scripts/provisionar-permissoes-master');

/**
 * Provisionamento das permissões do MASTER (Bloco 9, Etapa B) de ponta a
 * ponta, em PostgreSQL real (schema temporário): antes do provisionamento
 * o MASTER recebe 403 nas rotas do Bloco 9 (prova de que NÃO há bypass);
 * o dry-run não grava; a execução real insere só o ausente, audita, e o
 * MASTER passa a receber 200; a segunda execução não insere nada; uma
 * linha INSUFICIENTE preexistente é relatada e não alterada; outras
 * empresas e outros perfis não são tocados. O script administrativo é
 * exercitado pela sua função executarComando, com o pool do schema
 * temporário — nunca o banco principal.
 */

const MIGRATIONS = [
  '000', '001', '002', '003', '004', '005', '006', '007', '008', '009', '010', '011',
  '012', '013', '014', '015', '016', '017', '018', '019', '020', '021', '022', '023',
];

const SENHA = 'senha-correta-do-teste-provisionamento-2026';
const CNPJ_A = '11222333000181';
const CNPJ_B = '44555666000162';
let HASH_SENHA;

async function inserirUsuario(pool, empresaId, email, perfil) {
  const { rows } = await pool.query(
    'INSERT INTO usuarios (empresa_id, nome, email, senha_hash, perfil, ativo) VALUES ($1, $2, $3, $4, $5, true) RETURNING id',
    [empresaId, `Usuário ${email}`, email, HASH_SENHA, perfil],
  );
  return rows[0].id;
}

async function contarPermissoes(pool, empresaId) {
  const r = await pool.query('SELECT count(*)::int AS r FROM permissoes_recurso WHERE empresa_id = $1', [empresaId]);
  const a = await pool.query('SELECT count(*)::int AS a FROM permissoes_acao WHERE empresa_id = $1', [empresaId]);
  return { recursos: r.rows[0].r, acoes: a.rows[0].a };
}

async function contarAuditoria(pool, empresaId) {
  const { rows } = await pool.query("SELECT count(*)::int AS total FROM logs_auditoria WHERE empresa_id = $1 AND acao = 'PERMISSOES_MASTER_PROVISIONADAS'", [empresaId]);
  return rows[0].total;
}

function saidaCapturada() {
  const linhas = [];
  return { linhas, log: (l) => linhas.push(String(l)), error: (l) => linhas.push(`ERR ${l}`) };
}

/**
 * Instala um portão num método do repositório de provisionamento: executa
 * a implementação ORIGINAL e, na primeira chamada que casar com `filtro`,
 * sinaliza chegada e pausa até `liberar()`. Chamadas seguintes (a
 * releitura pós-conflito, por exemplo) passam direto — mesmo padrão de
 * `test/integracao/funcionario-ghe-concorrencia.integration.js`.
 *
 * Qualquer saída do teste — inclusive uma asserção falhando ANTES de
 * `liberar()` — solta o portão via `t.after`, para que a transação parada
 * nunca prenda uma conexão do pool indefinidamente.
 */
function instalarPortao(t, repo, nomes, filtro = () => true) {
  let chegou;
  let liberar;
  const chegada = new Promise((resolve) => { chegou = resolve; });
  const liberacao = new Promise((resolve) => { liberar = resolve; });
  let disparado = false;
  t.after(() => liberar());
  for (const nome of nomes) {
    const original = repo[nome];
    t.mock.method(repo, nome, async function portao(...args) {
      const resultado = await original.apply(this, args);
      if (!disparado && filtro(...args)) {
        disparado = true;
        chegou();
        await liberacao;
      }
      return resultado;
    });
  }
  return { chegada, liberar };
}

describe('Provisionamento das permissões do MASTER com PostgreSQL real', () => {
  let contexto;
  let pool;
  let app;
  let empresaA;
  let empresaB;
  let masterA;
  let cookieMasterA;
  let cookieAdminA;
  let cookieMasterB;

  async function login(cnpj, email) {
    const resposta = await request(app).post('/api/auth/login').send({ cnpj, email, senha: SENHA });
    assert.equal(resposta.status, 200);
    return resposta.headers['set-cookie'][0].split(';')[0];
  }

  before(async () => {
    HASH_SENHA = await gerarHashSenha(SENHA);
    contexto = await abrirPoolTemporario(MIGRATIONS);
    pool = contexto.pool;

    assert.equal(await inserirEmpresa(pool, CNPJ_A, 'Empresa A'), 'ok');
    assert.equal(await inserirEmpresa(pool, CNPJ_B, 'Empresa B'), 'ok');
    const { rows } = await pool.query('SELECT id, cnpj FROM empresas ORDER BY id');
    empresaA = rows.find((e) => e.cnpj === CNPJ_A).id;
    empresaB = rows.find((e) => e.cnpj === CNPJ_B).id;

    masterA = await inserirUsuario(pool, empresaA, 'master-a@demo.safeworkengenharia.com.br', 'MASTER');
    await inserirUsuario(pool, empresaA, 'admin-a@demo.safeworkengenharia.com.br', 'ADMINISTRADOR');
    await inserirUsuario(pool, empresaB, 'master-b@demo.safeworkengenharia.com.br', 'MASTER');

    const exigirSessao = criarExigirSessao({ pool });
    const limitador = criarLimitador({ limite: 1000, janelaSegundos: 60 });
    app = criarAppTeste((a) => {
      a.use(
        '/api',
        criarAuthRoutes({ controller: criarAuthController({ pool }), limitador, exigirSessao }),
        criarMaterialRoutes({ controller: criarMaterialController({ pool }), exigirSessao, pool }),
        criarEstoqueRoutes({ controller: criarEstoqueController({ pool }), exigirSessao, pool }),
        criarGrupoHomogeneoExposicaoRoutes({ controller: criarGrupoHomogeneoExposicaoController({ pool }), exigirSessao, pool }),
        criarFuncionarioRoutes({ controller: criarFuncionarioController({ pool }), exigirSessao, pool }),
      );
    });

    cookieMasterA = await login(CNPJ_A, 'master-a@demo.safeworkengenharia.com.br');
    cookieAdminA = await login(CNPJ_A, 'admin-a@demo.safeworkengenharia.com.br');
    cookieMasterB = await login(CNPJ_B, 'master-b@demo.safeworkengenharia.com.br');
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  const ROTAS_DE_LEITURA = ['/api/materiais', '/api/funcionarios', '/api/grupos-homogeneos'];

  test('1. sem provisionamento, o MASTER recebe 403 em todas as rotas do Bloco 9 (não existe bypass de perfil)', async () => {
    for (const rota of ROTAS_DE_LEITURA) {
      const r = await request(app).get(rota).set('Cookie', cookieMasterA);
      assert.equal(r.status, 403, rota);
      assert.equal(r.body.codigo, 'PERMISSAO_NEGADA');
    }
    assert.deepEqual(await contarPermissoes(pool, empresaA), { recursos: 0, acoes: 0 });
  });

  test('2. dry-run (padrão do script): relata 4 AUSENTES, não grava, não audita; saída OK', async () => {
    const saida = saidaCapturada();
    const { saida: codigo, resultado } = await script.executarComando({ empresaId: empresaA, atorId: null, executar: false }, { pool, saida });
    assert.equal(codigo, script.SAIDAS.OK);
    assert.equal(resultado.dryRun, true);
    // F — dry-run continua representando SIMULAÇÃO: nada inserido, plano
    // permanece AUSENTE (nunca INSERIDA), e a linha de totais impressa ao
    // operador não afirma nenhuma inserção.
    assert.deepEqual(provisionamento.resumir(resultado.plano), { AUSENTE: 4, ADEQUADA: 0, INSUFICIENTE: 0, NAO_CATALOGADA: 0, INSERIDA: 0 });
    assert.ok(resultado.plano.recursos.every((r) => r.situacao === 'AUSENTE'));
    assert.ok(resultado.plano.acoes.every((a) => a.situacao === 'AUSENTE'));
    assert.deepEqual(await contarPermissoes(pool, empresaA), { recursos: 0, acoes: 0 });
    assert.equal(await contarAuditoria(pool, empresaA), 0);
    assert.ok(saida.linhas.some((l) => l.startsWith('Banco: ')), 'imprime o banco em que está');
    assert.ok(saida.linhas.some((l) => l.includes('DRY-RUN')));
    assert.ok(saida.linhas.some((l) => l.includes('Nada foi gravado')));
    assert.ok(saida.linhas.some((l) => l === 'Totais: ausentes=4 inseridas=0 adequadas=0 insuficientes=0 naoCatalogadas=0'), 'dry-run nunca reporta inserção');
    assert.ok(!saida.linhas.join('\n').includes(SENHA) && !saida.linhas.join('\n').includes(HASH_SENHA), 'nenhuma credencial na saída');
    for (const rota of ROTAS_DE_LEITURA) {
      assert.equal((await request(app).get(rota).set('Cookie', cookieMasterA)).status, 403, 'dry-run não concede nada');
    }
  });

  test('3. --executar com ator: insere 3 recursos + 1 ação, audita uma vez com o ator; MASTER passa a 200 (inclusive movimentar estoque)', async () => {
    const saida = saidaCapturada();
    const { saida: codigo, resultado } = await script.executarComando({ empresaId: empresaA, atorId: masterA, executar: true }, { pool, saida });
    assert.equal(codigo, script.SAIDAS.OK);
    assert.deepEqual(resultado.inseridos, { recursos: ['materials', 'employeeHistory', 'employeeGroups'], acoes: ['MOVIMENTAR_ESTOQUE'] });
    assert.deepEqual(await contarPermissoes(pool, empresaA), { recursos: 3, acoes: 1 });

    // A/B/C/D/E — o plano FINAL desta execução não pode chamar de AUSENTE o
    // que acabou de ser inserido e confirmado: os 4 itens viram INSERIDA, e
    // os totais impressos ao operador refletem exatamente isso (ausentes=0).
    assert.ok(resultado.plano.recursos.every((r) => r.situacao === 'INSERIDA'), 'nenhum item inserido continua rotulado AUSENTE no plano final');
    assert.ok(resultado.plano.acoes.every((a) => a.situacao === 'INSERIDA'));
    assert.deepEqual(provisionamento.resumir(resultado.plano), { AUSENTE: 0, ADEQUADA: 0, INSUFICIENTE: 0, NAO_CATALOGADA: 0, INSERIDA: 4 });
    assert.ok(saida.linhas.some((l) => l === 'Totais: ausentes=0 inseridas=4 adequadas=0 insuficientes=0 naoCatalogadas=0'), 'relatório administrativo não pode mais dizer "ausentes=4" depois de inserir com sucesso');

    const { rows } = await pool.query(
      'SELECT recurso, pode_visualizar, pode_criar, pode_editar, pode_excluir, perfil FROM permissoes_recurso WHERE empresa_id = $1 ORDER BY recurso',
      [empresaA],
    );
    assert.deepEqual(rows, [
      { recurso: 'employeeGroups', pode_visualizar: true, pode_criar: true, pode_editar: true, pode_excluir: false, perfil: 'MASTER' },
      { recurso: 'employeeHistory', pode_visualizar: true, pode_criar: true, pode_editar: true, pode_excluir: false, perfil: 'MASTER' },
      { recurso: 'materials', pode_visualizar: true, pode_criar: true, pode_editar: true, pode_excluir: false, perfil: 'MASTER' },
    ]);

    assert.equal(await contarAuditoria(pool, empresaA), 1);
    const auditoria = await pool.query("SELECT usuario_id, referencia, contexto, dados_novos FROM logs_auditoria WHERE empresa_id = $1 AND acao = 'PERMISSOES_MASTER_PROVISIONADAS'", [empresaA]);
    assert.equal(auditoria.rows[0].usuario_id, masterA);
    assert.equal(auditoria.rows[0].referencia, String(empresaA));
    assert.equal(auditoria.rows[0].contexto.origem, 'script_administrativo');
    assert.deepEqual(auditoria.rows[0].dados_novos.acoes, [{ acaoCodigo: 'MOVIMENTAR_ESTOQUE', permitido: true }]);
    assert.ok(saida.linhas.some((l) => l.startsWith('Auditoria: logs_auditoria id ')));

    for (const rota of ROTAS_DE_LEITURA) {
      assert.equal((await request(app).get(rota).set('Cookie', cookieMasterA)).status, 200, rota);
    }
    const material = await request(app).post('/api/materiais').set('Cookie', cookieMasterA).send({ nome: 'Luva nitrílica' });
    assert.equal(material.status, 201);
    const movimento = await request(app).post(`/api/materiais/${material.body.material.id}/estoque/movimentar`).set('Cookie', cookieMasterA).send({ tamanho: 'M', tipo: 'ENTRADA', quantidade: 10 });
    assert.equal(movimento.status, 200, 'MOVIMENTAR_ESTOQUE concedida ao MASTER pela linha de permissoes_acao');
    assert.equal((await request(app).post('/api/grupos-homogeneos').set('Cookie', cookieMasterA).send({ nome: 'GHE 1' })).status, 201);
    assert.equal((await request(app).post('/api/funcionarios').set('Cookie', cookieMasterA).send({ matricula: 'M1', nome: 'F', cpf: '529.982.247-25' })).status, 201);
  });

  test('4. idempotência: segunda execução não insere nada e não audita de novo; saída OK', async () => {
    const antes = await contarPermissoes(pool, empresaA);
    const { saida: codigo, resultado } = await script.executarComando({ empresaId: empresaA, atorId: null, executar: true }, { pool, saida: saidaCapturada() });
    assert.equal(codigo, script.SAIDAS.OK);
    assert.deepEqual(resultado.inseridos, { recursos: [], acoes: [] });
    assert.equal(resultado.auditoriaId, null);
    // G — a segunda execução não insere nada: os 4 itens são reclassificados
    // ADEQUADA por planejar() (já existem com as flags certas), não INSERIDA
    // (esta execução não inseriu nada) — distinção preservada.
    assert.deepEqual(provisionamento.resumir(resultado.plano), { AUSENTE: 0, ADEQUADA: 4, INSUFICIENTE: 0, NAO_CATALOGADA: 0, INSERIDA: 0 });
    assert.deepEqual(await contarPermissoes(pool, empresaA), antes);
    assert.equal(await contarAuditoria(pool, empresaA), 1);
  });

  test('5. escopo e isolamento: ADMINISTRADOR da A continua 403 (só MASTER é provisionado); empresa B intocada (0 linhas, MASTER B 403)', async () => {
    for (const rota of ROTAS_DE_LEITURA) {
      assert.equal((await request(app).get(rota).set('Cookie', cookieAdminA)).status, 403, `ADMINISTRADOR ${rota}`);
      assert.equal((await request(app).get(rota).set('Cookie', cookieMasterB)).status, 403, `MASTER B ${rota}`);
    }
    assert.deepEqual(await contarPermissoes(pool, empresaB), { recursos: 0, acoes: 0 });
    const { rows } = await pool.query("SELECT count(*)::int AS total FROM permissoes_recurso WHERE empresa_id = $1 AND perfil <> 'MASTER'", [empresaA]);
    assert.equal(rows[0].total, 0, 'nenhum outro perfil recebe linha');
  });

  test('6. linha INSUFICIENTE preexistente (materials sem editar; ação negada) na empresa B: relatada, NÃO alterada; o resto é inserido; saída ATENCAO', async () => {
    await pool.query(
      `INSERT INTO permissoes_recurso (empresa_id, perfil, recurso, pode_visualizar, pode_criar, pode_editar, pode_excluir)
       VALUES ($1, 'MASTER', 'materials', true, true, false, false)`,
      [empresaB],
    );
    await pool.query("INSERT INTO permissoes_acao (empresa_id, perfil, acao_codigo, permitido) VALUES ($1, 'MASTER', 'MOVIMENTAR_ESTOQUE', false)", [empresaB]);
    const antes = await pool.query("SELECT atualizado_em FROM permissoes_recurso WHERE empresa_id = $1 AND recurso = 'materials'", [empresaB]);

    const dry = await script.executarComando({ empresaId: empresaB, atorId: null, executar: false }, { pool, saida: saidaCapturada() });
    assert.equal(dry.saida, script.SAIDAS.ATENCAO);
    const porRecurso = Object.fromEntries(dry.resultado.plano.recursos.map((r) => [r.recurso, r]));
    assert.equal(porRecurso.materials.situacao, 'INSUFICIENTE');
    assert.deepEqual(porRecurso.materials.faltantes, ['editar']);
    assert.equal(porRecurso.employeeHistory.situacao, 'AUSENTE');
    assert.equal(dry.resultado.plano.acoes[0].situacao, 'INSUFICIENTE');

    const saida = saidaCapturada();
    const exec = await script.executarComando({ empresaId: empresaB, atorId: null, executar: true }, { pool, saida });
    assert.equal(exec.saida, script.SAIDAS.ATENCAO);
    assert.deepEqual(exec.resultado.inseridos, { recursos: ['employeeHistory', 'employeeGroups'], acoes: [] });
    assert.ok(saida.linhas.some((l) => l.startsWith('ERR ATENÇÃO')));

    // G/H no plano FINAL desta execução: o que foi inserido agora vira
    // INSERIDA (não mais AUSENTE); o que já existia negado continua
    // INSUFICIENTE, byte a byte — nada se confunde numa execução mista.
    const porRecursoFinal = Object.fromEntries(exec.resultado.plano.recursos.map((r) => [r.recurso, r]));
    assert.equal(porRecursoFinal.materials.situacao, 'INSUFICIENTE');
    assert.equal(porRecursoFinal.employeeHistory.situacao, 'INSERIDA');
    assert.equal(porRecursoFinal.employeeGroups.situacao, 'INSERIDA');
    assert.equal(exec.resultado.plano.acoes[0].situacao, 'INSUFICIENTE');
    assert.deepEqual(provisionamento.resumir(exec.resultado.plano), { AUSENTE: 0, ADEQUADA: 0, INSUFICIENTE: 2, NAO_CATALOGADA: 0, INSERIDA: 2 });

    const depois = await pool.query("SELECT pode_visualizar, pode_criar, pode_editar, pode_excluir, atualizado_em FROM permissoes_recurso WHERE empresa_id = $1 AND recurso = 'materials'", [empresaB]);
    assert.deepEqual(
      { v: depois.rows[0].pode_visualizar, c: depois.rows[0].pode_criar, e: depois.rows[0].pode_editar, x: depois.rows[0].pode_excluir },
      { v: true, c: true, e: false, x: false },
      'a linha insuficiente permanece exatamente como estava',
    );
    assert.equal(depois.rows[0].atualizado_em.getTime(), antes.rows[0].atualizado_em.getTime(), 'nem o trigger de atualizado_em disparou: nenhum UPDATE');
    const acao = await pool.query("SELECT permitido FROM permissoes_acao WHERE empresa_id = $1 AND acao_codigo = 'MOVIMENTAR_ESTOQUE'", [empresaB]);
    assert.equal(acao.rows[0].permitido, false, 'ação negada permanece negada');
    assert.deepEqual(await contarPermissoes(pool, empresaB), { recursos: 3, acoes: 1 });

    const auditoria = await pool.query("SELECT contexto FROM logs_auditoria WHERE empresa_id = $1 AND acao = 'PERMISSOES_MASTER_PROVISIONADAS'", [empresaB]);
    assert.equal(auditoria.rows.length, 1);
    assert.deepEqual(auditoria.rows[0].contexto.naoAlterados, {
      recursosInsuficientes: [{ recurso: 'materials', faltantes: ['editar'] }],
      acoesInsuficientes: ['MOVIMENTAR_ESTOQUE'],
      acoesNaoCatalogadas: [],
    });

    // Consequência observável no RBAC: MASTER B vê materiais (visualizar concedido), mas não edita (a linha insuficiente não foi "corrigida" pelo script).
    assert.equal((await request(app).get('/api/materiais').set('Cookie', cookieMasterB)).status, 200);
    assert.equal((await request(app).post('/api/materiais').set('Cookie', cookieMasterB).send({ nome: 'X' })).status, 201, 'criar estava concedido');
    const { rows: mats } = await pool.query('SELECT id FROM materiais WHERE empresa_id = $1', [empresaB]);
    assert.equal((await request(app).patch(`/api/materiais/${mats[0].id}`).set('Cookie', cookieMasterB).send({ nome: 'Y' })).status, 403, 'editar continua negado');
  });

  test('7. empresa inexistente ou inativa: recusado com saída EMPRESA, nada gravado; ator de outra empresa: recusado com ROLLBACK', async () => {
    const inexistente = await script.executarComando({ empresaId: 999999, atorId: null, executar: true }, { pool, saida: saidaCapturada() });
    assert.equal(inexistente.saida, script.SAIDAS.EMPRESA);

    await pool.query('UPDATE empresas SET ativo = false WHERE id = $1', [empresaB]);
    const inativa = await script.executarComando({ empresaId: empresaB, atorId: null, executar: true }, { pool, saida: saidaCapturada() });
    assert.equal(inativa.saida, script.SAIDAS.EMPRESA);
    await pool.query('UPDATE empresas SET ativo = true WHERE id = $1', [empresaB]);

    const totalAntes = await contarPermissoes(pool, empresaB);
    const atorErrado = await script.executarComando({ empresaId: empresaB, atorId: masterA, executar: true }, { pool, saida: saidaCapturada() });
    assert.equal(atorErrado.saida, script.SAIDAS.EMPRESA);
    assert.deepEqual(await contarPermissoes(pool, empresaB), totalAntes);
  });

  describe('8. Concorrência REAL (Ajuste 2, correção pós-auditoria independente de 23/09/2026)', () => {
    /**
     * Interleaving controlado com conexões independentes do mesmo Pool: um
     * portão pausa a transação de provisionamento logo após a leitura de
     * planejamento (`planejar()`), ANTES da tentativa de INSERT; enquanto
     * pausada, uma SEGUNDA conexão (`pool.query`, fora da transação de
     * provisionamento) insere e COMMITA uma linha concorrente para o mesmo
     * empresa+perfil+recurso; o portão libera; a transação de
     * provisionamento retoma, tenta o INSERT (que agora conflita e não
     * insere nada) e precisa relêr — dentro da PRÓPRIA transação — para
     * decidir o que realmente aconteceu, sem presumir sucesso.
     */
    let empresaC;
    let empresaD;

    before(async () => {
      assert.equal(await inserirEmpresa(pool, '77888999000110', 'Empresa C'), 'ok');
      assert.equal(await inserirEmpresa(pool, '22333444000155', 'Empresa D'), 'ok');
      const { rows } = await pool.query('SELECT id, cnpj FROM empresas WHERE cnpj IN ($1, $2)', ['77888999000110', '22333444000155']);
      empresaC = rows.find((e) => e.cnpj === '77888999000110').id;
      empresaD = rows.find((e) => e.cnpj === '22333444000155').id;
    });

    test('outra CONEXÃO insere uma linha NEGADA entre o planejamento e o INSERT: reclassificada como INSUFICIENTE, preservada intocada, nada inserido/auditado indevidamente', async (t) => {
      const portao = instalarPortao(t, provisionamentoRepo, ['listarPermissoesRecurso'], (_executor, empresaId) => empresaId === empresaC);

      const execucao = provisionamento.provisionar(pool, { empresaId: empresaC, dryRun: false });
      await portao.chegada;

      // Conexão INDEPENDENTE (não é a transação de `execucao`): insere e
      // commita imediatamente — um `pool.query` fora de transação explícita
      // é uma única instrução autocommitada em sua própria conexão.
      await pool.query(
        `INSERT INTO permissoes_recurso (empresa_id, perfil, recurso, pode_visualizar, pode_criar, pode_editar, pode_excluir)
         VALUES ($1, 'MASTER', 'materials', true, true, false, false)`,
        [empresaC],
      );
      portao.liberar();

      const resultado = await execucao;

      assert.ok(!resultado.inseridos.recursos.includes('materials'), 'materials NÃO foi inserido por esta transação — a linha concorrente já existia');
      const materials = resultado.plano.recursos.find((r) => r.recurso === 'materials');
      assert.equal(materials.situacao, provisionamento.SITUACAO.INSUFICIENTE);
      assert.deepEqual(materials.faltantes, ['editar']);
      assert.deepEqual(resultado.inseridos.recursos.sort(), ['employeeGroups', 'employeeHistory'], 'os dois recursos que NÃO conflitaram foram inseridos normalmente');

      const { rows } = await pool.query(
        "SELECT pode_visualizar, pode_criar, pode_editar, pode_excluir FROM permissoes_recurso WHERE empresa_id = $1 AND recurso = 'materials'",
        [empresaC],
      );
      assert.equal(rows.length, 1, 'nenhuma segunda linha: sem duplicidade');
      assert.deepEqual(rows[0], { pode_visualizar: true, pode_criar: true, pode_editar: false, pode_excluir: false }, 'a linha persistida é EXATAMENTE a que a conexão concorrente inseriu — não foi sobrescrita (sem DO UPDATE)');

      const { rows: auditoria } = await pool.query(
        "SELECT contexto, dados_novos FROM logs_auditoria WHERE empresa_id = $1 AND acao = 'PERMISSOES_MASTER_PROVISIONADAS'",
        [empresaC],
      );
      assert.equal(auditoria.length, 1);
      assert.ok(!auditoria[0].dados_novos.recursos.some((r) => r.recurso === 'materials'), 'auditoria nunca descreve uma inserção que não aconteceu');
      assert.deepEqual(auditoria[0].contexto.naoAlterados.recursosInsuficientes, [{ recurso: 'materials', faltantes: ['editar'] }], 'comunicação expressa da pendência ao operador');
    });

    test('script administrativo: saída ATENCAO (nunca OK/0) quando a corrida deixa uma permissão necessária INSUFICIENTE', async (t) => {
      const portao = instalarPortao(t, provisionamentoRepo, ['listarPermissoesRecurso'], (_executor, empresaId) => empresaId === empresaD);

      const execucaoScript = script.executarComando({ empresaId: empresaD, atorId: null, executar: true }, { pool, saida: saidaCapturada() });
      await portao.chegada;

      await pool.query(
        `INSERT INTO permissoes_recurso (empresa_id, perfil, recurso, pode_visualizar, pode_criar, pode_editar, pode_excluir)
         VALUES ($1, 'MASTER', 'employeeHistory', true, false, false, false)`,
        [empresaD],
      );
      portao.liberar();

      const { saida: codigo, resultado } = await execucaoScript;
      assert.notEqual(codigo, script.SAIDAS.OK, 'nunca sucesso silencioso com uma permissão necessária ainda INSUFICIENTE');
      assert.equal(codigo, script.SAIDAS.ATENCAO);
      const employeeHistory = resultado.plano.recursos.find((r) => r.recurso === 'employeeHistory');
      assert.equal(employeeHistory.situacao, provisionamento.SITUACAO.INSUFICIENTE);
      assert.deepEqual(employeeHistory.faltantes, ['criar', 'editar']);
    });
  });
});
