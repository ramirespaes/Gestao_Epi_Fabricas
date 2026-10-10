'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { abrirSchemaTemporario, abrirPoolTemporario, migrationExiste } = require('./helpers/schema-temporario');
const { todasAsMigrations, erroDe, criarMaterial } = require('./helpers/entrega-epi');
const { montarCenario } = require('./helpers/solicitacao-epi');

/**
 * Migration 070 — grade de tamanhos do material (Bloco 12, 12G-8), em
 * PostgreSQL real e schema temporário.
 *
 * A grade diz quais tamanhos são válidos para o produto; o GHE diz quais
 * produtos o trabalhador pode usar e o estoque, o que pode ser entregue agora.
 * Por isso a grade é do MATERIAL, explícita, e nunca é deduzida dos lotes: uma
 * tabela por empresa, material, tamanho e ordem de exibição, com FK composta
 * (sem mistura entre empresas), tamanho aparado e não vazio de até 20
 * caracteres, sem repetir o tamanho (sem diferenciar maiúsculas) nem a ordem,
 * e só para material que exige tamanho.
 */

const DIRETORIO = path.join(__dirname, '..', '..', 'migrations');
const UNICIDADE = '23505';
const VIOLACAO_FK = '23503';
const VIOLACAO_CHECK = '23514';
const TEXTO_LONGO_DEMAIS = '22001';
const RECUSA_DO_TRIGGER = 'P0001';
const TRAVA_INDISPONIVEL = '55P03';

function exigirMigration070() {
  assert.equal(migrationExiste('070'), true, 'migration 070 ainda não implementada');
}

const tabelasDoSchema = async (cliente) => (await cliente.query(
  "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY 1",
)).rows.map((r) => r.table_name);

describe('migration 070 — grade de tamanhos do material', () => {
  let ctx;
  let d;
  const q = (sql, params) => ctx.pool.query(sql, params);
  const codigo = async (promessa) => (await erroDe(promessa))?.code;
  const gradear = (materialId, tamanho, ordem, empresaId = d.empresaA) => q(
    'INSERT INTO material_tamanhos (empresa_id, material_id, tamanho, ordem) VALUES ($1, $2, $3, $4) RETURNING *',
    [empresaId, materialId, tamanho, ordem],
  );

  before(async () => {
    exigirMigration070();
    ctx = await abrirPoolTemporario(todasAsMigrations());
    d = await montarCenario(ctx.pool);
  });
  after(async () => { if (ctx) await ctx.encerrar(); });

  test('a 070 cria só material_tamanhos (diferença real entre 000–069 e 000–070)', async () => {
    const antes = await abrirSchemaTemporario(todasAsMigrations().filter((p) => p !== '070'));
    let semA070;
    try {
      semA070 = await tabelasDoSchema(antes.cliente);
    } finally {
      await antes.encerrar();
    }
    const novas = (await tabelasDoSchema(ctx.pool)).filter((t) => !semA070.includes(t));
    assert.deepEqual(novas, ['material_tamanhos']);
    const colunas = (await q(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'material_tamanhos' ORDER BY ordinal_position",
    )).rows.map((r) => r.column_name);
    assert.deepEqual(colunas, ['id', 'empresa_id', 'material_id', 'tamanho', 'ordem', 'criado_em']);
  });

  test('grava a grade de um material que exige tamanho, na ordem de exibição', async () => {
    const material = await criarMaterial(ctx.pool, d.empresaA, 'Botina da grade');
    for (const [i, t] of ['38', '39', '40'].entries()) await gradear(material, t, i + 1);
    const grade = (await q('SELECT tamanho FROM material_tamanhos WHERE empresa_id = $1 AND material_id = $2 ORDER BY ordem', [d.empresaA, material])).rows;
    assert.deepEqual(grade.map((r) => r.tamanho), ['38', '39', '40']);
  });

  test('isolamento: material de outra empresa ou inexistente não recebe grade (FK composta)', async () => {
    assert.equal(await codigo(gradear(d.botinaB, '40', 1, d.empresaA)), VIOLACAO_FK);
    assert.equal(await codigo(gradear(d.botina, '40', 1, d.empresaB)), VIOLACAO_FK);
    assert.equal(await codigo(gradear(999999, '40', 1)), VIOLACAO_FK);
  });

  test('tamanho aparado, não vazio e de até 20 caracteres; ordem a partir de 1', async () => {
    const material = await criarMaterial(ctx.pool, d.empresaA, 'Luva dos limites');
    assert.equal(await codigo(gradear(material, '', 1)), VIOLACAO_CHECK);
    assert.equal(await codigo(gradear(material, ' M', 1)), VIOLACAO_CHECK);
    assert.equal(await codigo(gradear(material, 'M ', 1)), VIOLACAO_CHECK);
    assert.equal(await codigo(gradear(material, 'x'.repeat(21), 1)), TEXTO_LONGO_DEMAIS);
    assert.equal(await codigo(gradear(material, 'M', 0)), VIOLACAO_CHECK);
    await gradear(material, 'x'.repeat(20), 1);
  });

  test('sem duplicidade lógica: o mesmo tamanho (sem diferenciar maiúsculas) ou a mesma ordem não se repetem no material', async () => {
    const material = await criarMaterial(ctx.pool, d.empresaA, 'Luva das repetições');
    await gradear(material, 'PP', 1);
    assert.equal(await codigo(gradear(material, 'PP', 2)), UNICIDADE);
    assert.equal(await codigo(gradear(material, 'pp', 2)), UNICIDADE);
    assert.equal(await codigo(gradear(material, 'P', 1)), UNICIDADE);
    const outro = await criarMaterial(ctx.pool, d.empresaA, 'Outra luva');
    await gradear(outro, 'PP', 1);
  });

  test('só material que exige tamanho tem grade: tamanho único ou não classificado é recusado pelo banco', async () => {
    const unico = await criarMaterial(ctx.pool, d.empresaA, 'Capacete da grade', { exigeTamanho: false });
    const naoClassificado = await criarMaterial(ctx.pool, d.empresaA, 'Legado sem classificação', { exigeTamanho: null });
    assert.equal(await codigo(gradear(unico, 'M', 1)), RECUSA_DO_TRIGGER);
    assert.equal(await codigo(gradear(naoClassificado, 'M', 1)), RECUSA_DO_TRIGGER);
  });

  test('a gravação da grade lê o material FOR SHARE: espera quem está trocando o material (FOR UPDATE)', async () => {
    const material = await criarMaterial(ctx.pool, d.empresaA, 'Botina disputada');
    const quemTroca = await ctx.pool.connect();
    const quemGrava = await ctx.pool.connect();
    try {
      await quemTroca.query('BEGIN');
      await quemTroca.query('SELECT id FROM materiais WHERE empresa_id = $1 AND id = $2 FOR UPDATE', [d.empresaA, material]);
      await quemGrava.query('BEGIN');
      await quemGrava.query("SET LOCAL lock_timeout = '200ms'");
      const erro = await erroDe(quemGrava.query('INSERT INTO material_tamanhos (empresa_id, material_id, tamanho, ordem) VALUES ($1, $2, $3, $4)', [d.empresaA, material, '40', 1]));
      assert.equal(erro?.code, TRAVA_INDISPONIVEL);
    } finally {
      await quemGrava.query('ROLLBACK').catch(() => {});
      await quemTroca.query('ROLLBACK').catch(() => {});
      quemGrava.release();
      quemTroca.release();
    }
  });

  test('a 070 não edita nenhuma migration antiga e só acrescenta a sua entrada ao manifesto: 85 migrations, 000 a 084 (a 071 também é da 12G-8; a 072 e a 073 são das Configurações; a 074 é da Gestão de Usuários; a 075 a 077 são do usuário administrativo; a 078 e a 079 são das permissões e da auditoria; a 080 é da Fiscalização)', () => {
    const manifesto = JSON.parse(fs.readFileSync(path.join(DIRETORIO, 'checksums.json'), 'utf8'));
    const arquivos = fs.readdirSync(DIRETORIO).filter((n) => /^\d{3}_.*\.sql$/.test(n)).sort();
    assert.equal(arquivos.length, 85);
    assert.equal(arquivos[arquivos.length - 15], '070_create_material_tamanhos.sql');
    assert.equal(arquivos[arquivos.length - 14], '071_alter_materiais_add_tipo_descricao_e_tipos_oculos.sql');
    assert.equal(arquivos[arquivos.length - 13], '072_alter_identidades_add_telefone_tema_modo_visual.sql');
    assert.equal(arquivos[arquivos.length - 12], '073_alter_usuarios_add_funcionario_id.sql');
    assert.equal(arquivos[arquivos.length - 11], '074_alter_identidades_add_senha_provisoria.sql');
    assert.equal(arquivos[arquivos.length - 10], '075_alter_identidades_add_cpf.sql');
    assert.equal(arquivos[arquivos.length - 9], '076_alter_usuarios_add_matricula_setor_horario.sql');
    assert.equal(arquivos[arquivos.length - 8], '077_create_usuario_ips_permitidos.sql');
    assert.equal(arquivos[arquivos.length - 7], '078_insert_acoes_estoque_entrada_baixa.sql');
    assert.equal(arquivos[arquivos.length - 6], '079_alter_logs_auditoria_add_perfil_ator.sql');
    assert.equal(arquivos[arquivos.length - 5], '080_create_fiscalizacao_pacotes.sql');
    assert.equal(arquivos[arquivos.length - 4], '081_alter_matricula_opcional.sql');
    assert.equal(arquivos[arquivos.length - 3], '082_create_tipos_material_classificacao_v2.sql');
    assert.equal(arquivos[arquivos.length - 2], '083_alter_ghe_add_codigo_create_ghe_tipos_material.sql');
    assert.equal(arquivos[arquivos.length - 1], '084_alter_funcionarios_add_situacao.sql');
    assert.deepEqual(Object.keys(manifesto.migrations).sort(), arquivos);
    for (const nome of arquivos) {
      const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(DIRETORIO, nome))).digest('hex');
      assert.equal(manifesto.migrations[nome], sha, nome);
    }
  });
});
