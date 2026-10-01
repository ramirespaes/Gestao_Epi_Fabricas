'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { abrirPoolTemporario } = require('./helpers/schema-temporario');
const { todasAsMigrations, erroDe, criarIdentidade, colunasDe, RECUSA_DO_TRIGGER } = require('./helpers/recuperacao-senha');
const cooldown = require('../../src/security/cooldown');

/**
 * Repositórios de apoio do ciclo de senha contra PostgreSQL real:
 * solicitações de recuperação (063, primitivas do limite por e-mail) e trilha
 * de auditoria da identidade (064). Schema temporário com todas as
 * migrations.
 */

const solicitacaoRepo = () => require('../../src/repositories/recuperacao-senha-solicitacao.repository'); // eslint-disable-line global-require
const auditoriaRepo = () => require('../../src/repositories/auditoria-identidade.repository'); // eslint-disable-line global-require
const chaveAleatoria = () => crypto.createHash('sha256').update(crypto.randomBytes(32)).digest('hex');
const EMAIL = 'pessoa@exemplo-cliente.com.br';

describe('recuperacao-senha-solicitacao.repository — PostgreSQL real', () => {
  let contexto;
  let pool;
  const TABELA = 'recuperacao_senha_solicitacoes';

  before(async () => {
    contexto = await abrirPoolTemporario(todasAsMigrations());
    pool = contexto.pool;
  });
  after(async () => { if (contexto) await contexto.encerrar(); });

  test('registrar grava só a chave HMAC, o escopo e a origem; nada do e-mail chega ao banco', async () => {
    const chave = cooldown.gerarChaveRecuperacaoSenha('PORTAL', EMAIL);
    const id = await solicitacaoRepo().registrar(pool, { escopo: 'PORTAL', chave, ip: '203.0.113.7', dispositivo: 'Agente de Teste' });
    assert.match(id, /^[1-9][0-9]*$/);
    const { rows: [linha] } = await pool.query(`SELECT * FROM ${TABELA} WHERE id = $1`, [id]);
    assert.deepEqual([linha.escopo, linha.chave, linha.ip, linha.dispositivo], ['PORTAL', chave, '203.0.113.7', 'Agente de Teste']);
    assert.ok(linha.criado_em instanceof Date);
    assert.deepEqual(await colunasDe(pool, contexto.schema, TABELA), ['id', 'escopo', 'chave', 'criado_em', 'ip', 'dispositivo']);
    const texto = JSON.stringify(linha);
    for (const parte of ['pessoa', 'exemplo-cliente', '@']) assert.equal(texto.includes(parte), false, parte);
  });

  test('a linha é igual exista ou não a conta: não há coluna nem valor que indique existência', async () => {
    await criarIdentidade(pool, 'existe@example.invalid');
    const comConta = cooldown.gerarChaveRecuperacaoSenha('PORTAL', 'existe@example.invalid');
    const semConta = cooldown.gerarChaveRecuperacaoSenha('PORTAL', 'nao-existe@example.invalid');
    const a = await solicitacaoRepo().registrar(pool, { escopo: 'PORTAL', chave: comConta });
    const b = await solicitacaoRepo().registrar(pool, { escopo: 'PORTAL', chave: semConta });
    const { rows } = await pool.query(`SELECT * FROM ${TABELA} WHERE id = ANY($1::bigint[]) ORDER BY id`, [[a, b]]);
    const forma = (l) => Object.fromEntries(Object.entries(l).map(([k, v]) => [k, v === null ? null : typeof v]));
    assert.deepEqual(forma(rows[0]), forma(rows[1]));
    const { rows: fks } = await pool.query("SELECT conname FROM pg_constraint WHERE conrelid = $1::regclass AND contype = 'f'", [TABELA]);
    assert.deepEqual(fks, []);
  });

  test('contarRecentes conta só a chave e o escopo pedidos, dentro da janela pelo relógio do banco', async () => {
    const chave = chaveAleatoria();
    const outra = chaveAleatoria();
    for (let i = 0; i < 3; i += 1) await solicitacaoRepo().registrar(pool, { escopo: 'PORTAL', chave });
    await solicitacaoRepo().registrar(pool, { escopo: 'PLATAFORMA', chave });
    await solicitacaoRepo().registrar(pool, { escopo: 'PORTAL', chave: outra });
    await pool.query(`INSERT INTO ${TABELA} (escopo, chave, criado_em) VALUES ('PORTAL', $1, now() - interval '61 minutes')`, [chave]);

    assert.equal(await solicitacaoRepo().contarRecentes(pool, { escopo: 'PORTAL', chave, janelaMinutos: 60 }), 3);
    assert.equal(await solicitacaoRepo().contarRecentes(pool, { escopo: 'PLATAFORMA', chave, janelaMinutos: 60 }), 1);
    assert.equal(await solicitacaoRepo().contarRecentes(pool, { escopo: 'PORTAL', chave: outra, janelaMinutos: 60 }), 1);
    assert.equal(await solicitacaoRepo().contarRecentes(pool, { escopo: 'PORTAL', chave, janelaMinutos: 120 }), 4, 'janela maior alcança a solicitação antiga');
    assert.equal(await solicitacaoRepo().contarRecentes(pool, { escopo: 'PORTAL', chave: chaveAleatoria(), janelaMinutos: 60 }), 0);
  });

  test('o mesmo e-mail nos dois namespaces gera chaves diferentes e contagens separadas', async () => {
    const portal = cooldown.gerarChaveRecuperacaoSenha('PORTAL', 'ambos@example.invalid');
    const plataforma = cooldown.gerarChaveRecuperacaoSenha('PLATAFORMA', 'ambos@example.invalid');
    assert.notEqual(portal, plataforma);
    await solicitacaoRepo().registrar(pool, { escopo: 'PORTAL', chave: portal });
    assert.equal(await solicitacaoRepo().contarRecentes(pool, { escopo: 'PORTAL', chave: portal, janelaMinutos: 60 }), 1);
    assert.equal(await solicitacaoRepo().contarRecentes(pool, { escopo: 'PLATAFORMA', chave: plataforma, janelaMinutos: 60 }), 0);
  });

  test('usa o executor recebido: registro feito numa transação desfeita não é contado', async () => {
    const chave = chaveAleatoria();
    const cliente = await pool.connect();
    try {
      await cliente.query('BEGIN');
      await solicitacaoRepo().registrar(cliente, { escopo: 'PORTAL', chave });
      assert.equal(await solicitacaoRepo().contarRecentes(cliente, { escopo: 'PORTAL', chave, janelaMinutos: 60 }), 1);
      await cliente.query('ROLLBACK');
    } finally {
      cliente.release();
    }
    assert.equal(await solicitacaoRepo().contarRecentes(pool, { escopo: 'PORTAL', chave, janelaMinutos: 60 }), 0);
  });
});

describe('auditoria-identidade.repository — PostgreSQL real', () => {
  let contexto;
  let pool;
  let identidade;
  const TABELA = 'logs_auditoria_identidade';

  before(async () => {
    contexto = await abrirPoolTemporario(todasAsMigrations());
    pool = contexto.pool;
    identidade = await criarIdentidade(pool, 'auditada@example.invalid');
  });
  after(async () => { if (contexto) await contexto.encerrar(); });

  test('fluxo de sistema grava ator SISTEMA e fluxo autenticado grava ator IDENTIDADE; evento da identidade, sem empresa, com contexto JSON', async () => {
    const anonimo = await auditoriaRepo().registrarEventoSistema(pool, {
      identidadeId: identidade, acao: 'SENHA_REDEFINIDA', ip: '203.0.113.7', dispositivo: 'Agente de Teste',
      contexto: { origem: 'link', sessoesRevogadas: 3, pedidosCancelados: 0 },
    });
    assert.match(anonimo.id, /^[1-9][0-9]*$/);
    assert.ok(anonimo.criadoEm instanceof Date);
    const autenticado = await auditoriaRepo().registrarDaIdentidade(pool, { identidadeId: identidade, acao: 'SENHA_ALTERADA', referencia: String(identidade) });

    const { rows } = await pool.query(`SELECT * FROM ${TABELA} WHERE id = ANY($1::bigint[]) ORDER BY id`, [[anonimo.id, autenticado.id]]);
    assert.deepEqual(rows.map((l) => [l.identidade_id, l.ator_tipo, l.acao]), [[identidade, 'SISTEMA', 'SENHA_REDEFINIDA'], [identidade, 'IDENTIDADE', 'SENHA_ALTERADA']]);
    assert.deepEqual([rows[0].ip, rows[0].dispositivo], ['203.0.113.7', 'Agente de Teste']);
    assert.deepEqual(rows[0].contexto, { origem: 'link', sessoesRevogadas: 3, pedidosCancelados: 0 });
    assert.equal((await colunasDe(pool, contexto.schema, TABELA)).includes('empresa_id'), false);
  });

  test('quem chama não consegue escolher nem sobrescrever o ator: a tentativa é recusada e nada é gravado', async () => {
    const antes = (await pool.query(`SELECT count(*)::int AS n FROM ${TABELA}`)).rows[0].n;
    for (const funcao of ['registrarDaIdentidade', 'registrarEventoSistema']) {
      for (const atorTipo of ['IDENTIDADE', 'SISTEMA', 'ADMINISTRADOR', null]) {
        await assert.rejects(() => auditoriaRepo()[funcao](pool, { identidadeId: identidade, acao: 'SENHA_ALTERADA', atorTipo }), TypeError, `${funcao} ${atorTipo}`);
      }
    }
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${TABELA}`)).rows[0].n, antes);

    const daIdentidade = await auditoriaRepo().registrarDaIdentidade(pool, { identidadeId: identidade, acao: 'SENHA_ALTERADA', ator: 'SISTEMA', ator_tipo: 'SISTEMA' });
    const doSistema = await auditoriaRepo().registrarEventoSistema(pool, { identidadeId: identidade, acao: 'SENHA_REDEFINIDA', ator: 'IDENTIDADE', ator_tipo: 'IDENTIDADE' });
    const { rows } = await pool.query(`SELECT ator_tipo FROM ${TABELA} WHERE id = ANY($1::bigint[]) ORDER BY id`, [[daIdentidade.id, doSistema.id]]);
    assert.deepEqual(rows.map((l) => l.ator_tipo), ['IDENTIDADE', 'SISTEMA'], 'o ator gravado é sempre o da função chamada');
    assert.deepEqual(Object.keys(auditoriaRepo()).sort(), ['registrarDaIdentidade', 'registrarEventoSistema'], 'não existe função que aceite o ator de quem chama');
  });

  test('chave JSON sensível é recusada pelo banco e o erro é propagado; nada é gravado', async () => {
    const antes = (await pool.query(`SELECT count(*)::int AS n FROM ${TABELA}`)).rows[0].n;
    for (const funcao of ['registrarDaIdentidade', 'registrarEventoSistema']) {
      for (const contexto of [{ senha: 'x' }, { token: 'x' }, { token_hash: 'x' }, { interno: { senha_hash: 'x' } }]) {
        const erro = await erroDe(auditoriaRepo()[funcao](pool, { identidadeId: identidade, acao: 'SENHA_REDEFINIDA', contexto }));
        assert.equal(erro?.code, RECUSA_DO_TRIGGER, `${funcao} ${JSON.stringify(contexto)}`);
        assert.match(erro.message, /chave sensível/);
      }
    }
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${TABELA}`)).rows[0].n, antes);
  });

  test('a trilha é append-only: o que o repositório gravou não pode ser atualizado nem apagado', async () => {
    const { id } = await auditoriaRepo().registrarEventoSistema(pool, { identidadeId: identidade, acao: 'REDEFINICAO_SOLICITADA' });
    const atualizar = await erroDe(pool.query(`UPDATE ${TABELA} SET acao = 'OUTRA' WHERE id = $1`, [id]));
    const reclassificar = await erroDe(pool.query(`UPDATE ${TABELA} SET ator_tipo = 'IDENTIDADE' WHERE id = $1`, [id]));
    const apagar = await erroDe(pool.query(`DELETE FROM ${TABELA} WHERE id = $1`, [id]));
    assert.deepEqual([atualizar?.code, reclassificar?.code, apagar?.code], [RECUSA_DO_TRIGGER, RECUSA_DO_TRIGGER, RECUSA_DO_TRIGGER]);
    const { rows: [linha] } = await pool.query(`SELECT acao, ator_tipo FROM ${TABELA} WHERE id = $1`, [id]);
    assert.deepEqual([linha.acao, linha.ator_tipo], ['REDEFINICAO_SOLICITADA', 'SISTEMA']);
  });

  test('identidade inexistente é recusada pela FK; o repositório não cria identidade nem tolera evento sem dono', async () => {
    for (const funcao of ['registrarDaIdentidade', 'registrarEventoSistema']) {
      const erro = await erroDe(auditoriaRepo()[funcao](pool, { identidadeId: 999999, acao: 'SENHA_REDEFINIDA' }));
      assert.equal(erro?.code, '23503', funcao);
      await assert.rejects(() => auditoriaRepo()[funcao](pool, { acao: 'SENHA_REDEFINIDA' }), TypeError, funcao);
    }
  });

  test('usa o executor recebido: evento gravado numa transação desfeita não fica na trilha', async () => {
    const cliente = await pool.connect();
    let id;
    try {
      await cliente.query('BEGIN');
      ({ id } = await auditoriaRepo().registrarEventoSistema(cliente, { identidadeId: identidade, acao: 'SENHA_REDEFINIDA' }));
      await cliente.query('ROLLBACK');
    } finally {
      cliente.release();
    }
    const { rows } = await pool.query(`SELECT id FROM ${TABELA} WHERE id = $1`, [id]);
    assert.deepEqual(rows, []);
  });
});
