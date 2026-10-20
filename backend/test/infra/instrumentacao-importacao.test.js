'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { criarRaizTemporaria, removerTemporarioSeguro } = require('../storage/helpers/tmp-seguro');
const { criarArmazenamentoImagens } = require('../../src/storage/armazenamento-imagens');
const {
  espiarObjeto, espiarPool, falharNoPool, armazenamentoQueFalha, poolProibido, armazenamentoProibido, instantaneoDoArmazenamento, ESCRITA_SQL,
} = require('../helpers/instrumentacao-importacao');

/**
 * CONTROLES da instrumentação da importação (Unidade 5A-2, RED). Passam hoje: provam que os instantâneos e os espiões ENXERGAM o que os
 * contratos de idempotência vão exigir que não aconteça (reescrita com bytes idênticos, troca de inode, SQL de escrita), sem falso alarme
 * numa simples leitura. O controle do instantâneo do banco, que precisa de PostgreSQL, está em imagens-importar-padrao.integration.js.
 */

const raizes = [];
const novaRaiz = () => { const raiz = criarRaizTemporaria(); raizes.push(raiz); return raiz; };
after(() => { for (const raiz of raizes) removerTemporarioSeguro(raiz); });

const doArquivo = (instantaneo, final) => instantaneo.find((i) => i.caminho.endsWith(final));

describe('[CTRL-INS] instrumentação', () => {
  test('CTRL-INS-01 — o instantâneo do disco enxerga reescrita com bytes idênticos, troca de inode, conteúdo novo, pasta nova e remoção, e NÃO acusa leitura', () => {
    const raiz = novaRaiz();
    fs.mkdirSync(path.join(raiz, 'padrao', 'aa'), { recursive: true });
    const arquivo = path.join(raiz, 'padrao', 'aa', 'mestre.png');
    fs.writeFileSync(arquivo, 'conteudo');
    fs.utimesSync(arquivo, 1_000_000, 1_000_000);
    const base = instantaneoDoArmazenamento(raiz);

    fs.readFileSync(arquivo);
    fs.statSync(arquivo);
    fs.readdirSync(path.dirname(arquivo));
    assert.deepEqual(instantaneoDoArmazenamento(raiz), base, 'leitura não muda o instantâneo');

    fs.writeFileSync(arquivo, 'conteudo');
    const reescrito = instantaneoDoArmazenamento(raiz);
    assert.notDeepEqual(reescrito, base, 'reescrita no mesmo lugar, com os mesmos bytes, é vista');
    assert.equal(doArquivo(reescrito, 'mestre.png').sha256, doArquivo(base, 'mestre.png').sha256, 'os bytes continuam iguais: só o tempo denuncia');

    const antesDaTroca = instantaneoDoArmazenamento(raiz);
    fs.writeFileSync(`${arquivo}.novo`, 'conteudo');
    fs.renameSync(`${arquivo}.novo`, arquivo);
    const trocado = instantaneoDoArmazenamento(raiz);
    assert.notEqual(doArquivo(trocado, 'mestre.png').ino, doArquivo(antesDaTroca, 'mestre.png').ino, 'arquivo recriado por rename tem outro inode');
    assert.equal(doArquivo(trocado, 'mestre.png').sha256, doArquivo(antesDaTroca, 'mestre.png').sha256);

    const antesDoConteudo = instantaneoDoArmazenamento(raiz);
    fs.writeFileSync(arquivo, 'outro conteudo');
    assert.notEqual(doArquivo(instantaneoDoArmazenamento(raiz), 'mestre.png').sha256, doArquivo(antesDoConteudo, 'mestre.png').sha256);

    const antesDaPasta = instantaneoDoArmazenamento(raiz);
    fs.mkdirSync(path.join(raiz, 'padrao', 'bb'));
    assert.equal(instantaneoDoArmazenamento(raiz).length, antesDaPasta.length + 1, 'pasta nova aparece');
    fs.rmSync(path.join(raiz, 'padrao', 'bb'), { recursive: true });
    fs.rmSync(arquivo);
    assert.equal(doArquivo(instantaneoDoArmazenamento(raiz), 'mestre.png'), undefined, 'remoção aparece');
  });

  test('CTRL-INS-02 — o espião de objeto funciona em objeto congelado (como o armazenamento), registra nome e argumentos e devolve o resultado real', async () => {
    const alvo = Object.freeze({ soma: (a, b) => a + b, constante: 7 });
    const { espiao, registros } = espiarObjeto(alvo);
    assert.equal(espiao.soma(2, 3), 5);
    assert.equal(espiao.constante, 7);
    assert.deepEqual(registros, [{ metodo: 'soma', args: [2, 3] }]);

    const real = criarArmazenamentoImagens({ diretorio: novaRaiz() });
    const espiadoReal = espiarObjeto(real);
    const chave = `padrao/${'a'.repeat(64)}/mestre.png`;
    assert.equal(await espiadoReal.espiao.existe(chave), false);
    assert.deepEqual(espiadoReal.registros, [{ metodo: 'existe', args: [chave] }]);
  });

  test('CTRL-INS-03 — o espião de pool registra todo SQL (do pool e dos clientes) e a conexão, e separa as escritas das leituras', async () => {
    const cliente = { query: async () => ({ rows: [] }), release() {} };
    const poolFalso = { query: async () => ({ rows: [] }), connect: async () => cliente };
    const { espiao, registros, escritas } = espiarPool(poolFalso);
    await espiao.query('SELECT 1');
    const c = await espiao.connect();
    await c.query('BEGIN');
    await c.query('INSERT INTO t VALUES (1)');
    await c.query({ text: 'UPDATE t SET a = 1' });
    await c.query('COMMIT');
    c.release();
    assert.deepEqual(registros.map((r) => r.sql), ['SELECT 1', 'CONNECT', 'BEGIN', 'INSERT INTO t VALUES (1)', 'UPDATE t SET a = 1', 'COMMIT']);
    assert.deepEqual(escritas().map((r) => r.sql), ['INSERT INTO t VALUES (1)', 'UPDATE t SET a = 1']);
  });

  test('CTRL-INS-04 — pool e armazenamento "proibidos" registram a tentativa e falham', () => {
    const { pool, registros } = poolProibido();
    assert.throws(() => pool.query('SELECT 1'), /não deveria/);
    assert.throws(() => pool.connect(), /não deveria/);
    assert.deepEqual(registros.map((r) => r.metodo), ['query', 'connect']);

    const proibido = armazenamentoProibido();
    for (const metodo of ['gravar', 'abrir', 'existe', 'remover', 'removerVariantes', 'listar']) assert.throws(() => proibido.armazenamento[metodo]('x'), /não deveria/, metodo);
    assert.equal(proibido.registros.length, 6);
  });

  test('CTRL-INS-05 — a classificação de SQL de escrita pega INSERT, UPDATE, DELETE, TRUNCATE, MERGE, COPY e DDL (com espaço, quebra de linha e minúsculas) e deixa passar leitura e controle de transação', () => {
    const escritas = ['INSERT INTO t VALUES (1)', '  update t set a = 1', '\n\tDELETE FROM t', 'TRUNCATE t', 'MERGE INTO t USING s ON true WHEN MATCHED THEN DO NOTHING', 'COPY t FROM STDIN', 'CREATE TABLE x (a int)', 'ALTER TABLE t ADD b int', 'DROP TABLE t'];
    const leituras = ['SELECT * FROM t', 'select 1', 'SELECT id FROM t FOR UPDATE', 'SELECT pg_advisory_xact_lock(1)', 'BEGIN', 'COMMIT', 'ROLLBACK', 'SET LOCAL lock_timeout = 1000', 'WITH x AS (SELECT 1) SELECT * FROM x'];
    for (const sql of escritas) assert.equal(ESCRITA_SQL.test(sql), true, sql);
    for (const sql of leituras) assert.equal(ESCRITA_SQL.test(sql), false, sql);
    const escritasOcultas = [
      'WITH nova AS (INSERT INTO t VALUES (1) RETURNING id) SELECT id FROM nova', 'WITH x AS (UPDATE t SET a = 1 RETURNING a) SELECT * FROM x',
      'WITH x AS (DELETE FROM t RETURNING a) SELECT * FROM x', "SELECT nextval('seq')", "select setval('seq', 5)",
    ];
    for (const sql of escritasOcultas) assert.equal(ESCRITA_SQL.test(sql), true, sql);
    assert.equal(ESCRITA_SQL.test('WITH x AS (SELECT * FROM t FOR UPDATE) SELECT * FROM x'), false);
  });

  test('CTRL-INS-06 — o injetor de falha do pool dispara na N-ésima instrução que casa (no pool e nos clientes), uma só vez, antes de enviá-la, e deixa as demais passarem', async () => {
    const executadas = [];
    const cliente = { query: async (sql) => { executadas.push(typeof sql === 'string' ? sql : sql.text); return { rows: [] }; }, release() {} };
    const poolFalso = { query: async (sql) => { executadas.push(sql); return { rows: [] }; }, connect: async () => cliente };
    const { espiao, disparos, vistos } = falharNoPool(poolFalso, { padrao: /^\s*INSERT INTO a\b/i, numero: 3 });
    const c = await espiao.connect();
    await c.query('BEGIN');
    await c.query('INSERT INTO a VALUES (1)');
    await c.query('INSERT INTO b VALUES (1)');
    await c.query({ text: 'INSERT INTO a VALUES (2)' });
    await assert.rejects(() => c.query('INSERT INTO a VALUES (3)'), (falha) => falha.injetada === true && falha.code === 'XX000');
    await c.query('INSERT INTO a VALUES (4)');
    await espiao.query('INSERT INTO a VALUES (5)');
    c.release();
    assert.deepEqual(disparos, ['INSERT INTO a VALUES (3)']);
    assert.equal(vistos(), 5);
    assert.deepEqual(executadas, ['BEGIN', 'INSERT INTO a VALUES (1)', 'INSERT INTO b VALUES (1)', 'INSERT INTO a VALUES (2)', 'INSERT INTO a VALUES (4)', 'INSERT INTO a VALUES (5)']);
  });

  test('CTRL-INS-07 — o armazenamento que falha na N-ésima gravação grava de verdade as anteriores, falha na escolhida uma só vez com o código do próprio armazenamento e segue normal depois', async () => {
    const real = criarArmazenamentoImagens({ diretorio: novaRaiz() });
    const { armazenamento, disparos, chamadas } = armazenamentoQueFalha(real, { metodo: 'gravar', numero: 2 });
    const [a, b, c] = ['a', 'b', 'c'].map((x) => `padrao/${x.repeat(64)}/mestre.png`);
    const gravar = (chave) => armazenamento.gravar(chave, Buffer.from('conteudo'), { maxBytes: 1024 });
    assert.equal((await gravar(a)).reaproveitado, false);
    await assert.rejects(() => gravar(b), (falha) => falha.injetada === true && falha.codigo === 'ARMAZENAMENTO_FALHOU');
    assert.equal((await gravar(c)).reaproveitado, false);
    assert.deepEqual([await real.existe(a), await real.existe(b), await real.existe(c)], [true, false, true]);
    assert.equal(chamadas(), 3);
    assert.equal(disparos.length, 1);
  });
});
