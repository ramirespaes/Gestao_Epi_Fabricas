'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { abrirSchemaTemporario, migrationExiste } = require('./helpers/schema-temporario');
const { todasAsMigrations, erroDe, criarEmpresa, criarFuncionario } = require('./helpers/entrega-epi');

/**
 * Migration 073 (Configurações) — vínculo EXPLÍCITO e opcional do usuário
 * empresarial com o funcionário da mesma empresa (usuarios.funcionario_id),
 * em PostgreSQL real e schema temporário. Usuários criados ANTES da 073
 * ficam sem vínculo (nenhuma inferência por nome, e-mail, CPF ou matrícula);
 * a integridade é declarativa: FK composta por empresa e unicidade por
 * funcionário.
 */

const DIRETORIO = path.join(__dirname, '..', '..', 'migrations');
const ARQUIVO_073 = '073_alter_usuarios_add_funcionario_id.sql';
const VIOLACAO_FK = '23503';
const VIOLACAO_UNICIDADE = '23505';

describe('migration 073 — vínculo explícito usuário ↔ funcionário (usuarios.funcionario_id)', () => {
  let ctx;
  let erroAoAplicar = null;
  const d = {};
  const q = (sql, params) => ctx.cliente.query(sql, params);
  const codigo = async (promessa) => (await erroDe(promessa))?.code;
  const novoUsuario = async (empresaId, nome, sufixo) => (await q(
    "INSERT INTO usuarios (empresa_id, nome, email, senha_hash, perfil) VALUES ($1, $2, $3, 'hash-de-teste', 'USUARIO') RETURNING id",
    [empresaId, nome, `${sufixo}@example.invalid`],
  )).rows[0].id;
  const vincular = (usuarioId, funcionarioId) => q('UPDATE usuarios SET funcionario_id = $2 WHERE id = $1', [usuarioId, funcionarioId]);
  const vinculoDe = async (usuarioId) => (await q('SELECT funcionario_id FROM usuarios WHERE id = $1', [usuarioId])).rows[0].funcionario_id;

  before(async () => {
    assert.equal(migrationExiste('073'), true, 'migration 073 ainda não implementada');
    ctx = await abrirSchemaTemporario(todasAsMigrations().filter((p) => p !== '073'));
    d.A = await criarEmpresa(ctx.cliente, '11222333000181', 'Empresa A');
    d.B = await criarEmpresa(ctx.cliente, '11444777000161', 'Empresa B');
    d.fA1 = await criarFuncionario(ctx.cliente, d.A, { matricula: 'A-1', cpf: '52998224725' });
    d.fA2 = await criarFuncionario(ctx.cliente, d.A, { matricula: 'A-2', cpf: '11144477735' });
    d.fB1 = await criarFuncionario(ctx.cliente, d.B, { matricula: 'B-1', cpf: '12345678909' });
    // Usuário antigo com o MESMO nome do funcionário A-1: a migration não pode ligá-los.
    d.uAntigo = await novoUsuario(d.A, 'Trabalhador A-1', 'antigo');
    erroAoAplicar = await erroDe(q(fs.readFileSync(path.join(DIRETORIO, ARQUIVO_073), 'utf8')));
  });
  after(async () => { if (ctx) await ctx.encerrar(); });

  test('aplica sobre usuários existentes sem vincular ninguém: a coluna nasce nula, mesmo com nome igual ao de um funcionário', async () => {
    assert.equal(erroAoAplicar, null, erroAoAplicar && erroAoAplicar.message);
    const coluna = (await q("SELECT data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = 'usuarios' AND column_name = 'funcionario_id'")).rows[0];
    assert.deepEqual(coluna, { data_type: 'integer', is_nullable: 'YES', column_default: null });
    assert.equal(await vinculoDe(d.uAntigo), null, 'nenhuma inferência por nome');
    assert.equal((await q('SELECT count(*)::int AS n FROM usuarios WHERE funcionario_id IS NOT NULL')).rows[0].n, 0);
  });

  test('integridade declarativa: FK composta por empresa sobre a unicidade da 057 e unicidade (empresa, funcionário); sem gatilho novo', async () => {
    const { rows } = await q(`SELECT conname, pg_get_constraintdef(oid) AS definicao FROM pg_constraint
                              WHERE conrelid = 'usuarios'::regclass AND conname IN ('fk_usuarios_funcionario_mesma_empresa', 'uq_usuarios_empresa_funcionario') ORDER BY 1`);
    assert.deepEqual(rows, [
      { conname: 'fk_usuarios_funcionario_mesma_empresa', definicao: 'FOREIGN KEY (empresa_id, funcionario_id) REFERENCES funcionarios(empresa_id, id) ON DELETE RESTRICT' },
      { conname: 'uq_usuarios_empresa_funcionario', definicao: 'UNIQUE (empresa_id, funcionario_id)' },
    ]);
    const alvo = (await q("SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid = 'funcionarios'::regclass AND conname = 'uq_funcionarios_empresa_id'")).rows[0].n;
    assert.equal(alvo, 1, 'a unicidade (empresa_id, id) da 057 é reaproveitada, não recriada');
    const gatilhos = (await q("SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid = 'usuarios'::regclass AND NOT tgisinternal AND tgname ILIKE '%funcionario%'")).rows[0].n;
    assert.equal(gatilhos, 0);
  });

  test('vínculo válido na mesma empresa: CPF e matrícula passam a ser lidos pelo vínculo, só de funcionarios; desvincular volta a nulo', async () => {
    const u = await novoUsuario(d.A, 'Pessoa Vinculada', 'vinculada');
    await vincular(u, d.fA1);
    const { rows } = await q(`SELECT f.matricula, f.cpf FROM usuarios u JOIN funcionarios f ON f.empresa_id = u.empresa_id AND f.id = u.funcionario_id WHERE u.id = $1`, [u]);
    assert.deepEqual(rows, [{ matricula: 'A-1', cpf: '52998224725' }]);
    const colunasUsuarios = (await q("SELECT column_name FROM information_schema.columns WHERE table_name = 'usuarios' AND column_name = 'cpf'")).rows;
    assert.deepEqual(colunasUsuarios, [], 'o CPF do funcionário nunca é copiado para usuarios (o CPF do usuário administrativo, 075, vive em identidades)');
    // usuarios.matricula (076) é a matrícula ADMINISTRATIVA do vínculo, informada no cadastro do usuário; o vínculo com o funcionário não a preenche.
    assert.equal((await q('SELECT matricula FROM usuarios WHERE id = $1', [u])).rows[0].matricula, null, 'a matrícula do funcionário vinculado não é copiada para usuarios');
    await vincular(u, null);
    assert.equal(await vinculoDe(u), null);
  });

  test('funcionário de OUTRA empresa e funcionário inexistente são recusados pela FK composta', async () => {
    const u = await novoUsuario(d.A, 'Pessoa de A', 'de-a');
    assert.equal(await codigo(vincular(u, d.fB1)), VIOLACAO_FK, 'funcionário da empresa B');
    assert.equal(await codigo(vincular(u, 999999)), VIOLACAO_FK, 'funcionário inexistente');
    assert.equal(await vinculoDe(u), null);
  });

  test('o mesmo funcionário não fica em dois usuários da empresa; vários usuários sem vínculo convivem (NULL não participa da unicidade)', async () => {
    const u1 = await novoUsuario(d.A, 'Primeira', 'primeira');
    const u2 = await novoUsuario(d.A, 'Segunda', 'segunda');
    await vincular(u1, d.fA2);
    assert.equal(await codigo(vincular(u2, d.fA2)), VIOLACAO_UNICIDADE);
    assert.equal(await vinculoDe(u2), null);
    const semVinculo = (await q('SELECT count(*)::int AS n FROM usuarios WHERE empresa_id = $1 AND funcionario_id IS NULL', [d.A])).rows[0].n;
    assert.ok(semVinculo >= 3, `${semVinculo} usuários sem vínculo na empresa A`);
    assert.equal(await codigo(q('DELETE FROM funcionarios WHERE id = $1', [d.fA2])), VIOLACAO_FK, 'funcionário vinculado não é apagado (RESTRICT)');
  });

  test('manifesto: 78 migrations, 000 a 077; a 057 continua idêntica ao manifesto', () => {
    const manifesto = JSON.parse(fs.readFileSync(path.join(DIRETORIO, 'checksums.json'), 'utf8'));
    const arquivos = fs.readdirSync(DIRETORIO).filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort();
    assert.equal(arquivos.length, 79);
    assert.equal(arquivos[73], ARQUIVO_073);
    assert.deepEqual(Object.keys(manifesto.migrations).sort(), arquivos);
    const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(DIRETORIO, f))).digest('hex');
    for (const f of [ARQUIVO_073, '057_alter_funcionarios_estoque_lotes_add_unicidades.sql']) assert.equal(manifesto.migrations[f], sha(f), f);
  });
});
