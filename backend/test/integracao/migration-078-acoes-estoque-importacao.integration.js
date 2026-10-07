'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { abrirSchemaTemporario } = require('./helpers/schema-temporario');
const { todasAsMigrations, erroDe } = require('./helpers/entrega-epi');

/**
 * Migration 078, em PostgreSQL real e schema temporário, sobre dados anteriores a ela:
 * separa MOVIMENTAR_ESTOQUE em ENTRADA_ESTOQUE e BAIXA_ESTOQUE (preservando perfil, grupo, bloqueio e concessões
 * diretas e delegadas) e passa IMPORTAR_FUNCIONARIOS para ALTERNATIVA.
 */
const ARQUIVO = path.join(__dirname, '..', '..', 'migrations', '078_insert_acoes_estoque_entrada_baixa.sql');
const NOVAS = ['ENTRADA_ESTOQUE', 'BAIXA_ESTOQUE'];

async function semear(q) {
  const empresa = (await q("INSERT INTO empresas (nome, cnpj) VALUES ('Alfa', '11222333000181') RETURNING id")).rows[0].id;
  const outra = (await q("INSERT INTO empresas (nome, cnpj) VALUES ('Beta', '11444777000161') RETURNING id")).rows[0].id;
  let n = 0;
  const usuario = async (empresaId, perfil = 'USUARIO') => {
    n += 1;
    const ident = (await q('INSERT INTO identidades (email, senha_hash) VALUES ($1, $2) RETURNING id', [`p${n}@example.invalid`, 'h'])).rows[0].id;
    return (await q('INSERT INTO usuarios (empresa_id, nome, perfil, identidade_id) VALUES ($1, $2, $3, $4) RETURNING id', [empresaId, `U${n}`, perfil, ident])).rows[0].id;
  };
  const master = await usuario(empresa, 'MASTER');
  const a = await usuario(empresa);
  const b = await usuario(empresa);
  const c = await usuario(empresa);
  const d = await usuario(empresa);
  const deOutra = await usuario(outra, 'MASTER');
  const aut = async (empresaId, usuarioId, autorizadoPor, { podeDelegar = false, origem = null } = {}) => (await q(
    "INSERT INTO usuario_autorizacoes (empresa_id, usuario_id, acao_codigo, autorizado_por, pode_delegar, origem_id, motivo) VALUES ($1, $2, 'MOVIMENTAR_ESTOQUE', $3, $4, $5, $6) RETURNING id",
    [empresaId, usuarioId, autorizadoPor, podeDelegar, origem, origem === null ? 'direta' : 'delegada'],
  )).rows[0].id;
  // master -> a (direta, pode delegar) -> b (delegada, pode delegar) -> c (delegada de 2º nível); d: direta simples; outra empresa: direta.
  const ra = await aut(empresa, a, master, { podeDelegar: true });
  const rb = await aut(empresa, b, a, { podeDelegar: true, origem: ra });
  await aut(empresa, c, b, { origem: rb });
  await aut(empresa, d, master);
  await aut(outra, deOutra, deOutra);
  await q("INSERT INTO permissoes_acao (empresa_id, perfil, acao_codigo, permitido) VALUES ($1, 'MASTER', 'MOVIMENTAR_ESTOQUE', true), ($1, 'SUPERVISOR', 'MOVIMENTAR_ESTOQUE', false)", [empresa]);
  const grupo = (await q("INSERT INTO grupos_acesso (empresa_id, nome, criado_por) VALUES ($1, 'Almox', $2) RETURNING id", [empresa, master])).rows[0].id;
  await q("INSERT INTO grupo_permissoes_acao (empresa_id, grupo_acesso_id, acao_codigo, permitido) VALUES ($1, $2, 'MOVIMENTAR_ESTOQUE', true)", [empresa, grupo]);
  await q("INSERT INTO usuario_bloqueios (usuario_id, acao_codigo, bloqueado_por, motivo) VALUES ($1, 'MOVIMENTAR_ESTOQUE', $2, 'teste')", [d, master]);
  return { empresa, outra, master, a, b, c, d, grupo };
}

describe('migration 078 — ENTRADA_ESTOQUE, BAIXA_ESTOQUE e IMPORTAR_FUNCIONARIOS em modo ALTERNATIVA', () => {
  let ctx;
  let dados;
  let erro;
  const q = (sql, params) => ctx.cliente.query(sql, params);
  before(async () => {
    ctx = await abrirSchemaTemporario(todasAsMigrations().filter((p) => p !== '078'));
    dados = await semear(q);
    assert.equal((await q("SELECT modo_autorizacao_individual m FROM acoes WHERE codigo = 'IMPORTAR_FUNCIONARIOS'")).rows[0].m, 'NENHUMA', 'antes da 078');
    erro = await erroDe(q(fs.readFileSync(ARQUIVO, 'utf8')));
  });
  after(async () => { if (ctx) await ctx.encerrar(); });

  test('aplica sobre dados existentes; cria as duas ações (ALTERNATIVA, sem SST) e MOVIMENTAR_ESTOQUE permanece intacta', async () => {
    assert.equal(erro, null, erro && erro.message);
    const { rows } = await q("SELECT codigo, ativo, exige_sst, modo_autorizacao_individual FROM acoes WHERE codigo = ANY($1) ORDER BY codigo", [[...NOVAS, 'MOVIMENTAR_ESTOQUE']]);
    assert.deepEqual(rows, [
      { codigo: 'BAIXA_ESTOQUE', ativo: true, exige_sst: false, modo_autorizacao_individual: 'ALTERNATIVA' },
      { codigo: 'ENTRADA_ESTOQUE', ativo: true, exige_sst: false, modo_autorizacao_individual: 'ALTERNATIVA' },
      { codigo: 'MOVIMENTAR_ESTOQUE', ativo: true, exige_sst: false, modo_autorizacao_individual: 'ALTERNATIVA' },
    ]);
    assert.equal((await q("SELECT count(*)::int n FROM usuario_autorizacoes WHERE acao_codigo = 'MOVIMENTAR_ESTOQUE'")).rows[0].n, 5, 'nenhuma linha antiga apagada');
  });

  test('IMPORTAR_FUNCIONARIOS passa a ALTERNATIVA (mesma ação, sem duplicata) e continua sem SST', async () => {
    const { rows } = await q("SELECT codigo, exige_sst, modo_autorizacao_individual FROM acoes WHERE codigo LIKE 'IMPORTAR%'");
    assert.deepEqual(rows, [{ codigo: 'IMPORTAR_FUNCIONARIOS', exige_sst: false, modo_autorizacao_individual: 'ALTERNATIVA' }]);
  });

  test('perfil, grupo e bloqueio individual são espelhados nas duas ações, com o mesmo valor', async () => {
    for (const codigo of NOVAS) {
      const perfil = (await q('SELECT perfil, permitido FROM permissoes_acao WHERE empresa_id = $1 AND acao_codigo = $2 ORDER BY perfil', [dados.empresa, codigo])).rows;
      assert.deepEqual(perfil, [{ perfil: 'MASTER', permitido: true }, { perfil: 'SUPERVISOR', permitido: false }], codigo);
      const grupo = (await q('SELECT grupo_acesso_id, permitido FROM grupo_permissoes_acao WHERE acao_codigo = $1', [codigo])).rows;
      assert.deepEqual(grupo, [{ grupo_acesso_id: dados.grupo, permitido: true }], codigo);
      const bloqueio = (await q('SELECT usuario_id, bloqueado_por FROM usuario_bloqueios WHERE acao_codigo = $1', [codigo])).rows;
      assert.deepEqual(bloqueio, [{ usuario_id: dados.d, bloqueado_por: dados.master }], codigo);
    }
  });

  test('concessões diretas E DELEGADAS são preservadas: a cadeia de delegação é refeita com os ids novos, na mesma ação', async () => {
    for (const codigo of NOVAS) {
      const { rows } = await q('SELECT id, empresa_id, usuario_id, autorizado_por, pode_delegar, origem_id, motivo FROM usuario_autorizacoes WHERE acao_codigo = $1 ORDER BY id', [codigo]);
      assert.equal(rows.length, 5, `${codigo}: as 5 concessões antigas`);
      assert.deepEqual(rows.map((r) => [r.usuario_id, r.autorizado_por, r.pode_delegar, r.motivo]).sort(), [
        [dados.a, dados.master, true, 'direta'], [dados.b, dados.a, true, 'delegada'], [dados.c, dados.b, false, 'delegada'], [dados.d, dados.master, false, 'direta'],
        [rows.find((r) => r.empresa_id === dados.outra).usuario_id, rows.find((r) => r.empresa_id === dados.outra).usuario_id, false, 'direta'],
      ].sort());
      for (const r of rows.filter((x) => x.origem_id !== null)) {
        const origem = rows.find((o) => o.id === r.origem_id);
        assert.ok(origem, `${codigo}: a origem é da MESMA ação nova, nunca da antiga`);
        assert.equal(origem.usuario_id, r.autorizado_por, 'quem delegou é o dono da concessão de origem');
        assert.equal(origem.empresa_id, r.empresa_id);
      }
      assert.equal(rows.filter((r) => r.origem_id === null).length, 3);
    }
  });

  test('a migration recusa rodar se já houver autorização individual gravada para IMPORTAR_FUNCIONARIOS (ninguém ganha acesso sem revisão)', async () => {
    const outro = await abrirSchemaTemporario(todasAsMigrations().filter((p) => p !== '078'));
    try {
      const d = await semear((sql, params) => outro.cliente.query(sql, params));
      await outro.cliente.query("INSERT INTO usuario_autorizacoes (empresa_id, usuario_id, acao_codigo, autorizado_por) VALUES ($1, $2, 'IMPORTAR_FUNCIONARIOS', $3)", [d.empresa, d.a, d.master]);
      const e = await erroDe(outro.cliente.query(fs.readFileSync(ARQUIVO, 'utf8')));
      assert.match(e.message, /IMPORTAR_FUNCIONARIOS/);
    } finally {
      await outro.encerrar();
    }
  });
});
