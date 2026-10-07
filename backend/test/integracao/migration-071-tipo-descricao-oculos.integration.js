'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { abrirSchemaTemporario, migrationExiste } = require('./helpers/schema-temporario');
const { todasAsMigrations, erroDe } = require('./helpers/entrega-epi');

/**
 * Migration 071 (12G-8) — "Outros" com descrição em coluna própria e os dois
 * tipos de óculos de proteção, em PostgreSQL real e schema temporário.
 *
 * A 071 é incremental: acrescenta `materiais.tipo_descricao`, substitui os
 * CHECKs de óculos da 045 (materiais) e da 058 (cópia na entrega) por versões
 * que reconhecem os nomes novos e o histórico, e não converte nem apaga linha
 * alguma. O schema aqui recebe linhas antigas ANTES de aplicar a 071, para
 * provar que o legado sobrevive intacto.
 */

const DIRETORIO = path.join(__dirname, '..', '..', 'migrations');
const ARQUIVO_071 = '071_alter_materiais_add_tipo_descricao_e_tipos_oculos.sql';
const VIOLACAO_CHECK = '23514';
const INCOLOR = 'Óculos de Proteção Incolor';
const AMPLA = 'Óculos de Proteção Ampla Visão';
const LEGADO_OCULOS = 'Óculos de proteção';

describe('migration 071 — descrição de "Outros" e tipos de óculos de proteção', () => {
  let ctx;
  let empresa;
  let erroAoAplicar = null;
  const legado = {};
  const q = (sql, params) => ctx.cliente.query(sql, params);
  const codigo = async (promessa) => (await erroDe(promessa))?.code;
  const inserir = (campos) => {
    const v = { empresa_id: empresa, nome: `Material ${crypto.randomUUID().slice(0, 8)}`, prazo_uso_dias: 180, exige_tamanho: false, ...campos };
    const colunas = Object.keys(v);
    return q(`INSERT INTO materiais (${colunas.join(', ')}) VALUES (${colunas.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id, tipo, tipo_descricao, oculos_com_grau`, Object.values(v));
  };
  const linha = async (id) => (await q('SELECT tipo, tipo_descricao, oculos_com_grau, categoria, nome FROM materiais WHERE id = $1', [id])).rows[0];
  const restricao = async (tabela, nome) => (await q(
    `SELECT c.convalidated, pg_get_constraintdef(c.oid) AS definicao
       FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = current_schema() AND t.relname = $1 AND c.conname = $2`,
    [tabela, nome],
  )).rows[0];

  before(async () => {
    assert.equal(migrationExiste('071'), true, 'migration 071 ainda não implementada');
    ctx = await abrirSchemaTemporario(todasAsMigrations().filter((p) => p !== '071'));
    empresa = (await q("INSERT INTO empresas (nome, cnpj) VALUES ('Empresa 071', '11222333000181') RETURNING id")).rows[0].id;
    // Linhas como o sistema as gravava antes da 071.
    legado.oculos = (await q(
      "INSERT INTO materiais (empresa_id, nome, categoria, tipo, prazo_uso_dias, exige_tamanho, oculos_com_grau) VALUES ($1, 'Óculos antigo', 'EPI', $2, 180, false, true) RETURNING id",
      [empresa, LEGADO_OCULOS],
    )).rows[0].id;
    legado.outros = (await q(
      "INSERT INTO materiais (empresa_id, nome, categoria, tipo, prazo_uso_dias, exige_tamanho) VALUES ($1, 'Outros digitado', 'Ferramenta', 'Outros', 180, false) RETURNING id",
      [empresa],
    )).rows[0].id;
    legado.botina = (await q(
      "INSERT INTO materiais (empresa_id, nome, categoria, tipo, prazo_uso_dias, exige_tamanho) VALUES ($1, 'Botina antiga', 'EPI', 'Sapatão / Botina', 180, true) RETURNING id",
      [empresa],
    )).rows[0].id;
    // Falha aqui vira asserção abaixo (e não cancelamento da suíte): a migration tem de aceitar o legado como está.
    erroAoAplicar = await erroDe(q(fs.readFileSync(path.join(DIRETORIO, ARQUIVO_071), 'utf8')));
  });
  after(async () => { if (ctx) await ctx.encerrar(); });

  test('a 071 aplica sobre o schema que já tem linhas antigas, inclusive um "Outros" gravado sem descrição (por isso o CHECK é NOT VALID)', () => {
    assert.equal(erroAoAplicar, null, JSON.stringify(erroAoAplicar));
  });

  test('acrescenta só materiais.tipo_descricao (VARCHAR(100), nula) e não toca nenhuma linha antiga', async () => {
    const { rows } = await q(
      "SELECT column_name, data_type, character_maximum_length, is_nullable FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'materiais' AND column_name = 'tipo_descricao'",
    );
    assert.deepEqual(rows, [{ column_name: 'tipo_descricao', data_type: 'character varying', character_maximum_length: 100, is_nullable: 'YES' }]);
    assert.deepEqual(await linha(legado.oculos), { tipo: LEGADO_OCULOS, tipo_descricao: null, oculos_com_grau: true, categoria: 'EPI', nome: 'Óculos antigo' });
    assert.deepEqual(await linha(legado.outros), { tipo: 'Outros', tipo_descricao: null, oculos_com_grau: null, categoria: 'Ferramenta', nome: 'Outros digitado' });
    assert.deepEqual(await linha(legado.botina), { tipo: 'Sapatão / Botina', tipo_descricao: null, oculos_com_grau: null, categoria: 'EPI', nome: 'Botina antiga' });
    const sql = fs.readFileSync(path.join(DIRETORIO, ARQUIVO_071), 'utf8');
    assert.equal(/UPDATE\s+materiais|DELETE\s+FROM|DROP\s+TABLE|DROP\s+COLUMN/i.test(sql), false, 'sem conversão, exclusão ou perda');
  });

  test('restrições: formato da descrição; "Outros" ⇔ descrição como NOT VALID (o legado não é validado); os CHECKs de óculos da 045 e da 058 reconhecem os três nomes', async () => {
    const formato = await restricao('materiais', 'chk_materiais_tipo_descricao_formato');
    assert.equal(formato.convalidated, true);
    assert.match(formato.definicao, /btrim\(\(tipo_descricao\)::text\) = \(tipo_descricao\)::text/);
    const soOutros = await restricao('materiais', 'chk_materiais_tipo_descricao_so_outros');
    assert.equal(soOutros.convalidated, false, 'NOT VALID: nenhuma linha antiga é tocada pela migration');
    assert.match(soOutros.definicao, /Outros/);
    for (const [tabela, nome] of [['materiais', 'chk_materiais_oculos_com_grau_so_oculos'], ['entregas_epi_itens', 'chk_entregas_epi_itens_material_oculos']]) {
      const r = await restricao(tabela, nome);
      assert.ok(r, `${tabela}.${nome}`);
      assert.equal(r.convalidated, true, nome);
      for (const tipo of [LEGADO_OCULOS, INCOLOR, AMPLA]) assert.ok(r.definicao.includes(tipo), `${nome}: ${tipo}`);
    }
  });

  test('linhas novas: "Outros" exige descrição; outro tipo não a aceita; a descrição é aparada e não vazia', async () => {
    const ok = (await inserir({ categoria: 'Material de consumo', tipo: 'Outros', tipo_descricao: 'Fita isolante' })).rows[0];
    assert.deepEqual([ok.tipo, ok.tipo_descricao], ['Outros', 'Fita isolante']);
    assert.equal(await codigo(inserir({ categoria: 'Material de consumo', tipo: 'Outros' })), VIOLACAO_CHECK, 'Outros sem descrição');
    assert.equal(await codigo(inserir({ categoria: 'EPI', tipo: 'Luva', tipo_descricao: 'Luva de raspa' })), VIOLACAO_CHECK, 'descrição com tipo normal');
    assert.equal(await codigo(inserir({ categoria: 'EPI', tipo_descricao: 'sem tipo' })), VIOLACAO_CHECK, 'descrição sem tipo');
    assert.equal(await codigo(inserir({ categoria: 'EPI', tipo: 'Outros', tipo_descricao: ' x' })), VIOLACAO_CHECK, 'espaço na borda');
    assert.equal(await codigo(inserir({ categoria: 'EPI', tipo: 'Outros', tipo_descricao: '' })), VIOLACAO_CHECK, 'vazia');
    assert.equal(await codigo(inserir({ categoria: 'EPI', tipo: 'Outros', tipo_descricao: 'x'.repeat(101) })), '22001', 'acima de 100');
  });

  test('óculos com grau: Incolor, Ampla Visão e o nome histórico aceitam o valor; qualquer outro tipo não', async () => {
    for (const tipo of [INCOLOR, AMPLA, LEGADO_OCULOS]) {
      const r = (await inserir({ categoria: 'EPI', tipo, oculos_com_grau: true })).rows[0];
      assert.deepEqual([r.tipo, r.oculos_com_grau], [tipo, true]);
    }
    for (const tipo of ['Luva', 'Óculos', 'óculos de proteção incolor', 'Outros']) {
      assert.equal(await codigo(inserir({ categoria: 'EPI', tipo, oculos_com_grau: false, ...(tipo === 'Outros' ? { tipo_descricao: 'x' } : {}) })), VIOLACAO_CHECK, tipo);
    }
    assert.equal(await codigo(inserir({ categoria: 'EPI', oculos_com_grau: true })), VIOLACAO_CHECK, 'sem tipo');
  });

  test('o legado "Outros" sem descrição sobrevive à migration, mas qualquer alteração dele passa a exigir a descrição', async () => {
    assert.equal(await codigo(q("UPDATE materiais SET nome = 'Outros renomeado' WHERE id = $1", [legado.outros])), VIOLACAO_CHECK);
    await q("UPDATE materiais SET nome = 'Outros renomeado', tipo_descricao = 'Chave de fenda' WHERE id = $1", [legado.outros]);
    assert.deepEqual(await linha(legado.outros), { tipo: 'Outros', tipo_descricao: 'Chave de fenda', oculos_com_grau: null, categoria: 'Ferramenta', nome: 'Outros renomeado' });
    // O legado de óculos continua editável e pode receber o nome novo sem perder o grau.
    await q('UPDATE materiais SET tipo = $2 WHERE id = $1', [legado.oculos, INCOLOR]);
    assert.deepEqual((await linha(legado.oculos)).oculos_com_grau, true);
  });

  test('manifesto: 78 migrations, 000 a 077; a 045 e a 058 continuam idênticas ao manifesto; a 071 só acrescenta a sua entrada', () => {
    const manifesto = JSON.parse(fs.readFileSync(path.join(DIRETORIO, 'checksums.json'), 'utf8'));
    const arquivos = fs.readdirSync(DIRETORIO).filter((n) => /^\d{3}_.*\.sql$/.test(n)).sort();
    assert.equal(arquivos.length, 79);
    assert.equal(arquivos[arquivos.length - 8], ARQUIVO_071);
    assert.equal(arquivos[arquivos.length - 7], '072_alter_identidades_add_telefone_tema_modo_visual.sql');
    assert.equal(arquivos[arquivos.length - 6], '073_alter_usuarios_add_funcionario_id.sql');
    assert.equal(arquivos[arquivos.length - 5], '074_alter_identidades_add_senha_provisoria.sql');
    assert.equal(arquivos[arquivos.length - 4], '075_alter_identidades_add_cpf.sql');
    assert.equal(arquivos[arquivos.length - 3], '076_alter_usuarios_add_matricula_setor_horario.sql');
    assert.equal(arquivos[arquivos.length - 2], '077_create_usuario_ips_permitidos.sql');
    assert.equal(arquivos[arquivos.length - 1], '078_insert_acoes_estoque_entrada_baixa.sql');
    assert.deepEqual(Object.keys(manifesto.migrations).sort(), arquivos);
    for (const nome of arquivos) {
      const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(DIRETORIO, nome))).digest('hex');
      assert.equal(manifesto.migrations[nome], sha, nome);
    }
    for (const antiga of ['045_alter_materiais_add_oculos_com_grau.sql', '058_create_fichas_entregas_epi.sql']) {
      assert.match(fs.readFileSync(path.join(DIRETORIO, antiga), 'utf8'), /tipo = 'Óculos de proteção'\)/, `${antiga}: CHECK histórico intacto`);
    }
  });
});
