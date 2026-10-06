'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { abrirSchemaTemporario, migrationExiste } = require('./helpers/schema-temporario');
const { todasAsMigrations, erroDe } = require('./helpers/entrega-epi');

/**
 * Migrations 075, 076 e 077 (Gestão de Usuários — Novo → Usuário, decisão de
 * 05/10/2026), em PostgreSQL real e schema temporário:
 *   075 — CPF da identidade: canônico, único no sistema, nulo para as
 *         identidades anteriores e IMUTÁVEL depois de definido (gatilho);
 *   076 — matrícula, setor e horário de trabalho do vínculo (usuarios):
 *         nulos para os vínculos anteriores, matrícula única por empresa,
 *         horário sempre com os dois lados ou nenhum;
 *   077 — IPs permitidos por usuário: tabela normalizada, INET (IPv4 e IPv6),
 *         só endereço de host, FK composta com a empresa.
 */

const DIRETORIO = path.join(__dirname, '..', '..', 'migrations');
const NOVAS = ['075', '076', '077'];
const ARQUIVOS = {
  '075': '075_alter_identidades_add_cpf.sql',
  '076': '076_alter_usuarios_add_matricula_setor_horario.sql',
  '077': '077_create_usuario_ips_permitidos.sql',
};
const VIOLACAO_CHECK = '23514';
const TEXTO_LONGO = '22001';
const VIOLACAO_UNICIDADE = '23505';
const VIOLACAO_FK = '23503';
const EXCECAO_GATILHO = 'P0001';

describe('migrations 075–077 — CPF da identidade, dados administrativos do vínculo e IPs permitidos', () => {
  let ctx;
  let identidadeAntiga;
  let empresaA;
  let empresaB;
  let usuarioAntigo;
  const erros = {};
  const q = (sql, params) => ctx.cliente.query(sql, params);
  const codigo = async (promessa) => (await erroDe(promessa))?.code;
  let sequencia = 0;
  const identidade = async (cpf = null) => {
    sequencia += 1;
    return (await q('INSERT INTO identidades (email, senha_hash, cpf) VALUES ($1, $2, $3) RETURNING id', [`pessoa-${sequencia}@example.invalid`, 'h', cpf])).rows[0].id;
  };
  const usuario = async (empresaId, extra = {}) => {
    const id = await identidade();
    return (await q(
      `INSERT INTO usuarios (empresa_id, nome, perfil, identidade_id, matricula, setor, horario_trabalho_inicio, horario_trabalho_fim)
       VALUES ($1, 'Pessoa', 'USUARIO', $2, $3, $4, $5, $6) RETURNING id`,
      [empresaId, id, extra.matricula ?? null, extra.setor ?? null, extra.inicio ?? null, extra.fim ?? null],
    )).rows[0].id;
  };

  before(async () => {
    for (const p of NOVAS) assert.equal(migrationExiste(p), true, `migration ${p} ainda não implementada`);
    ctx = await abrirSchemaTemporario(todasAsMigrations().filter((p) => !NOVAS.includes(p)));
    identidadeAntiga = (await q("INSERT INTO identidades (email, senha_hash) VALUES ('antiga@example.invalid', 'h') RETURNING id")).rows[0].id;
    empresaA = (await q("INSERT INTO empresas (nome, cnpj) VALUES ('Alfa', '11222333000181') RETURNING id")).rows[0].id;
    empresaB = (await q("INSERT INTO empresas (nome, cnpj) VALUES ('Beta', '11444777000161') RETURNING id")).rows[0].id;
    usuarioAntigo = (await q("INSERT INTO usuarios (empresa_id, nome, perfil, identidade_id) VALUES ($1, 'Antigo', 'MASTER', $2) RETURNING id", [empresaA, identidadeAntiga])).rows[0].id;
    for (const p of NOVAS) erros[p] = await erroDe(q(fs.readFileSync(path.join(DIRETORIO, ARQUIVOS[p]), 'utf8')));
  });
  after(async () => { if (ctx) await ctx.encerrar(); });

  test('as três aplicam sobre dados existentes sem alterar nada: CPF, matrícula, setor e horário nulos nos registros antigos', async () => {
    for (const p of NOVAS) assert.equal(erros[p], null, `${p}: ${erros[p] && erros[p].message}`);
    assert.deepEqual((await q('SELECT cpf FROM identidades WHERE id = $1', [identidadeAntiga])).rows[0], { cpf: null });
    assert.deepEqual(
      (await q('SELECT matricula, setor, horario_trabalho_inicio, horario_trabalho_fim FROM usuarios WHERE id = $1', [usuarioAntigo])).rows[0],
      { matricula: null, setor: null, horario_trabalho_inicio: null, horario_trabalho_fim: null },
    );
    const colunas = (await q("SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = current_schema() AND ((table_name = 'identidades' AND column_name = 'cpf') OR (table_name = 'usuarios' AND column_name IN ('matricula', 'setor', 'horario_trabalho_inicio', 'horario_trabalho_fim')) OR table_name = 'usuario_ips_permitidos') ORDER BY table_name, column_name")).rows;
    assert.deepEqual(colunas.map((c) => [c.table_name, c.column_name, c.data_type, c.is_nullable]), [
      ['identidades', 'cpf', 'character', 'YES'],
      ['usuario_ips_permitidos', 'criado_em', 'timestamp with time zone', 'NO'],
      ['usuario_ips_permitidos', 'empresa_id', 'integer', 'NO'],
      ['usuario_ips_permitidos', 'id', 'integer', 'NO'],
      ['usuario_ips_permitidos', 'ip', 'inet', 'NO'],
      ['usuario_ips_permitidos', 'usuario_id', 'integer', 'NO'],
      ['usuarios', 'horario_trabalho_fim', 'time without time zone', 'YES'],
      ['usuarios', 'horario_trabalho_inicio', 'time without time zone', 'YES'],
      ['usuarios', 'matricula', 'character varying', 'YES'],
      ['usuarios', 'setor', 'character varying', 'YES'],
    ]);
  });

  test('075: CPF só canônico (11 dígitos), único no sistema inteiro (inclusive entre empresas), e a primeira definição em identidade antiga é aceita', async () => {
    // Acima de CHAR(11) o PostgreSQL recusa pelo tamanho (22001) antes de chegar ao CHECK.
    assert.ok([VIOLACAO_CHECK, TEXTO_LONGO].includes(await codigo(identidade('123.456.789-09'))), 'com máscara');
    assert.equal(await codigo(identidade('1234567890')), VIOLACAO_CHECK, '10 dígitos');
    assert.equal(await codigo(identidade('1234567890a')), VIOLACAO_CHECK, 'letra');
    const primeira = await identidade('52998224725');
    assert.equal(await codigo(identidade('52998224725')), VIOLACAO_UNICIDADE, 'o mesmo CPF não entra duas vezes');
    assert.equal((await q("SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'uq_identidades_cpf'")).rows[0].indexdef.includes('WHERE (cpf IS NOT NULL)'), true, 'nulos não colidem');
    await identidade(null);
    await identidade(null);
    await q('UPDATE identidades SET cpf = $2 WHERE id = $1', [identidadeAntiga, '11144477735']);
    assert.deepEqual((await q('SELECT cpf FROM identidades WHERE id = $1', [identidadeAntiga])).rows[0], { cpf: '11144477735' });
    assert.ok(primeira > 0);
  });

  test('075: CPF definido é IMUTÁVEL — trocar ou apagar falha no gatilho, mesmo por UPDATE direto; alterar outra coluna continua livre', async () => {
    const id = await identidade('39053344705');
    assert.equal(await codigo(q("UPDATE identidades SET cpf = '52998224725' WHERE id = $1", [id])), EXCECAO_GATILHO, 'troca');
    assert.equal(await codigo(q('UPDATE identidades SET cpf = NULL WHERE id = $1', [id])), EXCECAO_GATILHO, 'remoção');
    await q("UPDATE identidades SET telefone = '11999990000' WHERE id = $1", [id]);
    await q("UPDATE identidades SET cpf = '39053344705' WHERE id = $1", [id]);
    assert.deepEqual((await q('SELECT cpf, telefone FROM identidades WHERE id = $1', [id])).rows[0], { cpf: '39053344705', telefone: '11999990000' });
  });

  test('076: matrícula única por empresa (a mesma matrícula em outra empresa é aceita), formato aparado e limitado, setor idem', async () => {
    await usuario(empresaA, { matricula: 'ADM-001', setor: 'Recursos Humanos' });
    assert.equal(await codigo(usuario(empresaA, { matricula: 'ADM-001', setor: 'Administrativo' })), VIOLACAO_UNICIDADE, 'duplicada na empresa');
    await usuario(empresaB, { matricula: 'ADM-001', setor: 'Administrativo' });
    await usuario(empresaA, { matricula: null, setor: null });
    await usuario(empresaA, { matricula: null, setor: null });
    assert.equal(await codigo(usuario(empresaA, { matricula: ' X1', setor: 'S' })), VIOLACAO_CHECK, 'espaço na borda');
    assert.equal(await codigo(usuario(empresaA, { matricula: '', setor: 'S' })), VIOLACAO_CHECK, 'vazia');
    assert.ok([VIOLACAO_CHECK, TEXTO_LONGO].includes(await codigo(usuario(empresaA, { matricula: 'M'.repeat(31), setor: 'S' }))), 'acima de 30 (VARCHAR recusa antes do CHECK)');
    assert.equal(await codigo(usuario(empresaA, { matricula: 'OK-1', setor: '' })), VIOLACAO_CHECK, 'setor vazio');
    assert.equal(await codigo(usuario(empresaA, { matricula: 'OK-1', setor: ' S' })), VIOLACAO_CHECK, 'setor com espaço na borda');
    assert.ok([VIOLACAO_CHECK, TEXTO_LONGO].includes(await codigo(usuario(empresaA, { matricula: 'OK-2', setor: 'S'.repeat(101) }))), 'setor acima de 100');
  });

  test('076: horário de trabalho vem inteiro ou não vem; turno noturno (fim antes do início) é aceito, é só informação', async () => {
    await usuario(empresaA, { matricula: 'H-1', setor: 'S', inicio: '08:00', fim: '18:00' });
    await usuario(empresaA, { matricula: 'H-2', setor: 'S', inicio: '22:00', fim: '06:00' });
    assert.equal(await codigo(usuario(empresaA, { matricula: 'H-3', setor: 'S', inicio: '08:00', fim: null })), VIOLACAO_CHECK, 'só início');
    assert.equal(await codigo(usuario(empresaA, { matricula: 'H-4', setor: 'S', inicio: null, fim: '18:00' })), VIOLACAO_CHECK, 'só fim');
    const linha = (await q("SELECT horario_trabalho_inicio::text AS i, horario_trabalho_fim::text AS f FROM usuarios WHERE empresa_id = $1 AND matricula = 'H-2'", [empresaA])).rows[0];
    assert.deepEqual(linha, { i: '22:00:00', f: '06:00:00' });
  });

  test('077: IPs permitidos — IPv4 e IPv6 como endereço de host, sem faixa, sem repetição por usuário, e a FK composta recusa usuário de outra empresa', async () => {
    const u = await usuario(empresaA, { matricula: 'IP-1', setor: 'S' });
    const inserir = (empresaId, usuarioId, ip) => q('INSERT INTO usuario_ips_permitidos (empresa_id, usuario_id, ip) VALUES ($1, $2, $3)', [empresaId, usuarioId, ip]);
    await inserir(empresaA, u, '203.0.113.10');
    await inserir(empresaA, u, '2001:db8::10');
    assert.equal(await codigo(inserir(empresaA, u, '203.0.113.10')), VIOLACAO_UNICIDADE, 'repetido');
    assert.equal(await codigo(inserir(empresaA, u, '2001:0db8:0000:0000:0000:0000:0000:0010')), VIOLACAO_UNICIDADE, 'o mesmo IPv6 escrito por extenso é o mesmo endereço');
    assert.equal(await codigo(inserir(empresaA, u, '203.0.113.0/24')), VIOLACAO_CHECK, 'faixa IPv4');
    assert.equal(await codigo(inserir(empresaA, u, '2001:db8::/64')), VIOLACAO_CHECK, 'faixa IPv6');
    assert.equal(await codigo(inserir(empresaB, u, '203.0.113.11')), VIOLACAO_FK, 'usuário de outra empresa');
    assert.equal(await codigo(inserir(empresaA, 999999, '203.0.113.11')), VIOLACAO_FK, 'usuário inexistente');
    const { rows } = await q('SELECT host(ip) AS ip FROM usuario_ips_permitidos WHERE empresa_id = $1 AND usuario_id = $2 ORDER BY ip', [empresaA, u]);
    assert.deepEqual(rows.map((r) => r.ip).sort(), ['2001:db8::10', '203.0.113.10'], 'dois endereços, na forma canônica');
  });

  test('manifesto: 78 migrations, 000 a 077; nenhuma migration anterior foi editada', () => {
    const manifesto = JSON.parse(fs.readFileSync(path.join(DIRETORIO, 'checksums.json'), 'utf8'));
    const arquivos = fs.readdirSync(DIRETORIO).filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort();
    assert.equal(arquivos.length, 79);
    assert.deepEqual(arquivos.slice(-4, -1), [ARQUIVOS['075'], ARQUIVOS['076'], ARQUIVOS['077']]);
    assert.deepEqual(Object.keys(manifesto.migrations).sort(), arquivos);
    const crypto = require('node:crypto');
    const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(DIRETORIO, f))).digest('hex');
    for (const f of arquivos) assert.equal(manifesto.migrations[f], sha(f), `${f}: idêntica ao manifesto`);
  });
});
