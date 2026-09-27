'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { abrirSchemaTemporario, inserirEmpresa, conteudoDaMigration } = require('./helpers/schema-temporario');

/**
 * Migration 047 — GERENCIAR_USUARIOS passa a exigir autorização individual
 * (OBRIGATORIA), como as três ações administrativas da 024. PostgreSQL
 * real, schema temporário com a cadeia real 000 a 046, o banco como está
 * logo antes da 047.
 */

const ANTERIORES = Array.from({ length: 47 }, (_, i) => String(i).padStart(3, '0'));
const DIRETORIO = path.join(__dirname, '..', '..', 'migrations');
const ACAO = 'GERENCIAR_USUARIOS';

describe('migration 047 — GERENCIAR_USUARIOS em modo OBRIGATORIA', () => {
  let contexto;
  let fotoAcoes;
  let empresa;
  let master;
  let administrador;

  const q = (sql, params) => contexto.cliente.query(sql, params);
  const fotografarAcoes = async () => (await q(
    'SELECT codigo, nome, descricao, ativo, exige_sst, modo_autorizacao_individual FROM acoes ORDER BY codigo',
  )).rows;

  before(async () => {
    contexto = await abrirSchemaTemporario(ANTERIORES);
    assert.equal(await inserirEmpresa(contexto.cliente, '11222333000181', 'Empresa'), 'ok');
    empresa = (await q('SELECT id FROM empresas')).rows[0].id;
    const identidade = async (email) => (await q('INSERT INTO identidades (email, senha_hash) VALUES ($1, $2) RETURNING id', [email, 'h'])).rows[0].id;
    master = (await q("INSERT INTO usuarios (empresa_id, nome, perfil, identidade_id) VALUES ($1, 'Master', 'MASTER', $2) RETURNING id", [empresa, await identidade('m@x.com')])).rows[0].id;
    administrador = (await q("INSERT INTO usuarios (empresa_id, nome, perfil, identidade_id) VALUES ($1, 'Adm', 'ADMINISTRADOR', $2) RETURNING id", [empresa, await identidade('a@x.com')])).rows[0].id;
    fotoAcoes = await fotografarAcoes();
    assert.equal(fotoAcoes.find((a) => a.codigo === ACAO).modo_autorizacao_individual, 'NENHUMA', 'ponto de partida');
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  test('com autorização individual já gravada para a ação, a 047 recusa e nada muda', async () => {
    await q('BEGIN');
    try {
      await q(
        'INSERT INTO usuario_autorizacoes (empresa_id, usuario_id, acao_codigo, autorizado_por) VALUES ($1, $2, $3, $4)',
        [empresa, administrador, ACAO, master],
      );
      const erro = await q(conteudoDaMigration('047')).then(() => null, (e) => e);
      assert.ok(erro, 'a 047 deveria falhar');
      assert.equal(erro.code, 'P0001');
      assert.match(erro.message, /GERENCIAR_USUARIOS/);
    } finally {
      await q('ROLLBACK');
    }
    assert.deepEqual(await fotografarAcoes(), fotoAcoes);
    assert.equal((await q('SELECT count(*)::int AS n FROM usuario_autorizacoes')).rows[0].n, 0);
  });

  test('sem autorização gravada, só GERENCIAR_USUARIOS muda: modo OBRIGATORIA, sem SST, ainda ativa', async () => {
    await q(conteudoDaMigration('047'));
    const depois = await fotografarAcoes();
    const alvo = depois.find((a) => a.codigo === ACAO);
    assert.equal(alvo.modo_autorizacao_individual, 'OBRIGATORIA');
    assert.equal(alvo.exige_sst, false);
    assert.equal(alvo.ativo, true);
    assert.equal(alvo.nome, 'Gerenciar usuários');
    assert.ok(typeof alvo.descricao === 'string' && alvo.descricao.length > 0);
    assert.deepEqual(depois.filter((a) => a.codigo !== ACAO), fotoAcoes.filter((a) => a.codigo !== ACAO));
  });

  test('a 047 não cria nem apaga linha em tabela alguma de concessão', async () => {
    for (const tabela of ['usuario_autorizacoes', 'permissoes_acao', 'grupo_permissoes_acao']) {
      const { rows: [{ n }] } = await q(`SELECT count(*)::int AS n FROM ${tabela} WHERE acao_codigo = $1`, [ACAO]);
      assert.equal(n, 0, tabela);
    }
  });

  test('manifesto: entrada da 047 coerente com o arquivo; algoritmo sha256', () => {
    const manifesto = JSON.parse(fs.readFileSync(path.join(DIRETORIO, 'checksums.json'), 'utf8'));
    const arquivo = fs.readdirSync(DIRETORIO).find((nome) => nome.startsWith('047_') && nome.endsWith('.sql'));
    const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(DIRETORIO, arquivo))).digest('hex');
    assert.equal(manifesto.algoritmo, 'sha256');
    assert.equal(manifesto.migrations[arquivo], sha);
  });
});
