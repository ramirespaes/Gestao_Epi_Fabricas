'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { abrirSchemaTemporario, migrationExiste } = require('./helpers/schema-temporario');
const { todasAsMigrations, erroDe } = require('./helpers/entrega-epi');

/**
 * Migration 072 (Configurações) — telefone, tema e modo visual na identidade,
 * em PostgreSQL real e schema temporário. Identidades criadas ANTES da 072
 * recebem os padrões ("sistema" e "padrao", telefone nulo) sem conversão.
 */

const DIRETORIO = path.join(__dirname, '..', '..', 'migrations');
const ARQUIVO_072 = '072_alter_identidades_add_telefone_tema_modo_visual.sql';
const VIOLACAO_CHECK = '23514';
const TEMAS = ['sistema', 'claro', 'escuro'];
const MODOS = ['padrao', 'alto_contraste', 'deuteranopia', 'protanopia', 'tritanopia', 'baixa_visao', 'monocromatico'];

describe('migration 072 — telefone, tema e modo visual da identidade', () => {
  let ctx;
  let antiga;
  let erroAoAplicar = null;
  const q = (sql, params) => ctx.cliente.query(sql, params);
  const codigo = async (promessa) => (await erroDe(promessa))?.code;
  const nova = async (sufixo, campos = {}) => {
    const v = { email: `pessoa-${sufixo}@example.invalid`, senha_hash: '$argon2id$v=19$m=65536,t=3,p=4$abc$def', ...campos };
    const colunas = Object.keys(v);
    return (await q(`INSERT INTO identidades (${colunas.join(', ')}) VALUES (${colunas.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id, telefone, tema, modo_visual`, Object.values(v))).rows[0];
  };

  before(async () => {
    assert.equal(migrationExiste('072'), true, 'migration 072 ainda não implementada');
    ctx = await abrirSchemaTemporario(todasAsMigrations().filter((p) => p !== '072'));
    antiga = (await q("INSERT INTO identidades (email, senha_hash) VALUES ('antiga@example.invalid', 'h') RETURNING id")).rows[0].id;
    erroAoAplicar = await erroDe(q(fs.readFileSync(path.join(DIRETORIO, ARQUIVO_072), 'utf8')));
  });
  after(async () => { if (ctx) await ctx.encerrar(); });

  test('aplica sobre identidades já existentes sem converter nada: telefone nulo, tema "sistema" e modo "padrao" por padrão', async () => {
    assert.equal(erroAoAplicar, null, erroAoAplicar && erroAoAplicar.message);
    const linha = (await q('SELECT telefone, tema, modo_visual FROM identidades WHERE id = $1', [antiga])).rows[0];
    assert.deepEqual(linha, { telefone: null, tema: 'sistema', modo_visual: 'padrao' });
    const criada = await nova('nova');
    assert.deepEqual([criada.telefone, criada.tema, criada.modo_visual], [null, 'sistema', 'padrao']);
  });

  test('tema e modo visual aceitam só o domínio aprovado; o telefone pode ser nulo, não pode ser vazio, só espaços nem ter caractere de controle', async () => {
    for (const tema of TEMAS) assert.equal((await q('UPDATE identidades SET tema = $2 WHERE id = $1 RETURNING tema', [antiga, tema])).rows[0].tema, tema);
    for (const modo of MODOS) assert.equal((await q('UPDATE identidades SET modo_visual = $2 WHERE id = $1 RETURNING modo_visual', [antiga, modo])).rows[0].modo_visual, modo);
    for (const invalido of ['dark', 'Claro', 'system', '']) assert.equal(await codigo(q('UPDATE identidades SET tema = $2 WHERE id = $1', [antiga, invalido])), VIOLACAO_CHECK, `tema ${invalido}`);
    for (const invalido of ['contrast', 'Padrao', 'lowvision', '']) assert.equal(await codigo(q('UPDATE identidades SET modo_visual = $2 WHERE id = $1', [antiga, invalido])), VIOLACAO_CHECK, `modo ${invalido}`);
    assert.equal((await q('UPDATE identidades SET telefone = $2 WHERE id = $1 RETURNING telefone', [antiga, '(47) 99999-0001'])).rows[0].telefone, '(47) 99999-0001');
    assert.equal((await q('UPDATE identidades SET telefone = NULL WHERE id = $1 RETURNING telefone', [antiga])).rows[0].telefone, null);
    for (const invalido of ['', '   ', 'abc\u0007']) assert.equal(await codigo(q('UPDATE identidades SET telefone = $2 WHERE id = $1', [antiga, invalido])), VIOLACAO_CHECK, `telefone ${JSON.stringify(invalido)}`);
    assert.equal(await codigo(q('UPDATE identidades SET telefone = $2 WHERE id = $1', [antiga, '1'.repeat(21)])), '22001', 'VARCHAR(20)');
    for (const nulo of ['tema', 'modo_visual']) assert.equal(await codigo(q(`UPDATE identidades SET ${nulo} = NULL WHERE id = $1`, [antiga])), '23502', `${nulo} NOT NULL`);
  });

  test('a 072 não toca unicidade, senha nem o gatilho de atualizado_em da identidade', async () => {
    assert.equal(await codigo(q("INSERT INTO identidades (email, senha_hash) VALUES ('ANTIGA@example.invalid', 'h')")), '23505', 'uq_identidades_email_lower continua');
    const antes = (await q('SELECT atualizado_em FROM identidades WHERE id = $1', [antiga])).rows[0].atualizado_em;
    await q("UPDATE identidades SET tema = 'escuro' WHERE id = $1", [antiga]);
    const depois = (await q('SELECT atualizado_em FROM identidades WHERE id = $1', [antiga])).rows[0].atualizado_em;
    assert.ok(depois >= antes, 'gatilho set_atualizado_em continua ativo');
  });

  test('manifesto: 85 migrations, 000 a 084; a 025 continua idêntica ao manifesto', () => {
    const manifesto = JSON.parse(fs.readFileSync(path.join(DIRETORIO, 'checksums.json'), 'utf8'));
    const arquivos = fs.readdirSync(DIRETORIO).filter((f) => f.endsWith('.sql')).sort();
    assert.equal(arquivos.length, 85);
    assert.equal(arquivos[72], ARQUIVO_072);
    assert.deepEqual(Object.keys(manifesto.migrations).sort(), arquivos);
    const sha = (f) => require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(DIRETORIO, f))).digest('hex');
    for (const f of [ARQUIVO_072, '025_create_identidades.sql']) assert.equal(manifesto.migrations[f], sha(f), f);
  });
});
