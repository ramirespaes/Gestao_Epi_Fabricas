'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const { Client } = require('pg');

const { abrirSchemaTemporario } = require('./helpers/schema-temporario');
const { configuracaoDoBancoDeTeste, confirmarBancoDeTeste, BANCO_DE_TESTE } = require('./helpers/banco-de-teste');
const { registrarEventoSistema } = require('../../src/repositories/auditoria-plataforma.repository');
const { criarAuditoriaDoExecutor } = require('../../src/services/backup-executor-auditoria.service');
const { criarCoordenacaoDoExecutor } = require('../../src/services/backup-executor-compositor.service');
const { adquirirExclusao } = require('../../src/services/backup-fontes-coordenacao-operacoes.service');
const Ev = require('../../src/services/backup-executor-evidencia.service');
const { removerTemporarioSeguro, criarRaizTemporaria } = require('../storage/helpers/tmp-seguro');

/**
 * D-ORF-6, Rodada B (B3) [B3-ROLE]: papel mínimo de banco do executor (modelo SQL do H9-h) em PostgreSQL REAL. Só roda na instância efêmera local declarada por SWB_PGDATA; sem SWB_PGDATA é ignorado com motivo
 * explícito (nunca na CI). O papel é criado e removido pelo próprio teste, só dentro da instância descartável; o esquema `public` não é tocado (as migrations rodam em schema temporário, como no teste da trigger L1).
 * Prova: (1) o modelo SQL como está FALHA e reverte; (2) com o banco e o esquema trocados em memória, cria um papel sem privilégios de administração; (3) o INSERT com RETURNING da auditoria e os advisory locks funcionam
 * com ele; (4) ele não faz DDL, não altera a trilha, não lê nem escreve fora do previsto e a trigger de dado sensível ainda vale; (5) SEM leitura concedida o pg_dump falha; (6) medição, só como EVIDÊNCIA, de dois conjuntos
 * candidatos de leitura para o pg_dump (papel predefinido e SELECT por objeto). A decisão sobre os privilégios de leitura é de Ramires e não é tomada aqui.
 */

const MIGRATIONS = ['000', '001', '002', '005', '012', '014', '027', '028', '029', '030', '031', '048', '097'];
const PORTAS_PROTEGIDAS = [5432, 55460];
const PAPEL = 'safework_backup_executor';
const MODELO = path.join(__dirname, '..', '..', 'ops', 'sql', 'papel-executor-backup.sql.modelo');
const OP = 'b'.repeat(32);
const executar = promisify(cp.execFile);

const SO_NA_INSTANCIA_EFEMERA_LOCAL = process.env.SWB_PGDATA === undefined
  ? 'B3_SO_NA_INSTANCIA_EFEMERA_LOCAL: SWB_PGDATA ausente; esta suíte só roda na instância efêmera local declarada por SWB_PGDATA'
  : false;

const comandosDoModelo = (texto) => texto.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n').split(';').map((c) => c.replace(/\s+/g, ' ').trim()).filter((c) => c !== '');
const codigoDoErro = async (promessa) => { try { await promessa; return 'ok'; } catch (e) { return e.code ?? e.message; } };

async function exigirInstanciaEfemeraAutorizada(cliente) {
  const { SWB_PGDATA, SWB_PORT, DB_HOST, DB_USER } = process.env;
  assert.ok(SWB_PGDATA && SWB_PORT && DB_HOST, 'SWB_PGDATA, SWB_PORT e DB_HOST são obrigatórios: este teste só roda na instância efêmera autorizada');
  const mostrar = async (parametro) => (await cliente.query(`SHOW ${parametro}`)).rows[0][parametro];
  assert.equal(await mostrar('data_directory'), SWB_PGDATA, 'data_directory difere da instância autorizada');
  assert.equal(await mostrar('port'), SWB_PORT, 'porta difere da instância autorizada');
  assert.ok(!PORTAS_PROTEGIDAS.includes(Number(SWB_PORT)), 'porta protegida');
  assert.equal(await mostrar('listen_addresses'), '', 'a instância efêmera deve ouvir só em socket Unix');
  assert.ok((await mostrar('unix_socket_directories')).split(',').map((s) => s.trim()).includes(DB_HOST), 'DB_HOST não é o socket da instância');
  assert.equal(DB_USER, 'swb_teste');
  assert.equal((await cliente.query('SELECT current_user AS u')).rows[0].u, 'swb_teste');
  for (const [rotulo, sql] of Object.entries({
    relacoes: "SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'",
    funcoes: "SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'",
    tipos: "SELECT count(*)::int AS n FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public'",
  })) assert.equal((await cliente.query(sql)).rows[0].n, 0, `schema public não está vazio (${rotulo}): o banco não é efêmero e limpo`);
}

function binariosDoPostgres16() {
  const dir = process.env.BACKUP_PG_BINARIOS;
  assert.ok(typeof dir === 'string' && path.isAbsolute(dir), 'BACKUP_PG_BINARIOS (caminho absoluto dos binários 16) é obrigatório nesta suíte');
  const pgDump = path.join(dir, 'pg_dump');
  const pgRestore = path.join(dir, 'pg_restore');
  assert.ok(fs.existsSync(pgDump) && fs.existsSync(pgRestore), 'pg_dump e pg_restore ausentes em BACKUP_PG_BINARIOS');
  const versao = cp.execFileSync(pgDump, ['--version'], { env: {}, timeout: 10000, encoding: 'utf8' });
  assert.match(versao, /^pg_dump \(PostgreSQL\) 16\./, 'os binários precisam ser da versão 16');
  return { pgDump, pgRestore };
}

function linhaDeEvidencia() {
  let t = 1_800_000_000_000;
  const ev = Ev.criarEvidencia({ modo: 'ENSAIO', acao: 'VERIFICACAO_DESTINO', ambiente: 'HOMOLOGACAO', destinoId: 'hml-s3-principal', relogio: () => (t += 10), operacaoId: OP });
  ev.etapa('VERIFICAR_DESTINO', true);
  return ev.encerrar({ estado: 'CONCLUIDO', verificacaoIndependente: 'CONFORME', origemDeChaves: 'TESTE_CONTROLADO', origemDoDestino: 'TESTE_CONTROLADO' }).linha;
}

describe('[B3-ROLE] papel mínimo de banco do executor (PostgreSQL real, instância efêmera local)', { skip: SO_NA_INSTANCIA_EFEMERA_LOCAL }, () => {
  let admin;
  let ctx;
  let papel;
  let bin;
  let raiz;
  let papeisAntes;

  const comoPapel = () => new Client({ ...configuracaoDoBancoDeTeste(), user: PAPEL, password: undefined });
  const modeloAdaptado = () => comandosDoModelo(fs.readFileSync(MODELO, 'utf8')).map((c) => c
    .replace('DATABASE A_PREENCHER', `DATABASE ${BANCO_DE_TESTE}`)
    .replace('SCHEMA public', `SCHEMA ${ctx.schema}`)
    .replaceAll('TABLE logs_auditoria_plataforma', `TABLE ${ctx.schema}.logs_auditoria_plataforma`));
  const dump = async (arquivo) => {
    const { host, port } = configuracaoDoBancoDeTeste();
    try {
      await executar(bin.pgDump, ['--format=custom', `--file=${arquivo}`, '--host', host, '--port', String(port), '--username', PAPEL, '--no-password', BANCO_DE_TESTE], { env: {}, timeout: 120000 });
      return { codigo: 0, stderr: '' };
    } catch (e) { return { codigo: e.code ?? 1, stderr: String(e.stderr ?? '') }; }
  };
  const listar = async (arquivo) => {
    try { await executar(bin.pgRestore, ['--list', arquivo], { env: {}, timeout: 60000 }); return 0; } catch (e) { return e.code ?? 1; }
  };

  before(async () => {
    admin = new Client(configuracaoDoBancoDeTeste());
    await admin.connect();
    await confirmarBancoDeTeste(admin);
    await exigirInstanciaEfemeraAutorizada(admin);
    bin = binariosDoPostgres16();
    papeisAntes = (await admin.query('SELECT rolname FROM pg_roles ORDER BY rolname')).rows.map((r) => r.rolname);
    assert.ok(!papeisAntes.includes(PAPEL), `o papel ${PAPEL} já existe na instância: o teste não o toca`);
    raiz = criarRaizTemporaria();
    ctx = await abrirSchemaTemporario(MIGRATIONS);
  });

  after(async () => {
    try { if (papel) await papel.end().catch(() => {}); } finally {
      try {
        await admin.query(`DROP OWNED BY ${PAPEL}`).catch(() => {});
        await admin.query(`DROP ROLE IF EXISTS ${PAPEL}`);
        if (ctx) await ctx.encerrar();
        const depois = (await admin.query('SELECT rolname FROM pg_roles ORDER BY rolname')).rows.map((r) => r.rolname);
        assert.deepEqual(depois, papeisAntes, 'a lista de papéis mudou depois da limpeza');
      } finally {
        await admin.end();
        if (raiz) removerTemporarioSeguro(raiz);
      }
    }
  });

  test('B3-ROLE-01 — o modelo SQL COMO ESTÁ (banco A_PREENCHER) falha e a transação inteira é revertida: nenhum papel é criado', async () => {
    const comandos = comandosDoModelo(fs.readFileSync(MODELO, 'utf8'));
    const cliente = new Client(configuracaoDoBancoDeTeste());
    await cliente.connect();
    try {
      let erro;
      for (const comando of comandos) {
        try { await cliente.query(comando); } catch (e) { erro = e; break; }
      }
      assert.ok(erro, 'o modelo incompleto deveria falhar');
      await cliente.query('ROLLBACK');
    } finally { await cliente.end(); }
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM pg_roles WHERE rolname = $1', [PAPEL])).rows[0].n, 0);
  });

  test('B3-ROLE-02 — com o banco e o esquema trocados em memória o modelo cria um papel de login SEM nenhum privilégio de administração e sem pertencer a papel algum', async () => {
    for (const comando of modeloAdaptado()) await admin.query(comando);
    const { rows: [r] } = await admin.query('SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolcanlogin, rolconnlimit FROM pg_roles WHERE rolname = $1', [PAPEL]);
    assert.deepEqual(r, { rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false, rolcanlogin: true, rolconnlimit: 2 });
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = $1', [PAPEL])).rows[0].n, 0);
    papel = comoPapel();
    await papel.connect();
    await papel.query(`SET search_path TO ${ctx.schema}`);
    assert.equal((await papel.query('SELECT current_user AS u')).rows[0].u, PAPEL);
  });

  test('B3-ROLE-03 — POSITIVO: o INSERT com RETURNING da auditoria (repositório real) e a auditoria do executor funcionam com o papel; os eventos entram como SISTEMA', async () => {
    const r = await registrarEventoSistema(papel, { acao: 'BACKUP_EXECUTOR_BACKUP_CONCLUIDO', referencia: OP, descricao: 'evento do papel minimo', contexto: { operacaoId: OP, estado: 'CONCLUIDO' } });
    assert.ok(r !== null && typeof r === 'object' && r.id !== undefined, JSON.stringify(r));
    const a = criarAuditoriaDoExecutor({ executorDeBanco: papel, registrarEventoSistema });
    const g = await a.registrar({ linha: linhaDeEvidencia() });
    assert.equal(g.gravado, true, JSON.stringify(g));
    const { rows } = await ctx.cliente.query("SELECT ator_tipo FROM logs_auditoria_plataforma WHERE acao LIKE 'BACKUP_EXECUTOR_%' ORDER BY id");
    assert.ok(rows.length >= 2 && rows.every((l) => l.ator_tipo === 'SISTEMA'), JSON.stringify(rows));
  });

  test('B3-ROLE-04 — POSITIVO: os advisory locks (coordenação do P10) funcionam sem nenhuma concessão, e a migração falha rápido enquanto o backup segura a exclusão', async () => {
    const coordenacao = criarCoordenacaoDoExecutor({ executorDeBanco: papel });
    const obtida = await coordenacao.adquirir({ operacao: 'BACKUP' });
    assert.equal(obtida.ok, true, JSON.stringify(obtida));
    const outra = new Client(configuracaoDoBancoDeTeste());
    await outra.connect();
    try {
      const recusada = await adquirirExclusao(outra, { operacao: 'MIGRACAO' });
      assert.equal(recusada.ok, false, 'a migração deveria falhar rápido durante o backup');
      await obtida.liberar();
      const livre = await adquirirExclusao(outra, { operacao: 'MIGRACAO' });
      assert.equal(livre.ok, true, JSON.stringify(livre));
      await livre.liberar();
    } finally { await outra.end(); }
  });

  test('B3-ROLE-05 — NEGATIVO: o papel não faz DDL, não altera a trilha, não lê nem escreve fora do previsto, não vira administrador e a trigger de dado sensível ainda vale', async () => {
    const t = ctx.schema;
    const esperados = [
      ['CREATE TABLE no esquema', `CREATE TABLE ${t}.intruso (a int)`],
      ['CREATE SCHEMA', 'CREATE SCHEMA gepi_b3_intruso'],
      ['DROP TABLE da trilha', `DROP TABLE ${t}.logs_auditoria_plataforma`],
      ['DROP SCHEMA', `DROP SCHEMA ${t}`],
      ['UPDATE da trilha', `UPDATE ${t}.logs_auditoria_plataforma SET acao = 'X'`],
      ['DELETE da trilha', `DELETE FROM ${t}.logs_auditoria_plataforma`],
      ['TRUNCATE da trilha', `TRUNCATE ${t}.logs_auditoria_plataforma`],
      ['SELECT de coluna não concedida', `SELECT acao FROM ${t}.logs_auditoria_plataforma`],
      ['SELECT * da trilha', `SELECT * FROM ${t}.logs_auditoria_plataforma`],
      ['SELECT em outra tabela', `SELECT 1 FROM ${t}.empresas`],
      ['INSERT em outra tabela', `INSERT INTO ${t}.empresas (nome, cnpj) VALUES ('X', '00000000000000')`],
      ['SELECT na auditoria de empresas', `SELECT 1 FROM ${t}.logs_auditoria`],
      ['CREATE ROLE', 'CREATE ROLE gepi_b3_intruso'],
      ['CREATE DATABASE', 'CREATE DATABASE gepi_b3_intruso'],
      ['ALTER ROLE SUPERUSER', `ALTER ROLE ${PAPEL} SUPERUSER`],
    ];
    for (const [rotulo, sql] of esperados) assert.equal(await codigoDoErro(papel.query(sql)), '42501', rotulo);
    assert.equal(await codigoDoErro(papel.query(`SELECT id, criado_em FROM ${t}.logs_auditoria_plataforma LIMIT 1`)), 'ok', 'as duas colunas concedidas continuam legíveis');
    assert.equal(await codigoDoErro(papel.query(`INSERT INTO ${t}.logs_auditoria_plataforma (acao, ator_tipo, contexto) VALUES ('X', 'SISTEMA', '{"PGPASSWORD":"x"}'::jsonb)`)), 'P0001', 'a trigger de dado sensível (097) continua valendo para o papel');
  });

  test('B3-ROLE-06 — NEGATIVO: SEM nenhum privilégio de leitura concedido, o pg_dump do papel FALHA (o modelo não concede leitura)', async () => {
    const arquivo = path.join(raiz, 'sem-leitura.dump');
    const r = await dump(arquivo);
    assert.notEqual(r.codigo, 0, 'o pg_dump não deveria funcionar sem leitura');
    assert.match(r.stderr, /permission denied|insufficient|must be/i);
  });

  test('B3-ROLE-07 — EVIDÊNCIA (candidato A, papel predefinido): com pg_read_all_data o pg_dump completo e o pg_restore --list funcionam; revogado, volta a falhar', async (t) => {
    await admin.query(`GRANT pg_read_all_data TO ${PAPEL}`);
    const arquivo = path.join(raiz, 'candidato-a.dump');
    const r = await dump(arquivo);
    const lista = r.codigo === 0 ? await listar(arquivo) : 'n/a';
    t.diagnostic(`B3_CANDIDATO_A pg_read_all_data: pg_dump=${r.codigo} pg_restore_list=${lista} bytes=${r.codigo === 0 ? fs.statSync(arquivo).size : 0}`);
    assert.equal(r.codigo, 0, `pg_dump com pg_read_all_data falhou: ${r.stderr.slice(0, 200)}`);
    assert.equal(lista, 0);
    await admin.query(`REVOKE pg_read_all_data FROM ${PAPEL}`);
    assert.notEqual((await dump(path.join(raiz, 'candidato-a-revogado.dump'))).codigo, 0, 'revogado o papel predefinido, o pg_dump deveria voltar a falhar');
  });

  test('B3-ROLE-08 — EVIDÊNCIA (candidato B, SELECT por objeto): mede se USAGE nos esquemas mais SELECT em tabelas e sequências bastam para o pg_dump; só registra, não decide', async (t) => {
    const t1 = ctx.schema;
    for (const sql of [`GRANT USAGE ON SCHEMA ${t1} TO ${PAPEL}`, `GRANT USAGE ON SCHEMA public TO ${PAPEL}`, `GRANT SELECT ON ALL TABLES IN SCHEMA ${t1} TO ${PAPEL}`, `GRANT SELECT ON ALL SEQUENCES IN SCHEMA ${t1} TO ${PAPEL}`]) await admin.query(sql);
    const arquivo = path.join(raiz, 'candidato-b.dump');
    const r = await dump(arquivo);
    const lista = r.codigo === 0 ? await listar(arquivo) : 'n/a';
    t.diagnostic(`B3_CANDIDATO_B select_por_objeto: pg_dump=${r.codigo} pg_restore_list=${lista} stderr=${r.stderr.replace(/\s+/g, ' ').slice(0, 200)}`);
    assert.ok(Number.isInteger(r.codigo), 'a medição precisa terminar com um código de saída');
  });
});
