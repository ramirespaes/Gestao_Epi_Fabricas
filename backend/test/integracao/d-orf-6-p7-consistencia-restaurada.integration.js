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
const { criarLancadorComSpawn } = require('../../src/services/imagem-backup-pgdump-lancador.service');
const { criarLancadorDeRestauracaoReal } = require('../../src/services/imagem-backup-restauracao-lancador.service');
const { criarFonteDeChaves } = require('../../src/services/imagem-backup-manifesto-autenticado.service');
const { criarArmazenamentoImagens } = require('../../src/storage/armazenamento-imagens');
const { obterCatalogo } = require('../../src/services/backup-fontes-catalogo.service');
const C = require('../../src/services/backup-fontes-postgres-cobertura.service');
const CP = require('../../src/services/backup-fontes-composicao-l2.service');
const { obterAdaptador } = require('../../src/services/backup-fontes-adaptadores.service');
const K = require('../helpers/p4b-caracterizacao');

/**
 * D-ORF-6, P7 — CONSISTÊNCIA CRUZADA comprovada com PostgreSQL 16 EFÊMERO (só na CI do GitHub Actions, marcador `GEPI_CI_EFEMERO` obrigatório; fora dela o
 * teste é PULADO). Fluxo real: banco sintético (schema temporário + migrations + 2 imagens padrão) → snapshot REPEATABLE READ READ ONLY com planos por fonte e
 * inventário (P6) → pg_dump no mesmo snapshot (lançador histórico) → pacote layout 2 composto e selado (P5/P6) → pg_restore num banco NOVO da mesma instância →
 * referências lidas do banco RESTAURADO → `restaurarL2` (ordem 11.4) com conciliação (P7): INTEGRO. Depois, uma linha a mais no banco restaurado (F2: linha sem
 * arquivo) tem de produzir INCOMPLETO com a divergência nomeada. Nada aqui promove `recuperavelEmProducao`. Dados 100% fictícios; limpeza no `finally`.
 */

const DIRETORIO_MIGRATIONS = path.join(__dirname, '..', '..', 'migrations');
const CANDIDATOS_BIN = ['/usr/lib/postgresql/16/bin', '/usr/bin'];
const PREFIXO_RESTAURADO = 'gepi_p7_rest_';
const PROTEGIDOS = [BANCO_DE_TESTE, 'postgres', 'template0', 'template1'];
const PRAZO_PROCESSO_MS = 120000;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

function localizarBinarios() {
  for (const dir of CANDIDATOS_BIN) {
    const dump = path.join(dir, 'pg_dump');
    const restore = path.join(dir, 'pg_restore');
    if (!fs.existsSync(dump) || !fs.existsSync(restore)) continue;
    let versao;
    try { versao = cp.execFileSync(dump, ['--version'], { env: {}, timeout: 10000, encoding: 'utf8' }); } catch { continue; }
    if (/^pg_dump \(PostgreSQL\) 16\./.test(versao)) return { dump, restore, versao: versao.trim() };
  }
  return null;
}
const comPrazo = (promessa, rotulo) => Promise.race([promessa, new Promise((_, rej) => setTimeout(() => rej(new Error(`prazo esgotado: ${rotulo}`)), PRAZO_PROCESSO_MS).unref())]);

async function clienteNoEsquema(configuracao, esquema, somenteLeitura) {
  const cliente = new Client(configuracao);
  await cliente.connect();
  if (somenteLeitura) await cliente.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await cliente.query(`SET ${somenteLeitura ? 'LOCAL ' : ''}search_path TO ${esquema}`);
  return cliente;
}

describe('D-ORF-6 P7 — consistência banco restaurado × arquivos restaurados (só na CI efêmera)', () => {
  test('pacote L2 composto no snapshot, banco restaurado em banco novo, conciliação INTEGRO; linha a mais no banco restaurado => INCOMPLETO (F2)', async (t) => {
    const motivo = K.motivoDeRecusaCi(process.env);
    if (motivo !== null) { t.skip(`P7_SO_EM_CI_EFEMERA: ${motivo}`); return; }
    const binarios = localizarBinarios();
    assert.ok(binarios !== null, 'PG_BINARIOS_16_INDISPONIVEIS');

    const configuracao = configuracaoDoBancoDeTeste();
    const nonce = crypto.randomBytes(6).toString('hex');
    const bancoRestaurado = `${PREFIXO_RESTAURADO}${nonce}`;
    const area = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'p7-'));
    fs.chmodSync(area, 0o700);
    const arquivoDeSenha = path.join(area, 'pgpass');
    fs.writeFileSync(arquivoDeSenha, `${configuracao.host}:${configuracao.port}:*:${configuracao.user}:${configuracao.password}\n`, { mode: 0o600 });
    const ambienteDoCliente = { PGPASSFILE: arquivoDeSenha, PGHOST: configuracao.host, PGPORT: String(configuracao.port), PGUSER: configuracao.user };
    const observacao = { ci: { run: process.env.GITHUB_RUN_ID, tentativa: process.env.GITHUB_RUN_ATTEMPT } };

    let admin = null;
    let contexto = null;
    let snapshot = null;
    let bancoCriado = false;
    const clientes = [];
    try {
      // 0. instância efêmera comprovada
      admin = new Client(configuracao);
      await admin.connect();
      await confirmarBancoDeTeste(admin);
      const { rows: marcador } = await admin.query(K.SQL_MARCADOR_DO_BANCO);
      assert.ok(K.marcadorDoBancoConfere(marcador[0]?.marcador, K.marcadorEsperadoCi(process.env)), 'instância efêmera de CI não comprovada');

      // 1. banco sintético: schema temporário + migrations + 2 imagens padrão com arquivos reais na origem
      contexto = await abrirSchemaTemporario([]);
      await aplicarMigrations({ schema: contexto.schema, diretorio: DIRETORIO_MIGRATIONS });
      const migrationsDoCodigo = listarMigrations(DIRETORIO_MIGRATIONS).map((m) => m.nome.replace(/\.sql$/, ''));
      const origemDir = path.join(area, 'imagens');
      fs.mkdirSync(origemDir, { mode: 0o700 });
      const origem = criarArmazenamentoImagens({ diretorio: origemDir });
      const imagens = [];
      for (const n of [1, 2]) {
        const mestre = Buffer.from(`png-ficticio-${n}-${nonce}`);
        const mini = Buffer.from(`webp-mini-${n}-${nonce}`);
        const h = sha(mestre);
        await origem.gravar(`padrao/${h}/mestre.png`, mestre, { maxBytes: 1024 });
        await origem.gravar(`padrao/${h}/miniatura.webp`, mini, { maxBytes: 1024 });
        await contexto.cliente.query(
          'INSERT INTO imagens_padrao (nome, arquivo_origem, sha256, sha256_miniatura, formato, largura, altura, bytes_mestre, bytes_miniatura) VALUES ($1, $2, $3, $4, $5, 256, 256, $6, $7)',
          [`Imagem ${n}`, `imagem-${n}.png`, h, sha(mini), 'PNG', mestre.length, mini.length],
        );
        imagens.push({ h, mestre, mini });
      }

      // 2. snapshot único: planos por fonte + inventário no MESMO cliente/transação (P6/P7 11.3)
      snapshot = await clienteNoEsquema(configuracao, contexto.schema, true);
      clientes.push(snapshot);
      const snapshotId = await exportarSnapshot(snapshot);
      const catalogo = obterCatalogo();
      const planejado = await CP.planejarNoSnapshot({ executor: snapshot, catalogo, fontes: ['imagens'], esquemaDasMigrations: contexto.schema });
      assert.equal(planejado.planos.imagens.plano.length, 4);
      assert.deepEqual([...planejado.inventario.migrations], migrationsDoCodigo);

      // 3. pg_dump no mesmo snapshot (lançador histórico), incorporado à preparação
      const preparacao = path.join(area, 'prep');
      fs.mkdirSync(preparacao, { mode: 0o700 });
      fs.mkdirSync(path.join(preparacao, 'dump'), { mode: 0o700 });
      const caminhoDoDump = path.join(preparacao, 'dump', 'postgres.dump');
      const descritorDoDump = fs.openSync(caminhoDoDump, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
      try {
        const processo = await criarLancadorComSpawn({ spawn: cp.spawn }).lancar({
          executavel: binarios.dump, argumentos: ['--format=custom', '--no-password', `--snapshot=${snapshotId}`, `--dbname=${BANCO_DE_TESTE}`], ambiente: ambienteDoCliente,
          opcoes: { shell: false, detached: true, stdio: ['ignore', descritorDoDump, 'ignore'] },
        });
        assert.deepEqual(await comPrazo(processo.saida, 'pg_dump'), { codigo: 0, sinal: null });
        await comPrazo(processo.fluxosFechados, 'pg_dump (fluxos)');
      } finally { fs.closeSync(descritorDoDump); }
      await snapshot.query('ROLLBACK');
      await snapshot.end();
      snapshot = null;
      const dump = fs.readFileSync(caminhoDoDump);
      observacao.dump = { bytes: dump.length, sha256: sha(dump) };

      // 4. composição L2 (P5/P6) na preparação; bloco postgres N0 (sem sumário nesta prova: o foco é P7)
      const fonteDeChaves = criarFonteDeChaves({ origem: 'TESTE_CONTROLADO', chaves: [{ id: 'chave-ci-p7', segredo: crypto.randomBytes(32) }] });
      const composicao = CP.criarComposicaoL2({ catalogo, fonteDeChaves, chaveId: 'chave-ci-p7', maxBytesPorArquivo: 1024 * 1024 });
      const composto = await composicao.compor({
        preparacao, planos: planejado.planos, origens: { imagens: origem }, banco: { nome: BANCO_DE_TESTE, oid: '1' }, conjuntoId: `conjunto-p7-${nonce}`,
        dump: { bytes: dump.length, sha256: sha(dump) }, contexto: {}, postgres: C.blocoN0('P7_SEM_SUMARIO'),
      });
      assert.equal(composto.ok, true, JSON.stringify(composto.falha));
      observacao.composicao = composto.fontes;

      // 5. pg_restore no banco NOVO da mesma instância efêmera (lançador de restauração, política de destino própria)
      await admin.query(`CREATE DATABASE ${bancoRestaurado}`);
      bancoCriado = true;
      const descritorParaRestaurar = fs.openSync(caminhoDoDump, 'r');
      try {
        const restaurador = criarLancadorDeRestauracaoReal({ politicaDeDestino: { prefixoDoBanco: PREFIXO_RESTAURADO, hostsAutorizados: [configuracao.host], bancosProtegidos: PROTEGIDOS } });
        const processo = await restaurador.lancar({
          executavel: binarios.restore, argumentos: ['--exit-on-error', '--no-owner', '--no-privileges', '--single-transaction', `--dbname=${bancoRestaurado}`], ambiente: ambienteDoCliente,
          opcoes: { shell: false, detached: true, stdio: [descritorParaRestaurar, 'ignore', 'ignore'] },
        });
        assert.deepEqual(await comPrazo(processo.saida, 'pg_restore'), { codigo: 0, sinal: null });
        await comPrazo(processo.fluxosFechados, 'pg_restore (fluxos)');
      } finally { fs.closeSync(descritorParaRestaurar); }

      // 6. referências e esquema lidos do banco RESTAURADO (somente leitura)
      const lerDoRestaurado = async () => {
        const cliente = await clienteNoEsquema({ ...configuracao, database: bancoRestaurado }, contexto.schema, true);
        try {
          const refs = await obterAdaptador('imagens', catalogo).planejar(cliente);
          const inv = await CP.planejarNoSnapshot({ executor: cliente, catalogo, fontes: [], esquemaDasMigrations: contexto.schema });
          return { referencias: refs.referencias, migrations: inv.inventario.migrations };
        } finally { await cliente.query('ROLLBACK').catch(() => {}); await cliente.end().catch(() => {}); }
      };
      const lido = await lerDoRestaurado();
      const esquema = C.compatibilidadeDeEsquema({ migrationsDoBanco: lido.migrations, migrationsDoCodigo });
      assert.equal(esquema.relacao, 'IGUAL');

      // 7. restauração por fonte (11.4) + conciliação (P7): INTEGRO
      const destino = path.join(area, 'restaurado');
      const r = await CP.restaurarL2({ pacote: preparacao, destino, fonteDeChaves, layoutMinimo: 2, maxBytesPorArquivo: 1024 * 1024, referencias: { imagens: lido.referencias }, esquema, catalogo });
      observacao.restauracao = { ok: r.ok, veredito: r.veredito, ordem: r.ordem, imagens: r.fontes.imagens };
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.deepEqual(r.veredito, { classe: 'INTEGRO', motivos: [], recuperavelEmProducao: false, restauracaoReal: false });
      assert.equal(r.fontes.imagens.conciliacao.referencias, 4);
      for (const { h, mestre } of imagens) assert.equal(sha(fs.readFileSync(path.join(destino, 'arquivos', 'imagens', 'padrao', h, 'mestre.png'))), sha(mestre));

      // 8. F2 no banco restaurado (linha sem arquivo): a conciliação acusa ARQUIVO_AUSENTE/F2 e o veredito é INCOMPLETO
      const escritor = await clienteNoEsquema({ ...configuracao, database: bancoRestaurado }, contexto.schema, false);
      clientes.push(escritor);
      const fantasma = sha(Buffer.from(`fantasma-${nonce}`));
      await escritor.query('INSERT INTO imagens_padrao (nome, arquivo_origem, sha256, sha256_miniatura, formato, largura, altura, bytes_mestre, bytes_miniatura) VALUES ($1, $2, $3, $4, $5, 256, 256, 1, 1)', ['Fantasma', 'fantasma.png', fantasma, sha(Buffer.from('m')), 'PNG']);
      await escritor.end();
      clientes.pop();
      const lido2 = await lerDoRestaurado();
      const r2 = await CP.restaurarL2({ pacote: preparacao, destino: path.join(area, 'restaurado-2'), fonteDeChaves, layoutMinimo: 2, maxBytesPorArquivo: 1024 * 1024, referencias: { imagens: lido2.referencias }, esquema, catalogo });
      observacao.f2 = { ok: r2.ok, classe: r2.veredito.classe, divergencias: r2.fontes.imagens.conciliacao.divergencias.map((d) => [d.codigo, d.falha]) };
      process.stdout.write(`P7_OBSERVACAO_JSON ${JSON.stringify(observacao)}\n`);
      assert.equal(r2.ok, false);
      assert.equal(r2.veredito.classe, 'INCOMPLETO');
      assert.deepEqual(r2.fontes.imagens.conciliacao.divergencias.map((d) => [d.codigo, d.falha]), [['ARQUIVO_AUSENTE', 'F2'], ['ARQUIVO_AUSENTE', 'F2']]);
      assert.equal(r2.recuperavelEmProducao, false);
    } finally {
      if (snapshot !== null) { await snapshot.query('ROLLBACK').catch(() => {}); await snapshot.end().catch(() => {}); }
      for (const c of clientes) await c.end().catch(() => {});
      if (admin !== null && bancoCriado) await admin.query(`DROP DATABASE IF EXISTS ${bancoRestaurado} WITH (FORCE)`).catch((e) => process.stderr.write(`P7_LIMPEZA: banco restaurado não removido (${e.code ?? 'sem código'})\n`));
      if (admin !== null) await admin.end().catch(() => {});
      if (contexto !== null) await contexto.encerrar().catch(() => {});
      fs.rmSync(area, { recursive: true, force: true });
    }
  });
});
