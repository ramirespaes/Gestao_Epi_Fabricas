'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

const { configuracaoDoBancoDeTeste, confirmarBancoDeTeste } = require('./helpers/banco-de-teste');
const { localizarBinarios, semearImagensSinteticas } = require('./helpers/backup-ensaio-fixtures');
const H = require('./helpers/backup-ensaio-instancia-local');
const { listarMigrations } = require('../../src/db/checksums');
const { criarBackupDeProducao, criarRestauracaoDeProducao, classificarEstadoDoBackup } = require('../../src/services/imagem-backup-composicao-producao.service');
const { criarFonteDeChaves } = require('../../src/services/imagem-backup-manifesto-autenticado.service');
const { criarArmazenamentoImagens } = require('../../src/storage/armazenamento-imagens');
const { criarLeitorDePacote } = require('../../src/services/backup-executor-leitor-pacote.service');
const { verificarPacoteL2 } = require('../../src/services/backup-fontes-composicao-l2.service');
const E = require('../../src/services/backup-fontes-cifra-envelope.service');
const D = require('../../src/services/backup-fontes-dr.service');

/**
 * D-ORF-6, C-1 [C1-DR]: ensaio de integração B-1 → pacote L2 → cifra P11 → perda da origem → decifra → restauração P12, em PostgreSQL 16 efêmero local, dados sintéticos e fonte de chaves
 * `TESTE_CONTROLADO` (as listas de provedores de produção NÃO são tocadas). O backup é feito pela composição real de produção com o PAPEL mínimo B-1 (modelo SQL do repositório + concessões
 * de leitura), o pacote publicado é lido pelo leitor de produção e cifrado em envelope; depois só o contêiner sobrevive (pacote, preparação, dump e imagens da origem removidos e o banco de
 * origem apagado), é decifrado em diretório novo e restaurado em banco NOVO pela composição de restauração. Contraprova: um byte adulterado no contêiner recusa a decifra.
 * Só roda com SWB_PGDATA (instância efêmera declarada) e SWB_C1=1; sem eles é ignorado com motivo, e nunca depende de GEPI_CI_EFEMERO. O RTO é medido sobre a restauração COMPOSTA
 * (decifra → verificações → banco → arquivos → conciliação), sem o detalhe por passo do ensaio de CI (P12). Nada aqui promove `recuperavelEmProducao`.
 */

const DIRETORIO_MIGRATIONS = path.join(__dirname, '..', '..', 'migrations');
const BACKEND = path.join(__dirname, '..', '..');
const ALVOS = Object.freeze({ rpoMs: 24 * 3600 * 1000, rtoMs: 10 * 60 * 1000 });
const SEGREDOS = Object.freeze({ mac: crypto.randomBytes(32), kek: crypto.randomBytes(32) });
const FILHO = [
  "const { Client } = require('pg');",
  "const { aplicarMigrations } = require('./scripts/migrate');",
  '(async () => {',
  '  const e = process.env;',
  '  const instancia = /^\\/private\\/tmp\\/swb-[0-9]{14}-[0-9]{1,5}\\/pgdata$/;',
  "  if (!/^gepi_c1_origem_[0-9a-f]{12}$/.test(e.C1_NOME) || e.DB_NAME !== e.C1_NOME) throw new Error('C1_FILHO_BANCO_RECUSADO');",
  "  if (!instancia.test(e.C1_PGDATA) || e.DB_HOST !== e.C1_PGDATA.replace(/pgdata$/, 'sock') || e.DB_PORT !== e.C1_PORTA) throw new Error('C1_FILHO_INSTANCIA_RECUSADA');",
  '  const c = new Client({ host: e.DB_HOST, port: Number(e.DB_PORT), database: e.DB_NAME, user: e.DB_USER });',
  '  await c.connect();',
  "  const { rows: [r] } = await c.query(\"SELECT current_database() AS d, current_setting('data_directory') AS p, current_setting('port') AS t, current_setting('listen_addresses') AS l, (SELECT count(*)::int FROM pg_class k JOIN pg_namespace s ON s.oid = k.relnamespace WHERE s.nspname = 'public') AS n\");",
  '  await c.end();',
  "  if (r.d !== e.C1_NOME || r.p !== e.C1_PGDATA || r.t !== e.C1_PORTA || r.l !== '' || r.n !== 0) throw new Error('C1_FILHO_IDENTIDADE_RECUSADA');",
  "  const feitas = await aplicarMigrations({ schema: 'public', diretorio: e.C1_DIRETORIO });",
  "  process.stdout.write('C1_MIGRATIONS ' + feitas.length + '\\n');",
  "})().catch((x) => { process.stderr.write(String(x && x.message ? x.message : x) + '\\n'); process.exit(1); });",
].join('\n');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const agora = () => new Date().toISOString();
const ordenados = (lista) => [...lista].sort((a, b) => a.localeCompare(b));
const observar = (fase, dados) => process.stdout.write(`C1_OBSERVACAO_JSON ${JSON.stringify({ fase, ...dados })}\n`);

const SO_NA_INSTANCIA_EFEMERA_LOCAL = process.env.SWB_PGDATA === undefined
  ? 'C1_SO_NA_INSTANCIA_EFEMERA_LOCAL: SWB_PGDATA ausente; esta suíte só roda na instância efêmera local declarada por SWB_PGDATA'
  : (process.env.SWB_C1 !== '1' ? 'C1_NAO_AUTORIZADO: SWB_C1=1 ausente; o ensaio exige autorização própria' : false);

describe('[C-1] B-1 → pacote L2 → cifra P11 → recuperação P12 (instância efêmera exclusiva, só TESTE_CONTROLADO)', { skip: SO_NA_INSTANCIA_EFEMERA_LOCAL }, () => {
  const base = SO_NA_INSTANCIA_EFEMERA_LOCAL === false ? { ...configuracaoDoBancoDeTeste(), connectionTimeoutMillis: 8000 } : null;
  const criados = new Set();
  const abertos = [];
  const imagens = [];
  const medidas = {};
  let admin = null;
  let ctx = null;
  let papeisAntes = [];

  const baseDe = (banco, usuario = base.user) => ({ ...base, database: banco, user: usuario, password: undefined });
  const novoCliente = (banco, usuario) => { const c = new Client(baseDe(banco, usuario)); abertos.push(c); return c; };
  const bancosDaInstancia = async () => (await admin.query('SELECT datname FROM pg_database ORDER BY 1')).rows.map((r) => r.datname);
  async function noBanco(banco, fn) {
    const c = new Client(baseDe(banco));
    await c.connect();
    try { return await fn(c); } finally { await c.end().catch(() => {}); }
  }
  async function criarBancoNovo(tipo) {
    const nome = H.novoNomeDeBanco(tipo);
    assert.equal((await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [nome])).rowCount, 0, 'banco já existe: nunca reutilizar');
    await admin.query(`CREATE DATABASE ${nome} OWNER ${base.user} TEMPLATE template0`);
    criados.add(nome);
    return nome;
  }
  const arquivosDe = (raiz) => fs.readdirSync(raiz, { recursive: true }).filter((rel) => fs.statSync(path.join(raiz, rel)).isFile()).sort((a, b) => a.localeCompare(b));
  const lerPacote = (raiz, nome) => criarLeitorDePacote({ fonteDeChaves: ctx.fonteDeChaves, raizPublicados: raiz }).lerPacote({ dir: path.join(raiz, nome), nome });
  const decifrar = (container, destino) => E.decifrarContainer({ container, destino, ...ctx.chaves });

  before(async () => {
    const motivo = H.motivoDeRecusaDoAmbiente(process.env);
    assert.equal(motivo, null, `ambiente recusado: ${motivo}`);
    const { SWB_PGDATA, SWB_PORT, DB_HOST, DB_USER } = process.env;
    const binarios = localizarBinarios(process.env);

    admin = new Client(base);
    await admin.connect();
    await confirmarBancoDeTeste(admin);
    const mostrar = async (p) => (await admin.query(`SHOW ${p}`)).rows[0][p];
    for (const [parametro, valor] of Object.entries({ data_directory: SWB_PGDATA, port: SWB_PORT, listen_addresses: '' })) assert.equal(await mostrar(parametro), valor, `${parametro} difere da instância autorizada`);
    assert.ok((await mostrar('unix_socket_directories')).split(',').map((s) => s.trim()).includes(DB_HOST), 'DB_HOST não é o socket da instância');
    assert.match(await mostrar('server_version'), /^16\./);
    assert.deepEqual(await bancosDaInstancia(), ordenados(H.BANCOS_BASE), 'a instância tem bancos além dos quatro de base');
    papeisAntes = (await admin.query('SELECT rolname FROM pg_roles ORDER BY rolname')).rows.map((r) => r.rolname);
    assert.ok(!papeisAntes.includes(H.PAPEL_B1), `o papel ${H.PAPEL_B1} já existe na instância: o ensaio não o toca`);

    const area = path.join(path.dirname(SWB_PGDATA), `c1dr-${crypto.randomBytes(6).toString('hex')}`);
    fs.mkdirSync(area, { mode: 0o700 });
    assert.equal(fs.realpathSync(area), area);
    const dirs = {};
    for (const d of ['imagens', 'preparacoes', 'dumps', 'publicados', 'seg', 'restauradoImagens', 'decifrado']) { dirs[d] = path.join(area, d); fs.mkdirSync(dirs[d], { mode: 0o700 }); }
    const arquivoDeSenha = path.join(dirs.seg, 'pgpass');
    fs.writeFileSync(arquivoDeSenha, [DB_USER, H.PAPEL_B1].flatMap((u) => [DB_HOST, 'localhost'].map((h) => `${h}:${SWB_PORT}:*:${u}:ficticia\n`)).join(''), { mode: 0o600 });

    const nomeOrigem = await criarBancoNovo('origem');
    const nomeRestaurado = await criarBancoNovo('restaurado');
    const oidOrigem = (await admin.query('SELECT oid::text AS oid FROM pg_database WHERE datname = $1', [nomeOrigem])).rows[0].oid;
    const fonteDeChaves = criarFonteDeChaves({ origem: 'TESTE_CONTROLADO', chaves: [{ id: 'mac-c1', segredo: SEGREDOS.mac }] });
    const fonteDeCifra = E.criarFonteDeChavesDeCifra({ origem: 'TESTE_CONTROLADO', chaves: [{ id: 'kek-c1', segredo: SEGREDOS.kek }] });
    ctx = {
      area, dirs, arquivoDeSenha, binarios, host: DB_HOST, porta: Number(SWB_PORT), usuario: DB_USER, nomeOrigem, oidOrigem, nomeRestaurado, raizDecifrada: dirs.decifrado,
      nomeDoPacote: `prep-c1-${crypto.randomBytes(4).toString('hex')}`, conjuntoId: `conjunto-c1-${crypto.randomBytes(4).toString('hex')}`, container: path.join(area, 'container'),
      fonteDeChaves, chaveId: 'mac-c1', chaves: { cifra: { fonte: fonteDeCifra, chaveId: 'kek-c1' }, mac: { fonte: fonteDeChaves, chaveId: 'mac-c1' } },
    };

    const saida = cp.execFileSync(process.execPath, ['-e', FILHO], {
      cwd: BACKEND, encoding: 'utf8', timeout: 240000,
      env: { PATH: process.env.PATH, NODE_ENV: 'test', DB_HOST, DB_PORT: SWB_PORT, DB_NAME: nomeOrigem, DB_USER, ...(process.env.DB_PASSWORD === undefined ? {} : { DB_PASSWORD: process.env.DB_PASSWORD }), C1_NOME: nomeOrigem, C1_PGDATA: SWB_PGDATA, C1_PORTA: SWB_PORT, C1_DIRETORIO: DIRETORIO_MIGRATIONS },
    });
    assert.equal(saida.trim().split('\n').pop(), `C1_MIGRATIONS ${listarMigrations(DIRETORIO_MIGRATIONS).length}`);
    const origem = criarArmazenamentoImagens({ diretorio: dirs.imagens });
    await noBanco(nomeOrigem, async (c) => { imagens.push(...await semearImagensSinteticas({ armazenamento: origem, cliente: c, nomeOrigem })); });
  }, { timeout: 420000 });

  after(async () => {
    const falhas = [];
    try {
      for (const c of abertos) await c.end().catch(() => {});
      if (admin !== null) {
        for (const nome of criados) {
          if (!H.nomeDeBancoValido(nome)) { falhas.push(`nome fora do padrão não removido: ${nome}`); continue; }
          await admin.query(`DROP DATABASE IF EXISTS ${nome} WITH (FORCE)`).catch((e) => falhas.push(`banco não removido (${e.code ?? 'sem código'})`));
        }
        await admin.query(`DROP ROLE IF EXISTS ${H.PAPEL_B1}`).catch((e) => falhas.push(`papel não removido (${e.code ?? 'sem código'})`));
        const depois = (await admin.query('SELECT rolname FROM pg_roles ORDER BY rolname').catch(() => ({ rows: [] }))).rows.map((r) => r.rolname);
        if (JSON.stringify(depois) !== JSON.stringify(papeisAntes)) falhas.push('a lista de papéis mudou depois da limpeza');
        if ((await bancosDaInstancia().catch(() => [])).some((n) => n.startsWith('gepi_c1_'))) falhas.push('bancos gepi_c1_ restantes');
      }
    } finally {
      if (admin !== null) await admin.end().catch(() => {});
      if (ctx !== null && ctx.area.startsWith(`${path.dirname(process.env.SWB_PGDATA)}/c1dr-`)) fs.rmSync(ctx.area, { recursive: true, force: true });
      if (falhas.length > 0) process.stderr.write(`C1_LIMPEZA: ${falhas.join('; ')}\n`);
    }
    assert.deepEqual(falhas, [], 'limpeza do ensaio incompleta');
  });

  test('C1-01 — isolamento e papel B-1: instância exclusiva, origem com migrations e 2 imagens, papel criado pelo modelo SQL, sem leitura antes e zero objetos sem SELECT depois das concessões', async () => {
    assert.deepEqual((await bancosDaInstancia()).filter((n) => !H.BANCOS_BASE.includes(n)), ordenados([ctx.nomeOrigem, ctx.nomeRestaurado]));
    assert.equal(await noBanco(ctx.nomeRestaurado, async (c) => (await c.query("SELECT count(*)::int AS n FROM pg_class r JOIN pg_namespace s ON s.oid = r.relnamespace WHERE s.nspname = 'public'")).rows[0].n), 0, 'o banco de restauração nasce vazio');
    assert.equal(imagens.length, 2);
    const { antes, depois, atributos } = await noBanco(ctx.nomeOrigem, async (c) => {
      assert.equal((await c.query('SELECT count(*)::int AS n FROM imagens_padrao')).rows[0].n, 2);
      for (const comando of H.comandosDoModelo(fs.readFileSync(path.join(BACKEND, 'ops', 'sql', 'papel-executor-backup.sql.modelo'), 'utf8'), ctx.nomeOrigem)) await c.query(comando);
      await c.query(`ALTER ROLE ${H.PAPEL_B1} CONNECTION LIMIT 6`);
      const semLeitura = async () => (await c.query(H.VERIFICACAO_B1)).rows;
      const sem = await semLeitura();
      for (const sql of H.GRANTS_B1) await c.query(sql);
      const attrs = (await c.query('SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = $1', [H.PAPEL_B1])).rows[0];
      return { antes: sem.length, depois: await semLeitura(), atributos: attrs };
    });
    assert.ok(antes > 0, 'antes da concessão a verificação precisa listar objetos');
    assert.deepEqual(depois, []);
    assert.deepEqual({ ...atributos }, { rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false, rolcanlogin: true });
    observar('isolamento-e-papel', { versao: (await admin.query('SHOW server_version')).rows[0].server_version, migrations: listarMigrations(DIRETORIO_MIGRATIONS).length, objetosSemSelectAntes: antes, objetosSemSelectDepois: depois.length, papel: H.PAPEL_B1 });
  });

  test('C1-02 — backup real pelo PAPEL B-1 (composição de produção): pacote L2 layout 2 publicado como NÃO operacional, hash do dump provado', async () => {
    const config = H.montarConfigDoBackup({ ...ctx, criarConexao: () => novoCliente(ctx.nomeOrigem, H.PAPEL_B1) });
    assert.equal(config.postgres.usuario, H.PAPEL_B1);
    const composto = await criarBackupDeProducao(config).executar({ nomeDaPreparacao: ctx.nomeDoPacote, conjuntoId: ctx.conjuntoId });
    const { composicao, pacote, publicacao } = composto.resultado;
    const { pacotePublicado, publicacaoOperacional, recuperabilidadeComprovada } = classificarEstadoDoBackup(composto);
    assert.deepEqual([composicao?.ok, composicao?.layout, pacote?.ok, pacotePublicado], [true, 2, true, true], JSON.stringify({ composicao, pacote, publicacao }));
    assert.deepEqual([publicacaoOperacional, recuperabilidadeComprovada, composto.proveniencia.hashDoDump.correspondem], [false, false, true]);
    assert.deepEqual({ ...composto.proveniencia.chaves }, { origem: 'TESTE_CONTROLADO', chaveId: ctx.chaveId });
    const dump = fs.readFileSync(path.join(ctx.dirs.publicados, ctx.nomeDoPacote, 'dump', 'postgres.dump'));
    assert.equal(sha(dump), composto.proveniencia.hashDoDump.SHA256_ARQUIVO_PERSISTIDO);
    for (const c of abertos.splice(0)) await c.end().catch(() => {});
    Object.assign(medidas, { dump: { bytes: dump.length, sha256: sha(dump) }, ultimoBackupEm: agora() });
    observar('backup-pelo-papel', { usuarioDoDump: config.postgres.usuario, dump: medidas.dump, banco: ctx.nomeOrigem });
  });

  test('C1-03 — cifra P11: o leitor de produção lê o pacote publicado, cifrarPacote aceita e todo arquivo do contêiner é .enc, sem texto claro nem chave dentro', async () => {
    const lido = await lerPacote(ctx.dirs.publicados, ctx.nomeDoPacote);
    medidas.sha256Manifesto = lido.identidade.sha256Manifesto;
    const esperados = lido.fontes.reduce((n, f) => n + f.arquivos.length, 0) + 3;
    const cifrado = await E.cifrarPacote({ pacote: path.join(ctx.dirs.publicados, ctx.nomeDoPacote), lido, destino: ctx.container, cifra: ctx.chaves.cifra, mac: ctx.chaves.mac });
    assert.equal(cifrado.ok, true, JSON.stringify(cifrado.falha));
    assert.equal(cifrado.arquivos, esperados);
    const cifrados = arquivosDe(path.join(ctx.container, 'dados'));
    assert.equal(cifrados.length, esperados);
    const sentinelas = [Buffer.from('PGDMP'), Buffer.from(ctx.conjuntoId), Buffer.from(ctx.nomeOrigem), ...imagens.map((i) => i.mestre), SEGREDOS.mac, SEGREDOS.kek, Buffer.from(SEGREDOS.mac.toString('hex')), Buffer.from(SEGREDOS.kek.toString('hex'))];
    for (const rel of cifrados) assert.ok(rel.endsWith('.enc'), rel);
    for (const rel of [...cifrados.map((r) => path.join('dados', r)), 'envelope.json']) {
      const bytes = fs.readFileSync(path.join(ctx.container, rel));
      for (const s of sentinelas) assert.ok(!bytes.includes(s), `conteúdo em claro ou chave em ${rel}`);
    }
    medidas.cifrado = { arquivos: cifrado.arquivos, bytesEmClaro: cifrado.bytesEmClaro, sha256Envelope: cifrado.sha256Envelope };
    observar('cifra', { ...medidas.cifrado, sha256Manifesto: medidas.sha256Manifesto });
  });

  test('C1-04 — perda simulada da origem: pacote, preparação, dumps e imagens removidos e o banco de origem apagado; só o contêiner cifrado sobrevive', async () => {
    for (const d of [ctx.dirs.publicados, ctx.dirs.preparacoes, ctx.dirs.dumps]) for (const nome of fs.readdirSync(d)) fs.rmSync(path.join(d, nome), { recursive: true });
    fs.rmSync(ctx.dirs.imagens, { recursive: true });
    await admin.query(`DROP DATABASE ${ctx.nomeOrigem} WITH (FORCE)`);
    for (const d of [ctx.dirs.publicados, ctx.dirs.preparacoes, ctx.dirs.dumps]) assert.deepEqual(fs.readdirSync(d), [], d);
    assert.equal(fs.existsSync(ctx.dirs.imagens), false);
    assert.deepEqual(await bancosDaInstancia(), ordenados([...H.BANCOS_BASE, ctx.nomeRestaurado]));
    assert.equal(fs.statSync(path.join(ctx.container, 'envelope.json')).isFile(), true);
    observar('perda-da-origem', { bancos: (await bancosDaInstancia()).length, arquivosDoContainer: arquivosDe(ctx.container).length });
  });

  test('C1-05 — decifra e verificações 8.7: contêiner decifrado em diretório novo; manifesto e dump idênticos aos do backup original', async () => {
    const destino = path.join(ctx.raizDecifrada, ctx.nomeDoPacote);
    medidas.inicioEm = agora();
    const inicio = Date.now();
    const d = await decifrar(ctx.container, destino);
    assert.equal(d.ok, true, JSON.stringify(d.falha));
    assert.equal(d.arquivos, medidas.cifrado.arquivos);
    medidas.decifrarMs = Date.now() - inicio;
    const inicioVerificacao = Date.now();
    const lido = await lerPacote(ctx.raizDecifrada, ctx.nomeDoPacote);
    assert.equal(lido.identidade.sha256Manifesto, medidas.sha256Manifesto);
    const v = await verificarPacoteL2({ pacote: destino, lido });
    assert.equal(v.ok, true, JSON.stringify(v));
    assert.equal(sha(fs.readFileSync(path.join(destino, 'dump', 'postgres.dump'))), medidas.dump.sha256);
    medidas.verificarMs = Date.now() - inicioVerificacao;
    observar('decifra', { decifrarMs: medidas.decifrarMs, verificarMs: medidas.verificarMs, arquivos: d.arquivos, layout: v.layout });
  });

  test('C1-06 — restauração real em banco NOVO pela composição de produção, só a partir do contêiner decifrado: INTEGRO, esquema IGUAL, imagens e linhas conferidas', async () => {
    const pedidos = [];
    const restauracao = criarRestauracaoDeProducao(H.montarConfigDaRestauracao({
      ...ctx,
      criarConexaoDoBanco: (nome) => { pedidos.push(nome); assert.equal(nome, ctx.nomeRestaurado, 'só o banco novo pode ser pedido'); return novoCliente(nome); },
    }));
    const nomeDasImagens = `img-${crypto.randomBytes(4).toString('hex')}`;
    const inicio = Date.now();
    const out = await restauracao.restaurar(H.pedidoDeRestauracao(ctx, nomeDasImagens));
    medidas.restauracaoMs = Date.now() - inicio;
    medidas.fimEm = agora();
    const { restauracao: r, estado } = out;
    const integro = { classe: 'INTEGRO', motivos: [], recuperavelEmProducao: false, restauracaoReal: false };
    assert.deepEqual([r.ok, { ...r.veredito }, r.esquema.relacao, r.banco.ok, r.fontes.imagens.restaurados], [true, integro, 'IGUAL', true, 4], JSON.stringify(r));
    assert.deepEqual(Object.entries(estado).sort(([a], [b]) => a.localeCompare(b)), [['consistenciaLogicaVerificada', true], ['publicacaoOperacional', false], ['recuperavelEmProducao', false], ['restauracaoReal', false]]);
    assert.deepEqual([...new Set(pedidos)], [ctx.nomeRestaurado]);
    for (const { h, mestre, mini } of imagens) {
      const pasta = path.join(ctx.dirs.restauradoImagens, nomeDasImagens, 'arquivos', 'imagens', 'padrao', h);
      assert.equal(sha(fs.readFileSync(path.join(pasta, 'mestre.png'))), sha(mestre));
      assert.equal(sha(fs.readFileSync(path.join(pasta, 'miniatura.webp'))), sha(mini));
    }
    const linhas = await noBanco(ctx.nomeRestaurado, async (c) => (await c.query('SELECT count(*)::int AS n FROM imagens_padrao')).rows[0].n);
    assert.equal(linhas, 2);
    observar('restauracao', { veredito: out.restauracao.veredito.classe, esquema: out.restauracao.esquema.relacao, imagensRestauradas: out.restauracao.fontes.imagens.restaurados, restauracaoMs: medidas.restauracaoMs, banco: ctx.nomeRestaurado });
  });

  test('C1-07 — DR medido: RPO pelo plano P12 e RTO da restauração composta dentro dos alvos sintéticos (24 h e 10 min), sem promover recuperabilidade em produção', () => {
    const plano = D.planejarEnsaioDeDR({ ultimoBackupEm: medidas.ultimoBackupEm, agora: medidas.inicioEm, alvos: ALVOS });
    const rtoMs = Date.parse(medidas.fimEm) - Date.parse(medidas.inicioEm);
    assert.equal(plano.rpoAtendido, true, `RPO ${plano.rpoMedidoMs} ms`);
    assert.ok(rtoMs >= 0 && rtoMs <= ALVOS.rtoMs, `RTO ${rtoMs} ms`);
    assert.ok(medidas.decifrarMs + medidas.verificarMs + medidas.restauracaoMs <= rtoMs + 50, 'a soma dos tempos parciais não pode exceder o RTO medido');
    assert.deepEqual([plano.passos.map((p) => p.id).slice(0, 2), plano.alvos.rtoMs], [['DECIFRAR', 'VERIFICACOES_8_7'], ALVOS.rtoMs]);
    observar('dr', { rpoMedidoMs: plano.rpoMedidoMs, rtoMedidoMs: rtoMs, decifrarMs: medidas.decifrarMs, verificarMs: medidas.verificarMs, restauracaoMs: medidas.restauracaoMs, alvos: ALVOS, medicao: 'COMPOSTA', recuperavelEmProducao: false });
  });

  test('C1-08 — contraprova: com UM byte adulterado no dump cifrado a decifra recusa (ARQUIVO_ADULTERADO), nada é publicado e nenhum banco novo aparece; a cópia sem alteração decifra', async () => {
    const bancosAntes = await bancosDaInstancia();
    const copiar = (rotulo) => { const copia = path.join(ctx.area, `container-${rotulo}`); fs.cpSync(ctx.container, copia, { recursive: true, errorOnExist: true, force: false }); return copia; };
    const controle = copiar('controle');
    const dControle = await decifrar(controle, path.join(ctx.area, 'decifrado-controle'));
    assert.equal(dControle.ok, true, JSON.stringify(dControle.falha));
    const adulterado = copiar('adulterado');
    const alvo = path.join(adulterado, 'dados', 'dump', 'postgres.dump.enc');
    fs.chmodSync(alvo, 0o600);
    const bytes = fs.readFileSync(alvo);
    bytes[bytes.length >> 1] ^= 0x01;
    fs.writeFileSync(alvo, bytes);
    const destino = path.join(ctx.area, 'decifrado-adulterado');
    const d = await decifrar(adulterado, destino);
    assert.equal(d.ok, false);
    assert.deepEqual({ ...d.falha }, { passo: 'DECIFRA', codigo: 'ARQUIVO_ADULTERADO' });
    assert.equal(fs.existsSync(path.join(destino, 'dump', 'postgres.dump')), false);
    assert.deepEqual(await bancosDaInstancia(), bancosAntes);
    observar('contraprova', { controle: dControle.ok, falha: d.falha, dumpPublicado: false, bancosInalterados: true });
  });
});
