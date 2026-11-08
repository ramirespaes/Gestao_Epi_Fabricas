'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { abrirSchemaTemporario, inserirEmpresa } = require('./helpers/schema-temporario');
const C = require('../../src/utils/chave-json-sensivel');
const { CAMPOS_DO_CONTEXTO } = require('../../src/services/backup-executor-auditoria.service');

/**
 * Migration 097 — PENDENCIA-SEG-TRG04 (Rodada A, R2). PostgreSQL real, schema temporário exclusivo (CI e banco de teste local), nunca o `public`.
 * RED→GREEN: com a 014 sozinha, PGPASSWORD/DBPASSWORD/ACCESSTOKEN/CLIENTSECRET eram aceitos (confirmado em banco real em 06/11/2026); com a 097 aplicada por cima,
 * a MESMA função (compartilhada pelos gatilhos das três trilhas) os recusa, preserva tudo o que a 014 já recusava e continua aceitando identificadores legítimos.
 * O espelho JS (`src/utils/chave-json-sensivel.js`, primeira barreira) é confrontado com a função do banco chave por chave, inclusive sobre um corpus gerado.
 * Prefixos mínimos: 001/002/005 (FKs de 012), 012 e 014 (tabela, funções e gatilho), 027 e 029 (plataforma), 097.
 */

const MIGRATIONS_NECESSARIAS = ['000', '001', '002', '005', '012', '014', '027', '029', '097'];
const RECUSADAS_PELA_014 = ['senha', 'senhaHash', 'refresh_token', 'api-key', 'chave_privada', 'password', 'PG_PASSWORD', 'sessionToken', 'secretAccessKey', 'accessKey', 'credential', 'authorization', 'cookie', 'otp', 'totp', 'senha_alterada_em'];
const RECUSADAS_PELA_097 = ['PGPASSWORD', 'DBPASSWORD', 'ACCESSTOKEN', 'CLIENTSECRET', 'secretkey', 'accesskey', 'privatekey', 'senhahash', 'passwordhash', 'dbsenha', 'appsegredo', 'usercredential', 'sessioncookie', 'tokenid', 'segredoatual', 'credencialexterna', 'cookiesessao', 'apikeyid', 'chaveprivada', 'chavesecreta', 'chaveapi', 'chaveacesso', 'pgpasswd', 'mypassphrase', 'clientcredentials', 'basicauthorization'];
const LEGITIMAS = ['secretaria_id', 'hashtag', 'hash_arquivo', 'chave_primaria', 'chave', 'key', 'id', 'usuarioId', 'acaoCodigo', 'tipo', 'motivo', 'rota', 'alterada_em', 'secretariado', 'monkey', 'turkey', 'optional', 'cookbook', 'tokyo', 'totem', 'perfil_ator', ...CAMPOS_DO_CONTEXTO];

const tentar = async (p) => { try { await p; return 'ok'; } catch (e) { return `${e.code ?? ''}:${e.message}`; } };

describe('migration 097 — chave JSON sensível sem separador', () => {
  let ctx;
  let administradorId;
  let empresaId;
  const sensivel = async (chave) => (await ctx.cliente.query('SELECT logs_auditoria_chave_json_e_sensivel($1) AS s', [chave])).rows[0].s;

  before(async () => {
    ctx = await abrirSchemaTemporario(MIGRATIONS_NECESSARIAS);
    administradorId = (await ctx.cliente.query("INSERT INTO administradores_plataforma (email, senha_hash) VALUES ('m97@safework.com.br', 'hash-ficticio') RETURNING id")).rows[0].id;
    assert.equal(await inserirEmpresa(ctx.cliente, '11222333000181', 'Empresa 097'), 'ok');
    empresaId = (await ctx.cliente.query('SELECT id FROM empresas LIMIT 1')).rows[0].id;
  });
  after(async () => { if (ctx) await ctx.encerrar(); });

  test('MIG97-01 — a função existe uma única vez no schema, continua IMMUTABLE e passou a ter as listas novas; as demais funções e os gatilhos da 014/029 permanecem', async () => {
    const { rows } = await ctx.cliente.query("SELECT proname, provolatile, prosrc FROM pg_proc WHERE pronamespace = current_schema()::regnamespace AND proname LIKE 'logs_auditoria%' ORDER BY proname");
    assert.deepEqual(rows.map((r) => r.proname), ['logs_auditoria_bloquear_dado_sensivel', 'logs_auditoria_chave_json_e_sensivel', 'logs_auditoria_jsonb_possui_chave_sensivel']);
    const f = rows.find((r) => r.proname === 'logs_auditoria_chave_json_e_sensivel');
    assert.equal(f.provolatile, 'i');
    for (const lista of ['palavras_inteiras', 'compostos', 'sufixos', 'prefixos']) assert.ok(f.prosrc.includes(`${lista} CONSTANT TEXT[]`), lista);
    const gatilhos = (await ctx.cliente.query("SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE '%bloquear_dado_sensivel' ORDER BY tgname")).rows.map((r) => r.tgname);
    assert.deepEqual(gatilhos, ['trg_logs_auditoria_bloquear_dado_sensivel', 'trg_logs_auditoria_plataforma_bloquear_dado_sensivel']);
  });

  test('MIG97-02 — o que a 014 recusava continua recusado', async () => {
    for (const k of RECUSADAS_PELA_014) assert.equal(await sensivel(k), true, k);
  });

  test('MIG97-03 — RED→GREEN: os quatro nomes confirmados aceitos com a 014 e os demais compostos/sufixos/prefixos são recusados pela função', async () => {
    for (const k of RECUSADAS_PELA_097) assert.equal(await sensivel(k), true, k);
  });

  test('MIG97-04 — identificadores legítimos continuam aceitos (secretaria_id, hashtag, hash_arquivo, chave_primaria, as 15 chaves do executor); NULL e vazio são falsos', async () => {
    for (const k of LEGITIMAS) assert.equal(await sensivel(k), false, k);
    assert.equal((await ctx.cliente.query('SELECT logs_auditoria_chave_json_e_sensivel(NULL) AS s')).rows[0].s, false);
    for (const k of ['', '___', '--']) assert.equal(await sensivel(k), false, JSON.stringify(k));
  });

  test('MIG97-05 — o espelho JS (primeira barreira) e a função do banco concordam chave por chave, inclusive num corpus gerado (prefixos, sufixos, camelCase e separadores)', async () => {
    const bases = ['pg', 'db', 'app', 'user', 'client', 'session', 'x', 'minha', 'hash', 'id', 'v2'];
    const nucleos = [...C.PALAVRAS_INTEIRAS, ...C.COMPOSTOS, ...C.SUFIXOS, ...C.PREFIXOS, 'secretaria', 'hashtag', 'chave', 'key', 'tok', 'cook', 'otpauth'];
    const corpus = new Set([...RECUSADAS_PELA_014, ...RECUSADAS_PELA_097, ...LEGITIMAS]);
    for (const n of nucleos) {
      for (const b of bases) { corpus.add(`${b}${n}`); corpus.add(`${n}${b}`); corpus.add(`${b}_${n}`); corpus.add(`${b}${n[0].toUpperCase()}${n.slice(1)}`); corpus.add(`${n.toUpperCase()}${b.toUpperCase()}`); }
    }
    const divergentes = [];
    for (const k of corpus) if ((await sensivel(k)) !== C.chaveJsonSensivel(k)) divergentes.push(k);
    assert.deepEqual(divergentes, [], `banco × JS divergem em ${divergentes.length} de ${corpus.size}`);
    assert.ok(corpus.size > 500);
  });

  test('MIG97-06 — o gatilho recusa o INSERT nas duas trilhas presentes (logs_auditoria e logs_auditoria_plataforma) com nome composto sem separador em qualquer profundidade e aceita contexto legítimo', async () => {
    const plataforma = (contexto) => tentar(ctx.cliente.query("INSERT INTO logs_auditoria_plataforma (administrador_id, acao, contexto) VALUES ($1, 'M97', $2::jsonb)", [administradorId, JSON.stringify(contexto)]));
    const empresa = (contexto) => tentar(ctx.cliente.query("INSERT INTO logs_auditoria (empresa_id, acao, dados_novos) VALUES ($1, 'M97', $2::jsonb)", [empresaId, JSON.stringify(contexto)]));
    for (const ruim of [{ PGPASSWORD: 'x' }, { aws: { ACCESSTOKEN: 'x' } }, { itens: [{ CLIENTSECRET: 'x' }] }, { DBPASSWORD: null }]) {
      assert.match(await plataforma(ruim), /chave sens/i, `plataforma ${JSON.stringify(ruim)}`);
      assert.match(await empresa(ruim), /chave sens/i, `empresa ${JSON.stringify(ruim)}`);
    }
    assert.equal(await plataforma({ secretaria_id: 1, operacaoId: 'a'.repeat(32) }), 'ok');
    assert.equal(await empresa({ hashtag: 'x', alterada_em: '2026-11-07T00:00:00Z' }), 'ok');
    const { rows } = await ctx.cliente.query("SELECT (SELECT count(*)::int FROM logs_auditoria_plataforma WHERE acao = 'M97') AS p, (SELECT count(*)::int FROM logs_auditoria WHERE acao = 'M97') AS e");
    assert.deepEqual(rows[0], { p: 1, e: 1 }, 'só as linhas legítimas foram gravadas');
  });
});
