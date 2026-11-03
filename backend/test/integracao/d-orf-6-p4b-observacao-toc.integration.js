'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Client } = require('pg');

const { abrirSchemaTemporario } = require('./helpers/schema-temporario');
const { configuracaoDoBancoDeTeste, confirmarBancoDeTeste, BANCO_DE_TESTE } = require('./helpers/banco-de-teste');
const { aplicarMigrations } = require('../../scripts/migrate');
const { listarMigrations } = require('../../src/db/checksums');
const { exportarSnapshot } = require('../../src/repositories/imagem-backup-snapshot.repository');
const { inventariar } = require('../../src/repositories/backup-fontes-postgres-inventario.repository');
const { criarLeitorDeSumario } = require('../../src/services/backup-fontes-postgres-sumario.service');
const C = require('../../src/services/backup-fontes-postgres-cobertura.service');
const { criarLancadorComSpawn } = require('../../src/services/imagem-backup-pgdump-lancador.service');
const { criarLancadorDeRestauracaoReal } = require('../../src/services/imagem-backup-restauracao-lancador.service');
const K = require('../helpers/p4b-caracterizacao');

/**
 * D-ORF-6, P4b — OBSERVAÇÃO REAL do sumário (`pg_restore --list`) de um dump PostgreSQL 16 SINTÉTICO, feita SOMENTE na instância efêmera do GitHub
 * Actions (serviço `postgres:16` desta execução, marcada pelo workflow com `GEPI_CI_EFEMERO:<run>:<tentativa>:<nonce>`). Fora dela o teste é PULADO
 * com motivo explícito: nunca inicia PostgreSQL, nunca executa `pg_dump`/`pg_restore` local.
 *
 * Banco de testes: `gestao_epi_teste_local` (único aceito por `helpers/banco-de-teste.js`). Impacto: um schema temporário `test_migration_<hex>` com as
 * migrations reais (removido com DROP SCHEMA CASCADE), um banco `gepi_p4b_rest_<hex>` criado na MESMA instância efêmera só para a restauração
 * fictícia (removido com DROP DATABASE), um diretório temporário 0700 com o dump e o PGPASSFILE (removido). Tudo morre com o runner.
 *
 * O que se observa e registra (linha `P4B_OBSERVACAO_JSON` no log): tipos de entrada do TOC por categoria do inventário, opcionais presentes/ausentes,
 * igualdade `TOC Entries` × linhas, versões, entradas não interpretadas; a comparação inventário × sumário pelo comparador do P4a; e a restauração
 * fictícia num banco novo com inventário idêntico (relações do esquema e migrations). Toda contradição do mapa v1 REPROVA o teste (falha fechada) e o
 * JSON fica no log para a revisão: este teste NÃO altera `MAPA_DE_CORRESPONDENCIA.observadoEm`; isso é edição humana com a evidência.
 *
 * Componentes reutilizados: lançador do pg_dump (args fechados, ambiente só PGPASSFILE/PGHOST/PGPORT/PGUSER, stdio para descritor), lançador de
 * restauração (política de destino `gepi_p4b_rest_`), snapshot `REPEATABLE READ READ ONLY` + `pg_export_snapshot()`, inventário e leitor do P4a. O
 * `pg_restore --list` é lançado aqui com o MESMO spec do lançador estrutural (argumentos `['--list']`, ambiente vazio, dump pela entrada padrão),
 * porque aquele lançador retém só 64 KiB e não expõe o fluxo.
 */

const DIRETORIO_MIGRATIONS = path.join(__dirname, '..', '..', 'migrations');
const CANDIDATOS_BIN = ['/usr/lib/postgresql/16/bin', '/usr/bin'];
const PREFIXO_RESTAURADO = 'gepi_p4b_rest_';
const PROTEGIDOS = [BANCO_DE_TESTE, 'postgres', 'template0', 'template1'];
const PRAZO_PROCESSO_MS = 120000;

function localizarBinarios() {
  for (const dir of CANDIDATOS_BIN) {
    const dump = path.join(dir, 'pg_dump');
    const restore = path.join(dir, 'pg_restore');
    if (!fs.existsSync(dump) || !fs.existsSync(restore)) continue;
    let versao;
    try { versao = cp.execFileSync(dump, ['--version'], { env: {}, timeout: 10000, encoding: 'utf8' }); } catch { continue; }
    if (/^pg_dump \(PostgreSQL\) 16\./.test(versao)) return { dir, dump, restore, versao: versao.trim() };
  }
  return null;
}

const comPrazo = (promessa, rotulo) => Promise.race([promessa, new Promise((_, rej) => setTimeout(() => rej(new Error(`prazo esgotado: ${rotulo}`)), PRAZO_PROCESSO_MS).unref())]);

/** Lança `pg_restore --list` com o spec do lançador estrutural e alimenta o leitor em fluxo. */
function listarSumario(executavel, descritorDoDump) {
  return new Promise((resolver, rejeitar) => {
    const leitor = criarLeitorDeSumario();
    const filho = cp.spawn(executavel, ['--list'], { env: {}, shell: false, detached: false, stdio: [descritorDoDump, 'pipe', 'ignore'] });
    let codigo = null;
    filho.on('error', (e) => rejeitar(new Error(`pg_restore --list não iniciou (${e.code ?? 'sem código'})`)));
    filho.stdout.on('data', (bloco) => { try { leitor.alimentar(bloco); } catch { /* leitor já truncou: ignora */ } });
    filho.on('exit', (c) => { codigo = c; });
    filho.on('close', () => resolver({ codigo, sumario: leitor.concluir() }));
  });
}

async function inventarioEmLeitura(configuracao, esquema) {
  const cliente = new Client(configuracao);
  await cliente.connect();
  try {
    await cliente.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    return await inventariar(cliente, { esquemaDasMigrations: esquema });
  } finally {
    await cliente.query('ROLLBACK').catch(() => {});
    await cliente.end().catch(() => {});
  }
}

describe('D-ORF-6 P4b — observação real do TOC de um dump sintético (só na CI efêmera)', () => {
  test('o sumário real confirma o mapa v1 por categoria, o comparador do P4a aprova, e a restauração num banco novo reproduz o esquema', async (t) => {
    const motivo = K.motivoDeRecusaCi(process.env);
    if (motivo !== null) { t.skip(`P4B_SO_EM_CI_EFEMERA: ${motivo}`); return; }
    const binarios = localizarBinarios();
    assert.ok(binarios !== null, 'PG_BINARIOS_16_INDISPONIVEIS: pg_dump/pg_restore 16 não encontrados no runner (ver procedimento P4b, seção "binários")');

    const configuracao = configuracaoDoBancoDeTeste();
    const nonce = crypto.randomBytes(6).toString('hex');
    const bancoRestaurado = `${PREFIXO_RESTAURADO}${nonce}`;
    const area = fs.mkdtempSync(path.join(os.tmpdir(), 'p4b-'));
    fs.chmodSync(area, 0o700);
    const arquivoDeSenha = path.join(area, 'pgpass');
    const caminhoDoDump = path.join(area, 'postgres.dump');
    fs.writeFileSync(arquivoDeSenha, `${configuracao.host}:${configuracao.port}:*:${configuracao.user}:${configuracao.password}\n`, { mode: 0o600 });
    const ambienteDoCliente = { PGPASSFILE: arquivoDeSenha, PGHOST: configuracao.host, PGPORT: String(configuracao.port), PGUSER: configuracao.user };

    const observacao = { ci: { run: process.env.GITHUB_RUN_ID, tentativa: process.env.GITHUB_RUN_ATTEMPT }, binarios: binarios.versao };
    let contexto = null;
    let snapshot = null;
    let admin = null;
    let bancoCriado = false;
    try {
      // 0. Instância efêmera comprovada pelo marcador do próprio banco (mesma regra do J2a).
      admin = new Client(configuracao);
      await admin.connect();
      await confirmarBancoDeTeste(admin);
      const { rows: marcador } = await admin.query(K.SQL_MARCADOR_DO_BANCO);
      assert.ok(K.marcadorDoBancoConfere(marcador[0]?.marcador, K.marcadorEsperadoCi(process.env)), 'instância efêmera de CI não comprovada: marcador do banco ausente ou divergente');

      // 1. Banco sintético: schema temporário com TODAS as migrations reais (dados: só o que as migrations semeiam).
      contexto = await abrirSchemaTemporario([]);
      await aplicarMigrations({ schema: contexto.schema, diretorio: DIRETORIO_MIGRATIONS });
      const migrationsDoCodigo = listarMigrations(DIRETORIO_MIGRATIONS).map((m) => m.nome.replace(/\.sql$/, ''));
      observacao.esquema = contexto.schema;
      observacao.migrationsDoCodigo = migrationsDoCodigo.length;

      // 2. Snapshot REPEATABLE READ READ ONLY: inventário e pg_dump no MESMO snapshot.
      snapshot = new Client(configuracao);
      await snapshot.connect();
      await snapshot.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const snapshotId = await exportarSnapshot(snapshot);
      assert.match(String(snapshotId), /^[0-9A-F]{8}-[0-9A-F]{8}-[1-9][0-9]{0,9}$/, 'snapshot exportado em formato inesperado');
      const inventario = await inventariar(snapshot, { esquemaDasMigrations: contexto.schema });
      assert.deepEqual([...inventario.migrations], migrationsDoCodigo, 'as migrations aplicadas no banco sintético precisam ser exatamente as do código');
      observacao.inventario = { relacoes: inventario.relacoes.length, outros: inventario.outros, extensoes: inventario.extensoes, servidor: inventario.servidor };

      // 3. pg_dump pelo lançador histórico (args fechados; dump para descritor próprio; ambiente mínimo).
      const descritorDoDump = fs.openSync(caminhoDoDump, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
      try {
        const lancador = criarLancadorComSpawn({ spawn: cp.spawn });
        const processo = await lancador.lancar({
          executavel: binarios.dump,
          argumentos: ['--format=custom', '--no-password', `--snapshot=${snapshotId}`, `--dbname=${BANCO_DE_TESTE}`],
          ambiente: ambienteDoCliente,
          opcoes: { shell: false, detached: true, stdio: ['ignore', descritorDoDump, 'ignore'] },
        });
        const termino = await comPrazo(processo.saida, 'pg_dump');
        await comPrazo(processo.fluxosFechados, 'pg_dump (fluxos)');
        assert.deepEqual(termino, { codigo: 0, sinal: null }, 'pg_dump precisa terminar com código 0');
      } finally {
        fs.closeSync(descritorDoDump);
      }
      await snapshot.query('ROLLBACK');
      await snapshot.end();
      snapshot = null;
      const dump = fs.readFileSync(caminhoDoDump);
      observacao.dump = { bytes: dump.length, sha256: crypto.createHash('sha256').update(dump).digest('hex') };
      assert.ok(dump.length > 0 && dump.subarray(0, 5).toString('latin1') === 'PGDMP', 'o artefato precisa ser um dump custom (PGDMP)');

      // 4. pg_restore --list em fluxo, leitor do P4a.
      const descritorDeLeitura = fs.openSync(caminhoDoDump, 'r');
      let listagem;
      try { listagem = await comPrazo(listarSumario(binarios.restore, descritorDeLeitura), 'pg_restore --list'); } finally { fs.closeSync(descritorDeLeitura); }
      assert.equal(listagem.codigo, 0, 'pg_restore --list precisa terminar com código 0');
      const { sumario } = listagem;
      const caracterizacao = K.caracterizarObservacao({ inventario, sumario, esquema: contexto.schema });
      observacao.caracterizacao = caracterizacao;
      observacao.sumarioMotivos = sumario.motivos;

      // 5. Comparador e bloco do P4a sobre dados reais.
      const comparacao = C.compararInventarioComSumario({ inventario, sumario });
      const bloco = C.avaliarCoberturaPostgres({ inventario, sumario, migrationsDoCodigo });
      observacao.comparacao = { ok: comparacao.ok, motivos: comparacao.motivos, relacoes: comparacao.relacoes };
      observacao.bloco = { nivelCalculado: bloco.nivelCalculado, nivelAtingido: bloco.nivelAtingido, motivos: bloco.motivos, esquema: bloco.esquema };

      // 6. Restauração FICTÍCIA num banco NOVO da mesma instância efêmera (lançador de restauração, política de destino própria).
      await admin.query(`CREATE DATABASE ${bancoRestaurado}`);
      bancoCriado = true;
      const descritorParaRestaurar = fs.openSync(caminhoDoDump, 'r');
      try {
        const restaurador = criarLancadorDeRestauracaoReal({ politicaDeDestino: { prefixoDoBanco: PREFIXO_RESTAURADO, hostsAutorizados: [configuracao.host], bancosProtegidos: PROTEGIDOS } });
        const processo = await restaurador.lancar({
          executavel: binarios.restore,
          argumentos: ['--exit-on-error', '--no-owner', '--no-privileges', '--single-transaction', `--dbname=${bancoRestaurado}`],
          ambiente: ambienteDoCliente,
          opcoes: { shell: false, detached: true, stdio: [descritorParaRestaurar, 'ignore', 'ignore'] },
        });
        const termino = await comPrazo(processo.saida, 'pg_restore');
        await comPrazo(processo.fluxosFechados, 'pg_restore (fluxos)');
        observacao.restauracao = { termino };
        assert.deepEqual(termino, { codigo: 0, sinal: null }, 'pg_restore precisa terminar com código 0');
      } finally {
        fs.closeSync(descritorParaRestaurar);
      }
      const inventarioRestaurado = await inventarioEmLeitura({ ...configuracao, database: bancoRestaurado }, contexto.schema);
      const restauracao = K.compararRestauracao({ origem: inventario, restaurado: inventarioRestaurado, esquema: contexto.schema });
      observacao.restauracao = { ...observacao.restauracao, ...restauracao };

      // 7. Registro durável no log e veredito (falha fechada: qualquer contradição reprova).
      process.stdout.write(`P4B_OBSERVACAO_JSON ${JSON.stringify(observacao)}\n`);
      assert.deepEqual(sumario.motivos, [], `sumário com motivos: ${sumario.motivos.join(',')}`);
      assert.deepEqual(caracterizacao.contradicoes, [], `mapa v1 contradito: ${caracterizacao.contradicoes.join(',')}`);
      assert.ok(caracterizacao.relacoesDoEsquema > 50, 'o esquema sintético precisa ter as relações das migrations reais');
      assert.equal(comparacao.ok, true, `comparador reprovou: ${comparacao.motivos.join(',')}`);
      assert.equal(bloco.nivelCalculado, 'N1');
      assert.equal(bloco.nivelAtingido, 'N0', 'o nível atingido só sobe depois da revisão humana desta observação (observadoEm)');
      assert.deepEqual(bloco.motivos, ['MAPA_NAO_OBSERVADO']);
      assert.equal(restauracao.ok, true, `restauração fictícia divergente: ${restauracao.divergencias.join(',')}`);
      assert.equal(restauracao.migrations.relacao, 'IGUAL');
    } finally {
      if (snapshot !== null) { await snapshot.query('ROLLBACK').catch(() => {}); await snapshot.end().catch(() => {}); }
      if (admin !== null && bancoCriado) await admin.query(`DROP DATABASE IF EXISTS ${bancoRestaurado} WITH (FORCE)`).catch((e) => process.stderr.write(`P4B_LIMPEZA: banco restaurado não removido (${e.code ?? 'sem código'})\n`));
      if (admin !== null) await admin.end().catch(() => {});
      if (contexto !== null) await contexto.encerrar().catch(() => {});
      fs.rmSync(area, { recursive: true, force: true });
    }
  });
});
