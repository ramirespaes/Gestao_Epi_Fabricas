'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { abrirSchemaTemporario, migrationExiste } = require('./helpers/schema-temporario');
const { todasAsMigrations, erroDe } = require('./helpers/entrega-epi');

/**
 * Migration 074 (Gestão de Usuários) — estado da senha PROVISÓRIA na
 * identidade global, em PostgreSQL real e schema temporário. Identidades
 * criadas ANTES da 074 (o MASTER do Painel Privado inclusive) ficam com
 * senha_provisoria = false e datas nulas, sem mudança de comportamento. A
 * integridade é declarativa: provisória exige as duas datas, e a ausência
 * dela exige as duas nulas.
 */

const DIRETORIO = path.join(__dirname, '..', '..', 'migrations');
const ARQUIVO_074 = '074_alter_identidades_add_senha_provisoria.sql';
const VIOLACAO_CHECK = '23514';
const NAO_NULO = '23502';

describe('migration 074 — senha provisória da identidade (troca obrigatória no primeiro acesso)', () => {
  let ctx;
  let antiga;
  let erroAoAplicar = null;
  const q = (sql, params) => ctx.cliente.query(sql, params);
  const codigo = async (promessa) => (await erroDe(promessa))?.code;
  const nova = async (sufixo) => (await q(
    "INSERT INTO identidades (email, senha_hash) VALUES ($1, 'h') RETURNING id, senha_provisoria, senha_provisoria_definida_em, senha_provisoria_expira_em",
    [`pessoa-${sufixo}@example.invalid`],
  )).rows[0];
  const estado = async (id) => (await q('SELECT senha_provisoria, senha_provisoria_definida_em, senha_provisoria_expira_em FROM identidades WHERE id = $1', [id])).rows[0];

  before(async () => {
    assert.equal(migrationExiste('074'), true, 'migration 074 ainda não implementada');
    ctx = await abrirSchemaTemporario(todasAsMigrations().filter((p) => p !== '074'));
    antiga = (await q("INSERT INTO identidades (email, senha_hash) VALUES ('antiga@example.invalid', 'h') RETURNING id")).rows[0].id;
    erroAoAplicar = await erroDe(q(fs.readFileSync(path.join(DIRETORIO, ARQUIVO_074), 'utf8')));
  });
  after(async () => { if (ctx) await ctx.encerrar(); });

  test('aplica sobre identidades existentes sem mudar nada: senha_provisoria false e datas nulas, para antigas e novas', async () => {
    assert.equal(erroAoAplicar, null, erroAoAplicar && erroAoAplicar.message);
    assert.deepEqual(await estado(antiga), { senha_provisoria: false, senha_provisoria_definida_em: null, senha_provisoria_expira_em: null });
    const criada = await nova('nova');
    assert.deepEqual([criada.senha_provisoria, criada.senha_provisoria_definida_em, criada.senha_provisoria_expira_em], [false, null, null]);
    const colunas = (await q("SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = 'identidades' AND column_name LIKE 'senha_provisoria%' ORDER BY ordinal_position")).rows;
    assert.deepEqual(colunas, [
      { column_name: 'senha_provisoria', data_type: 'boolean', is_nullable: 'NO', column_default: 'false' },
      { column_name: 'senha_provisoria_definida_em', data_type: 'timestamp with time zone', is_nullable: 'YES', column_default: null },
      { column_name: 'senha_provisoria_expira_em', data_type: 'timestamp with time zone', is_nullable: 'YES', column_default: null },
    ]);
  });

  test('integridade declarativa: provisória exige as duas datas, com expiração depois da definição; sem provisória as duas datas são nulas', async () => {
    const { id } = await nova('check');
    const definir = (sql, params = []) => q(`UPDATE identidades SET ${sql} WHERE id = $1`, [id, ...params]);
    assert.equal(await codigo(definir('senha_provisoria = true')), VIOLACAO_CHECK, 'provisória sem datas');
    assert.equal(await codigo(definir("senha_provisoria = true, senha_provisoria_definida_em = now()")), VIOLACAO_CHECK, 'provisória sem expiração');
    assert.equal(await codigo(definir("senha_provisoria = true, senha_provisoria_expira_em = now() + interval '48 hours'")), VIOLACAO_CHECK, 'provisória sem definição');
    assert.equal(await codigo(definir("senha_provisoria = true, senha_provisoria_definida_em = now(), senha_provisoria_expira_em = now()")), VIOLACAO_CHECK, 'expiração igual à definição');
    assert.equal(await codigo(definir("senha_provisoria = true, senha_provisoria_definida_em = now(), senha_provisoria_expira_em = now() - interval '1 hour'")), VIOLACAO_CHECK, 'expiração antes da definição');
    await definir("senha_provisoria = true, senha_provisoria_definida_em = now(), senha_provisoria_expira_em = now() + interval '48 hours'");
    const provisoria = await estado(id);
    assert.equal(provisoria.senha_provisoria, true);
    assert.ok(provisoria.senha_provisoria_expira_em > provisoria.senha_provisoria_definida_em);
    assert.equal(await codigo(definir('senha_provisoria = false')), VIOLACAO_CHECK, 'sem provisória as datas precisam ser nulas');
    assert.equal(await codigo(definir('senha_provisoria = false, senha_provisoria_definida_em = NULL')), VIOLACAO_CHECK, 'expiração sobrando');
    assert.equal(await codigo(definir('senha_provisoria = NULL')), NAO_NULO);
    await definir('senha_provisoria = false, senha_provisoria_definida_em = NULL, senha_provisoria_expira_em = NULL');
    assert.deepEqual(await estado(id), { senha_provisoria: false, senha_provisoria_definida_em: null, senha_provisoria_expira_em: null });
    const nomeDoCheck = (await q("SELECT conname FROM pg_constraint WHERE conrelid = 'identidades'::regclass AND conname = 'chk_identidades_senha_provisoria'")).rows;
    assert.equal(nomeDoCheck.length, 1);
    const gatilhos = (await q("SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid = 'identidades'::regclass AND NOT tgisinternal AND tgname ILIKE '%provis%'")).rows[0].n;
    assert.equal(gatilhos, 0, 'sem gatilho: integridade só por CHECK');
  });

  test('a 074 não toca unicidade do e-mail, senha, aparência nem o gatilho de atualizado_em', async () => {
    assert.equal(await codigo(q("INSERT INTO identidades (email, senha_hash) VALUES ('ANTIGA@example.invalid', 'h')")), '23505', 'uq_identidades_email_lower continua');
    const antes = (await q('SELECT senha_hash, tema, modo_visual, telefone, atualizado_em FROM identidades WHERE id = $1', [antiga])).rows[0];
    assert.deepEqual([antes.senha_hash, antes.tema, antes.modo_visual, antes.telefone], ['h', 'sistema', 'padrao', null]);
    await q("UPDATE identidades SET senha_provisoria = true, senha_provisoria_definida_em = now(), senha_provisoria_expira_em = now() + interval '48 hours' WHERE id = $1", [antiga]);
    const depois = (await q('SELECT atualizado_em FROM identidades WHERE id = $1', [antiga])).rows[0].atualizado_em;
    assert.ok(depois >= antes.atualizado_em, 'gatilho set_atualizado_em continua ativo');
  });

  test('manifesto: 78 migrations, 000 a 077; a 025 e a 072 continuam idênticas ao manifesto', () => {
    const manifesto = JSON.parse(fs.readFileSync(path.join(DIRETORIO, 'checksums.json'), 'utf8'));
    const arquivos = fs.readdirSync(DIRETORIO).filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort();
    assert.equal(arquivos.length, 79);
    assert.equal(arquivos[74], ARQUIVO_074);
    assert.deepEqual(Object.keys(manifesto.migrations).sort(), arquivos);
    const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(DIRETORIO, f))).digest('hex');
    for (const f of [ARQUIVO_074, '025_create_identidades.sql', '072_alter_identidades_add_telefone_tema_modo_visual.sql']) assert.equal(manifesto.migrations[f], sha(f), f);
  });
});
