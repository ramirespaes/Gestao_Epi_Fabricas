'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Client } = require('pg');

const { abrirSchemaTemporario } = require('./helpers/schema-temporario');
const { configuracaoDoBancoDeTeste, confirmarBancoDeTeste } = require('./helpers/banco-de-teste');
const { registrarEventoSistema } = require('../../src/repositories/auditoria-plataforma.repository');
const { criarAuditoriaDoExecutor, eventoDaEvidencia, CAMPOS_DO_CONTEXTO } = require('../../src/services/backup-executor-auditoria.service');
const Ev = require('../../src/services/backup-executor-evidencia.service');

/**
 * D-ORF-6, L1 (Bloco B): confronto das chaves REAIS do contexto de auditoria do executor com o trigger `logs_auditoria_bloquear_dado_sensivel` em PostgreSQL real.
 * Só roda na instância efêmera local autorizada (SWB_PGDATA declarado); sem SWB_PGDATA é ignorado com o motivo TRG_SO_NA_INSTANCIA_EFEMERA_LOCAL (ver abaixo). Executado em 06/11/2026: 16/16 GREEN.
 * PENDENCIA-SEG-TRG04 (segurança, bloqueia a produção): o TRG-04L só CARACTERIZA a limitação atual da função de chave sensível (nomes compostos sem separador não são bloqueados); não é correção. Antes de qualquer escrita, uma conexão própria de sondagem exige:
 *   - o banco de teste do projeto (gestao_epi_teste_local, trava existente);
 *   - a identidade da instância autorizada: SWB_PGDATA e SWB_PORT do ambiente iguais a SHOW data_directory / SHOW port; porta fora de 5432 e 55460; listen_addresses vazio (só socket);
 *     DB_HOST igual ao diretório de socket da instância; usuário swb_teste;
 *   - schema `public` VAZIO (nenhuma relação, função, tipo, extensão ou ACL padrão): banco recém-criado, nunca um banco com dados.
 * Em seguida registra a IMPRESSÃO do catálogo (schemas, relações, funções, tipos, gatilhos, restrições, extensões, ACLs padrão, bancos e papéis) e a compara DEPOIS das migrations e dos eventos e DEPOIS do DROP SCHEMA:
 * qualquer diferença reprova. As migrations (000..048) rodam por `abrirSchemaTemporario`: schema `test_migration_<hex>` exclusivo, `SET search_path` só nele (sem `public`), DROP SCHEMA CASCADE ao final.
 * Verificação estática das 12 migrations: nenhuma contém CREATE ROLE/DATABASE/EXTENSION/SCHEMA, GRANT/REVOKE, SET search_path nem referência `public.`.
 */

const MIGRATIONS = ['000', '001', '002', '005', '012', '014', '027', '028', '029', '030', '031', '048'];
const PORTAS_PROTEGIDAS = [5432, 55460];
const OP = 'a'.repeat(32);

const CONSULTAS_DA_IMPRESSAO = Object.freeze({
  schemas: "SELECT nspname, nspowner::regrole::text AS dono, nspacl::text AS acl FROM pg_namespace ORDER BY nspname",
  relacoes: "SELECT c.oid::int AS oid, c.relname, c.relkind::text AS tipo, c.relacl::text AS acl FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' ORDER BY c.oid",
  funcoes: "SELECT p.oid::int AS oid, p.proname, md5(p.prosrc) AS corpo FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' ORDER BY p.oid",
  tipos: "SELECT t.oid::int AS oid, t.typname FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' ORDER BY t.oid",
  gatilhos: "SELECT g.oid::int AS oid, g.tgname FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' ORDER BY g.oid",
  restricoes: "SELECT k.oid::int AS oid, k.conname FROM pg_constraint k JOIN pg_namespace n ON n.oid = k.connamespace WHERE n.nspname = 'public' ORDER BY k.oid",
  extensoes: 'SELECT extname, extversion FROM pg_extension ORDER BY extname',
  aclsPadrao: 'SELECT defaclrole::regrole::text AS papel, defaclnamespace::int AS ns, defaclobjtype::text AS tipo, defaclacl::text AS acl FROM pg_default_acl ORDER BY oid',
  bancos: 'SELECT datname FROM pg_database ORDER BY datname',
  papeis: 'SELECT rolname FROM pg_roles ORDER BY rolname',
});

async function tirarImpressao(cliente) {
  const partes = {};
  for (const [nome, sql] of Object.entries(CONSULTAS_DA_IMPRESSAO)) partes[nome] = (await cliente.query(sql)).rows;
  return { partes, sha256: crypto.createHash('sha256').update(JSON.stringify(partes)).digest('hex') };
}

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
    aclsPadrao: 'SELECT count(*)::int AS n FROM pg_default_acl',
  })) assert.equal((await cliente.query(sql)).rows[0].n, 0, `schema public não está vazio (${rotulo}): o banco não é efêmero e limpo`);
  const extensoes = (await cliente.query('SELECT extname FROM pg_extension ORDER BY extname')).rows.map((r) => r.extname);
  assert.deepEqual(extensoes, ['plpgsql'], 'extensões inesperadas na instância');
}

function linha(estado) {
  let t = 1_800_000_000_000;
  const ev = Ev.criarEvidencia({ modo: 'ENSAIO', acao: 'VERIFICACAO_DESTINO', ambiente: 'HOMOLOGACAO', destinoId: 'hml-s3-principal', relogio: () => (t += 10), operacaoId: OP });
  if (estado === 'CONCLUIDO') { ev.etapa('VERIFICAR_DESTINO', true); return ev.encerrar({ estado: 'CONCLUIDO', verificacaoIndependente: 'CONFORME', origemDeChaves: 'TESTE_CONTROLADO', origemDoDestino: 'TESTE_CONTROLADO' }).linha; }
  if (estado === 'BLOQUEADO') return ev.encerrar({ estado: 'BLOQUEADO', codigo: 'OPERACAO_NAO_HABILITADA', falhouEm: 'GATE', bloqueios: ['OPERACAO_NAO_HABILITADA'] }).linha;
  ev.etapa('VERIFICAR_DESTINO', false, 'DESTINO_INDISPONIVEL');
  return ev.encerrar({ estado: 'FALHOU', codigo: 'DESTINO_INDISPONIVEL', falhouEm: 'VERIFICAR_DESTINO' }).linha;
}
const tentar = async (promessa) => { try { await promessa; return 'ok'; } catch (e) { return e.message; } };

// Fora da instância efêmera local (por exemplo, no job de integração do CI) a suíte é IGNORADA com motivo explícito, só quando SWB_PGDATA está AUSENTE (undefined).
// Com SWB_PGDATA declarado (mesmo vazio ou incoerente) a suíte RODA, e qualquer erro de configuração REPROVA: nunca vira skip.
const SO_NA_INSTANCIA_EFEMERA_LOCAL = process.env.SWB_PGDATA === undefined
  ? 'TRG_SO_NA_INSTANCIA_EFEMERA_LOCAL: SWB_PGDATA ausente; esta suíte só roda na instância efêmera local declarada por SWB_PGDATA'
  : false;

describe('[L1-TRIGGER] auditoria do executor × trigger de dado sensível (PostgreSQL real, schema temporário)', { skip: SO_NA_INSTANCIA_EFEMERA_LOCAL }, () => {
  let sonda;
  let ctx;
  let antes;

  before(async () => {
    sonda = new Client(configuracaoDoBancoDeTeste());
    await sonda.connect();
    await confirmarBancoDeTeste(sonda);
    await exigirInstanciaEfemeraAutorizada(sonda);
    antes = await tirarImpressao(sonda);
    ctx = await abrirSchemaTemporario(MIGRATIONS);
  });
  after(async () => {
    try {
      if (ctx) await ctx.encerrar();
      if (sonda && antes) {
        const depois = await tirarImpressao(sonda);
        assert.deepEqual(depois.partes, antes.partes, 'o catálogo mudou depois do DROP SCHEMA');
      }
    } finally {
      if (sonda) await sonda.end();
    }
  });

  test('TRG-01 — as migrations existem só no schema temporário; search_path sem public; impressão do catálogo idêntica depois das migrations', async () => {
    const { rows: [{ r }] } = await ctx.cliente.query('SELECT to_regclass($1) AS r', [`${ctx.schema}.logs_auditoria_plataforma`]);
    assert.notEqual(r, null);
    const { rows: [{ r: noPublic }] } = await ctx.cliente.query("SELECT to_regclass('public.logs_auditoria_plataforma') AS r");
    assert.equal(noPublic, null);
    assert.equal((await ctx.cliente.query('SHOW search_path')).rows[0].search_path, ctx.schema);
    const depois = await tirarImpressao(sonda);
    const semSchemaTemporario = (partes) => ({ ...partes, schemas: partes.schemas.filter((s) => s.nspname !== ctx.schema) });
    assert.deepEqual(semSchemaTemporario(depois.partes), antes.partes, 'o catálogo fora do schema temporário mudou');
    assert.equal(depois.partes.schemas.length, antes.partes.schemas.length + 1, 'só o schema temporário foi acrescentado');
  });

  test('TRG-02 — eventos reais do executor (CONCLUIDO, FALHOU, BLOQUEADO) são aceitos como SISTEMA', async () => {
    const a = criarAuditoriaDoExecutor({ executorDeBanco: ctx.cliente, registrarEventoSistema });
    for (const estado of ['CONCLUIDO', 'FALHOU', 'BLOQUEADO']) {
      const r = await a.registrar({ linha: linha(estado) });
      assert.equal(r.gravado, true, `${estado}: ${JSON.stringify(r)}`);
    }
    const { rows } = await ctx.cliente.query('SELECT ator_tipo, administrador_id, acao, referencia FROM logs_auditoria_plataforma ORDER BY id');
    assert.equal(rows.length, 3);
    for (const l of rows) {
      assert.equal(l.ator_tipo, 'SISTEMA');
      assert.equal(l.administrador_id, null);
      assert.equal(l.referencia, OP);
      assert.match(l.acao, /^BACKUP_EXECUTOR_VERIFICACAO_DESTINO_(CONCLUIDO|FALHOU|BLOQUEADO)$/);
    }
  });

  test('TRG-03 — cada chave do contexto do executor é aceita isoladamente pelo trigger', async () => {
    for (const chave of CAMPOS_DO_CONTEXTO) {
      const r = await tentar(registrarEventoSistema(ctx.cliente, { acao: 'BACKUP_EXECUTOR_TESTE', contexto: { [chave]: 'x' } }));
      assert.equal(r, 'ok', `chave ${chave} recusada: ${r}`);
    }
  });

  // TRG-04: cada caso é um teste independente (uma falha não impede os demais). O contrato do trigger (migration 014) é por SEGMENTOS do nome, não por substring.
  describe('TRG-04 — chaves sensíveis protegidas hoje são recusadas (contrato da migration 014)', () => {
    const casos = [
      ['contexto.token', { contexto: { token: 'x' } }],
      ['contexto.sessionToken (camelCase)', { contexto: { sessionToken: 'x' } }],
      ['contexto.senha', { contexto: { senha: 'x' } }],
      ['contexto.secretAccessKey (camelCase)', { contexto: { secretAccessKey: 'x' } }],
      ['contexto.accessKey (par adjacente)', { contexto: { accessKey: 'x' } }],
      ['contexto.PG_PASSWORD (separador)', { contexto: { PG_PASSWORD: 'x' } }],
      ['contexto aninhado: a.b.credential', { contexto: { a: { b: { credential: 'x' } } } }],
      ['contexto em array: a[].authorization', { contexto: { a: [{ authorization: 'x' }] } }],
      ['dadosNovos.password', { dadosNovos: { password: 'x' } }],
      ['dadosAnteriores.cookie', { dadosAnteriores: { cookie: 'x' } }],
    ];
    for (const [rotulo, campos] of casos) {
      test(`TRG-04 — ${rotulo} é recusada`, async () => {
        const r = await tentar(registrarEventoSistema(ctx.cliente, { acao: 'BACKUP_EXECUTOR_TESTE', ...campos }));
        assert.match(r, /chave sens/i, JSON.stringify(campos));
      });
    }
  });

  // PENDENCIA-SEG-TRG04 (segurança, tratamento separado antes da produção): CARACTERIZAÇÃO DA LIMITAÇÃO ATUAL, NÃO é comportamento seguro nem correção.
  // `logs_auditoria_chave_json_e_sensivel` não reconhece nomes COMPOSTOS SEM SEPARADOR e sem fronteira camelCase (`PGPASSWORD` vira o segmento único `pgpassword`).
  // Este teste afirma o comportamento ATUAL (aceita) para documentá-lo; quando a função for endurecida (nova migration), ele DEVE falhar e ser invertido para exigir a recusa.
  test('TRG-04L — LIMITAÇÃO CONHECIDA (PENDENCIA-SEG-TRG04): nomes compostos sem separador NÃO são bloqueados hoje (não é comportamento seguro)', async () => {
    const aceitas = [];
    for (const chave of ['PGPASSWORD', 'DBPASSWORD', 'ACCESSTOKEN', 'CLIENTSECRET']) {
      const r = await tentar(registrarEventoSistema(ctx.cliente, { acao: 'BACKUP_EXECUTOR_TESTE', contexto: { [chave]: 'x' } }));
      if (r === 'ok') aceitas.push(chave);
    }
    assert.deepEqual(aceitas, ['PGPASSWORD', 'DBPASSWORD', 'ACCESSTOKEN', 'CLIENTSECRET'], 'a limitação mudou: se a função foi endurecida, inverta este teste para exigir a recusa e feche a PENDENCIA-SEG-TRG04');
  });

  test('TRG-05 — a trilha é append-only: UPDATE, DELETE e TRUNCATE são recusados e as linhas permanecem', async () => {
    const contar = async () => (await ctx.cliente.query('SELECT count(*)::int AS n FROM logs_auditoria_plataforma')).rows[0].n;
    const antesDasLinhas = await contar();
    assert.match(await tentar(ctx.cliente.query("UPDATE logs_auditoria_plataforma SET descricao = 'x'")), /append-only/);
    assert.match(await tentar(ctx.cliente.query('DELETE FROM logs_auditoria_plataforma')), /append-only/);
    assert.match(await tentar(ctx.cliente.query('TRUNCATE logs_auditoria_plataforma')), /append-only/);
    assert.equal(await contar(), antesDasLinhas);
  });

  test('TRG-06 — o evento derivado da evidência só usa chaves do conjunto declarado; o catálogo fora do schema temporário segue idêntico depois de todos os eventos', async () => {
    const lida = Ev.lerLinhaDeEvidencia(linha('CONCLUIDO'));
    assert.equal(lida.ok, true);
    assert.ok(Object.keys(eventoDaEvidencia(lida.evidencia).contexto).every((k) => CAMPOS_DO_CONTEXTO.includes(k)));
    const depois = await tirarImpressao(sonda);
    assert.deepEqual({ ...depois.partes, schemas: depois.partes.schemas.filter((s) => s.nspname !== ctx.schema) }, antes.partes);
  });
});
