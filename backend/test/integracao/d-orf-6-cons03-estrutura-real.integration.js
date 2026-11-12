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
const { criarBackupDeProducao, classificarEstadoDoBackup } = require('../../src/services/imagem-backup-composicao-producao.service');
const { criarFonteDeChaves } = require('../../src/services/imagem-backup-manifesto-autenticado.service');
const { criarArmazenamentoImagens } = require('../../src/storage/armazenamento-imagens');
const { criarLancadorEstruturalReal } = require('../../src/services/imagem-backup-estrutura-lancador.service');
const { ehEvidenciaEstrutural } = require('../../src/services/imagem-backup-estrutura.service');

/**
 * D-ORF-6, CONS-03 [CONS03-REAL]: ensaio de integração da VERIFICAÇÃO ESTRUTURAL REAL do dump (`pg_restore --list` supervisionado), em PostgreSQL 16 efêmero local, dados sintéticos e fonte de chaves
 * `TESTE_CONTROLADO`. Nenhum módulo de produção é alterado: o backup é feito pela composição real de produção (que já liga o verificador estrutural ao `pg_restore` real) com o PAPEL mínimo B-1.
 *  - Dump VÁLIDO: a evidência estrutural da composição precisa ser PG_RESTORE_LIST_SUPERVISIONADO, ok, com formato CUSTOM e contagem de entradas igual à de uma listagem independente do mesmo arquivo.
 *  - Dump ADULTERADO: (a) pela composição, com um `pg_dump` de ENSAIO (script da área do teste que corrompe os cinco primeiros bytes da saída do `pg_dump` real, de modo que T1/T2 e o hash continuem coerentes
 *    e só a estrutura seja inválida): o pacote NÃO pode ser publicado e a estrutura, se avaliada, NÃO pode ser ok; (b) pelo lançador estrutural real, direto, sobre cópias adulteradas (magia trocada e arquivo truncado):
 *    saída diferente de 0 e nenhum sumário. Controle: o mesmo lançador sobre o dump válido sai com 0.
 * A listagem do sumário NÃO comprova restauração nem integridade do conteúdo das tabelas. Só roda com SWB_PGDATA (instância efêmera declarada) e SWB_CONS03=1; sem eles é ignorado com motivo, e nunca
 * depende de GEPI_CI_EFEMERO. Nada aqui promove publicação operacional nem recuperabilidade em produção.
 */

const DIRETORIO_MIGRATIONS = path.join(__dirname, '..', '..', 'migrations');
const BACKEND = path.join(__dirname, '..', '..');
const PREFIXO_ORIGEM = 'gepi_c3_origem_';
const NOME_CONTROLADO = /^gepi_c3_origem_[0-9a-f]{12}$/;
const PADRAO_PGDATA = /^\/private\/tmp\/swb-[0-9]{14}-[0-9]{1,5}\/pgdata$/;
const VARIAVEIS_DO_CLIENTE_PG = ['PGHOST', 'PGPORT', 'PGSERVICE', 'PGSERVICEFILE', 'PGDATABASE', 'PGSSLMODE'];
const ESPERA_MAXIMA_MS = 30000;
const FILHO = [
  "const { Client } = require('pg');",
  "const { aplicarMigrations } = require('./scripts/migrate');",
  '(async () => {',
  '  const e = process.env;',
  '  const instancia = /^\\/private\\/tmp\\/swb-[0-9]{14}-[0-9]{1,5}\\/pgdata$/;',
  "  if (!/^gepi_c3_origem_[0-9a-f]{12}$/.test(e.C3_NOME) || e.DB_NAME !== e.C3_NOME) throw new Error('C3_FILHO_BANCO_RECUSADO');",
  "  if (!instancia.test(e.C3_PGDATA) || e.DB_HOST !== e.C3_PGDATA.replace(/pgdata$/, 'sock') || e.DB_PORT !== e.C3_PORTA) throw new Error('C3_FILHO_INSTANCIA_RECUSADA');",
  '  const c = new Client({ host: e.DB_HOST, port: Number(e.DB_PORT), database: e.DB_NAME, user: e.DB_USER });',
  '  await c.connect();',
  "  const { rows: [r] } = await c.query(\"SELECT current_database() AS d, current_setting('data_directory') AS p, current_setting('port') AS t, current_setting('listen_addresses') AS l, (SELECT count(*)::int FROM pg_class k JOIN pg_namespace s ON s.oid = k.relnamespace WHERE s.nspname = 'public') AS n\");",
  '  await c.end();',
  "  if (r.d !== e.C3_NOME || r.p !== e.C3_PGDATA || r.t !== e.C3_PORTA || r.l !== '' || r.n !== 0) throw new Error('C3_FILHO_IDENTIDADE_RECUSADA');",
  "  const feitas = await aplicarMigrations({ schema: 'public', diretorio: e.C3_DIRETORIO });",
  "  process.stdout.write('C3_MIGRATIONS ' + feitas.length + '\\n');",
  "})().catch((x) => { process.stderr.write(String(x && x.message ? x.message : x) + '\\n'); process.exit(1); });",
].join('\n');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const ordenados = (lista) => [...lista].sort((a, b) => a.localeCompare(b));
const observar = (fase, dados) => process.stdout.write(`C3_OBSERVACAO_JSON ${JSON.stringify({ fase, ...dados })}\n`);
const nomeValido = (nome) => typeof nome === 'string' && NOME_CONTROLADO.test(nome) && !H.PROTEGIDOS.includes(nome);

/** Atributos exigidos do papel B-1: nenhum privilégio administrativo e com login. */
const ATRIBUTOS_DO_PAPEL_B1 = Object.freeze({ rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false, rolcanlogin: true });
const SQL_ATRIBUTOS_DO_PAPEL = 'SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = $1';
const SQL_PARAMETROS_DA_INSTANCIA = "SELECT current_setting('data_directory') AS data_directory, current_setting('port') AS port, current_setting('listen_addresses') AS listen_addresses, current_setting('unix_socket_directories') AS unix_socket_directories, current_setting('server_version') AS server_version";

/** Primeiro motivo pelo qual o ambiente NÃO é a instância efêmera exclusiva autorizada para o CONS-03; `null` se tudo confere. */
function motivoDeRecusaDoAmbiente(env) {
  const pgdata = typeof env.SWB_PGDATA === 'string' ? env.SWB_PGDATA : '';
  const porta = Number(env.SWB_PORT);
  const regras = [
    [env.SWB_CONS03 !== '1', 'SWB_CONS03 diferente de 1'],
    [!PADRAO_PGDATA.test(pgdata), 'SWB_PGDATA fora do padrão /private/tmp/swb-<AAAAMMDDHHMMSS>-<n>/pgdata'],
    [!/^[0-9]{4,5}$/.test(String(env.SWB_PORT)), 'SWB_PORT ausente ou inválida'],
    [porta < 1024 || porta > 65535 || H.PORTAS_PROTEGIDAS.includes(porta), 'porta protegida ou fora da faixa'],
    [env.DB_PORT !== env.SWB_PORT, 'DB_PORT difere de SWB_PORT'],
    [env.DB_HOST !== `${path.dirname(pgdata)}/sock`, 'DB_HOST não é o socket da instância'],
    [env.DB_USER !== 'swb_teste', 'DB_USER diferente de swb_teste'],
    [env.DB_NAME !== 'gestao_epi_teste_local', 'DB_NAME diferente do banco de teste'],
    [env.NODE_ENV !== 'test', 'NODE_ENV diferente de test'],
    ...VARIAVEIS_DO_CLIENTE_PG.map((v) => [env[v] !== undefined, `${v} definida`]),
  ];
  const violada = regras.find(([desvio]) => desvio);
  return violada === undefined ? null : violada[1];
}

/** Comandos do modelo SQL do papel (um por posição, sem comentários nem `;`), com o marcador trocado pelo banco de origem controlado. O modelo em si nunca é alterado. */
function comandosDoModelo(texto, banco) {
  if (!nomeValido(banco)) throw new TypeError('nome de banco fora do padrão controlado');
  if (!texto.includes('DATABASE A_PREENCHER')) throw new TypeError('marcador do banco ausente no modelo');
  return texto.split('\n').filter((linha) => !/^\s*--/.test(linha)).join('\n').split(';')
    .map((c) => c.replace(/\s+/g, ' ').trim()).filter((c) => c !== '')
    .map((c) => c.replace('DATABASE A_PREENCHER', `DATABASE ${banco}`));
}

/** Parâmetros que identificam a instância, numa só consulta. `current_setting` é o equivalente funcional do `SHOW`: mesma função interna, mesmo texto e mesma exigência de permissão (erro se o papel não puder ler). */
async function parametrosDaInstancia(cliente) {
  const { rows: [parametros] } = await cliente.query(SQL_PARAMETROS_DA_INSTANCIA);
  return parametros;
}

/** Cria o papel B-1 pelo modelo SQL e devolve o retrato dos privilégios: objetos sem SELECT antes e depois das concessões e os atributos do papel. */
async function provisionarPapelB1(cliente, banco) {
  const modelo = fs.readFileSync(path.join(BACKEND, 'ops', 'sql', 'papel-executor-backup.sql.modelo'), 'utf8');
  for (const comando of comandosDoModelo(modelo, banco)) await cliente.query(comando);
  await cliente.query(`ALTER ROLE ${H.PAPEL_B1} CONNECTION LIMIT 6`);
  const objetosSemSelect = async () => (await cliente.query(H.VERIFICACAO_B1)).rows;
  const antes = await objetosSemSelect();
  for (const sql of H.GRANTS_B1) await cliente.query(sql);
  const { rows: [atributos] } = await cliente.query(SQL_ATRIBUTOS_DO_PAPEL, [H.PAPEL_B1]);
  return { antes: antes.length, depois: await objetosSemSelect(), atributos };
}

const limitar = (promessa, rotulo) => {
  let temporizador;
  const limite = new Promise((_, rejeitar) => { temporizador = setTimeout(() => rejeitar(new Error(`C3_TEMPO_ESGOTADO: ${rotulo}`)), ESPERA_MAXIMA_MS); });
  return Promise.race([promessa, limite]).finally(() => clearTimeout(temporizador));
};

const AREA_DO_ENSAIO = /^\/private\/tmp\/swb-[0-9]{14}-[0-9]{1,5}\/c3est-[0-9a-f]{12}$/;

/**
 * Remove a área exclusiva do ensaio SÓ se TODA a identidade conferir; devolve a lista de problemas (vazia = removida ou já inexistente). Nunca remove nada fora do padrão
 * `/private/tmp/swb-<AAAAMMDDHHMMSS>-<n>/c3est-<12 hex>` filha direta do diretório da instância declarada, e recusa (sem remover nada) link simbólico, caminho não canônico, dono diferente do
 * usuário corrente, modo diferente de 0700, outro dispositivo e qualquer entrada interna que seja link, de outro dono ou de outro dispositivo.
 */
function removerAreaDoEnsaio(area, pgdata) {
  const recusa = (motivo) => [`área do ensaio NÃO removida: ${motivo}`];
  if (typeof area !== 'string' || typeof pgdata !== 'string' || !PADRAO_PGDATA.test(pgdata) || !AREA_DO_ENSAIO.test(area) || path.dirname(area) !== path.dirname(pgdata)) return recusa('fora do padrão exclusivo');
  let st;
  try { st = fs.lstatSync(area); } catch (e) { return e.code === 'ENOENT' ? [] : recusa('não foi possível ler os metadados'); }
  if (st.isSymbolicLink() || !st.isDirectory()) return recusa('não é um diretório (ou é link simbólico)');
  let pai;
  try { pai = fs.lstatSync(path.dirname(area)); } catch { return recusa('diretório da instância ilegível'); }
  if (pai.isSymbolicLink() || !pai.isDirectory()) return recusa('diretório da instância inválido');
  if (fs.realpathSync(area) !== area) return recusa('caminho não canônico');
  if (typeof process.getuid !== 'function' || st.uid !== process.getuid()) return recusa('dono diferente do usuário corrente');
  if ((st.mode & 0o777) !== 0o700) return recusa('modo diferente de 0700');
  if (st.dev !== pai.dev) return recusa('dispositivo diferente do da instância');
  try {
    for (const entrada of fs.readdirSync(area, { recursive: true, withFileTypes: true })) {
      const caminho = path.join(entrada.parentPath ?? entrada.path, entrada.name);
      const e = fs.lstatSync(caminho);
      if (e.isSymbolicLink()) return recusa('há link simbólico dentro da área');
      if (e.uid !== process.getuid()) return recusa('há entrada de outro dono dentro da área');
      if (e.dev !== st.dev) return recusa('há entrada em outro dispositivo dentro da área');
    }
    fs.rmSync(area, { recursive: true });
  } catch (e) {
    return recusa(`falha ao varrer ou remover (${e.code ?? 'sem código'})`);
  }
  return [];
}

const SO_NA_INSTANCIA_EFEMERA_LOCAL = process.env.SWB_PGDATA === undefined
  ? 'C3_SO_NA_INSTANCIA_EFEMERA_LOCAL: SWB_PGDATA ausente; esta suíte só roda na instância efêmera local declarada por SWB_PGDATA'
  : (process.env.SWB_CONS03 !== '1' ? 'C3_NAO_AUTORIZADO: SWB_CONS03=1 ausente; o ensaio exige autorização própria' : false);

describe('[CONS03-REAL] verificação estrutural real do dump (pg_restore --list supervisionado), instância efêmera exclusiva, só TESTE_CONTROLADO', { skip: SO_NA_INSTANCIA_EFEMERA_LOCAL }, () => {
  const base = SO_NA_INSTANCIA_EFEMERA_LOCAL === false ? { ...configuracaoDoBancoDeTeste(), connectionTimeoutMillis: 8000 } : null;
  const abertos = [];
  const imagens = [];
  const medidas = {};
  let admin = null;
  let ctx = null;
  let nomeOrigem = null;
  let papeisAntes = [];
  let papeisCapturados = false;
  let bancoCriado = false;
  let areaDoEnsaio = null;
  const pidsRastreados = new Set();

  const baseDe = (banco, usuario = base.user) => ({ ...base, database: banco, user: usuario, password: undefined });
  const novoCliente = (banco, usuario) => { const c = new Client(baseDe(banco, usuario)); abertos.push(c); return c; };
  const bancosDaInstancia = async () => (await admin.query('SELECT datname FROM pg_database ORDER BY 1')).rows.map((r) => r.datname);
  async function noBanco(banco, fn) {
    const c = new Client(baseDe(banco));
    await c.connect();
    try { return await fn(c); } finally { await c.end().catch(() => {}); }
  }
  const linhasDoCmd = (cmd, args) => cp.execFileSync(cmd, args, { env: {}, encoding: 'latin1', maxBuffer: 64 * 1024 * 1024, timeout: 60000 });
  const entradasDoSumario = (texto) => { const m = /^;\s+TOC Entries:\s+(\d{1,9})\s*$/m.exec(texto); return m === null ? null : Number(m[1]); };
  const processosDaArea = () => cp.execFileSync('/bin/ps', ['-axww', '-o', 'pid=,command='], { encoding: 'utf8' }).split('\n').filter((l) => l.includes(ctx.area));
  const dumpPublicado = (dirDePublicados, nome) => path.join(dirDePublicados, nome, 'dump', 'postgres.dump');
  const configDoBackup = (dirs, binarios, nomeDoPacote) => H.montarConfigDoBackup({ ...ctx, dirs, binarios, nomeOrigem, nomeDoPacote, criarConexao: () => novoCliente(nomeOrigem, H.PAPEL_B1) });

  /**
   * O pid NÃO está comprovadamente encerrado? Só leitura (`ps -p`): nunca envia sinal. Só vale "encerrado" com prova: `ps` com status 1 e stdout e stderr vazios (pid inexistente), ou `ps`
   * com status 0 mostrando outro comando (pid reaproveitado, o `pg_restore` não está mais lá). Processo ainda `pg_restore`, falha ao executar o `ps`, tempo esgotado, status inesperado,
   * texto no stderr ou saída vazia com status 0 são todos "não encerrado" (ambíguo bloqueia a limpeza e preserva a área para investigação).
   */
  const pgRestoreNaoEncerrado = (pid) => {
    try {
      const saida = cp.execFileSync('/bin/ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 });
      return saida.trim() === '' || saida.includes('pg_restore');
    } catch (e) {
      const semTexto = (v) => v === undefined || v === null || String(v).trim() === '';
      return !(e.status === 1 && e.signal == null && e.code === undefined && semTexto(e.stdout) && semTexto(e.stderr));
    }
  };
  const rastrearPids = (texto) => { for (const m of String(texto).matchAll(/"pid":([1-9][0-9]+)/g)) pidsRastreados.add(Number(m[1])); };

  /**
   * Lança o `pg_restore --list` REAL pelo lançador estrutural de produção sobre `arquivo` e devolve término, fluxos e sumário restrito. O pid é rastreado assim que o processo nasce. Em
   * tempo esgotado NENHUM sinal é enviado (política de encerramento protegido: o processo é identificado, não morto às cegas); o erro traz o pid e o teste C3-06 e o roteiro V15 reprovam
   * enquanto o processo existir.
   */
  async function listarComLancadorReal(arquivo) {
    const fd = fs.openSync(arquivo, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let pid = null;
    try {
      const lancador = criarLancadorEstruturalReal();
      const spec = { executavel: ctx.binarios.restore, argumentos: ['--list'], ambiente: {}, opcoes: { shell: false, detached: true, stdio: [fd, 'pipe', 'ignore'] } };
      const processo = await limitar(lancador.lancar(spec), 'lancar');
      pid = processo.pid;
      pidsRastreados.add(pid);
      const saida = await limitar(processo.saida, 'saida');
      await limitar(processo.fluxosFechados, 'fluxosFechados');
      const resumo = await limitar(processo.resultado, 'resultado');
      return { pid, saida, resumo, registros: lancador.situacao() };
    } catch (erro) {
      if (pid !== null) erro.message = `${erro.message} (pg_restore pid ${pid} rastreado; nenhum sinal foi enviado; identifique o processo antes de qualquer ação)`;
      throw erro;
    } finally {
      fs.closeSync(fd);
    }
  }

  /** Semeia as imagens sintéticas: primeiro o armazenamento da origem, depois as linhas no banco de origem (mesma ordem do ensaio original). */
  async function semear(diretorio) {
    const origem = criarArmazenamentoImagens({ diretorio });
    await noBanco(nomeOrigem, async (c) => { imagens.push(...await semearImagensSinteticas({ armazenamento: origem, cliente: c, nomeOrigem })); });
  }

  before(async () => {
    const motivo = motivoDeRecusaDoAmbiente(process.env);
    assert.equal(motivo, null, `ambiente recusado: ${motivo}`);
    const { SWB_PGDATA, SWB_PORT, DB_HOST, DB_USER } = process.env;
    const binarios = localizarBinarios(process.env);

    admin = new Client(base);
    await admin.connect();
    await confirmarBancoDeTeste(admin);
    const parametros = await parametrosDaInstancia(admin);
    assert.deepEqual({ data_directory: parametros.data_directory, port: parametros.port, listen_addresses: parametros.listen_addresses }, { data_directory: SWB_PGDATA, port: SWB_PORT, listen_addresses: '' }, 'a instância difere da autorizada');
    assert.ok(parametros.unix_socket_directories.split(',').map((s) => s.trim()).includes(DB_HOST), 'DB_HOST não é o socket da instância');
    assert.match(parametros.server_version, /^16\./);
    assert.deepEqual(await bancosDaInstancia(), ordenados(H.BANCOS_BASE), 'a instância tem bancos além dos quatro de base');
    papeisAntes = (await admin.query('SELECT rolname FROM pg_roles ORDER BY rolname')).rows.map((r) => r.rolname);
    papeisCapturados = true;
    assert.ok(!papeisAntes.includes(H.PAPEL_B1), `o papel ${H.PAPEL_B1} já existe na instância: o ensaio não o toca`);

    const area = path.join(path.dirname(SWB_PGDATA), `c3est-${crypto.randomBytes(6).toString('hex')}`);
    assert.match(area, AREA_DO_ENSAIO);
    fs.mkdirSync(area, { mode: 0o700 });
    areaDoEnsaio = area;
    assert.equal(fs.realpathSync(area), area);
    const criarDirs = (raiz, nomes) => Object.fromEntries(nomes.map((d) => { const p = path.join(raiz, d); fs.mkdirSync(p, { mode: 0o700 }); return [d, p]; }));
    const dirs = criarDirs(area, ['imagens', 'preparacoes', 'dumps', 'publicados', 'seg']);
    const raizAdulterada = path.join(area, 'adulterada');
    fs.mkdirSync(raizAdulterada, { mode: 0o700 });
    const dirsAdulterado = { imagens: dirs.imagens, ...criarDirs(raizAdulterada, ['preparacoes', 'dumps', 'publicados']) };
    const arquivoDeSenha = path.join(dirs.seg, 'pgpass');
    fs.writeFileSync(arquivoDeSenha, [DB_USER, H.PAPEL_B1].flatMap((u) => [DB_HOST, 'localhost'].map((h) => `${h}:${SWB_PORT}:*:${u}:ficticia\n`)).join(''), { mode: 0o600 });

    nomeOrigem = `${PREFIXO_ORIGEM}${crypto.randomBytes(6).toString('hex')}`;
    assert.ok(nomeValido(nomeOrigem));
    assert.equal((await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [nomeOrigem])).rowCount, 0, 'banco já existe: nunca reutilizar');
    await admin.query(`CREATE DATABASE ${nomeOrigem} OWNER ${base.user} TEMPLATE template0`);
    bancoCriado = true;
    const oidOrigem = (await admin.query('SELECT oid::text AS oid FROM pg_database WHERE datname = $1', [nomeOrigem])).rows[0].oid;
    const fonteDeChaves = criarFonteDeChaves({ origem: 'TESTE_CONTROLADO', chaves: [{ id: 'mac-c3', segredo: crypto.randomBytes(32) }] });
    ctx = {
      area, dirs, dirsAdulterado, raizAdulterada, arquivoDeSenha, binarios, host: DB_HOST, porta: Number(SWB_PORT), usuario: DB_USER, oidOrigem,
      nomeValido: `prep-c3-ok-${crypto.randomBytes(4).toString('hex')}`, nomeAdulterado: `prep-c3-ruim-${crypto.randomBytes(4).toString('hex')}`,
      conjuntoId: `conjunto-c3-${crypto.randomBytes(4).toString('hex')}`, fonteDeChaves, chaveId: 'mac-c3',
    };

    const saida = cp.execFileSync(process.execPath, ['-e', FILHO], {
      cwd: BACKEND, encoding: 'utf8', timeout: 240000,
      env: { PATH: process.env.PATH, NODE_ENV: 'test', DB_HOST, DB_PORT: SWB_PORT, DB_NAME: nomeOrigem, DB_USER, ...(process.env.DB_PASSWORD === undefined ? {} : { DB_PASSWORD: process.env.DB_PASSWORD }), C3_NOME: nomeOrigem, C3_PGDATA: SWB_PGDATA, C3_PORTA: SWB_PORT, C3_DIRETORIO: DIRETORIO_MIGRATIONS },
    });
    assert.equal(saida.trim().split('\n').pop(), `C3_MIGRATIONS ${listarMigrations(DIRETORIO_MIGRATIONS).length}`);
    await semear(dirs.imagens);
  }, { timeout: 420000 });

  /** Remove SÓ o que este ensaio criou, na ordem de sempre; cada falha é acumulada e a limpeza incompleta reprova ao final. */
  async function limpar() {
    const falhas = [];
    try {
      for (const c of abertos) await c.end().catch(() => {});
      if (admin !== null) {
        // só remove o que ESTE ensaio criou: o banco só depois do CREATE confirmado; o papel só se a lista de papéis foi capturada e ele NÃO existia antes (um papel preexistente nunca é tocado)
        if (bancoCriado) {
          if (!nomeValido(nomeOrigem)) falhas.push('nome fora do padrão não removido');
          else await admin.query(`DROP DATABASE IF EXISTS ${nomeOrigem} WITH (FORCE)`).catch((e) => falhas.push(`banco não removido (${e.code ?? 'sem código'})`));
        }
        if (papeisCapturados && !papeisAntes.includes(H.PAPEL_B1)) await admin.query(`DROP ROLE IF EXISTS ${H.PAPEL_B1}`).catch((e) => falhas.push(`papel não removido (${e.code ?? 'sem código'})`));
        if (papeisCapturados) {
          const depois = (await admin.query('SELECT rolname FROM pg_roles ORDER BY rolname').catch(() => ({ rows: [] }))).rows.map((r) => r.rolname);
          if (JSON.stringify(depois) !== JSON.stringify(papeisAntes)) falhas.push('a lista de papéis mudou depois da limpeza');
        }
        if ((await bancosDaInstancia().catch(() => [])).some((n) => n.startsWith('gepi_c3_'))) falhas.push('bancos gepi_c3_ restantes');
      }
    } finally {
      if (admin !== null) await admin.end().catch(() => {});
      // pg_restore rastreado ainda vivo: NÃO se sinaliza nada aqui (encerramento protegido); registra o pid e preserva a área para identificação
      const vivos = [...pidsRastreados].filter(pgRestoreNaoEncerrado);
      if (vivos.length > 0) falhas.push(`pg_restore não comprovadamente encerrado (pids ${vivos.join(',')}: ainda ativo ou consulta ao ps inconclusiva); nenhum sinal enviado; área preservada para investigação`);
      else if (areaDoEnsaio !== null) falhas.push(...removerAreaDoEnsaio(areaDoEnsaio, process.env.SWB_PGDATA));
      if (falhas.length > 0) process.stderr.write(`C3_LIMPEZA: ${falhas.join('; ')}\n`);
    }
    assert.deepEqual(falhas, [], 'limpeza do ensaio incompleta');
  }

  after(limpar);

  test('C3-01 — isolamento e papel B-1: instância exclusiva, origem com migrations e 2 imagens, papel criado pelo modelo SQL, zero objetos sem SELECT depois das concessões', async () => {
    assert.deepEqual((await bancosDaInstancia()).filter((n) => !H.BANCOS_BASE.includes(n)), [nomeOrigem]);
    assert.equal(imagens.length, 2);
    const { antes, depois, atributos } = await noBanco(nomeOrigem, async (c) => {
      assert.equal((await c.query('SELECT count(*)::int AS n FROM imagens_padrao')).rows[0].n, 2);
      return provisionarPapelB1(c, nomeOrigem);
    });
    assert.ok(antes > 0, 'antes da concessão a verificação precisa listar objetos');
    assert.deepEqual(depois, []);
    assert.deepEqual({ ...atributos }, ATRIBUTOS_DO_PAPEL_B1);
    observar('isolamento-e-papel', { versao: (await admin.query('SHOW server_version')).rows[0].server_version, migrations: listarMigrations(DIRETORIO_MIGRATIONS).length, objetosSemSelectDepois: depois.length, papel: H.PAPEL_B1 });
  });

  test('C3-02 — dump VÁLIDO pela composição real: a evidência estrutural é PG_RESTORE_LIST_SUPERVISIONADO, ok, CUSTOM, com bytes e SHA-256 do dump e um processo pg_restore real iniciado e encerrado', async () => {
    const config = configDoBackup(ctx.dirs, ctx.binarios, ctx.nomeValido);
    const composto = await criarBackupDeProducao(config).executar({ nomeDaPreparacao: ctx.nomeValido, conjuntoId: ctx.conjuntoId });
    const { composicao, pacote, publicacao, correlacao } = composto.resultado;
    const { pacotePublicado, publicacaoOperacional, recuperabilidadeComprovada } = classificarEstadoDoBackup(composto);
    assert.deepEqual([composicao?.ok, composicao?.layout, pacote?.ok, pacotePublicado], [true, 2, true, true], JSON.stringify({ composicao, pacote, publicacao }));
    assert.deepEqual([publicacaoOperacional, recuperabilidadeComprovada], [false, false]);
    const dump = fs.readFileSync(dumpPublicado(ctx.dirs.publicados, ctx.nomeValido));
    assert.equal(sha(dump), composto.proveniencia.hashDoDump.SHA256_ARQUIVO_PERSISTIDO);
    const e = correlacao.estrutura;
    assert.equal(ehEvidenciaEstrutural(e), true, 'a evidência não foi produzida pelo verificador estrutural de produção');
    assert.deepEqual({ ok: e.ok, origem: e.origem, escopo: e.escopo, concluida: e.concluida, formato: e.formato }, { ok: true, origem: 'PG_RESTORE_LIST_SUPERVISIONADO', escopo: 'LISTAGEM_DO_SUMARIO', concluida: true, formato: 'CUSTOM' }, JSON.stringify(e));
    assert.ok(Number.isSafeInteger(e.entradas) && e.entradas > 0, `entradas ${e.entradas}`);
    assert.deepEqual([e.bytes, e.sha256], [dump.length, sha(dump)]);
    rastrearPids(JSON.stringify(composto.proveniencia.processosDaListagem));
    assert.match(JSON.stringify(composto.proveniencia.processosDaListagem), /"pid":[1-9][0-9]+/, 'nenhum processo pg_restore real registrado');
    for (const c of abertos.splice(0)) await c.end().catch(() => {});
    Object.assign(medidas, { dumpValido: { bytes: dump.length, sha256: sha(dump), entradas: e.entradas }, caminhoDump: dumpPublicado(ctx.dirs.publicados, ctx.nomeValido) });
    observar('dump-valido', { estrutura: { ok: e.ok, origem: e.origem, escopo: e.escopo, formato: e.formato, entradas: e.entradas, bytes: e.bytes, sha256: e.sha256 }, processosDaListagem: composto.proveniencia.processosDaListagem, banco: nomeOrigem });
  });

  test('C3-03 — confirmação independente: uma listagem separada do MESMO dump (pg_restore --list no teste) tem a mesma contagem de entradas que a evidência da composição', () => {
    const texto = linhasDoCmd(ctx.binarios.restore, ['--list', medidas.caminhoDump]);
    const entradas = entradasDoSumario(texto);
    assert.equal(entradas, medidas.dumpValido.entradas);
    assert.match(texto, /^;\s+Format:\s+CUSTOM\s*$/m);
    observar('confirmacao-independente', { entradasIndependentes: entradas, entradasDaComposicao: medidas.dumpValido.entradas });
  });

  test('C3-04 — lançador estrutural REAL sobre o dump válido (controle) e sobre cópias adulteradas (magia trocada e truncada): válido sai 0 com sumário; adulteradas saem diferente de 0, sem sumário', async () => {
    const original = fs.readFileSync(medidas.caminhoDump);
    const pasta = path.join(ctx.area, 'copias');
    fs.mkdirSync(pasta, { mode: 0o700 });
    const gravar = (nome, bytes) => { const alvo = path.join(pasta, nome); fs.writeFileSync(alvo, bytes, { mode: 0o600, flag: 'wx' }); return alvo; };
    const trocada = Buffer.from(original); trocada.write('XXXXX', 0, 'latin1');
    const copias = { controle: gravar('controle.dump', original), magiaTrocada: gravar('magia-trocada.dump', trocada), truncada: gravar('truncada.dump', original.subarray(0, 200)) };
    const resultados = {};
    for (const [rotulo, arquivo] of Object.entries(copias)) resultados[rotulo] = await listarComLancadorReal(arquivo);

    const c = resultados.controle;
    assert.deepEqual([c.saida.codigo, c.saida.sinal, c.resumo.formato, c.resumo.entradas], [0, null, 'CUSTOM', medidas.dumpValido.entradas], JSON.stringify(c));
    assert.ok(Number.isSafeInteger(c.pid) && c.pid > 1);
    for (const rotulo of ['magiaTrocada', 'truncada']) {
      const r = resultados[rotulo];
      assert.ok(Number.isInteger(r.saida.codigo) && r.saida.codigo !== 0 && r.saida.sinal === null, `${rotulo}: ${JSON.stringify(r.saida)}`);
      assert.deepEqual([r.resumo.formato, r.resumo.entradas], [null, null], `${rotulo}: ${JSON.stringify(r.resumo)}`);
      assert.ok(Number.isSafeInteger(r.pid) && r.pid > 1);
    }
    assert.equal(sha(fs.readFileSync(medidas.caminhoDump)), medidas.dumpValido.sha256, 'o dump publicado não pode mudar');
    observar('lancador-real', Object.fromEntries(Object.entries(resultados).map(([k, r]) => [k, { pid: r.pid, codigo: r.saida.codigo, sinal: r.saida.sinal, formato: r.resumo.formato, entradas: r.resumo.entradas, truncado: r.resumo.truncado }])));
  });

  test('C3-05 — dump ADULTERADO pela composição: com um pg_dump de ensaio que corrompe a magia da saída, T1/T2 e o hash seguem coerentes, a estrutura NÃO é ok e nenhum pacote é publicado', async () => {
    const wrapper = path.join(ctx.area, 'bin', 'pg_dump');
    fs.mkdirSync(path.dirname(wrapper), { mode: 0o700 });
    fs.writeFileSync(wrapper, `#!/bin/sh\nprintf 'XXXXX'\n"${ctx.binarios.dump}" "$@" | /usr/bin/tail -c +6\n`, { mode: 0o700, flag: 'wx' });
    const config = configDoBackup(ctx.dirsAdulterado, { dump: wrapper, restore: ctx.binarios.restore }, ctx.nomeAdulterado);
    let composto = null;
    let lancou = null;
    try { composto = await criarBackupDeProducao(config).executar({ nomeDaPreparacao: ctx.nomeAdulterado, conjuntoId: `${ctx.conjuntoId}-ruim` }); } catch (e) { lancou = { codigo: e && e.code ? String(e.code) : null, nome: e && e.name ? String(e.name) : null }; }
    for (const c of abertos.splice(0)) await c.end().catch(() => {});
    if (composto !== null) rastrearPids(JSON.stringify(composto.proveniencia.processosDaListagem));
    assert.deepEqual(fs.readdirSync(ctx.dirsAdulterado.publicados), [], 'nada pode ser publicado com a estrutura inválida');
    const r = composto === null ? null : composto.resultado;
    const e = r?.correlacao?.estrutura ?? null;
    if (composto !== null) {
      assert.notEqual(classificarEstadoDoBackup(composto).pacotePublicado, true);
      assert.notEqual(r.publicacao?.publicada, true);
    }
    // o cenário só vale como prova do CONS-03 se a verificação estrutural chegou a ser avaliada; se um estágio anterior barrou o dump, o motivo é registrado e o teste reprova (falha fechada)
    assert.notEqual(e, null, `a estrutura não foi avaliada (bloqueio anterior): ${JSON.stringify({ lancou, publicacao: r?.publicacao ?? null, composicao: r?.composicao ?? null })}`);
    assert.equal(ehEvidenciaEstrutural(e), true);
    assert.deepEqual([e.ok, e.concluida, e.origem], [false, true, 'PG_RESTORE_LIST_SUPERVISIONADO'], JSON.stringify(e));
    assert.ok(['SAIDA_NAO_ZERO', 'SUMARIO_INVALIDO'].includes(e.motivo), `motivo ${e.motivo}`);
    assert.equal(r.publicacao?.motivo, 'ESTRUTURA_NAO_VERIFICADA');
    observar('dump-adulterado-composicao', { estrutura: { ok: e.ok, concluida: e.concluida, origem: e.origem, motivo: e.motivo }, publicada: false, processosDaListagem: composto.proveniencia.processosDaListagem });
  });

  test('C3-06 — encerramento limpo: nenhum processo da área do ensaio restou, a instância só tem os bancos de base e o de origem do ensaio, e os arquivos de controle não foram alterados', async () => {
    assert.deepEqual(processosDaArea(), [], 'processo residual da área do ensaio');
    assert.ok(pidsRastreados.size >= 4, `pg_restore rastreados: ${pidsRastreados.size}`);
    assert.deepEqual([...pidsRastreados].filter(pgRestoreNaoEncerrado), [], 'pg_restore não comprovadamente encerrado (ativo ou ps inconclusivo): nenhum sinal foi enviado; identifique o processo antes de qualquer ação');
    assert.deepEqual((await bancosDaInstancia()).filter((n) => !H.BANCOS_BASE.includes(n)), [nomeOrigem]);
    assert.equal(sha(fs.readFileSync(medidas.caminhoDump)), medidas.dumpValido.sha256);
    observar('encerramento', { processosResiduais: 0, bancosDoEnsaio: 1 });
  });
});
