'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

const { configuracaoDoBancoDeTeste, confirmarBancoDeTeste, BANCO_DE_TESTE } = require('./helpers/banco-de-teste');
const { localizarBinarios, semearImagensSinteticas } = require('./helpers/backup-ensaio-fixtures');
const { listarMigrations } = require('../../src/db/checksums');
const { criarBackupDeProducao, criarRestauracaoDeProducao } = require('../../src/services/imagem-backup-composicao-producao.service');
const { montarColaboradoresReais } = require('../../src/services/backup-executor-colaboradores-reais.service');
const { adquirirExclusao } = require('../../src/services/backup-fontes-coordenacao-operacoes.service');
const { registrarEventoSistema } = require('../../src/repositories/auditoria-plataforma.repository');
const { criarFonteDeChaves } = require('../../src/services/imagem-backup-manifesto-autenticado.service');
const { criarProdutorDeRelatorio } = require('../../src/services/imagem-backup-publicacao.service');
const { criarJanelaDeBackup } = require('../../src/services/imagem-backup.service');
const { criarArmazenamentoImagens } = require('../../src/storage/armazenamento-imagens');
const Ev = require('../../src/services/backup-executor-evidencia.service');

/**
 * D-ORF-6, H9-h [H9H-B1]: ENSAIO do candidato B-1 (SELECT por objeto) de privilégios mínimos do executor de backup e restauração, em PostgreSQL 16 efêmero local e dados sintéticos.
 * Backup: coordenação (advisory locks), auditoria, snapshot, inventário, pg_dump, pacote L2 e verificação, tudo pela composição real de produção (montarColaboradoresReais + criarBackupDeProducao) COM O PAPEL MÍNIMO,
 * nunca com o administrador da instância. Restauração: criarRestauracaoDeProducao com um papel não administrativo que é dono apenas do banco de destino novo. Só roda com SWB_PGDATA e SWB_H9H_B1=1.
 * Nada aqui promove recuperabilidade em produção nem prova operação real. O modelo SQL do repositório é lido, não alterado. Os papéis, bancos e diretórios criados são removidos no `after`.
 */

const PORTAS_PROTEGIDAS = Object.freeze([5432, 55460]);
const PADRAO_PGDATA = /^\/private\/tmp\/swb-[0-9]{14}-[0-9]{1,5}\/pgdata$/;
const PREFIXO_ORIGEM = 'gepi_h9h_origem_';
const PREFIXO_RESTAURADO = 'gepi_h9h_rest_';
const PREFIXO_OUTRO = 'gepi_h9h_outro_';
const NOME_ORIGEM = /^gepi_h9h_origem_[0-9a-f]{12}$/;
const NOME_RESTAURADO = /^gepi_h9h_rest_[0-9a-f]{12}$/;
const NOME_OUTRO = /^gepi_h9h_outro_[0-9a-f]{12}$/;
const PROTEGIDOS = Object.freeze([BANCO_DE_TESTE, 'postgres', 'template0', 'template1', 'gestao_epi', 'homolog_local']);
const BANCOS_BASE = Object.freeze(['gestao_epi_teste_local', 'postgres', 'template0', 'template1']);
const VARIAVEIS_PG_PROIBIDAS = Object.freeze(['PGHOST', 'PGPORT', 'PGSERVICE', 'PGSERVICEFILE', 'PGDATABASE', 'PGSSLMODE']);
const DIRETORIO_MIGRATIONS = path.join(__dirname, '..', '..', 'migrations');
const BACKEND = path.join(__dirname, '..', '..');
const MODELO = path.join(BACKEND, 'ops', 'sql', 'papel-executor-backup.sql.modelo');
const PAPEL = 'safework_backup_executor';
const PAPEL_RESTAURACAO = 'safework_restore_executor';
const PAPEL_SONDA = 'h9h_sonda_probe';
const PAPEIS_DO_ENSAIO = Object.freeze([PAPEL, PAPEL_RESTAURACAO, PAPEL_SONDA]);
const LIMITE_INICIAL = 6;
const PRAZOS = Object.freeze({ totalMs: 180000, cortesiaMs: 5000, intervaloGrupoMs: 250, tentativasGrupo: 40, consultaGrupoMs: 2000 });
const MIB = 1024 * 1024;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const ordenar = (lista) => [...lista].sort((a, b) => a.localeCompare(b));
const GRANTS_B1 = Object.freeze([
  'GRANT USAGE ON SCHEMA public TO safework_backup_executor',
  'GRANT SELECT ON ALL TABLES IN SCHEMA public TO safework_backup_executor',
  'GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO safework_backup_executor',
]);
const VERIFICACAO_B1 = `SELECT c.relname, c.relkind::text AS relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'm', 'S') AND NOT has_table_privilege('${PAPEL}', c.oid, 'SELECT') ORDER BY c.relname`;

function motivoDeRecusaDoAmbiente(env) {
  if (env.SWB_H9H_B1 !== '1') return 'SWB_H9H_B1 diferente de 1';
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
const nomeValido = (n) => typeof n === 'string' && (NOME_ORIGEM.test(n) || NOME_RESTAURADO.test(n) || NOME_OUTRO.test(n)) && !PROTEGIDOS.includes(n);
const nomeRestauradoValido = (n) => typeof n === 'string' && NOME_RESTAURADO.test(n) && !PROTEGIDOS.includes(n);
const novoNome = (prefixo) => `${prefixo}${crypto.randomBytes(6).toString('hex')}`;
const comandosDoModelo = (texto) => texto.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n').split(';').map((c) => c.replace(/\s+/g, ' ').trim()).filter((c) => c !== '');
const codigoDoErro = async (promessa) => { try { await promessa; return 'ok'; } catch (e) { return e.code ?? e.message; } };

const CODIGO_DO_FILHO = `
const { Client } = require('pg');
const { aplicarMigrations } = require('./scripts/migrate');
(async () => {
  const { H9H_NOME, H9H_PGDATA, H9H_PORTA, H9H_DIRETORIO, DB_NAME, DB_HOST, DB_PORT } = process.env;
  if (!/^gepi_h9h_origem_[0-9a-f]{12}$/.test(H9H_NOME) || DB_NAME !== H9H_NOME) throw new Error('H9H_FILHO_BANCO_RECUSADO');
  if (!/^\\/private\\/tmp\\/swb-[0-9]{14}-[0-9]{1,5}\\/pgdata$/.test(H9H_PGDATA) || DB_HOST !== H9H_PGDATA.replace(/pgdata$/, 'sock') || DB_PORT !== H9H_PORTA) throw new Error('H9H_FILHO_INSTANCIA_RECUSADA');
  const c = new Client({ host: DB_HOST, port: Number(DB_PORT), database: DB_NAME, user: process.env.DB_USER });
  await c.connect();
  const q = async (sql) => (await c.query(sql)).rows[0];
  const ok = await q('SELECT current_database() AS d, current_setting(\\'data_directory\\') AS p, current_setting(\\'port\\') AS t, current_setting(\\'listen_addresses\\') AS l');
  const vazio = (await q("SELECT count(*)::int AS n FROM pg_class r JOIN pg_namespace s ON s.oid = r.relnamespace WHERE s.nspname = 'public'")).n;
  await c.end();
  if (ok.d !== H9H_NOME || ok.p !== H9H_PGDATA || ok.t !== H9H_PORTA || ok.l !== '' || vazio !== 0) throw new Error('H9H_FILHO_IDENTIDADE_RECUSADA');
  const aplicadas = await aplicarMigrations({ schema: 'public', diretorio: H9H_DIRETORIO });
  process.stdout.write('H9H_MIGRATIONS ' + aplicadas.length + '\\n');
})().catch((e) => { process.stderr.write(String(e && e.message ? e.message : e) + '\\n'); process.exit(1); });
`;

const SO_NA_INSTANCIA_EFEMERA_LOCAL = process.env.SWB_PGDATA === undefined
  ? 'H9H_SO_NA_INSTANCIA_EFEMERA_LOCAL: SWB_PGDATA ausente; esta suíte só roda na instância efêmera local declarada por SWB_PGDATA'
  : (process.env.SWB_H9H_B1 !== '1' ? 'H9H_NAO_AUTORIZADO: SWB_H9H_B1=1 ausente; o ensaio exige autorização própria' : false);

describe('[H9H-B1] papel mínimo de banco, candidato B-1: backup e restauração pela composição real (instância efêmera exclusiva)', { skip: SO_NA_INSTANCIA_EFEMERA_LOCAL }, () => {
  const base = SO_NA_INSTANCIA_EFEMERA_LOCAL === false ? { ...configuracaoDoBancoDeTeste(), connectionTimeoutMillis: 8000 } : null;
  const criadosEmMemoria = new Set();
  const clientes = [];
  const pedidos = [];
  const imagens = [];
  const resultados = { versao: 1, fases: {} };
  let admin = null;
  let ctx = null;
  let papeisAntes = [];
  let ultimoPacote = null;
  let picoMedido = 0;
  let limiteRecomendado = LIMITE_INICIAL;

  const baseDe = (nome, usuario = base.user) => ({ ...base, database: nome, user: usuario, password: undefined });
  const bancosDaInstancia = async () => (await admin.query('SELECT datname FROM pg_database ORDER BY 1')).rows.map((r) => r.datname);
  const registrar = (fase, objeto) => {
    resultados.fases[fase] = objeto;
    process.stdout.write(`H9H_OBSERVACAO_JSON ${JSON.stringify({ fase, ...objeto })}\n`);
  };
  async function criarBancoNovo(nome, dono = base.user) {
    assert.ok(nomeValido(nome), 'nome de banco fora do padrão controlado');
    const { rows } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [nome]);
    assert.equal(rows.length, 0, 'banco já existe: nunca reutilizar');
    await admin.query(`CREATE DATABASE ${nome} OWNER ${dono} TEMPLATE template0`);
    criadosEmMemoria.add(nome);
  }
  async function noBanco(nome, fn, usuario = base.user) {
    const c = new Client(baseDe(nome, usuario));
    await c.connect();
    try { return await fn(c); } finally { await c.end().catch(() => {}); }
  }
  const comoAdminNaOrigem = (fn) => noBanco(ctx.nomeOrigem, fn);
  const tabelasDe = (nome) => noBanco(nome, async (c) => (await c.query("SELECT count(*)::int AS n FROM pg_class r JOIN pg_namespace s ON s.oid = r.relnamespace WHERE s.nspname = 'public' AND r.relkind = 'r'")).rows[0].n);
  const definirLimite = (n) => admin.query(`ALTER ROLE ${PAPEL} CONNECTION LIMIT ${Number(n)}`);

  function configDoBackup(lista = ctx.criadosClientes) {
    return {
      postgres: { pgDump: ctx.binarios.dump, pgRestore: ctx.binarios.restore, host: ctx.host, porta: ctx.porta, usuario: PAPEL, arquivoDeSenha: ctx.arquivoDeSenha, banco: { nome: ctx.nomeOrigem, oid: ctx.oidOrigem } },
      conexao: { criarConexao: () => { const c = new Client(baseDe(ctx.nomeOrigem, PAPEL)); lista.push(c); return c; }, finalizacaoMs: 30000 },
      armazenamento: { imagens: ctx.dirs.imagens, preparacoes: ctx.dirs.preparacoes, dumps: ctx.dirs.dumps, publicados: ctx.dirs.publicados },
      chaves: { fonteDeChaves: ctx.fonteDeChaves, chaveId: ctx.chaveId },
      relatorio: { produtor: criarProdutorDeRelatorio({ origem: 'TESTE_CONTROLADO', decidir: () => ({ ok: true }) }), origensAceitas: ['TESTE_CONTROLADO'] },
      prazos: { ...PRAZOS },
      maxBytesPorArquivo: MIB,
      janela: criarJanelaDeBackup({ arquivo: path.join(ctx.area, `janela-${crypto.randomBytes(4).toString('hex')}.lock`), raizArmazenamento: ctx.dirs.imagens }),
      limites: { totalBytes: 512 * MIB, maxBytesDoDump: 256 * MIB, bytesLivresMinimos: 1024 * MIB },
      layoutDoManifesto: 2,
      fontes: ['imagens'],
    };
  }
  function configDaRestauracao(usuario) {
    return {
      postgres: { pgRestore: ctx.binarios.restore },
      politicaDeDestino: { prefixoDoBanco: PREFIXO_RESTAURADO, hostsAutorizados: [ctx.host], bancosProtegidos: [...PROTEGIDOS] },
      fonteDeChaves: ctx.fonteDeChaves,
      criarConexaoDoBanco: (nome) => {
        pedidos.push(nome);
        if (typeof nome !== 'string' || !criadosEmMemoria.has(nome)) { const e = new Error('H9H_BANCO_NAO_AUTORIZADO'); e.code = 'H9H_BANCO_NAO_AUTORIZADO'; throw e; }
        const c = new Client(baseDe(nome, usuario));
        ctx.criadosClientes.push(c);
        return c;
      },
      prazos: { ...PRAZOS },
    };
  }

  function linhaDeEvidencia(operacaoId, estado) {
    let t = 1_800_000_000_000;
    const relogio = () => (t += 10);
    try {
      const ev = Ev.criarEvidencia({ modo: 'ENSAIO', acao: 'BACKUP', ambiente: 'HOMOLOGACAO', destinoId: 'hml-s3-principal', relogio, operacaoId });
      for (const e of Ev.ETAPAS.BACKUP.slice(0, 2)) ev.etapa(e, estado === 'CONCLUIDO');
      return { tipo: 'BACKUP', linha: ev.encerrar(estado === 'CONCLUIDO'
        ? { estado: 'CONCLUIDO', verificacaoIndependente: 'PENDENTE', origemDeChaves: 'TESTE_CONTROLADO', origemDoDestino: 'TESTE_CONTROLADO' }
        : { estado: 'FALHOU', codigo: 'PRODUCAO_FALHOU', falhouEm: 'PRODUCAO' }).linha };
    } catch {
      const ev = Ev.criarEvidencia({ modo: 'ENSAIO', acao: 'VERIFICACAO_DESTINO', ambiente: 'HOMOLOGACAO', destinoId: 'hml-s3-principal', relogio, operacaoId });
      if (estado === 'CONCLUIDO') { ev.etapa('VERIFICAR_DESTINO', true); return { tipo: 'VERIFICACAO_DESTINO', linha: ev.encerrar({ estado: 'CONCLUIDO', verificacaoIndependente: 'CONFORME', origemDeChaves: 'TESTE_CONTROLADO', origemDoDestino: 'TESTE_CONTROLADO' }).linha }; }
      ev.etapa('VERIFICAR_DESTINO', false, 'DESTINO_INDISPONIVEL');
      return { tipo: 'VERIFICACAO_DESTINO', linha: ev.encerrar({ estado: 'FALHOU', codigo: 'DESTINO_INDISPONIVEL', falhouEm: 'VERIFICAR_DESTINO' }).linha };
    }
  }

  function iniciarAmostragem() {
    const estado = { parar: false, pico: 0, picoPorAplicacao: {}, amostras: 0, etiquetas: new Set() };
    const etiquetas = [[/pg_export_snapshot/i, 'pg_export_snapshot'], [/SET TRANSACTION SNAPSHOT/i, 'SET TRANSACTION SNAPSHOT'], [/pg_try_advisory_lock/i, 'pg_try_advisory_lock'], [/COPY /i, 'COPY'], [/INSERT INTO logs_auditoria_plataforma/i, 'INSERT auditoria'], [/pg_advisory_unlock/i, 'pg_advisory_unlock']];
    const laco = (async () => {
      while (!estado.parar) {
        try {
          const { rows } = await admin.query('SELECT application_name AS app, left(query, 300) AS q FROM pg_stat_activity WHERE usename = $1 AND pid <> pg_backend_pid()', [PAPEL]);
          estado.amostras += 1;
          estado.pico = Math.max(estado.pico, rows.length);
          const porApp = {};
          for (const r of rows) {
            const app = r.app === '' ? '(sem nome)' : r.app;
            porApp[app] = (porApp[app] ?? 0) + 1;
            for (const [re, nome] of etiquetas) if (re.test(r.q)) estado.etiquetas.add(nome);
          }
          for (const [app, n] of Object.entries(porApp)) estado.picoPorAplicacao[app] = Math.max(estado.picoPorAplicacao[app] ?? 0, n);
        } catch { /* a amostragem nunca interrompe o ensaio */ }
        await new Promise((r) => setTimeout(r, 15));
      }
    })();
    return { async parar() { estado.parar = true; await laco; return { ...estado, etiquetas: [...estado.etiquetas].sort((a, b) => a.localeCompare(b)) }; } };
  }

  // A exclusão de migração só é concedida se nenhuma trava de backup estiver presa NO BANCO DE ORIGEM (travas advisory valem por banco).
  async function exclusaoDeMigracaoLivre() {
    const sessao = new Client(baseDe(ctx.nomeOrigem));
    ctx.criadosClientes.push(sessao);
    await sessao.connect();
    try {
      const t = await adquirirExclusao(sessao, { operacao: 'MIGRACAO' });
      if (t.ok === true) await t.liberar();
      return t.ok === true;
    } finally { await sessao.end().catch(() => {}); }
  }

  // Backup completo COMO O PAPEL, pelas peças reais: sessão de coordenação, sessão de auditoria, produção (snapshot, inventário, pg_dump, pacote L2, verificação) e auditoria do desfecho.
  async function rodarBackupComoPapel(rotulo, { verificarExclusao = false } = {}) {
    const operacaoId = crypto.randomBytes(16).toString('hex');
    const conjuntoId = `conjunto-h9h-${crypto.randomBytes(4).toString('hex')}`;
    const saida = { rotulo, operacaoId, sessoes: 'ok', coordenacao: null, producao: null, auditoria: null, exclusaoRecusada: null, pacoteExiste: false, quedaEmSessao: null };
    const sessaoCoord = new Client(baseDe(ctx.nomeOrigem, PAPEL));
    const sessaoAud = new Client(baseDe(ctx.nomeOrigem, PAPEL));
    ctx.criadosClientes.push(sessaoCoord, sessaoAud);
    const proprios = [];
    let amostragem = null;
    try {
      try { await sessaoCoord.connect(); await sessaoAud.connect(); } catch (e) { saida.sessoes = e.code ?? 'FALHOU'; saida.quedaEmSessao = String(e.message).slice(0, 160); return saida; }
      amostragem = iniciarAmostragem();
      const pecas = montarColaboradoresReais({ acao: 'BACKUP', executorDeCoordenacao: sessaoCoord, executorDeAuditoria: sessaoAud, registrarEventoSistema, relogio: () => Date.now(), backup: { composicao: configDoBackup(proprios) } });
      const obtida = await pecas.coordenacao.adquirir({ operacao: 'BACKUP' });
      saida.coordenacao = obtida.ok === true ? 'ok' : (obtida.motivo ?? 'recusada');
      if (obtida.ok === true) {
        if (verificarExclusao) {
          // as travas advisory valem por BANCO: a tentativa de migração tem de vir de uma sessão no mesmo banco (origem), como a migração real
          const migracao = new Client(baseDe(ctx.nomeOrigem));
          ctx.criadosClientes.push(migracao);
          await migracao.connect();
          try {
            const tentativa = await adquirirExclusao(migracao, { operacao: 'MIGRACAO' });
            saida.exclusaoRecusada = tentativa.ok === false;
            if (tentativa.ok === true) await tentativa.liberar();
          } finally { await migracao.end().catch(() => {}); }
        }
        const r = await pecas.producao.produzir({ operacaoId, conjuntoId });
        saida.producao = r.ok === true ? { ok: true, sha256Manifesto: r.pacote.lido.identidade.sha256Manifesto } : { ok: false, codigo: r.codigo };
        saida.pacoteExiste = fs.existsSync(path.join(ctx.dirs.publicados, `l2-${operacaoId}`, 'dump', 'postgres.dump'));
        const { tipo, linha } = linhaDeEvidencia(operacaoId, r.ok === true ? 'CONCLUIDO' : 'FALHOU');
        const aud = await pecas.auditoria.registrar({ linha });
        saida.auditoria = { gravado: aud.gravado === true, codigo: aud.codigo ?? null, tipoDaEvidencia: tipo, usuarioDaSessao: (await sessaoAud.query('SELECT current_user AS u, session_user AS s')).rows[0] };
        await obtida.liberar();
      }
    } finally {
      if (amostragem !== null) saida.amostragem = await amostragem.parar();
      await sessaoCoord.end().catch(() => {});
      await sessaoAud.end().catch(() => {});
      // Conexões que a composição deixou abertas depois de terminar (medição). Em produção o processo do CLI encerra e o servidor as derruba; aqui o ensaio as fecha para não contaminar a próxima execução.
      await new Promise((resolve) => setTimeout(resolve, 300));
      saida.conexoesResiduaisDaComposicao = (await admin.query('SELECT state, left(query, 80) AS q FROM pg_stat_activity WHERE usename = $1 AND pid <> pg_backend_pid()', [PAPEL])).rows;
      for (const c of proprios) await c.end().catch(() => {});
    }
    return saida;
  }

  // Diagnóstico da falha: a mesma composição, chamada diretamente, para ver se o resultado nomeia o objeto sem permissão.
  async function diagnosticarFalhaDaComposicao(objetoEsperado) {
    const nome = `l2-${crypto.randomBytes(16).toString('hex')}`;
    let texto = '';
    const proprios = [];
    try {
      const composto = await criarBackupDeProducao(configDoBackup(proprios)).executar({ nomeDaPreparacao: nome, conjuntoId: `conjunto-diag-${crypto.randomBytes(3).toString('hex')}` });
      texto = JSON.stringify(composto.resultado ?? composto);
    } catch (e) { texto = String(e.code ?? e.message); } finally { for (const c of proprios) await c.end().catch(() => {}); }
    return { nomeadoNaComposicao: texto.includes(objetoEsperado), amostraDoResultado: texto.replace(/\s+/g, ' ').slice(0, 600), pacoteExiste: fs.existsSync(path.join(ctx.dirs.publicados, nome)) };
  }

  async function matrizEfetiva(cliente, papel) {
    const { rows } = await cliente.query(`SELECT c.relname, c.relkind::text AS relkind, pg_get_userbyid(c.relowner) AS dono,
      CASE WHEN c.relkind = 'S' THEN ARRAY(SELECT p FROM unnest(ARRAY['USAGE','SELECT','UPDATE']) p WHERE has_sequence_privilege($1::name, c.oid, p))
           ELSE ARRAY(SELECT p FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p WHERE has_table_privilege($1::name, c.oid, p)) END AS privilegios
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','p','m','S','v') ORDER BY 1`, [papel]);
    const grupos = {};
    for (const r of rows) {
      const chave = `${r.relkind}:${r.privilegios.join('+') || '(nenhum)'}`;
      (grupos[chave] ??= []).push(r.relname);
    }
    const resumo = Object.fromEntries(Object.entries(grupos).map(([k, v]) => [k, { quantidade: v.length, exemplos: v.slice(0, 4) }]));
    const { rows: [g] } = await cliente.query(`SELECT has_database_privilege($1::name, current_database(), 'CONNECT') AS connect, has_database_privilege($1::name, current_database(), 'CREATE') AS criar_esquema,
      has_database_privilege($1::name, current_database(), 'TEMP') AS temp, has_schema_privilege($1::name, 'public', 'USAGE') AS usage_public, has_schema_privilege($1::name, 'public', 'CREATE') AS create_public,
      (SELECT count(*)::int FROM pg_class c WHERE c.relowner = (SELECT oid FROM pg_roles WHERE rolname = $1::name)) AS objetos_do_papel`, [papel]);
    const { rows: [a] } = await cliente.query('SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolcanlogin, rolconnlimit FROM pg_roles WHERE rolname = $1', [papel]);
    const { rows: [m] } = await cliente.query('SELECT count(*)::int AS n FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = $1', [papel]);
    return { relacoes: rows.length, grupos: resumo, banco: g, atributos: a, membroDe: m.n };
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
    assert.match(await mostrar('server_version'), /^16\./);
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = \'public\'')).rows[0].n, 0, 'public do banco de teste não está vazio');
    assert.deepEqual(await bancosDaInstancia(), ordenar(BANCOS_BASE), 'a instância tem bancos além dos quatro de base');
    papeisAntes = (await admin.query('SELECT rolname FROM pg_roles ORDER BY rolname')).rows.map((r) => r.rolname);
    for (const p of PAPEIS_DO_ENSAIO) assert.ok(!papeisAntes.includes(p), `o papel ${p} já existe na instância: o ensaio não o toca`);

    const instancia = path.dirname(SWB_PGDATA);
    const area = path.join(instancia, `b3e2e-h9h-${crypto.randomBytes(6).toString('hex')}`);
    fs.mkdirSync(area, { mode: 0o700 });
    assert.equal(fs.realpathSync(area), area);
    const dirs = {};
    for (const d of ['imagens', 'preparacoes', 'dumps', 'publicados', 'seg', 'restauradoImagens']) { dirs[d] = path.join(area, d); fs.mkdirSync(dirs[d], { mode: 0o700 }); }
    const arquivoDeSenha = path.join(dirs.seg, 'pgpass');
    fs.writeFileSync(arquivoDeSenha, [DB_USER, PAPEL, PAPEL_RESTAURACAO].map((u) => `${DB_HOST}:${SWB_PORT}:*:${u}:ficticia\nlocalhost:${SWB_PORT}:*:${u}:ficticia\n`).join(''), { mode: 0o600 });

    const nomeOrigem = novoNome(PREFIXO_ORIGEM);
    await criarBancoNovo(nomeOrigem);
    const oidOrigem = (await admin.query('SELECT oid::text AS oid FROM pg_database WHERE datname = $1', [nomeOrigem])).rows[0].oid;
    const nomeOutro = novoNome(PREFIXO_OUTRO);
    await criarBancoNovo(nomeOutro);

    const criadosClientes = [];
    clientes.push(criadosClientes);
    ctx = {
      area, dirs, arquivoDeSenha, binarios, host: DB_HOST, porta: Number(SWB_PORT), nomeOrigem, oidOrigem, nomeOutro, criadosClientes,
      chaveId: 'chave-h9h', fonteDeChaves: criarFonteDeChaves({ origem: 'TESTE_CONTROLADO', chaves: [{ id: 'chave-h9h', segredo: crypto.randomBytes(32) }] }),
    };

    const saida = cp.execFileSync(process.execPath, ['-e', CODIGO_DO_FILHO], {
      cwd: BACKEND, encoding: 'utf8', timeout: 240000,
      env: { PATH: process.env.PATH, NODE_ENV: 'test', DB_HOST, DB_PORT: SWB_PORT, DB_NAME: nomeOrigem, DB_USER, ...(process.env.DB_PASSWORD === undefined ? {} : { DB_PASSWORD: process.env.DB_PASSWORD }), H9H_NOME: nomeOrigem, H9H_PGDATA: SWB_PGDATA, H9H_PORTA: SWB_PORT, H9H_DIRETORIO: DIRETORIO_MIGRATIONS },
    });
    assert.equal(saida.trim().split('\n').pop(), `H9H_MIGRATIONS ${listarMigrations(DIRETORIO_MIGRATIONS).length}`);

    const origem = criarArmazenamentoImagens({ diretorio: dirs.imagens });
    await noBanco(nomeOrigem, async (c) => { imagens.push(...await semearImagensSinteticas({ armazenamento: origem, cliente: c, nomeOrigem })); });
    await noBanco(nomeOutro, async (c) => { await c.query("CREATE TABLE segredo_do_outro_banco (id int, valor text)"); await c.query("INSERT INTO segredo_do_outro_banco VALUES (1, 'sintetico')"); });
  }, { timeout: 420000 });

  after(async () => {
    const falhas = [];
    try {
      for (const lista of clientes) for (const c of lista) await c.end().catch(() => {});
      if (admin !== null) {
        for (const nome of criadosEmMemoria) {
          if (!nomeValido(nome)) { falhas.push(`nome fora do padrão não removido: ${nome}`); continue; }
          await admin.query(`DROP DATABASE IF EXISTS ${nome} WITH (FORCE)`).catch((e) => falhas.push(`banco não removido (${e.code ?? 'sem código'})`));
        }
        for (const p of PAPEIS_DO_ENSAIO) await admin.query(`DROP ROLE IF EXISTS ${p}`).catch((e) => falhas.push(`papel ${p} não removido (${e.code ?? 'sem código'})`));
        const restantes = (await bancosDaInstancia().catch(() => [])).filter((n) => n.startsWith('gepi_h9h_'));
        if (restantes.length > 0) falhas.push(`bancos gepi_h9h_ restantes: ${restantes.length}`);
        const depois = (await admin.query('SELECT rolname FROM pg_roles ORDER BY rolname').catch(() => ({ rows: [] }))).rows.map((r) => r.rolname);
        if (JSON.stringify(depois) !== JSON.stringify(papeisAntes)) falhas.push('a lista de papéis mudou depois da limpeza');
        resultados.limpeza = { falhas: falhas.length, papeisRestauradosAoEstadoInicial: JSON.stringify(depois) === JSON.stringify(papeisAntes) };
      }
    } finally {
      if (admin !== null) await admin.end().catch(() => {});
      const instancia = path.dirname(process.env.SWB_PGDATA);
      try { fs.writeFileSync(path.join(instancia, 'h9h-resultados.json'), `${JSON.stringify(resultados, null, 2)}\n`, { mode: 0o600, flag: 'wx' }); } catch (e) { falhas.push(`resultados não gravados (${e.code ?? 'sem código'})`); }
      if (ctx !== null && ctx.area.startsWith(`${instancia}/b3e2e-h9h-`)) fs.rmSync(ctx.area, { recursive: true, force: true });
      if (falhas.length > 0) process.stderr.write(`H9H_LIMPEZA: ${falhas.join('; ')}\n`);
    }
    assert.deepEqual(falhas, [], 'limpeza do ensaio incompleta');
  });

  test('H9H-B1-01 — isolamento: instância exclusiva em socket Unix, origem com as migrations no public, outro banco sintético, nenhum banco existente reutilizado', async () => {
    assert.deepEqual((await bancosDaInstancia()).filter((n) => !BANCOS_BASE.includes(n)), ordenar([ctx.nomeOrigem, ctx.nomeOutro]));
    assert.equal(await tabelasDe(BANCO_DE_TESTE), 0);
    const n = await noBanco(ctx.nomeOrigem, async (c) => (await c.query('SELECT count(*)::int AS n FROM imagens_padrao')).rows[0].n);
    assert.equal(n, 2);
    const tabelas = await tabelasDe(ctx.nomeOrigem);
    registrar('isolamento', { versao: (await admin.query('SHOW server_version')).rows[0].server_version, tabelasNaOrigem: tabelas, migrations: listarMigrations(DIRETORIO_MIGRATIONS).length, maxConnections: (await admin.query('SHOW max_connections')).rows[0].max_connections });
  });

  test('H9H-B1-02 — o papel nasce pelo modelo SQL do repositório (banco trocado em memória), sem administração, sem leitura e sem nenhum papel predefinido', async () => {
    await comoAdminNaOrigem(async (c) => {
      for (const comando of comandosDoModelo(fs.readFileSync(MODELO, 'utf8')).map((s) => s.replace('DATABASE A_PREENCHER', `DATABASE ${ctx.nomeOrigem}`))) await c.query(comando);
    });
    await definirLimite(LIMITE_INICIAL);
    await admin.query(`CREATE ROLE ${PAPEL_RESTAURACAO} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 4`);
    const antes = await comoAdminNaOrigem((c) => matrizEfetiva(c, PAPEL));
    assert.deepEqual({ ...antes.atributos }, { rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false, rolcanlogin: true, rolconnlimit: LIMITE_INICIAL });
    assert.equal(antes.membroDe, 0);
    registrar('papel-antes-das-concessoes-b1', antes);
  });

  test('H9H-B1-03 — SEM concessões de leitura: o backup completo pela composição FALHA FECHADO, nenhum pacote é publicado e a trava é liberada', async () => {
    const r = await rodarBackupComoPapel('sem-concessoes');
    assert.equal(r.coordenacao, 'ok');
    assert.equal(r.producao.ok, false, JSON.stringify(r.producao));
    assert.equal(r.pacoteExiste, false);
    assert.equal(r.auditoria.gravado, true, 'a falha também é auditada pelo papel (INSERT concedido)');
    assert.equal(await exclusaoDeMigracaoLivre(), true, 'a trava de coordenação não pode ficar presa');
    const diag = await diagnosticarFalhaDaComposicao('imagens_padrao');
    assert.equal(diag.pacoteExiste, false);
    registrar('backup-sem-concessoes', { falhouFechado: true, codigo: r.producao.codigo, auditoriaGravada: r.auditoria.gravado, pico: r.amostragem.pico, diagnostico: diag });
  });

  test('H9H-B1-04 — aplicam-se as concessões B-1 SOMENTE no banco de origem: a consulta de verificação passa a devolver zero linhas e a matriz efetiva fica restrita a SELECT por objeto', async () => {
    const antes = await comoAdminNaOrigem(async (c) => (await c.query(VERIFICACAO_B1)).rows.length);
    assert.ok(antes > 0, 'antes da concessão a verificação precisa listar objetos');
    await comoAdminNaOrigem(async (c) => { for (const sql of GRANTS_B1) await c.query(sql); });
    const depois = await comoAdminNaOrigem(async (c) => (await c.query(VERIFICACAO_B1)).rows);
    assert.deepEqual(depois, []);
    const matriz = await comoAdminNaOrigem((c) => matrizEfetiva(c, PAPEL));
    assert.equal(matriz.banco.criar_esquema, false);
    assert.equal(matriz.banco.create_public, false);
    assert.equal(matriz.banco.usage_public, true);
    assert.equal(matriz.banco.objetos_do_papel, 0);
    const permitidos = ['r:SELECT', 'r:SELECT+INSERT', 'p:SELECT', 'v:SELECT', 'm:SELECT', 'S:SELECT'];
    for (const grupo of Object.keys(matriz.grupos)) assert.ok(permitidos.includes(grupo), `privilégio inesperado na matriz efetiva: ${grupo}`);
    assert.deepEqual(matriz.grupos['r:SELECT+INSERT']?.exemplos, ['logs_auditoria_plataforma'], 'só a trilha tem INSERT');
    // nenhuma concessão no banco de destino ou nos demais bancos
    const outro = await noBanco(ctx.nomeOutro, async (c) => (await c.query("SELECT has_table_privilege($1::name, 'segredo_do_outro_banco', 'SELECT') AS lê", [PAPEL])).rows[0]['lê']);
    assert.equal(outro, false);
    registrar('papel-depois-das-concessoes-b1', { objetosSemSelectAntes: antes, objetosSemSelectDepois: depois.length, sql: [...GRANTS_B1], matriz });
  });

  test('H9H-B1-05 — backup completo COMO O PAPEL pela composição de produção: coordenação, snapshot, inventário, pg_dump, pacote L2 e verificação, auditoria SISTEMA; pico de conexões medido', async () => {
    const execucoes = [];
    for (const rotulo of ['completo-1', 'completo-2']) {
      const r = await rodarBackupComoPapel(rotulo, { verificarExclusao: rotulo === 'completo-1' });
      assert.equal(r.sessoes, 'ok', JSON.stringify(r));
      assert.equal(r.coordenacao, 'ok');
      assert.equal(r.producao.ok, true, JSON.stringify(r.producao));
      assert.equal(r.pacoteExiste, true);
      assert.equal(r.auditoria.gravado, true, JSON.stringify(r.auditoria));
      assert.equal(r.auditoria.usuarioDaSessao.u, PAPEL);
      execucoes.push(r);
      const linhas = (await comoAdminNaOrigem((c) => c.query("SELECT acao, ator_tipo FROM logs_auditoria_plataforma WHERE referencia = $1", [r.operacaoId]))).rows;
      assert.equal(linhas.length, 1, 'um evento de auditoria por execução');
      assert.equal(linhas[0].ator_tipo, 'SISTEMA');
      ultimoPacote = { nome: `l2-${r.operacaoId}`, sha256Manifesto: r.producao.sha256Manifesto, dump: sha(fs.readFileSync(path.join(ctx.dirs.publicados, `l2-${r.operacaoId}`, 'dump', 'postgres.dump'))) };
    }
    assert.equal(execucoes[0].exclusaoRecusada, true, 'durante o backup, a exclusão de migração é recusada');
    picoMedido = Math.max(...execucoes.map((e) => e.amostragem.pico));
    assert.ok(picoMedido >= 3, `pico implausível: ${picoMedido}`);
    limiteRecomendado = picoMedido + 1;
    const etiquetas = new Set(execucoes.flatMap((e) => e.amostragem.etiquetas));
    registrar('backup-completo-como-papel', {
      execucoes: execucoes.map((e) => ({ rotulo: e.rotulo, operacaoId: e.operacaoId, coordenacao: e.coordenacao, producao: e.producao, auditoria: e.auditoria, exclusaoRecusada: e.exclusaoRecusada, pico: e.amostragem.pico, picoPorAplicacao: e.amostragem.picoPorAplicacao, amostras: e.amostragem.amostras })),
      picoMedido, limiteMinimoNecessario: picoMedido, limiteRecomendado, etiquetasObservadas: [...etiquetas].sort((a, b) => a.localeCompare(b)), pacote: ultimoPacote,
    });
  });

  test('H9H-B1-06 — CONNECTION LIMIT definido pela medição: no limite medido o backup passa; um abaixo, falha fechado sem pacote e sem trava presa; no recomendado volta a passar', async () => {
    // A amostragem pode perder um pico de poucos milissegundos; por isso o limite mínimo é procurado também por tentativa: sobe de (pico - 1) até o primeiro limite com que o backup passa.
    const passou = (r) => r.sessoes === 'ok' && r.producao?.ok === true && r.pacoteExiste === true;
    const falhouFechado = (r) => r.pacoteExiste === false && (r.sessoes !== 'ok' || r.producao?.ok !== true);
    const tentativas = [];
    let minimo = null;
    for (let limite = Math.max(2, picoMedido - 1); limite <= picoMedido + 3 && minimo === null; limite += 1) {
      await definirLimite(limite);
      const r = await rodarBackupComoPapel(`limite-${limite}`);
      tentativas.push({ conexoesResiduaisDaComposicao: r.conexoesResiduaisDaComposicao ?? null, limite, passou: passou(r), falhouFechado: falhouFechado(r), sessoes: r.sessoes, coordenacao: r.coordenacao, producao: r.producao, pacoteExiste: r.pacoteExiste, erroDeSessao: r.quedaEmSessao, auditoria: r.auditoria === null ? null : { gravado: r.auditoria.gravado, codigo: r.auditoria.codigo }, pico: r.amostragem?.pico ?? null });
      if (passou(r)) minimo = limite; else assert.ok(falhouFechado(r), `limite ${limite}: falha sem fechar (pacote publicado ou estado inconsistente)`);
    }
    registrar('connection-limit-tentativas', { picoAmostrado: picoMedido, tentativas });
    assert.notEqual(minimo, null, 'nenhum limite até o pico + 3 permitiu o backup');
    const abaixo = tentativas.find((t) => t.limite === minimo - 1) ?? null;
    let abaixoConfirmado = abaixo;
    if (abaixo === null && minimo - 1 >= 1) {
      await definirLimite(minimo - 1);
      const r = await rodarBackupComoPapel(`limite-${minimo - 1}`);
      abaixoConfirmado = { limite: minimo - 1, passou: passou(r), falhouFechado: falhouFechado(r), sessoes: r.sessoes, codigo: r.producao?.codigo ?? null };
      assert.ok(falhouFechado(r), 'um abaixo do mínimo o backup precisa falhar fechado');
    }
    limiteRecomendado = minimo + 1;
    await definirLimite(limiteRecomendado);
    const recomendado = await rodarBackupComoPapel('limite-recomendado');
    assert.equal(passou(recomendado), true, JSON.stringify(recomendado.producao));
    assert.equal(await exclusaoDeMigracaoLivre(), true, 'a trava não pode ficar presa depois da falha por limite');
    ultimoPacote = { nome: `l2-${recomendado.operacaoId}`, sha256Manifesto: recomendado.producao.sha256Manifesto, dump: sha(fs.readFileSync(path.join(ctx.dirs.publicados, `l2-${recomendado.operacaoId}`, 'dump', 'postgres.dump'))) };
    registrar('connection-limit', { picoAmostrado: picoMedido, tentativas, limiteMinimoEmpirico: minimo, umAbaixo: abaixoConfirmado, limiteRecomendado, recomendado: { passou: true, pico: recomendado.amostragem.pico, picoPorAplicacao: recomendado.amostragem.picoPorAplicacao } });
  });

  test('H9H-B1-07 — tabela nova SEM concessão: o backup falha e a verificação B-1 identifica a tabela; concedida e verificada, o backup volta a funcionar', async () => {
    await comoAdminNaOrigem((c) => c.query('CREATE TABLE public.h9h_tabela_nova (id integer PRIMARY KEY, valor text)'));
    const pendentes = await comoAdminNaOrigem(async (c) => (await c.query(VERIFICACAO_B1)).rows);
    assert.deepEqual(pendentes.map((r) => r.relname), ['h9h_tabela_nova']);
    const falha = await rodarBackupComoPapel('tabela-nova-sem-concessao');
    assert.equal(falha.producao?.ok, false, JSON.stringify(falha.producao));
    assert.equal(falha.pacoteExiste, false);
    const diag = await diagnosticarFalhaDaComposicao('h9h_tabela_nova');
    await comoAdminNaOrigem(async (c) => { for (const sql of GRANTS_B1) await c.query(sql); });
    const depois = await comoAdminNaOrigem(async (c) => (await c.query(VERIFICACAO_B1)).rows);
    assert.deepEqual(depois, []);
    const ok = await rodarBackupComoPapel('tabela-nova-concedida');
    assert.equal(ok.producao?.ok, true, JSON.stringify(ok.producao));
    assert.equal(ok.pacoteExiste, true);
    ultimoPacote = { nome: `l2-${ok.operacaoId}`, sha256Manifesto: ok.producao.sha256Manifesto, dump: sha(fs.readFileSync(path.join(ctx.dirs.publicados, `l2-${ok.operacaoId}`, 'dump', 'postgres.dump'))) };
    registrar('tabela-nova', { identificadaPelaVerificacaoB1: pendentes.map((r) => r.relname), falhouFechado: true, codigoDaFalha: falha.producao.codigo, identificadaPelaComposicao: diag.nomeadoNaComposicao, diagnostico: diag, depoisDaConcessao: { verificacaoPendentes: depois.length, backupOk: true } });
  });

  test('H9H-B1-08 — negativos como o papel: outro banco, pg_authid, trilha de auditoria, DDL, UPDATE, DELETE, TRUNCATE, papéis e arquivos do servidor; positivos: leitura de public e INSERT da auditoria', async () => {
    const papel = new Client(baseDe(ctx.nomeOrigem, PAPEL));
    ctx.criadosClientes.push(papel);
    await papel.connect();
    const casos = [];
    const tentar = async (rotulo, sql, esperado) => {
      const obtido = await codigoDoErro(papel.query(sql));
      casos.push({ rotulo, esperado, obtido });
      assert.equal(obtido, esperado, `${rotulo}: esperado ${esperado}, obtido ${obtido}`);
    };
    // positivos
    await tentar('SELECT em tabela do public (B-1 concede)', 'SELECT 1 FROM imagens_padrao LIMIT 1', 'ok');
    await tentar('SELECT id, criado_em da trilha', 'SELECT id, criado_em FROM logs_auditoria_plataforma LIMIT 1', 'ok');
    await tentar('INSERT na trilha (auditoria do executor)', "INSERT INTO logs_auditoria_plataforma (acao, ator_tipo, contexto) VALUES ('BACKUP_EXECUTOR_BACKUP_CONCLUIDO', 'SISTEMA', '{}'::jsonb)", 'ok');
    // trilha de auditoria
    await tentar('UPDATE da trilha', "UPDATE logs_auditoria_plataforma SET acao = 'X'", '42501');
    await tentar('DELETE da trilha', 'DELETE FROM logs_auditoria_plataforma', '42501');
    await tentar('TRUNCATE da trilha', 'TRUNCATE logs_auditoria_plataforma', '42501');
    await tentar('trigger de dado sensível (097) continua valendo', "INSERT INTO logs_auditoria_plataforma (acao, ator_tipo, contexto) VALUES ('X', 'SISTEMA', '{\"PGPASSWORD\":\"x\"}'::jsonb)", 'P0001');
    // escrita e DDL
    await tentar('INSERT em outra tabela', "INSERT INTO imagens_padrao (nome) VALUES ('x')", '42501');
    await tentar('UPDATE em outra tabela', "UPDATE imagens_padrao SET nome = 'x'", '42501');
    await tentar('DELETE em outra tabela', 'DELETE FROM imagens_padrao', '42501');
    await tentar('TRUNCATE em outra tabela', 'TRUNCATE imagens_padrao', '42501');
    await tentar('CREATE TABLE no public', 'CREATE TABLE public.intruso (a int)', '42501');
    await tentar('CREATE SCHEMA', 'CREATE SCHEMA gepi_h9h_intruso', '42501');
    await tentar('DROP TABLE', 'DROP TABLE imagens_padrao', '42501');
    await tentar('ALTER TABLE', 'ALTER TABLE imagens_padrao ADD COLUMN intruso int', '42501');
    await tentar('CREATE FUNCTION', 'CREATE FUNCTION public.intruso() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$', '42501');
    await tentar('CREATE ROLE', 'CREATE ROLE gepi_h9h_intruso', '42501');
    await tentar('CREATE DATABASE', 'CREATE DATABASE gepi_h9h_intruso', '42501');
    await tentar('ALTER ROLE SUPERUSER', `ALTER ROLE ${PAPEL} SUPERUSER`, '42501');
    // administração e servidor
    await tentar('SELECT em pg_authid', 'SELECT rolname FROM pg_authid', '42501');
    await tentar('SELECT em pg_shadow', 'SELECT usename FROM pg_shadow', '42501');
    await tentar('SET ROLE para o administrador', 'SET ROLE swb_teste', '42501');
    await tentar('pg_read_file', "SELECT pg_read_file('/etc/hosts')", '42501');
    await tentar('COPY PROGRAM', "COPY (SELECT 1) TO PROGRAM 'id'", '42501');
    await tentar('COPY FROM arquivo do servidor', "COPY imagens_padrao FROM '/etc/hosts'", '42501');
    await tentar('lo_import no servidor', "SELECT lo_import('/etc/hosts')", '42501');
    await tentar('pg_reload_conf', 'SELECT pg_reload_conf()', '42501');
    await tentar('ALTER SYSTEM', "ALTER SYSTEM SET work_mem = '8MB'", '42501');
    const papeisVisiveis = (await papel.query('SELECT count(*)::int AS n FROM pg_roles')).rows[0].n;
    await papel.end().catch(() => {});

    // outro banco do cluster: o CONNECT vem do PUBLIC por padrão; a leitura de dados continua negada; com REVOKE CONNECT FROM PUBLIC a conexão é recusada
    const outroBanco = { conectaPorPadrao: null, leituraDeDados: null, conectaComRevoke: null };
    try {
      outroBanco.leituraDeDados = await noBanco(ctx.nomeOutro, async (c) => { outroBanco.conectaPorPadrao = true; return codigoDoErro(c.query('SELECT valor FROM segredo_do_outro_banco')); }, PAPEL);
    } catch (e) { outroBanco.conectaPorPadrao = false; outroBanco.leituraDeDados = e.code ?? e.message; }
    outroBanco.postgresDefault = await noBanco('postgres', async (c) => ({ conecta: true, pgAuthid: await codigoDoErro(c.query('SELECT 1 FROM pg_authid')) }), PAPEL).catch((e) => ({ conecta: false, codigo: e.code ?? e.message }));
    assert.equal(outroBanco.leituraDeDados, '42501', 'sem SELECT concedido, nenhum dado do outro banco é legível');
    await admin.query(`REVOKE CONNECT ON DATABASE ${ctx.nomeOutro} FROM PUBLIC`);
    outroBanco.conectaComRevoke = await noBanco(ctx.nomeOutro, async () => true, PAPEL).catch((e) => e.code ?? e.message);
    assert.equal(outroBanco.conectaComRevoke, '42501', 'com REVOKE CONNECT FROM PUBLIC a conexão ao outro banco é recusada');
    const { rows: [temp] } = await admin.query('SELECT has_database_privilege($1::name, $2::name, \'TEMP\') AS temp', [PAPEL, ctx.nomeOrigem]);
    registrar('negativos-e-positivos', { casos, totalCasos: casos.length, papeisVisiveisEmPgRoles: papeisVisiveis, outroBanco, privilegioTempNaOrigem: temp.temp });
  });

  test('H9H-B1-09 — identidade do INSERT de auditoria: é a sessão do papel de backup, sem posse, com INSERT e SELECT na trilha e nenhum UPDATE, DELETE ou TRUNCATE', async () => {
    const trilha = await comoAdminNaOrigem(async (c) => {
      const { rows: [p] } = await c.query(`SELECT pg_get_userbyid(c.relowner) AS dono, has_table_privilege($1::name, c.oid, 'INSERT') AS i, has_table_privilege($1::name, c.oid, 'SELECT') AS s, has_table_privilege($1::name, c.oid, 'UPDATE') AS u,
        has_table_privilege($1::name, c.oid, 'DELETE') AS d, has_table_privilege($1::name, c.oid, 'TRUNCATE') AS t, has_table_privilege($1::name, c.oid, 'REFERENCES') AS r, has_table_privilege($1::name, c.oid, 'TRIGGER') AS g
        FROM pg_class c WHERE c.oid = 'public.logs_auditoria_plataforma'::regclass`, [PAPEL]);
      const { rows: [seq] } = await c.query("SELECT pg_get_serial_sequence('public.logs_auditoria_plataforma', 'id') AS sequencia, (SELECT attidentity FROM pg_attribute WHERE attrelid = 'public.logs_auditoria_plataforma'::regclass AND attname = 'id') AS identidade");
      return { ...p, ...seq };
    });
    assert.notEqual(trilha.dono, PAPEL);
    assert.deepEqual({ i: trilha.i, s: trilha.s, u: trilha.u, d: trilha.d, t: trilha.t, r: trilha.r, g: trilha.g }, { i: true, s: true, u: false, d: false, t: false, r: false, g: false });
    const eventos = (await comoAdminNaOrigem((c) => c.query("SELECT ator_tipo, count(*)::int AS n FROM logs_auditoria_plataforma WHERE acao LIKE 'BACKUP_EXECUTOR_%' GROUP BY 1"))).rows;
    assert.ok(eventos.length >= 1 && eventos.every((e) => e.ator_tipo === 'SISTEMA'));
    registrar('identidade-da-auditoria', { identidade: PAPEL, sessaoDeAuditoriaDistintaDaCoordenacao: true, trilha, eventosPorAtor: eventos, observacao: 'a trilha não registra o usuário de banco; a identidade é a da sessão entregue ao montador, provada por current_user na própria sessão e pelos privilégios acima' });
  });

  test('H9H-B1-10 — SONDA: o que é preciso para ler data_directory e unix_socket_directories, investigado com um papel descartável e sem conceder nada ao papel de backup', async () => {
    await admin.query(`CREATE ROLE ${PAPEL_SONDA} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`);
    const parametros = ['data_directory', 'unix_socket_directories', 'port', 'listen_addresses', 'server_version_num'];
    const ler = async () => {
      const c = new Client(baseDe(BANCO_DE_TESTE, PAPEL_SONDA));
      ctx.criadosClientes.push(c);
      await c.connect();
      const r = {};
      try { for (const p of parametros) r[p] = await codigoDoErro(c.query(`SELECT current_setting('${p}')`)); } finally { await c.end().catch(() => {}); }
      return r;
    };
    const semConcessao = await ler();
    await admin.query(`GRANT pg_read_all_settings TO ${PAPEL_SONDA}`);
    const comLeituraDeConfiguracao = await ler();
    await admin.query(`REVOKE pg_read_all_settings FROM ${PAPEL_SONDA}`);
    const apos = await ler();
    const papelDeBackup = new Client(baseDe(ctx.nomeOrigem, PAPEL));
    ctx.criadosClientes.push(papelDeBackup);
    await papelDeBackup.connect();
    const backupSemConcessao = {};
    for (const p of parametros) backupSemConcessao[p] = await codigoDoErro(papelDeBackup.query(`SELECT current_setting('${p}')`));
    await papelDeBackup.end().catch(() => {});
    registrar('sonda-privilegio-necessario', { papelDescartavel: PAPEL_SONDA, semConcessao, comPgReadAllSettings: comLeituraDeConfiguracao, revogadoDeNovo: apos, papelDeBackupAtual: backupSemConcessao });
    assert.deepEqual(apos, semConcessao, 'revogado, o papel descartável volta ao estado sem concessão');
  });

  test('H9H-B1-11 — restauração integral em banco NOVO, com um papel não administrativo dono apenas do destino: veredito INTEGRO, esquema IGUAL, imagens e linhas conferidas', async () => {
    assert.notEqual(ultimoPacote, null, 'depende de um backup do papel mínimo');
    const tentar = async (rotulo, concessaoExtra) => {
      const destino = novoNome(PREFIXO_RESTAURADO);
      assert.ok(nomeRestauradoValido(destino));
      await criarBancoNovo(destino, PAPEL_RESTAURACAO);
      if (concessaoExtra !== null) await admin.query(concessaoExtra);
      const imagensRaiz = path.join(ctx.dirs.restauradoImagens, rotulo);
      fs.mkdirSync(imagensRaiz, { mode: 0o700 });
      const restauracao = criarRestauracaoDeProducao(configDaRestauracao(PAPEL_RESTAURACAO));
      const out = await restauracao.restaurar({
        raizAutorizada: ctx.dirs.publicados, nome: ultimoPacote.nome, imagens: { raiz: imagensRaiz, nome: `img-${crypto.randomBytes(4).toString('hex')}` },
        destino: { banco: destino, host: ctx.host, porta: ctx.porta, usuario: PAPEL_RESTAURACAO, arquivoDeSenha: ctx.arquivoDeSenha }, layoutMinimo: 2, maxBytesPorArquivo: MIB,
      });
      return { rotulo, destino, imagensRaiz, out };
    };
    const resumo = (t) => ({ rotulo: t.rotulo, ok: t.out.restauracao.ok, veredito: t.out.restauracao.veredito ?? null, falha: t.out.restauracao.falha ?? null, esquema: t.out.restauracao.esquema?.relacao ?? null, estado: t.out.estado ?? null });

    const minimo = await tentar('r1-minimo', null);
    const r1 = resumo(minimo);
    let final = minimo;
    let ressalva = null;
    let r2 = null;
    if (minimo.out.restauracao.ok !== true) {
      // EXPERIMENTO ROTULADO: só se o papel estritamente mínimo não chegar a INTEGRO, mede-se se a ÚNICA concessão restante (leitura de configuração do servidor, papel predefinido) basta. Revertida em seguida.
      await admin.query(`GRANT pg_read_all_settings TO ${PAPEL_RESTAURACAO}`);
      try {
        final = await tentar('r2-com-leitura-de-configuracao', null);
        r2 = resumo(final);
      } finally { await admin.query(`REVOKE pg_read_all_settings FROM ${PAPEL_RESTAURACAO}`); }
      ressalva = 'O papel de restauração estritamente mínimo NÃO chegou a INTEGRO; foi preciso pg_read_all_settings (leitura de configuração do servidor) para a sonda de instância. Decisão humana necessária.';
    }
    assert.equal(final.out.restauracao.ok, true, JSON.stringify(final.out.restauracao).slice(0, 600));
    assert.deepEqual(final.out.restauracao.veredito, { classe: 'INTEGRO', motivos: [], recuperavelEmProducao: false, restauracaoReal: false });
    assert.equal(final.out.restauracao.esquema.relacao, 'IGUAL');
    assert.equal(final.out.restauracao.banco.ok, true);
    assert.equal(final.out.restauracao.fontes.imagens.restaurados, 4);
    assert.deepEqual(final.out.estado, { restauracaoReal: false, consistenciaLogicaVerificada: true, recuperavelEmProducao: false, publicacaoOperacional: false });
    for (const { h, mestre, mini } of imagens) {
      const dir = path.join(final.imagensRaiz, fs.readdirSync(final.imagensRaiz)[0], 'arquivos', 'imagens', 'padrao', h);
      assert.equal(sha(fs.readFileSync(path.join(dir, 'mestre.png'))), sha(mestre));
      assert.equal(sha(fs.readFileSync(path.join(dir, 'miniatura.webp'))), sha(mini));
    }
    const linhas = await noBanco(final.destino, async (c) => (await c.query('SELECT count(*)::int AS n FROM imagens_padrao')).rows[0].n);
    assert.equal(linhas, 2);
    const tabelasDestino = await tabelasDe(final.destino);
    const tabelasOrigem = await tabelasDe(ctx.nomeOrigem);
    assert.equal(tabelasDestino, tabelasOrigem, 'o destino tem as mesmas tabelas da origem');
    const { rows: [papelRest] } = await admin.query('SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolconnlimit FROM pg_roles WHERE rolname = $1', [PAPEL_RESTAURACAO]);
    const { rows: [donoDe] } = await admin.query('SELECT count(*)::int AS n FROM pg_database d WHERE pg_get_userbyid(d.datdba) = $1', [PAPEL_RESTAURACAO]);
    const { rows: [membro] } = await admin.query('SELECT count(*)::int AS n FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = $1', [PAPEL_RESTAURACAO]);
    assert.equal(papelRest.rolsuper, false);
    assert.equal(membro.n, 0, 'a concessão experimental foi revertida');
    assert.deepEqual(pedidos.filter((p) => !nomeRestauradoValido(p)), [], 'só bancos restaurados autorizados foram pedidos à fábrica de conexões');
    registrar('restauracao', {
      papelDeRestauracao: { atributos: papelRest, bancosDeQueEDono: donoDe.n, membroDePapeis: membro.n, observacao: 'dono apenas do banco de destino novo; sem acesso à origem' },
      minimo: r1, experimentoComLeituraDeConfiguracao: r2, ressalva, destinoFinal: final.destino, tabelasOrigem, tabelasDestino, linhasImagensPadrao: linhas,
      imagensRestauradas: final.out.restauracao.fontes.imagens.restaurados, pacote: ultimoPacote,
    });
  });
});
