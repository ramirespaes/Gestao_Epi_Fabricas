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
const { criarLeitorL2 } = require('../../src/services/backup-fontes-manifesto-l2.service');
const E = require('../../src/services/backup-fontes-cifra-envelope.service');
const D = require('../../src/services/backup-fontes-dr.service');
const { obterAdaptador } = require('../../src/services/backup-fontes-adaptadores.service');
const K = require('../helpers/p4b-caracterizacao');

/**
 * D-ORF-6, P12 — ENSAIO DE RECUPERAÇÃO DE DESASTRES com PostgreSQL 16 EFÊMERO (só na CI do GitHub Actions, marcador `GEPI_CI_EFEMERO` obrigatório; fora
 * dela o teste é PULADO). Fluxo real medido passo a passo pelo plano do P12: banco sintético → snapshot + pg_dump → pacote L2 selado (P5/P6) → CIFRA em envelope
 * (P11, chaves sintéticas separadas) → "desastre": só o CONTÊINER cifrado sobrevive (preparação e origem removidas) → DECIFRAR em diretório novo →
 * verificações 8.7 → pg_restore em banco NOVO → esquema IGUAL → arquivos por fonte → conciliação → veredito INTEGRO. Resultado esperado: RECUPERADO dentro
 * dos alvos sintéticos (RPO 24 h, RTO 10 min), com linha de evidência NDJSON. Contraprova: contêiner com um byte adulterado → ensaio FALHOU em DECIFRAR, sem
 * nada publicado. Nada aqui promove `recuperavelEmProducao`; dados 100% fictícios; limpeza no `finally`. Não é homologação (P9 exige AWS, outra decisão).
 */

const DIRETORIO_MIGRATIONS = path.join(__dirname, '..', '..', 'migrations');
const CANDIDATOS_BIN = ['/usr/lib/postgresql/16/bin', '/usr/bin'];
const PREFIXO_RESTAURADO = 'gepi_p12_rest_';
const PROTEGIDOS = [BANCO_DE_TESTE, 'postgres', 'template0', 'template1'];
const PRAZO_PROCESSO_MS = 120000;
const ALVOS = Object.freeze({ rpoMs: 24 * 3600 * 1000, rtoMs: 10 * 60 * 1000 });
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const agoraIso = () => new Date().toISOString();

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

describe('D-ORF-6 P12 — ensaio de DR: só o contêiner cifrado sobrevive; recuperação medida passo a passo (só na CI efêmera)', () => {
  test('decifrar → 8.7 → banco novo → esquema → arquivos → conciliação → veredito: RECUPERADO; contêiner adulterado: FALHOU em DECIFRAR', async (t) => {
    const motivo = K.motivoDeRecusaCi(process.env);
    if (motivo !== null) { t.skip(`P12_SO_EM_CI_EFEMERA: ${motivo}`); return; }
    const binarios = localizarBinarios();
    assert.ok(binarios !== null, 'PG_BINARIOS_16_INDISPONIVEIS');

    const configuracao = configuracaoDoBancoDeTeste();
    const nonce = crypto.randomBytes(6).toString('hex');
    const bancoRestaurado = `${PREFIXO_RESTAURADO}${nonce}`;
    const area = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'p12-'));
    fs.chmodSync(area, 0o700);
    const arquivoDeSenha = path.join(area, 'pgpass');
    fs.writeFileSync(arquivoDeSenha, `${configuracao.host}:${configuracao.port}:*:${configuracao.user}:${configuracao.password}\n`, { mode: 0o600 });
    const ambienteDoCliente = { PGPASSFILE: arquivoDeSenha, PGHOST: configuracao.host, PGPORT: String(configuracao.port), PGUSER: configuracao.user };
    const observacao = { ci: { run: process.env.GITHUB_RUN_ID, tentativa: process.env.GITHUB_RUN_ATTEMPT } };
    const fonteDeChaves = criarFonteDeChaves({ origem: 'TESTE_CONTROLADO', chaves: [{ id: 'mac-ci-p12', segredo: crypto.randomBytes(32) }] });
    const fonteDeCifra = E.criarFonteDeChavesDeCifra({ origem: 'TESTE_CONTROLADO', chaves: [{ id: 'kek-ci-p12', segredo: crypto.randomBytes(32) }] });
    const chaves = { cifra: { fonte: fonteDeCifra, chaveId: 'kek-ci-p12' }, mac: { fonte: fonteDeChaves, chaveId: 'mac-ci-p12' } };

    let admin = null;
    let contexto = null;
    let snapshot = null;
    let bancoCriado = false;
    try {
      // 0. instância efêmera comprovada
      admin = new Client(configuracao);
      await admin.connect();
      await confirmarBancoDeTeste(admin);
      const { rows: marcador } = await admin.query(K.SQL_MARCADOR_DO_BANCO);
      assert.ok(K.marcadorDoBancoConfere(marcador[0]?.marcador, K.marcadorEsperadoCi(process.env)), 'instância efêmera de CI não comprovada');

      // 1. banco sintético + 2 imagens padrão com arquivos reais
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
        imagens.push({ h, mestre });
      }

      // 2. backup: snapshot + planos + pg_dump + composição L2 selada
      snapshot = await clienteNoEsquema(configuracao, contexto.schema, true);
      const snapshotId = await exportarSnapshot(snapshot);
      const catalogo = obterCatalogo();
      const planejado = await CP.planejarNoSnapshot({ executor: snapshot, catalogo, fontes: ['imagens'], esquemaDasMigrations: contexto.schema });
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
      const ultimoBackupEm = agoraIso();
      const composicao = CP.criarComposicaoL2({ catalogo, fonteDeChaves, chaveId: 'mac-ci-p12', maxBytesPorArquivo: 1024 * 1024 });
      const composto = await composicao.compor({
        preparacao, planos: planejado.planos, origens: { imagens: origem }, banco: { nome: BANCO_DE_TESTE, oid: '1' }, conjuntoId: `conjunto-p12-${nonce}`,
        dump: { bytes: dump.length, sha256: sha(dump) }, contexto: {}, postgres: C.blocoN0('P12_SEM_SUMARIO'),
      });
      assert.equal(composto.ok, true, JSON.stringify(composto.falha));
      const sha256Manifesto = composto.identidade.sha256Manifesto;

      // 3. P11: cifra em envelope do pacote verificado; o contêiner é o ÚNICO artefato que sobrevive ao "desastre"
      const container = path.join(area, 'container');
      const cifrado = await E.cifrarPacote({ pacote: preparacao, lido: composto.escrito, destino: container, ...chaves });
      assert.equal(cifrado.ok, true, JSON.stringify(cifrado.falha));
      observacao.cifra = { arquivos: cifrado.arquivos, bytesEmClaro: cifrado.bytesEmClaro, sha256Envelope: cifrado.sha256Envelope };
      for (const f of fs.readdirSync(path.join(container, 'dados'), { recursive: true })) if (fs.statSync(path.join(container, 'dados', f)).isFile()) assert.ok(f.endsWith('.enc'), f);
      fs.rmSync(preparacao, { recursive: true, force: true });
      fs.rmSync(origemDir, { recursive: true, force: true });
      await contexto.encerrar();
      const esquemaOriginal = contexto.schema;
      contexto = null;

      // 4. ensaio de DR medido pelo plano do P12
      const plano = D.planejarEnsaioDeDR({ ultimoBackupEm, agora: agoraIso(), alvos: ALVOS });
      const passos = [];
      const medir = async (id, acao) => { const inicioEm = agoraIso(); let ok = false; let detalhe = null; try { detalhe = await acao(); ok = true; } finally { passos.push({ id, ok, inicioEm, fimEm: agoraIso() }); } return detalhe; };
      const pacote = path.join(area, 'decifrado');
      await medir('DECIFRAR', async () => { const d = await E.decifrarContainer({ container, destino: pacote, ...chaves }); assert.equal(d.ok, true, JSON.stringify(d.falha)); assert.equal(d.arquivos, cifrado.arquivos); });
      const lidoL2 = await medir('VERIFICACOES_8_7', async () => {
        const bytes = fs.readFileSync(path.join(pacote, 'manifesto.json'));
        const lido = criarLeitorL2({ fonteDeChaves, layoutMinimo: 2 })({ bytes, sha256: sha(bytes) });
        assert.equal(lido.identidade.sha256Manifesto, sha256Manifesto);
        const v = await CP.verificarPacoteL2({ pacote, lido });
        assert.equal(v.ok, true, JSON.stringify(v));
        return lido;
      });
      await medir('BANCO', async () => {
        await admin.query(`CREATE DATABASE ${bancoRestaurado}`);
        bancoCriado = true;
        const descritor = fs.openSync(path.join(pacote, 'dump', 'postgres.dump'), 'r');
        try {
          const restaurador = criarLancadorDeRestauracaoReal({ politicaDeDestino: { prefixoDoBanco: PREFIXO_RESTAURADO, hostsAutorizados: [configuracao.host], bancosProtegidos: PROTEGIDOS } });
          const processo = await restaurador.lancar({
            executavel: binarios.restore, argumentos: ['--exit-on-error', '--no-owner', '--no-privileges', '--single-transaction', `--dbname=${bancoRestaurado}`], ambiente: ambienteDoCliente,
            opcoes: { shell: false, detached: true, stdio: [descritor, 'ignore', 'ignore'] },
          });
          assert.deepEqual(await comPrazo(processo.saida, 'pg_restore'), { codigo: 0, sinal: null });
          await comPrazo(processo.fluxosFechados, 'pg_restore (fluxos)');
        } finally { fs.closeSync(descritor); }
      });
      const lerDoRestaurado = async () => {
        const cliente = await clienteNoEsquema({ ...configuracao, database: bancoRestaurado }, esquemaOriginal, true);
        try {
          const refs = await obterAdaptador('imagens', catalogo).planejar(cliente);
          const inv = await CP.planejarNoSnapshot({ executor: cliente, catalogo, fontes: [], esquemaDasMigrations: esquemaOriginal });
          return { referencias: refs.referencias, migrations: inv.inventario.migrations };
        } finally { await cliente.query('ROLLBACK').catch(() => {}); await cliente.end().catch(() => {}); }
      };
      const lido = await lerDoRestaurado();
      const esquema = await medir('ESQUEMA', async () => { const e = C.compatibilidadeDeEsquema({ migrationsDoBanco: lido.migrations, migrationsDoCodigo }); assert.equal(e.relacao, 'IGUAL'); return e; });
      const destino = path.join(area, 'restaurado');
      const r = await medir('ARQUIVOS_POR_FONTE', async () => {
        const x = await CP.restaurarL2({ pacote, destino, fonteDeChaves, layoutMinimo: 2, maxBytesPorArquivo: 1024 * 1024, referencias: { imagens: lido.referencias }, esquema, catalogo });
        assert.equal(x.ok, true, JSON.stringify(x));
        for (const { h, mestre } of imagens) assert.equal(sha(fs.readFileSync(path.join(destino, 'arquivos', 'imagens', 'padrao', h, 'mestre.png'))), sha(mestre));
        return x;
      });
      await medir('CONCILIACAO', async () => { assert.equal(r.fontes.imagens.conciliacao.referencias, 4); assert.equal(r.fontes.imagens.classe, 'INTEGRO'); });
      await medir('VEREDITO', async () => { assert.deepEqual(r.veredito, { classe: 'INTEGRO', motivos: [], recuperavelEmProducao: false, restauracaoReal: false }); });
      assert.equal(lidoL2.layout, 2);
      const resultado = D.avaliarEnsaioDeDR({ plano, passos, restauracao: r });
      const evidencia = D.linhaDeEvidencia(resultado, { conjuntoId: `conjunto-p12-${nonce}`, sha256Manifesto, ensaioEm: agoraIso(), ambiente: 'ENSAIO_CI' });
      observacao.ensaio = { classe: resultado.classe, rpoMedidoMs: resultado.rpoMedidoMs, rtoMedidoMs: resultado.rtoMedidoMs, passos: resultado.passos, motivos: resultado.motivos, sha256Evidencia: evidencia.sha256 };
      assert.equal(resultado.classe, 'RECUPERADO', JSON.stringify(resultado));
      assert.equal(resultado.recuperavelEmProducao, false);

      // 5. contraprova: um byte adulterado no contêiner => decifra recusa (tag GCM), nada publicado, ensaio FALHOU em DECIFRAR
      const adulterado = path.join(area, 'container-adulterado');
      fs.cpSync(container, adulterado, { recursive: true });
      const alvo = path.join(adulterado, 'dados', 'dump', 'postgres.dump.enc');
      const b = fs.readFileSync(alvo); b[Math.floor(b.length / 2)] ^= 0x01; fs.writeFileSync(alvo, b);
      const passos2 = [];
      const inicioEm = agoraIso();
      const d2 = await E.decifrarContainer({ container: adulterado, destino: path.join(area, 'decifrado-2'), ...chaves });
      passos2.push({ id: 'DECIFRAR', ok: d2.ok === true, inicioEm, fimEm: agoraIso() });
      const resultado2 = D.avaliarEnsaioDeDR({ plano, passos: passos2, restauracao: {} });
      observacao.contraprova = { falha: d2.falha, classe: resultado2.classe, falhouEm: resultado2.falhouEm };
      process.stdout.write(`P12_OBSERVACAO_JSON ${JSON.stringify(observacao)}\n`);
      assert.deepEqual(d2.falha, { passo: 'DECIFRA', codigo: 'ARQUIVO_ADULTERADO' });
      assert.ok(!fs.existsSync(path.join(area, 'decifrado-2', 'dump', 'postgres.dump')));
      assert.deepEqual([resultado2.classe, resultado2.falhouEm], ['FALHOU', 'DECIFRAR']);
    } finally {
      if (snapshot !== null) { await snapshot.query('ROLLBACK').catch(() => {}); await snapshot.end().catch(() => {}); }
      if (admin !== null && bancoCriado) await admin.query(`DROP DATABASE IF EXISTS ${bancoRestaurado} WITH (FORCE)`).catch((e) => process.stderr.write(`P12_LIMPEZA: banco restaurado não removido (${e.code ?? 'sem código'})\n`));
      if (admin !== null) await admin.end().catch(() => {});
      if (contexto !== null) await contexto.encerrar().catch(() => {});
      fs.rmSync(area, { recursive: true, force: true });
    }
  });
});
