'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

const { configuracaoDoBancoDeTeste, confirmarBancoDeTeste, BANCO_DE_TESTE } = require('./helpers/banco-de-teste');
const { listarMigrations } = require('../../src/db/checksums');
const { criarBackupDeProducao, criarRestauracaoDeProducao, classificarEstadoDoBackup } = require('../../src/services/imagem-backup-composicao-producao.service');
const { criarFonteDeChaves } = require('../../src/services/imagem-backup-manifesto-autenticado.service');
const { criarProdutorDeRelatorio } = require('../../src/services/imagem-backup-publicacao.service');
const { criarJanelaDeBackup } = require('../../src/services/imagem-backup.service');
const { criarArmazenamentoImagens } = require('../../src/storage/armazenamento-imagens');

/**
 * D-ORF-6, Rodada B (B3B-2) [B3-E2E]: ensaio ponta a ponta pela composição REAL de produção (criarBackupDeProducao e criarRestauracaoDeProducao, sem alterá-las) em PostgreSQL efêmero local.
 * Fluxo: banco sintético de origem com as migrations no esquema `public` do PRÓPRIO banco dedicado -> pg_dump real -> pacote L2 (chaves e destino de TESTE_CONTROLADO) -> pg_restore real em banco NOVO -> RECUPERADO/ÍNTEGRO.
 * Só roda com SWB_PGDATA (instância efêmera declarada) e SWB_B3_PONTA_A_PONTA=1; sem eles é ignorado com motivo, nunca na CI. A aplicação das migrations no `public` do banco dedicado é exceção à regra de nunca
 * aplicá-las no `public` e exige autorização própria. Nada aqui promove `recuperavelEmProducao` nem prova operação real. Dados 100% fictícios; bancos e diretórios removidos no `after`.
 */

const PORTAS_PROTEGIDAS = Object.freeze([5432, 55460]);
const PADRAO_PGDATA = /^\/private\/tmp\/swb-[0-9]{14}-[0-9]{1,5}\/pgdata$/;
const PREFIXO_ORIGEM = 'gepi_b3_origem_';
const PREFIXO_RESTAURADO = 'gepi_b3_rest_';
const NOME_ORIGEM = /^gepi_b3_origem_[0-9a-f]{12}$/;
const NOME_RESTAURADO = /^gepi_b3_rest_[0-9a-f]{12}$/;
const PROTEGIDOS = Object.freeze([BANCO_DE_TESTE, 'postgres', 'template0', 'template1', 'gestao_epi', 'homolog_local']);
const BANCOS_BASE = Object.freeze(['gestao_epi_teste_local', 'postgres', 'template0', 'template1']);
const VARIAVEIS_PG_PROIBIDAS = Object.freeze(['PGHOST', 'PGPORT', 'PGSERVICE', 'PGSERVICEFILE', 'PGDATABASE', 'PGSSLMODE']);
const DIRETORIO_MIGRATIONS = path.join(__dirname, '..', '..', 'migrations');
const BACKEND = path.join(__dirname, '..', '..');
const PRAZOS = Object.freeze({ totalMs: 180000, cortesiaMs: 5000, intervaloGrupoMs: 250, tentativasGrupo: 40, consultaGrupoMs: 2000 });
const MIB = 1024 * 1024;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

function motivoDeRecusaDoAmbiente(env) {
  if (env.SWB_B3_PONTA_A_PONTA !== '1') return 'SWB_B3_PONTA_A_PONTA diferente de 1';
  if (typeof env.SWB_PGDATA !== 'string' || !PADRAO_PGDATA.test(env.SWB_PGDATA)) return 'SWB_PGDATA fora do padrão /private/tmp/swb-<AAAAMMDDHHMMSS>-<n>/pgdata';
  if (typeof env.SWB_PORT !== 'string' || !/^[0-9]{4,5}$/.test(env.SWB_PORT)) return 'SWB_PORT ausente ou inválida';
  const porta = Number(env.SWB_PORT);
  if (porta < 1024 || porta > 65535 || PORTAS_PROTEGIDAS.includes(porta)) return 'porta protegida ou fora da faixa';
  if (env.DB_PORT !== env.SWB_PORT) return 'DB_PORT difere de SWB_PORT';
  if (env.DB_HOST !== `${path.dirname(env.SWB_PGDATA)}/sock`) return 'DB_HOST não é o socket da instância';
  if (env.DB_USER !== 'swb_teste') return 'DB_USER diferente de swb_teste';
  if (env.DB_NAME !== BANCO_DE_TESTE) return 'DB_NAME diferente do banco de teste';
  if (env.NODE_ENV !== 'test') return 'NODE_ENV diferente de test';
  for (const v of VARIAVEIS_PG_PROIBIDAS) if (env[v] !== undefined) return `${v} definida`;
  return null;
}
const nomeDeOrigemValido = (n) => typeof n === 'string' && NOME_ORIGEM.test(n) && !PROTEGIDOS.includes(n);
const nomeRestauradoValido = (n) => typeof n === 'string' && NOME_RESTAURADO.test(n) && !PROTEGIDOS.includes(n);
const novoNome = (prefixo) => `${prefixo}${crypto.randomBytes(6).toString('hex')}`;

function criarFabricaDeConexoes({ base, permitidos, pedidos, criados }) {
  return (nome) => {
    pedidos.push(nome);
    if (typeof nome !== 'string' || !permitidos.has(nome)) {
      const erro = new Error('B3E2E_BANCO_NAO_AUTORIZADO');
      erro.code = 'B3E2E_BANCO_NAO_AUTORIZADO';
      throw erro;
    }
    const cliente = new Client({ ...base, database: nome });
    criados.push(cliente);
    return cliente;
  };
}

function adulterarByte(caminho, posicao) {
  fs.chmodSync(caminho, 0o600);
  const fd = fs.openSync(caminho, 'r+');
  try {
    const b = Buffer.alloc(1);
    assert.equal(fs.readSync(fd, b, 0, 1, posicao), 1);
    b[0] ^= 0xff;
    fs.writeSync(fd, b, 0, 1, posicao);
  } finally { fs.closeSync(fd); }
}

function montarConfigDoBackup(c) {
  return {
    postgres: { pgDump: c.binarios.dump, pgRestore: c.binarios.restore, host: c.host, porta: c.porta, usuario: c.usuario, arquivoDeSenha: c.arquivoDeSenha, banco: { nome: c.nomeOrigem, oid: c.oidOrigem } },
    conexao: { criarConexao: c.criarConexaoOrigem, finalizacaoMs: 30000 },
    armazenamento: { imagens: c.dirs.imagens, preparacoes: c.dirs.preparacoes, dumps: c.dirs.dumps, publicados: c.dirs.publicados },
    chaves: { fonteDeChaves: c.fonteDeChaves, chaveId: c.chaveId },
    relatorio: { produtor: criarProdutorDeRelatorio({ origem: 'TESTE_CONTROLADO', decidir: () => ({ ok: true }) }), origensAceitas: ['TESTE_CONTROLADO'] },
    prazos: { ...PRAZOS },
    maxBytesPorArquivo: MIB,
    janela: criarJanelaDeBackup({ arquivo: path.join(c.area, 'janela.lock'), raizArmazenamento: c.dirs.imagens }),
    limites: { totalBytes: 512 * MIB, maxBytesDoDump: 256 * MIB, bytesLivresMinimos: 1024 * MIB },
    layoutDoManifesto: 2,
    fontes: ['imagens'],
  };
}
function montarConfigDaRestauracao(c) {
  return {
    postgres: { pgRestore: c.binarios.restore },
    politicaDeDestino: { prefixoDoBanco: PREFIXO_RESTAURADO, hostsAutorizados: [c.host], bancosProtegidos: [...PROTEGIDOS] },
    fonteDeChaves: c.fonteDeChaves,
    criarConexaoDoBanco: c.fabricaDeRestauracao,
    prazos: { ...PRAZOS },
  };
}
const pedidoDeRestauracao = (c, extras = {}) => ({
  raizAutorizada: c.dirs.publicados, nome: c.nomeDoPacote, imagens: { raiz: c.dirs.restauradoImagens, nome: `img-${crypto.randomBytes(4).toString('hex')}` },
  destino: { banco: c.nomeRestaurado, host: c.host, porta: c.porta, usuario: c.usuario, arquivoDeSenha: c.arquivoDeSenha }, layoutMinimo: 2, maxBytesPorArquivo: MIB, ...extras,
});

function localizarBinarios(env) {
  const dir = env.BACKUP_PG_BINARIOS;
  assert.ok(typeof dir === 'string' && path.isAbsolute(dir) && fs.realpathSync(dir) === dir, 'BACKUP_PG_BINARIOS ausente ou não canônico');
  const binarios = { dump: path.join(dir, 'pg_dump'), restore: path.join(dir, 'pg_restore') };
  for (const b of Object.values(binarios)) fs.accessSync(b, fs.constants.X_OK);
  const versao = cp.execFileSync(binarios.dump, ['--version'], { env: {}, timeout: 10000, encoding: 'utf8' });
  assert.match(versao, /^pg_dump \(PostgreSQL\) 16\./);
  return binarios;
}

const CODIGO_DO_FILHO = `
const { Client } = require('pg');
const { aplicarMigrations } = require('./scripts/migrate');
(async () => {
  const { B3_NOME, B3_PGDATA, B3_PORTA, B3_DIRETORIO, DB_NAME, DB_HOST, DB_PORT } = process.env;
  if (!/^gepi_b3_origem_[0-9a-f]{12}$/.test(B3_NOME) || DB_NAME !== B3_NOME) throw new Error('B3E2E_FILHO_BANCO_RECUSADO');
  if (!/^\\/private\\/tmp\\/swb-[0-9]{14}-[0-9]{1,5}\\/pgdata$/.test(B3_PGDATA) || DB_HOST !== B3_PGDATA.replace(/pgdata$/, 'sock') || DB_PORT !== B3_PORTA) throw new Error('B3E2E_FILHO_INSTANCIA_RECUSADA');
  const c = new Client({ host: DB_HOST, port: Number(DB_PORT), database: DB_NAME, user: process.env.DB_USER });
  await c.connect();
  const q = async (sql) => (await c.query(sql)).rows[0];
  const ok = (await q('SELECT current_database() AS d, current_setting(\\'data_directory\\') AS p, current_setting(\\'port\\') AS t, current_setting(\\'listen_addresses\\') AS l')) ;
  const vazio = (await q("SELECT count(*)::int AS n FROM pg_class r JOIN pg_namespace s ON s.oid = r.relnamespace WHERE s.nspname = 'public'")).n;
  await c.end();
  if (ok.d !== B3_NOME || ok.p !== B3_PGDATA || ok.t !== B3_PORTA || ok.l !== '' || vazio !== 0) throw new Error('B3E2E_FILHO_IDENTIDADE_RECUSADA');
  const aplicadas = await aplicarMigrations({ schema: 'public', diretorio: B3_DIRETORIO });
  process.stdout.write('B3E2E_MIGRATIONS ' + aplicadas.length + '\\n');
})().catch((e) => { process.stderr.write(String(e && e.message ? e.message : e) + '\\n'); process.exit(1); });
`;

const SO_NA_INSTANCIA_EFEMERA_LOCAL = process.env.SWB_PGDATA === undefined
  ? 'B3E2E_SO_NA_INSTANCIA_EFEMERA_LOCAL: SWB_PGDATA ausente; esta suíte só roda na instância efêmera local declarada por SWB_PGDATA'
  : (process.env.SWB_B3_PONTA_A_PONTA !== '1' ? 'B3E2E_NAO_AUTORIZADO: SWB_B3_PONTA_A_PONTA=1 ausente; a exceção de migrations no public do banco dedicado exige autorização própria' : false);

describe('[B3-E2E] ponta a ponta pela composição real (banco dedicado em public, instância efêmera exclusiva)', { skip: SO_NA_INSTANCIA_EFEMERA_LOCAL }, () => {
  const base = SO_NA_INSTANCIA_EFEMERA_LOCAL === false ? { ...configuracaoDoBancoDeTeste(), connectionTimeoutMillis: 8000 } : null;
  const criadosEmMemoria = new Set();
  const clientes = [];
  const pedidos = [];
  const imagens = [];
  let admin = null;
  let ctx = null;
  let pacoteBackup = null;

  const baseDe = (nome) => ({ ...base, database: nome });
  const bancosDaInstancia = async () => (await admin.query('SELECT datname FROM pg_database ORDER BY 1')).rows.map((r) => r.datname);
  async function criarBancoNovo(nome, validador) {
    assert.ok(validador(nome), 'nome de banco fora do padrão controlado');
    assert.ok(!PROTEGIDOS.includes(nome), 'nome protegido');
    const { rows } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [nome]);
    assert.equal(rows.length, 0, 'banco já existe: nunca reutilizar');
    await admin.query(`CREATE DATABASE ${nome} OWNER swb_teste TEMPLATE template0`);
    criadosEmMemoria.add(nome);
  }
  async function noBanco(nome, fn) {
    const c = new Client(baseDe(nome));
    await c.connect();
    try { return await fn(c); } finally { await c.end().catch(() => {}); }
  }
  const tabelasDe = (nome) => noBanco(nome, async (c) => (await c.query("SELECT count(*)::int AS n FROM pg_class r JOIN pg_namespace s ON s.oid = r.relnamespace WHERE s.nspname = 'public'")).rows[0].n);
  function copiarPacoteAdulterado(rotulo, alterar) {
    const raiz = path.join(ctx.area, `copia-${rotulo}`);
    fs.mkdirSync(raiz, { mode: 0o700 });
    fs.cpSync(path.join(ctx.dirs.publicados, ctx.nomeDoPacote), path.join(raiz, ctx.nomeDoPacote), { recursive: true, errorOnExist: true, force: false });
    alterar(path.join(raiz, ctx.nomeDoPacote));
    return raiz;
  }

  before(async () => {
    const motivo = motivoDeRecusaDoAmbiente(process.env);
    assert.equal(motivo, null, `ambiente recusado: ${motivo}`);
    const { SWB_PGDATA, SWB_PORT, DB_HOST, DB_USER } = process.env;
    const binarios = localizarBinarios(process.env);

    admin = new Client(base);
    await admin.connect();
    await confirmarBancoDeTeste(admin);
    const mostrar = async (p) => (await admin.query(`SHOW ${p}`)).rows[0][p];
    assert.equal(await mostrar('data_directory'), SWB_PGDATA, 'data_directory difere da instância autorizada');
    assert.equal(await mostrar('port'), SWB_PORT, 'porta difere da instância autorizada');
    assert.equal(await mostrar('listen_addresses'), '', 'a instância deve ouvir só em socket Unix');
    assert.ok((await mostrar('unix_socket_directories')).split(',').map((s) => s.trim()).includes(DB_HOST), 'DB_HOST não é o socket da instância');
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = \'public\'')).rows[0].n, 0, 'public do banco de teste não está vazio');
    assert.deepEqual(await bancosDaInstancia(), [...BANCOS_BASE].sort((a, b) => a.localeCompare(b)), 'a instância tem bancos além dos quatro de base');

    const instancia = path.dirname(SWB_PGDATA);
    const area = path.join(instancia, `b3e2e-${crypto.randomBytes(6).toString('hex')}`);
    fs.mkdirSync(area, { mode: 0o700 });
    assert.equal(fs.realpathSync(area), area);
    const dirs = {};
    for (const d of ['imagens', 'preparacoes', 'dumps', 'publicados', 'seg', 'restauradoImagens']) { dirs[d] = path.join(area, d); fs.mkdirSync(dirs[d], { mode: 0o700 }); }
    const arquivoDeSenha = path.join(dirs.seg, 'pgpass');
    fs.writeFileSync(arquivoDeSenha, `localhost:${SWB_PORT}:*:${DB_USER}:ficticia\n${DB_HOST}:${SWB_PORT}:*:${DB_USER}:ficticia\n`, { mode: 0o600 });

    const nomeOrigem = novoNome(PREFIXO_ORIGEM);
    assert.ok(nomeDeOrigemValido(nomeOrigem));
    await criarBancoNovo(nomeOrigem, nomeDeOrigemValido);
    const oidOrigem = (await admin.query('SELECT oid::text AS oid FROM pg_database WHERE datname = $1', [nomeOrigem])).rows[0].oid;
    const nomeRestaurado = novoNome(PREFIXO_RESTAURADO);
    await criarBancoNovo(nomeRestaurado, nomeRestauradoValido);

    const criadosClientes = [];
    clientes.push(criadosClientes);
    ctx = {
      area, dirs, arquivoDeSenha, binarios, host: DB_HOST, porta: Number(SWB_PORT), usuario: DB_USER, nomeOrigem, oidOrigem, nomeRestaurado,
      nomeDoPacote: `prep-b3e2e-${crypto.randomBytes(4).toString('hex')}`, conjuntoId: `conjunto-b3e2e-${crypto.randomBytes(4).toString('hex')}`,
      chaveId: 'chave-b3e2e', fonteDeChaves: criarFonteDeChaves({ origem: 'TESTE_CONTROLADO', chaves: [{ id: 'chave-b3e2e', segredo: crypto.randomBytes(32) }] }),
      criarConexaoOrigem: () => { const c = new Client(baseDe(nomeOrigem)); criadosClientes.push(c); return c; },
      fabricaDeRestauracao: criarFabricaDeConexoes({ base, permitidos: criadosEmMemoria, pedidos, criados: criadosClientes }),
    };

    // migrations no public SOMENTE do banco de origem, em processo próprio (o preload do test:integracao só vale para este processo)
    const saida = cp.execFileSync(process.execPath, ['-e', CODIGO_DO_FILHO], {
      cwd: BACKEND, encoding: 'utf8', timeout: 240000,
      env: { PATH: process.env.PATH, NODE_ENV: 'test', DB_HOST, DB_PORT: SWB_PORT, DB_NAME: nomeOrigem, DB_USER, ...(process.env.DB_PASSWORD === undefined ? {} : { DB_PASSWORD: process.env.DB_PASSWORD }), B3_NOME: nomeOrigem, B3_PGDATA: SWB_PGDATA, B3_PORTA: SWB_PORT, B3_DIRETORIO: DIRETORIO_MIGRATIONS },
    });
    assert.equal(saida.trim().split('\n').pop(), `B3E2E_MIGRATIONS ${listarMigrations(DIRETORIO_MIGRATIONS).length}`);

    // seed sintético: duas imagens padrão com arquivos reais na origem
    const origem = criarArmazenamentoImagens({ diretorio: dirs.imagens });
    await noBanco(nomeOrigem, async (c) => {
      for (const n of [1, 2]) {
        const mestre = Buffer.from(`png-ficticio-${n}-${nomeOrigem}`);
        const mini = Buffer.from(`webp-mini-${n}-${nomeOrigem}`);
        const h = sha(mestre);
        await origem.gravar(`padrao/${h}/mestre.png`, mestre, { maxBytes: 1024 });
        await origem.gravar(`padrao/${h}/miniatura.webp`, mini, { maxBytes: 1024 });
        await c.query('INSERT INTO imagens_padrao (nome, arquivo_origem, sha256, sha256_miniatura, formato, largura, altura, bytes_mestre, bytes_miniatura) VALUES ($1, $2, $3, $4, $5, 256, 256, $6, $7)', [`Imagem ${n}`, `imagem-${n}.png`, h, sha(mini), 'PNG', mestre.length, mini.length]);
        imagens.push({ h, mestre, mini });
      }
    });
  }, { timeout: 420000 });

  after(async () => {
    const falhas = [];
    try {
      for (const lista of clientes) for (const c of lista) await c.end().catch(() => {});
      if (admin !== null) {
        for (const nome of criadosEmMemoria) {
          if (!nomeDeOrigemValido(nome) && !nomeRestauradoValido(nome)) { falhas.push(`nome fora do padrão não removido: ${nome}`); continue; }
          await admin.query(`DROP DATABASE IF EXISTS ${nome} WITH (FORCE)`).catch((e) => falhas.push(`banco não removido (${e.code ?? 'sem código'})`));
        }
        const restantes = (await bancosDaInstancia().catch(() => [])).filter((n) => n.startsWith('gepi_b3_'));
        if (restantes.length > 0) falhas.push(`bancos gepi_b3_ restantes: ${restantes.length}`);
      }
    } finally {
      if (admin !== null) await admin.end().catch(() => {});
      if (ctx !== null && ctx.area.startsWith(`${path.dirname(process.env.SWB_PGDATA)}/b3e2e-`)) fs.rmSync(ctx.area, { recursive: true, force: true });
      if (falhas.length > 0) process.stderr.write(`B3E2E_LIMPEZA: ${falhas.join('; ')}\n`);
    }
    assert.deepEqual(falhas, [], 'limpeza do ensaio incompleta');
  });

  test('B3-E2E-01 — isolamento: instância exclusiva, quatro bancos de base, origem com as migrations no public, restaurado vazio e nomes controlados', async () => {
    assert.deepEqual((await bancosDaInstancia()).filter((n) => !BANCOS_BASE.includes(n)).sort((a, b) => a.localeCompare(b)), [ctx.nomeOrigem, ctx.nomeRestaurado].sort((a, b) => a.localeCompare(b)));
    assert.equal(await tabelasDe(ctx.nomeRestaurado), 0, 'o banco de restauração deve nascer vazio');
    const n = await noBanco(ctx.nomeOrigem, async (c) => (await c.query('SELECT count(*)::int AS n FROM imagens_padrao')).rows[0].n);
    assert.equal(n, 2);
    assert.equal(await tabelasDe(BANCO_DE_TESTE), 0, 'o banco de teste da instância não pode receber objetos');
    assert.equal(nomeDeOrigemValido(BANCO_DE_TESTE), false);
    assert.equal(nomeRestauradoValido('postgres'), false);
  });

  test('B3-E2E-02 — backup real: pg_dump pela composição de produção, pacote L2 publicado como NÃO operacional, hash do dump provado', async () => {
    const config = montarConfigDoBackup(ctx);
    const composto = await criarBackupDeProducao(config).executar({ nomeDaPreparacao: ctx.nomeDoPacote, conjuntoId: ctx.conjuntoId });
    const estado = classificarEstadoDoBackup(composto);
    assert.equal(composto.resultado.composicao?.ok, true, JSON.stringify(composto.resultado.composicao));
    assert.equal(composto.resultado.composicao.layout, 2);
    assert.equal(composto.resultado.pacote?.ok, true, JSON.stringify(composto.resultado.pacote));
    assert.equal(estado.pacotePublicado, true, JSON.stringify(composto.resultado.publicacao));
    assert.equal(estado.publicacaoOperacional, false);
    assert.equal(estado.recuperabilidadeComprovada, false);
    assert.equal(composto.proveniencia.hashDoDump.correspondem, true);
    assert.equal(composto.proveniencia.chaves.origem, 'TESTE_CONTROLADO');
    const dump = fs.readFileSync(path.join(ctx.dirs.publicados, ctx.nomeDoPacote, 'dump', 'postgres.dump'));
    assert.equal(sha(dump), composto.proveniencia.hashDoDump.SHA256_ARQUIVO_PERSISTIDO);
    pacoteBackup = { bytes: dump.length, sha256: sha(dump) };
    process.stdout.write(`B3E2E_OBSERVACAO_JSON ${JSON.stringify({ fase: 'backup', dump: pacoteBackup, banco: ctx.nomeOrigem })}\n`);
  });

  test('B3-E2E-03 — restauração real em banco NOVO pela composição de produção: INTEGRO, esquema IGUAL, imagens e linhas conferidas', async () => {
    assert.notEqual(pacoteBackup, null, 'depende do backup do caso anterior');
    const restauracao = criarRestauracaoDeProducao(montarConfigDaRestauracao(ctx));
    const pedido = pedidoDeRestauracao(ctx);
    const out = await restauracao.restaurar(pedido);
    assert.equal(out.restauracao.ok, true, JSON.stringify(out.restauracao));
    assert.deepEqual(out.restauracao.veredito, { classe: 'INTEGRO', motivos: [], recuperavelEmProducao: false, restauracaoReal: false });
    assert.equal(out.restauracao.esquema.relacao, 'IGUAL');
    assert.equal(out.restauracao.banco.ok, true);
    assert.equal(out.restauracao.fontes.imagens.restaurados, 4);
    assert.deepEqual(out.estado, { restauracaoReal: false, consistenciaLogicaVerificada: true, recuperavelEmProducao: false, publicacaoOperacional: false });
    for (const { h, mestre, mini } of imagens) {
      const dir = path.join(pedido.imagens.raiz, pedido.imagens.nome, 'arquivos', 'imagens', 'padrao', h);
      assert.equal(sha(fs.readFileSync(path.join(dir, 'mestre.png'))), sha(mestre));
      assert.equal(sha(fs.readFileSync(path.join(dir, 'miniatura.webp'))), sha(mini));
    }
    const n = await noBanco(ctx.nomeRestaurado, async (c) => (await c.query('SELECT count(*)::int AS n FROM imagens_padrao')).rows[0].n);
    assert.equal(n, 2);
    assert.deepEqual(pedidos.filter((p) => p !== ctx.nomeRestaurado), [], 'só o banco restaurado foi pedido à fábrica de conexões');
    process.stdout.write(`B3E2E_OBSERVACAO_JSON ${JSON.stringify({ fase: 'restauracao', veredito: out.restauracao.veredito.classe, esquema: out.restauracao.esquema.relacao, banco: ctx.nomeRestaurado })}\n`);
  });

  test('B3-E2E-04 — negativo, prefixo e protegidos: destino fora da política é recusado antes de qualquer processo ou conexão', async () => {
    const antes = pedidos.length;
    const restauracao = criarRestauracaoDeProducao(montarConfigDaRestauracao(ctx));
    for (const banco of [BANCO_DE_TESTE, 'postgres', ctx.nomeOrigem, 'gepi_b3_outro_aaaaaaaaaaaa']) {
      const r = await restauracao.restaurar(pedidoDeRestauracao(ctx, { destino: { banco, host: ctx.host, porta: ctx.porta, usuario: ctx.usuario, arquivoDeSenha: ctx.arquivoDeSenha } }));
      assert.deepEqual({ ...r.restauracao.falha }, { passo: 'BANCO_E_ESQUEMA', codigo: 'DESTINO_NAO_AUTORIZADO' }, banco);
    }
    assert.equal(pedidos.length, antes, 'nenhuma conexão pedida a banco fora da política');
    assert.equal(await tabelasDe(BANCO_DE_TESTE), 0);
  });

  test('B3-E2E-05 — negativo, host indevido: host fora da lista autorizada é recusado e nada é lançado', async () => {
    const antes = pedidos.length;
    const restauracao = criarRestauracaoDeProducao(montarConfigDaRestauracao(ctx));
    const novo = novoNome(PREFIXO_RESTAURADO);
    for (const host of ['127.0.0.1', 'localhost', `${path.dirname(ctx.host)}/sock-outro`]) {
      const r = await restauracao.restaurar(pedidoDeRestauracao(ctx, { destino: { banco: novo, host, porta: ctx.porta, usuario: ctx.usuario, arquivoDeSenha: ctx.arquivoDeSenha } }));
      assert.deepEqual({ ...r.restauracao.falha }, { passo: 'BANCO_E_ESQUEMA', codigo: 'DESTINO_NAO_AUTORIZADO' }, host);
    }
    assert.equal(pedidos.length, antes);
    assert.ok(!(await bancosDaInstancia()).includes(novo), 'a recusa não cria banco');
  });

  test('B3-E2E-06 — negativo, banco preexistente: recusa do próprio ensaio e falha fechada do pg_restore em banco já povoado', async () => {
    await assert.rejects(() => criarBancoNovo(ctx.nomeRestaurado, nomeRestauradoValido), /banco já existe/);
    const povoado = novoNome(PREFIXO_RESTAURADO);
    await criarBancoNovo(povoado, nomeRestauradoValido);
    await noBanco(povoado, (c) => c.query('CREATE TABLE imagens_padrao (id integer)'));
    const restauracao = criarRestauracaoDeProducao(montarConfigDaRestauracao(ctx));
    const r = await restauracao.restaurar(pedidoDeRestauracao(ctx, { destino: { banco: povoado, host: ctx.host, porta: ctx.porta, usuario: ctx.usuario, arquivoDeSenha: ctx.arquivoDeSenha } }));
    assert.equal(r.restauracao.ok, false);
    assert.equal(r.restauracao.falha.passo, 'BANCO_E_ESQUEMA');
    assert.match(r.restauracao.falha.codigo, /^PG_RESTORE_/);
    assert.equal(r.estado.consistenciaLogicaVerificada, false);
    assert.equal(await tabelasDe(povoado), 1, 'o banco preexistente ficou como estava (transação única)');
  });

  test('B3-E2E-07 — negativo, pgpass inseguro: modo aberto e link simbólico recusados antes de qualquer conexão, dump ou preparação', async () => {
    const inseguro = path.join(ctx.dirs.seg, 'pgpass-aberto');
    fs.writeFileSync(inseguro, `*:${ctx.porta}:*:${ctx.usuario}:ficticia\n`, { mode: 0o644 });
    fs.chmodSync(inseguro, 0o644);
    const link = path.join(ctx.dirs.seg, 'pgpass-link');
    fs.symlinkSync(ctx.arquivoDeSenha, link);
    const dumpsAntes = fs.readdirSync(ctx.dirs.dumps).sort();
    const preparacoesAntes = fs.readdirSync(ctx.dirs.preparacoes).sort();
    for (const arquivoDeSenha of [inseguro, link]) {
      let conexoes = 0;
      const config = montarConfigDoBackup({ ...ctx, arquivoDeSenha, criarConexaoOrigem: () => { conexoes += 1; throw new Error('conexão não deveria ser pedida'); } });
      await assert.rejects(() => criarBackupDeProducao(config).executar({ nomeDaPreparacao: `prep-inseguro-${crypto.randomBytes(3).toString('hex')}`, conjuntoId: `conjunto-inseguro-${crypto.randomBytes(3).toString('hex')}` }), (e) => e.code === 'DEPENDENCIA_INDISPONIVEL' && e.item === 'ARQUIVO_DE_SENHA');
      assert.equal(conexoes, 0);
    }
    assert.deepEqual(fs.readdirSync(ctx.dirs.dumps).sort(), dumpsAntes, 'nenhum dump novo criado');
    assert.deepEqual(fs.readdirSync(ctx.dirs.preparacoes).sort(), preparacoesAntes, 'nenhuma preparação nova criada');
  });

  test('B3-E2E-08 — negativo, adulteração: dump e manifesto adulterados na cópia do pacote falham fechado e o banco de destino continua vazio', async () => {
    // controle: a cópia SEM alteração tem de restaurar INTEGRO, senão a falha das cópias adulteradas não provaria a adulteração
    const controle = copiarPacoteAdulterado('controle', () => {});
    const bancoDeControle = novoNome(PREFIXO_RESTAURADO);
    await criarBancoNovo(bancoDeControle, nomeRestauradoValido);
    const rc = await criarRestauracaoDeProducao(montarConfigDaRestauracao(ctx)).restaurar(pedidoDeRestauracao(ctx, { raizAutorizada: controle, destino: { banco: bancoDeControle, host: ctx.host, porta: ctx.porta, usuario: ctx.usuario, arquivoDeSenha: ctx.arquivoDeSenha } }));
    assert.equal(rc.restauracao.ok, true, JSON.stringify(rc.restauracao));
    assert.equal(rc.restauracao.veredito.classe, 'INTEGRO');
    const dumpAdulterado = copiarPacoteAdulterado('dump', (p) => adulterarByte(path.join(p, 'dump', 'postgres.dump'), Math.floor(pacoteBackup.bytes / 2)));
    const manifestoAdulterado = copiarPacoteAdulterado('manifesto', (p) => adulterarByte(path.join(p, 'manifesto.json'), 10));
    for (const [rotulo, raiz] of [['dump', dumpAdulterado], ['manifesto', manifestoAdulterado]]) {
      const destino = novoNome(PREFIXO_RESTAURADO);
      await criarBancoNovo(destino, nomeRestauradoValido);
      const restauracao = criarRestauracaoDeProducao(montarConfigDaRestauracao(ctx));
      const r = await restauracao.restaurar(pedidoDeRestauracao(ctx, { raizAutorizada: raiz, destino: { banco: destino, host: ctx.host, porta: ctx.porta, usuario: ctx.usuario, arquivoDeSenha: ctx.arquivoDeSenha } }));
      assert.equal(r.restauracao.ok, false, rotulo);
      assert.match(`${r.restauracao.falha.passo}/${r.restauracao.falha.codigo}`, /^(VERIFICACOES_8_7\/SELAGEM_|BANCO_E_ESQUEMA\/DUMP_DIVERGENTE)/, rotulo);
      assert.equal(r.estado.consistenciaLogicaVerificada, false);
      assert.equal(await tabelasDe(destino), 0, `${rotulo}: nada foi restaurado`);
    }
  });

  test('B3-E2E-09 — isolamento final: fábrica de conexões recusa banco externo sem criar cliente, e a instância só tem os bancos esperados', async () => {
    const antes = pedidos.length;
    const total = clientes.reduce((s, l) => s + l.length, 0);
    for (const externo of [BANCO_DE_TESTE, 'postgres', 'template1', 'gestao_epi', 'homolog_local', 'gepi_b3_rest_000000000000']) {
      assert.throws(() => ctx.fabricaDeRestauracao(externo), (e) => e.code === 'B3E2E_BANCO_NAO_AUTORIZADO', externo);
    }
    assert.equal(pedidos.length, antes + 6);
    assert.equal(clientes.reduce((s, l) => s + l.length, 0), total, 'nenhum cliente foi criado para banco externo');
    assert.deepEqual((await bancosDaInstancia()).filter((n) => !BANCOS_BASE.includes(n)).every((n) => criadosEmMemoria.has(n)), true);
    assert.equal(await tabelasDe(BANCO_DE_TESTE), 0);
    assert.ok(PORTAS_PROTEGIDAS.every((p) => String(p) !== process.env.SWB_PORT));
  });
});

module.exports = Object.freeze({
  guardas: Object.freeze({ motivoDeRecusaDoAmbiente, nomeDeOrigemValido, nomeRestauradoValido, criarFabricaDeConexoes, adulterarByte, montarConfigDoBackup, montarConfigDaRestauracao, pedidoDeRestauracao, novoNome, CODIGO_DO_FILHO }),
});
