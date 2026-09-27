'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const request = require('supertest');

const { abrirPoolTemporario } = require('./helpers/schema-temporario');
const { criarAppTeste } = require('../helpers/app-teste');
const { criarAuthGlobalController } = require('../../src/controllers/auth-global.controller');
const { criarAuthGlobalRoutes } = require('../../src/routes/auth-global.routes');
const { criarEstoqueController } = require('../../src/controllers/estoque.controller');
const { criarEstoqueRoutes } = require('../../src/routes/estoque.routes');
const { criarExigirSessao } = require('../../src/middleware/autenticacao');
const { criarExigirSessaoGlobal } = require('../../src/middleware/autenticacao-global');
const { criarLimitador } = require('../../src/middleware/rate-limit');
const { gerarHashSenha } = require('../../src/security/password');
const { authConfig } = require('../../src/config/auth');
const provisionamento = require('../../src/services/provisionamento-permissoes.service');

/**
 * E8 — Operações de estoque: GET /api/estoque/operacoes lê o fato de negócio
 * de estoque_operacoes (saldo inicial, entrada, baixa), nunca logs_auditoria.
 * PostgreSQL real, schema temporário. Parte das operações nasce pela API real
 * (entrada idempotente e baixa); parte é gravada com data controlada.
 */

const TODAS_AS_MIGRATIONS = Array.from({ length: 46 }, (_, i) => String(i).padStart(3, '0'));
const SENHA = 'senha-forte-das-operacoes-2026';
const EMAILS = {
  masterA: 'master.a.operacoes@exemplo-cliente.com.br',
  usuarioA: 'usuario.a.operacoes@exemplo-cliente.com.br', // sem operations
  masterB: 'master.b.operacoes@exemplo-cliente.com.br',
};
const { cookieNome: C_EMPRESA, cookieNomeGlobal: C_GLOBAL } = authConfig.sessao;
const ATAQUE = '<img src=x onerror=alert(1)>';

function cookiesDe(resposta) {
  const saida = {};
  for (const bruto of resposta.headers['set-cookie'] || []) {
    const [par] = bruto.split(';');
    const i = par.indexOf('=');
    saida[par.slice(0, i)] = par.slice(i + 1);
  }
  return saida;
}

describe('E8 — operações de estoque (PostgreSQL real)', () => {
  let contexto;
  let pool;
  let app;
  const empresa = {};
  const u = {};
  const m = {};
  const lote = {};
  const op = {};
  const cookie = {};

  const q = (sql, params) => pool.query(sql, params);
  const get = (quem, rota) => request(app).get(rota).set('Cookie', cookie[quem]);
  const operacoes = (quem, query = '') => get(quem, `/api/estoque/operacoes${query}`);
  const porId = (lista) => Object.fromEntries(lista.map((o) => [o.operacaoId, o]));

  /** Lote de saldo inicial e a sua operação, na mesma transação, com data controlada. */
  async function saldoInicial(chave, empresaId, materialId, tamanho, quantidade, ca, validade, criadoEm) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      lote[chave] = (await c.query(
        `INSERT INTO estoque_lotes (empresa_id, material_id, tamanho, ca_numero, ca_validade, origem, quantidade_entrada)
         VALUES ($1, $2, $3, $4, $5, 'SALDO_INICIAL', $6) RETURNING id`,
        [empresaId, materialId, tamanho, ca, validade, quantidade],
      )).rows[0].id;
      op[chave] = (await c.query(
        "INSERT INTO estoque_operacoes (empresa_id, lote_id, tipo, quantidade, criado_em) VALUES ($1, $2, 'SALDO_INICIAL', $3, $4) RETURNING id::text",
        [empresaId, lote[chave], quantidade, criadoEm],
      )).rows[0].id;
      await c.query('COMMIT');
    } catch (erro) {
      await c.query('ROLLBACK');
      throw erro;
    } finally {
      c.release();
    }
  }

  /** Baixa gravada direto, com data controlada, como a API gravaria. */
  async function baixaDireta(chave, empresaId, loteChave, quantidade, motivo, usuarioId, criadoEm, justificativa = null) {
    op[chave] = (await q(
      `INSERT INTO estoque_operacoes (empresa_id, lote_id, tipo, quantidade, motivo, justificativa, usuario_id, chave_idempotencia, requisicao_hash, criado_em)
       VALUES ($1, $2, 'BAIXA', $3, $4, $5, $6, $7, $8, $9) RETURNING id::text`,
      [empresaId, lote[loteChave], quantidade, motivo, justificativa, usuarioId, crypto.randomUUID(), 'e'.repeat(64), criadoEm],
    )).rows[0].id;
  }

  before(async () => {
    contexto = await abrirPoolTemporario(TODAS_AS_MIGRATIONS);
    pool = contexto.pool;
    const hash = await gerarHashSenha(SENHA);

    for (const [k, nome, cnpj] of [['A', 'Empresa Alfa Operações', '11222333000181'], ['B', 'Empresa Beta Operações', '22333444000100']]) {
      empresa[k] = (await q('INSERT INTO empresas (nome, cnpj) VALUES ($1, $2) RETURNING id', [nome, cnpj])).rows[0].id;
      await provisionamento.provisionar(pool, { empresaId: empresa[k], dryRun: false });
    }
    const vinculo = async (chave, empresaId, email, perfil, nome) => {
      const id = (await q('INSERT INTO identidades (email, senha_hash) VALUES ($1, $2) RETURNING id', [email, hash])).rows[0].id;
      u[chave] = (await q('INSERT INTO usuarios (empresa_id, nome, email, senha_hash, perfil, identidade_id) VALUES ($1, $2, NULL, NULL, $3, $4) RETURNING id',
        [empresaId, nome, perfil, id])).rows[0].id;
    };
    await vinculo('masterA', empresa.A, EMAILS.masterA, 'MASTER', 'Maria Estoquista');
    await vinculo('usuarioA', empresa.A, EMAILS.usuarioA, 'USUARIO', 'Usuário sem estoque');
    await vinculo('masterB', empresa.B, EMAILS.masterB, 'MASTER', 'Bruno B');

    const material = async (chave, empresaId, nome, exigeTamanho) => {
      m[chave] = (await q('INSERT INTO materiais (empresa_id, nome, tipo, prazo_uso_dias, exige_tamanho, codigo_interno) VALUES ($1, $2, $3, 180, $4, $5) RETURNING id',
        [empresaId, nome, 'Luva', exigeTamanho, `COD-${chave}`])).rows[0].id;
    };
    await material('botina', empresa.A, 'Botina de segurança', true);
    await material('luva', empresa.A, ATAQUE, false);
    await material('botinaB', empresa.B, 'Botina B', true);

    // Datas controladas no passado. A baixa de 10/09 às 02h30 UTC é 09/09 às 23h30 em São Paulo.
    await saldoInicial('saldoBotina', empresa.A, m.botina, '40', 10, 'CA-100', '2027-01-31', '2026-09-01T12:00:00Z');
    await saldoInicial('saldoLuva', empresa.A, m.luva, null, 6, null, null, '2026-09-01T12:00:00Z');
    await baixaDireta('baixaAvaria', empresa.A, 'saldoBotina', 2, 'AVARIA', u.masterA, '2026-09-10T02:30:00Z');
    await saldoInicial('saldoB', empresa.B, m.botinaB, '40', 50, 'CA-B', '2027-01-31', '2026-09-05T12:00:00Z');

    const semLimite = () => criarLimitador({ limite: 100000, janelaSegundos: 60 });
    const exigirSessao = criarExigirSessao({ pool });
    app = criarAppTeste((a) => {
      a.use(
        '/api',
        criarAuthGlobalRoutes({ controller: criarAuthGlobalController({ pool }), limitador: semLimite(), exigirSessaoGlobal: criarExigirSessaoGlobal({ pool }) }),
        criarEstoqueRoutes({ controller: criarEstoqueController({ pool }), exigirSessao, pool }),
      );
    });
    for (const k of Object.keys(EMAILS)) {
      const login = await request(app).post('/api/auth/global/login').send({ email: EMAILS[k], senha: SENHA });
      assert.equal(login.status, 200, JSON.stringify(login.body));
      const c = cookiesDe(login);
      cookie[k] = `${C_GLOBAL}=${c[C_GLOBAL]}; ${C_EMPRESA}=${c[C_EMPRESA]}`;
    }

    // Pela API real: uma entrada repetida com a mesma chave e uma baixa "Outro" justificada.
    const chave = crypto.randomUUID();
    const corpoEntrada = { tamanho: '42', quantidade: 5, caNumero: 'CA-777', caValidade: '2030-12-31', chaveIdempotencia: chave };
    const e1 = await request(app).post(`/api/materiais/${m.botina}/estoque/entradas`).set('Cookie', cookie.masterA).send(corpoEntrada);
    const e2 = await request(app).post(`/api/materiais/${m.botina}/estoque/entradas`).set('Cookie', cookie.masterA).send(corpoEntrada);
    assert.deepEqual([e1.status, e2.status, e2.body.repetida], [201, 200, true], JSON.stringify(e2.body));
    lote.entrada = e1.body.lote.loteId;
    op.entrada = String(e1.body.operacao.id);
    const b = await request(app).post(`/api/estoque/lotes/${lote.entrada}/baixas`).set('Cookie', cookie.masterA)
      .send({ quantidade: 1, motivo: 'OUTRO', justificativa: 'Doação para treinamento', chaveIdempotencia: crypto.randomUUID() });
    assert.equal(b.status, 201, JSON.stringify(b.body));
    op.baixaOutro = String(b.body.operacao.id);
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  test('1, 13 e 16. saldo inicial aparece como saldo inicial, sem responsável; tamanho null vem null', async () => {
    const r = await operacoes('masterA', '?limite=100');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const o = porId(r.body.operacoes);
    assert.deepEqual(o[op.saldoBotina], {
      operacaoId: op.saldoBotina, tipo: 'SALDO_INICIAL', quantidade: 10, motivo: null, justificativa: null, responsavel: null,
      criadoEm: '2026-09-01T12:00:00.000Z', loteId: lote.saldoBotina, materialId: m.botina, material: 'Botina de segurança', codigoInterno: 'COD-botina',
      tamanho: '40', caNumero: 'CA-100', caValidade: '2027-01-31',
    });
    assert.deepEqual([o[op.saldoLuva].tamanho, o[op.saldoLuva].caNumero, o[op.saldoLuva].responsavel], [null, null, null]);
  });

  test('2. entrada aparece com lote, tamanho, CA, quantidade e o responsável da própria empresa', async () => {
    const o = porId((await operacoes('masterA', '?limite=100')).body.operacoes)[op.entrada];
    assert.deepEqual([o.tipo, o.quantidade, o.tamanho, o.caNumero, o.caValidade, o.loteId, o.responsavel, o.motivo], ['ENTRADA', 5, '42', 'CA-777', '2030-12-31', lote.entrada, 'Maria Estoquista', null]);
  });

  test('3, 14 e 15. baixa aparece com o motivo gravado e a justificativa, quando existe', async () => {
    const o = porId((await operacoes('masterA', '?limite=100')).body.operacoes);
    assert.deepEqual([o[op.baixaAvaria].tipo, o[op.baixaAvaria].quantidade, o[op.baixaAvaria].motivo, o[op.baixaAvaria].justificativa], ['BAIXA', 2, 'AVARIA', null]);
    assert.deepEqual([o[op.baixaOutro].motivo, o[op.baixaOutro].justificativa, o[op.baixaOutro].responsavel], ['OUTRO', 'Doação para treinamento', 'Maria Estoquista']);
  });

  test('4. mais recente primeiro; no mesmo instante, o id maior primeiro', async () => {
    const lista = (await operacoes('masterA', '?limite=100')).body.operacoes;
    for (let i = 1; i < lista.length; i += 1) {
      const [a, b] = [lista[i - 1], lista[i]];
      assert.ok(a.criadoEm > b.criadoEm || (a.criadoEm === b.criadoEm && BigInt(a.operacaoId) > BigInt(b.operacaoId)), `${a.operacaoId} antes de ${b.operacaoId}`);
    }
    assert.deepEqual(lista.slice(-2).map((o) => o.operacaoId), [op.saldoLuva, op.saldoBotina], 'mesmo instante: id maior antes');
  });

  test('5 e 6. paginação com total e páginas; limite padrão 50 e teto 100', async () => {
    const todas = (await operacoes('masterA', '?limite=100')).body.operacoes.map((o) => o.operacaoId);
    const r = await operacoes('masterA', '?limite=2&pagina=2');
    assert.deepEqual([r.body.total, r.body.pagina, r.body.limite, r.body.paginas], [5, 2, 2, 3]);
    assert.deepEqual(r.body.operacoes.map((o) => o.operacaoId), todas.slice(2, 4));
    assert.equal((await operacoes('masterA')).body.limite, 50);
    assert.deepEqual([(await operacoes('masterA', '?limite=101')).status, (await operacoes('masterA', '?limite=0')).status], [400, 400]);
  });

  test('7. filtro por operação: só o tipo pedido', async () => {
    for (const [tipo, esperadas] of [['SALDO_INICIAL', [op.saldoBotina, op.saldoLuva]], ['ENTRADA', [op.entrada]], ['BAIXA', [op.baixaAvaria, op.baixaOutro]]]) {
      const r = await operacoes('masterA', `?tipo=${tipo}&limite=100`);
      assert.deepEqual(r.body.operacoes.map((o) => o.operacaoId).sort(), [...esperadas].sort(), tipo);
      assert.ok(r.body.operacoes.every((o) => o.tipo === tipo));
    }
  });

  test('8. período em dias de São Paulo: 10/09 às 02h30 UTC é 09/09 às 23h30', async () => {
    const dia09 = await operacoes('masterA', '?de=2026-09-09&ate=2026-09-09');
    assert.deepEqual(dia09.body.operacoes.map((o) => o.operacaoId), [op.baixaAvaria]);
    assert.equal((await operacoes('masterA', '?de=2026-09-10&ate=2026-09-10')).body.total, 0);
    const setembroAte09 = await operacoes('masterA', '?ate=2026-09-09&limite=100');
    assert.deepEqual(setembroAte09.body.operacoes.map((o) => o.operacaoId).sort(), [op.baixaAvaria, op.saldoBotina, op.saldoLuva].sort());
  });

  test('9 e 10. busca por material e por CA, sem diferenciar maiúsculas; coringas são texto', async () => {
    const porMaterial = await operacoes('masterA', '?busca=BOTINA&limite=100');
    assert.ok(porMaterial.body.total > 0 && porMaterial.body.operacoes.every((o) => o.materialId === m.botina));
    const porCa = await operacoes('masterA', '?busca=ca-777');
    assert.deepEqual(porCa.body.operacoes.map((o) => o.operacaoId).sort(), [op.entrada, op.baixaOutro].sort());
    for (const coringa of ['%25', '_']) assert.equal((await operacoes('masterA', `?busca=${coringa}`)).body.total, 0, coringa);
  });

  test('11. empresa A não vê operações da B, e B não vê as da A', async () => {
    const a = (await operacoes('masterA', '?limite=100')).body.operacoes.map((o) => o.operacaoId);
    const b = (await operacoes('masterB', '?limite=100')).body.operacoes.map((o) => o.operacaoId);
    assert.deepEqual(b, [op.saldoB]);
    assert.equal(a.includes(op.saldoB), false);
  });

  test('12. filtro adulterado, ordenação pedida pelo cliente, datas inválidas ou período invertido: 400, nada listado', async () => {
    for (const query of ['?tipo=ENTREGA', '?tipo=entrada', "?tipo=BAIXA'%20OR%201=1", '?tipo=BAIXA&tipo=ENTRADA', '?ordem=criado_em', '?empresaId=2', '?de=2026-13-01',
      '?de=2026-09-10&ate=2026-09-09', '?ate=ontem', '?busca=' + 'x'.repeat(101)]) {
      const r = await operacoes('masterA', query);
      assert.deepEqual([r.status, r.body.codigo], [400, 'VALIDACAO'], query);
      assert.equal('operacoes' in r.body, false, query);
    }
  });

  test('17. a entrada repetida com a mesma chave aparece uma vez só', async () => {
    const entradas = (await operacoes('masterA', '?tipo=ENTRADA&limite=100')).body.operacoes;
    assert.equal(entradas.length, 1);
    assert.equal((await q("SELECT count(*)::int AS n FROM estoque_operacoes WHERE tipo = 'ENTRADA' AND empresa_id = $1", [empresa.A])).rows[0].n, 1);
  });

  test('18. texto vindo do cadastro volta como dado, sem virar nada: o nome com marcação chega igual', async () => {
    const o = porId((await operacoes('masterA', '?limite=100')).body.operacoes)[op.saldoLuva];
    assert.equal(o.material, ATAQUE);
  });

  test('19. a fonte é estoque_operacoes: a auditoria da entrada e da baixa não vira operação; o SQL não lê logs_auditoria', async () => {
    const auditorias = (await q("SELECT count(*)::int AS n FROM logs_auditoria WHERE empresa_id = $1 AND acao LIKE 'ESTOQUE_%'", [empresa.A])).rows[0].n;
    assert.ok(auditorias > 0, 'a API gravou auditoria');
    const total = (await operacoes('masterA')).body.total;
    assert.equal(total, (await q('SELECT count(*)::int AS n FROM estoque_operacoes WHERE empresa_id = $1', [empresa.A])).rows[0].n);
    const repositorio = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'repositories', 'estoque-operacao.repository.js'), 'utf8');
    assert.equal(/logs_auditoria/.test(repositorio), false);
  });

  test('20. histórico só de leitura: não há rota para editar ou excluir operação', async () => {
    for (const metodo of ['patch', 'put', 'delete']) {
      const r = await request(app)[metodo](`/api/estoque/operacoes/${op.entrada}`).set('Cookie', cookie.masterA).send({ quantidade: 99 });
      assert.equal(r.status, 404, metodo);
    }
    assert.equal((await q('SELECT quantidade FROM estoque_operacoes WHERE id = $1', [op.entrada])).rows[0].quantidade, 5);
  });

  test('autenticação e RBAC: sem sessão 401; sem operations.visualizar 403, nada listado', async () => {
    assert.equal((await request(app).get('/api/estoque/operacoes')).status, 401);
    const r = await operacoes('usuarioA');
    assert.equal(r.status, 403);
    assert.equal('operacoes' in r.body, false);
  });
});
