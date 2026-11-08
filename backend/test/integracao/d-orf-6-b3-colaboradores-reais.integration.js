'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');

const { abrirSchemaTemporario } = require('./helpers/schema-temporario');
const { configuracaoDoBancoDeTeste, confirmarBancoDeTeste } = require('./helpers/banco-de-teste');
const { registrarEventoSistema } = require('../../src/repositories/auditoria-plataforma.repository');
const { montarColaboradoresReais } = require('../../src/services/backup-executor-colaboradores-reais.service');
const { CAMPOS_DO_CONTEXTO } = require('../../src/services/backup-executor-auditoria.service');
const { adquirirExclusao } = require('../../src/services/backup-fontes-coordenacao-operacoes.service');
const Ev = require('../../src/services/backup-executor-evidencia.service');

/**
 * D-ORF-6, Rodada B (B3) [B3-REAIS]: peças REAIS de coordenação e de auditoria, montadas pelo montador, em PostgreSQL real. Só roda na instância efêmera local declarada por SWB_PGDATA; sem SWB_PGDATA é ignorado com motivo
 * explícito (nunca na CI). As migrations rodam em schema temporário (search_path só nele); o esquema `public` não é tocado.
 * COBERTURA E LIMITE (08/11/2026): este arquivo NÃO é o ensaio ponta a ponta com `pg_dump` pela composição de produção. Essa composição inventaria o esquema `public` do banco (o `planejarNoSnapshot` é chamado sem o parâmetro
 * de esquema), o que exigiria aplicar migrations no `public` ou alterar o módulo aprovado da composição; as duas saídas dependem de autorização própria (ver o relatório do B3A). Aqui se prova o que é possível sem isso:
 * coordenação por advisory locks (backup × migração, e liberação por queda da sessão) e auditoria (um evento por execução, só campos do contexto, nunca a trilha alterada).
 */

const MIGRATIONS = ['000', '001', '002', '005', '012', '014', '027', '028', '029', '030', '031', '048', '097'];
const PORTAS_PROTEGIDAS = [5432, 55460];
const OP = 'c'.repeat(32);
const relogio = () => 1_800_000_000_000;

const SO_NA_INSTANCIA_EFEMERA_LOCAL = process.env.SWB_PGDATA === undefined
  ? 'B3_SO_NA_INSTANCIA_EFEMERA_LOCAL: SWB_PGDATA ausente; esta suíte só roda na instância efêmera local declarada por SWB_PGDATA'
  : false;

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
  for (const [rotulo, sql] of Object.entries({
    relacoes: "SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'",
    funcoes: "SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'",
  })) assert.equal((await cliente.query(sql)).rows[0].n, 0, `schema public não está vazio (${rotulo}): o banco não é efêmero e limpo`);
}

function linha(estado) {
  let t = 1_800_000_000_000;
  const ev = Ev.criarEvidencia({ modo: 'ENSAIO', acao: 'VERIFICACAO_DESTINO', ambiente: 'HOMOLOGACAO', destinoId: 'hml-s3-principal', relogio: () => (t += 10), operacaoId: OP });
  if (estado === 'CONCLUIDO') { ev.etapa('VERIFICAR_DESTINO', true); return ev.encerrar({ estado: 'CONCLUIDO', verificacaoIndependente: 'CONFORME', origemDeChaves: 'TESTE_CONTROLADO', origemDoDestino: 'TESTE_CONTROLADO' }).linha; }
  ev.etapa('VERIFICAR_DESTINO', false, 'DESTINO_INDISPONIVEL');
  return ev.encerrar({ estado: 'FALHOU', codigo: 'DESTINO_INDISPONIVEL', falhouEm: 'VERIFICAR_DESTINO' }).linha;
}

describe('[B3-REAIS] peças reais de coordenação e auditoria pelo montador (PostgreSQL real, schema temporário)', { skip: SO_NA_INSTANCIA_EFEMERA_LOCAL }, () => {
  let sonda;
  let ctx;
  const abertos = [];
  const novaSessao = async () => { const c = new Client(configuracaoDoBancoDeTeste()); await c.connect(); abertos.push(c); return c; };

  before(async () => {
    sonda = new Client(configuracaoDoBancoDeTeste());
    await sonda.connect();
    await confirmarBancoDeTeste(sonda);
    await exigirInstanciaEfemeraAutorizada(sonda);
    ctx = await abrirSchemaTemporario(MIGRATIONS);
  });
  after(async () => {
    try {
      for (const c of abertos) await c.end().catch(() => {});
      if (ctx) await ctx.encerrar();
    } finally { if (sonda) await sonda.end(); }
  });

  test('B3-REAIS-01 — a coordenação montada segura a exclusão do backup: a migração falha rápido; liberada, a migração passa', async () => {
    const coord = await novaSessao();
    const outra = await novaSessao();
    const pecas = montarColaboradoresReais({ acao: 'VERIFICACAO_DESTINO', executorDeCoordenacao: coord, executorDeAuditoria: ctx.cliente, registrarEventoSistema, relogio });
    const obtida = await pecas.coordenacao.adquirir({ operacao: 'BACKUP' });
    assert.equal(obtida.ok, true, JSON.stringify(obtida));
    assert.equal((await adquirirExclusao(outra, { operacao: 'MIGRACAO' })).ok, false);
    await obtida.liberar();
    const livre = await adquirirExclusao(outra, { operacao: 'MIGRACAO' });
    assert.equal(livre.ok, true, JSON.stringify(livre));
    await livre.liberar();
  });

  test('B3-REAIS-02 — queda da sessão de coordenação libera a exclusão: nenhuma trava fica presa', async () => {
    const coord = await novaSessao();
    const outra = await novaSessao();
    const pecas = montarColaboradoresReais({ acao: 'VERIFICACAO_DESTINO', executorDeCoordenacao: coord, executorDeAuditoria: ctx.cliente, registrarEventoSistema, relogio });
    assert.equal((await pecas.coordenacao.adquirir({ operacao: 'BACKUP' })).ok, true);
    assert.equal((await adquirirExclusao(outra, { operacao: 'MIGRACAO' })).ok, false);
    await coord.end();
    const depois = await adquirirExclusao(outra, { operacao: 'MIGRACAO' });
    assert.equal(depois.ok, true, JSON.stringify(depois));
    await depois.liberar();
  });

  test('B3-REAIS-03 — a auditoria montada grava UM evento por execução como SISTEMA, só com campos do contexto declarado, e a trilha não é alterada', async () => {
    const pecas = montarColaboradoresReais({ acao: 'VERIFICACAO_DESTINO', executorDeCoordenacao: await novaSessao(), executorDeAuditoria: ctx.cliente, registrarEventoSistema, relogio });
    for (const estado of ['CONCLUIDO', 'FALHOU']) {
      const r = await pecas.auditoria.registrar({ linha: linha(estado) });
      assert.equal(r.gravado, true, `${estado}: ${JSON.stringify(r)}`);
    }
    const { rows } = await ctx.cliente.query("SELECT acao, ator_tipo, contexto FROM logs_auditoria_plataforma WHERE referencia = $1 ORDER BY id", [OP]);
    assert.deepEqual(rows.map((l) => [l.acao, l.ator_tipo]), [['BACKUP_EXECUTOR_VERIFICACAO_DESTINO_CONCLUIDO', 'SISTEMA'], ['BACKUP_EXECUTOR_VERIFICACAO_DESTINO_FALHOU', 'SISTEMA']]);
    for (const l of rows) assert.ok(Object.keys(l.contexto).every((k) => CAMPOS_DO_CONTEXTO.includes(k)), JSON.stringify(Object.keys(l.contexto)));
    for (const sql of ["UPDATE logs_auditoria_plataforma SET acao = 'X'", 'DELETE FROM logs_auditoria_plataforma', 'TRUNCATE logs_auditoria_plataforma']) {
      let erro;
      try { await ctx.cliente.query(sql); } catch (e) { erro = e; }
      assert.ok(erro && /append-only/.test(erro.message), `${sql}: a trilha não pode ser alterada`);
    }
  });

  test('B3-REAIS-04 — falha da auditoria não lança nem mascara o desfecho: sessão de auditoria já encerrada vira gravado=false com código fixo', async () => {
    const morta = new Client(configuracaoDoBancoDeTeste());
    await morta.connect();
    await morta.end();
    const pecas = montarColaboradoresReais({ acao: 'VERIFICACAO_DESTINO', executorDeCoordenacao: await novaSessao(), executorDeAuditoria: morta, registrarEventoSistema, relogio });
    const r = await pecas.auditoria.registrar({ linha: linha('CONCLUIDO') });
    assert.deepEqual({ ...r }, { gravado: false, codigo: 'AUDITORIA_NAO_GRAVADA' });
  });

  test('B3-REAIS-05 — a sessão de coordenação e a de auditoria são distintas por contrato: o montador recusa a mesma sessão para os dois usos', async () => {
    const unica = await novaSessao();
    assert.throws(() => montarColaboradoresReais({ acao: 'VERIFICACAO_DESTINO', executorDeCoordenacao: unica, executorDeAuditoria: unica, registrarEventoSistema, relogio }), (e) => e.code === 'COLABORADORES_REAIS_CONFIGURACAO_INVALIDA');
  });
});
