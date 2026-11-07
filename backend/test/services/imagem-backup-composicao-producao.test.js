'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { criarBackupDeProducao, criarRestauracaoDeProducao, classificarEstadoDoBackup } = require('../../src/services/imagem-backup-composicao-producao.service');
const { criarCriadorExclusivoDeArquivo, observarGrupoReal, temporizadorReal } = require('../../src/services/imagem-backup-portas-sistema.service');
const { criarFonteDeChaves, criarFonteOperacionalDeChaves } = require('../../src/services/imagem-backup-manifesto-autenticado.service');
const { criarProdutorDeRelatorio, criarProdutorOperacional, DESTINOS_OPERACIONAIS_AUTORIZADOS } = require('../../src/services/imagem-backup-publicacao.service');
const { criarArmazenamentoImagens } = require('../../src/storage/armazenamento-imagens');
const { planejarArquivos } = require('../../src/services/imagem-backup-plano.service');
const { criarJanelaDeBackup } = require('../../src/services/imagem-backup.service');
const { avaliarRestauracaoReal, criarAvaliadorDeRestauracaoReal, ehAvaliacaoReconhecida } = require('../../src/services/imagem-backup-proveniencia-restauracao.service');
const { criarSondaDeInstancia, criarAdaptadorDeReferencias } = require('../../src/services/imagem-backup-consistencia-banco.service');
const { emitirExecucaoDeRestauracao, consultarAvaliacaoDaExecucao, criarAvaliadorPadrao } = require('../../src/services/imagem-backup-proveniencia-restauracao.service');
const { criarControleDeProcesso } = require('../../src/services/imagem-backup-pgdump-controle-processo.service');
const { criarRestauradorDoBanco } = require('../../src/services/imagem-backup-restauracao-banco.service');
const { criarRestaurador } = require('../../src/services/imagem-backup-restauracao.service');
const { criarLancadorDeRestauracaoComSpawn } = require('../../src/services/imagem-backup-restauracao-lancador.service');
const { criarRegistroDeExecucoes } = require('../../src/services/imagem-backup-execucoes.service');

/**
 * COMPOSIÇÃO DE PRODUÇÃO (backup e restauração) com dependências CONTROLADAS: diretórios temporários do próprio teste, `spawn` falso (nenhum pg_dump/pg_restore executado), cliente PostgreSQL falso (nenhuma conexão), chaves aleatórias em memória.
 * Nada aqui comprova backup operacional, restauração real ou recuperabilidade.
 */

const PREFIXO = 'gepi-cp-test-';
const raizes = [];
const teste = (nome, fn) => test(nome, { timeout: 30000 }, fn);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const H = (c) => c.repeat(64);
const DUMP_BYTES = Buffer.from('dump-ficticio-composicao-0123456789-'.repeat(100));
const PRAZOS = { totalMs: 1000, cortesiaMs: 100, intervaloGrupoMs: 100, tentativasGrupo: 1, consultaGrupoMs: 100 };
const POLITICA = { prefixoDoBanco: 'gepi_cp_', hostsAutorizados: ['127.0.0.1'], bancosProtegidos: ['gestao_epi'] };

after(() => {
  const tmp = fs.realpathSync(os.tmpdir());
  for (const r of raizes) if (path.dirname(r) === tmp && path.basename(r).startsWith(PREFIXO)) fs.rmSync(r, { recursive: true, force: true });
});
function novaRaiz() {
  const r = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), PREFIXO)));
  fs.chmodSync(r, 0o700);
  raizes.push(r);
  return r;
}

// ----------------------------------------------------------------------------------------------------------------------- fixtures
const conteudos = ['padrao-mestre', 'padrao-miniatura', 'empresa7-mestre', 'empresa7-exibicao', 'empresa7-miniatura'].map((t) => Buffer.from(`${t}-conteudo`));
const [pm, pn, em, ee, en] = conteudos;
const linhas = () => ({
  padrao: [{ id: '1', sha256: sha(pm), sha256_miniatura: sha(pn), sha256_exibicao: null, formato: 'PNG', bytes_mestre: pm.length, bytes_miniatura: pn.length, bytes_exibicao: null }],
  empresa: [{ id: '2', empresa_id: 7, sha256: H('c'), sha256_mestre: sha(em), sha256_exibicao: sha(ee), sha256_miniatura: sha(en), formato: 'PNG', bytes_mestre: em.length, bytes_exibicao: ee.length, bytes_miniatura: en.length }],
});
const tipoDe = (sql) => {
  const t = String(sql).replace(/\s+/g, ' ').trim();
  if (/^BEGIN\b/i.test(t)) return 'BEGIN';
  if (/^ROLLBACK\b/i.test(t)) return 'ROLLBACK';
  if (/pg_export_snapshot\(\)/.test(t)) return 'EXPORTAR';
  if (/data_directory/.test(t)) return 'SONDA';
  if (/current_database\(\)/.test(t)) return 'IDENTIDADE';
  if (/FROM imagens_padrao/.test(t)) return 'PADRAO';
  if (/FROM imagens_empresa/.test(t)) return 'EMPRESA';
  return 'OUTRO';
};
function clienteFalso(banco, dados = linhas()) {
  const c = {
    ouvintes: { error: [], end: [] },
    sqls: [],
    async connect() {},
    async query(sql, parametros) {
      const tipo = tipoDe(sql);
      c.sqls.push(tipo);
      switch (tipo) {
        case 'EXPORTAR': return { rows: [{ snapshot_id: '00000003-0000001B-1' }] };
        case 'IDENTIDADE': return { rows: [{ nome: banco, oid: '16384' }] };
        case 'SONDA': return { rows: [{ banco, versao: '160015', data_directory: '/dados/pg-ficticio', sockets: '/tmp/s-ficticio', porta: '5432', listen: '', sem_tcp: true }] };
        case 'PADRAO': return { rows: dados.padrao.filter((l) => BigInt(l.id) > BigInt(parametros[0])).slice(0, parametros[1]) };
        case 'EMPRESA': return { rows: dados.empresa.filter((l) => BigInt(l.id) > BigInt(parametros[0])).slice(0, parametros[1]) };
        default: return { rows: [] };
      }
    },
    async end() { for (const f of c.ouvintes.end) f(); },
    on(evento, ouvinte) { (c.ouvintes[evento] ??= []).push(ouvinte); return c; },
  };
  return c;
}

function spawnFalso({ dump = 'ok', lista = 'ok', restore = 'ok', aposDump = null, aoListar = null, pidBase = 7000 } = {}) {
  const chamadas = [];
  let pid = pidBase;
  const spawn = (exe, args, opcoes) => {
    const nome = path.basename(exe);
    chamadas.push({ nome, args: [...args], env: opcoes.env, shell: opcoes.shell, stdio: opcoes.stdio });
    const filho = new EventEmitter();
    pid += 1;
    filho.pid = pid;
    filho.kill = () => true;
    filho.stdout = nome === 'pg_dump' ? new PassThrough() : new EventEmitter();
    filho.stderr = new PassThrough();
    setImmediate(() => {
      filho.emit('spawn');
      if (nome === 'pg_dump') {
        // MODO PIPE: os bytes saem pelo stdout (fluxo binário); o arquivo é gravado pela captura do lançador, não pelo processo
        if (dump === 'trava') { filho.stdout.write(DUMP_BYTES.subarray(0, 10)); return; }
        if (dump !== 'falha') filho.stdout.write(DUMP_BYTES);
        filho.stdout.end();
        filho.stderr.end();
        filho.emit('exit', dump === 'falha' ? 1 : 0, null);
        if (aposDump) aposDump();
        filho.emit('close', 0, null);
      } else if (args.includes('--list')) {
        if (aoListar) aoListar();
        if (lista === 'trava') return;
        filho.stdout.emit('data', Buffer.from('; Format: CUSTOM\n; TOC Entries: 12\n'));
        filho.emit('exit', lista === 'falha' ? 1 : 0, null);
        filho.emit('close', 0, null);
      } else {
        if (restore === 'trava') return;
        filho.emit('exit', restore === 'falha' ? 1 : 0, null);
        filho.emit('close', 0, null);
      }
    });
    return filho;
  };
  return { chamadas, spawn };
}
const temporizadorQueExpira = { prazo: (ms) => (ms === PRAZOS.totalMs || ms === PRAZOS.cortesiaMs ? { promessa: Promise.resolve(), cancelar() {} } : { promessa: new Promise(() => {}), cancelar() {} }), intervalo: () => Promise.resolve() };
const temporizadorInerte = { prazo: () => ({ promessa: new Promise(() => {}), cancelar() {} }), intervalo: () => Promise.resolve() };

/** Ambiente completo e fictício: diretórios, binários de mentira (executáveis, nunca executados), arquivo de senha 0600, imagens e config. */
async function ambiente({ portasExtras = {}, relatorio = 'teste', alterarConfig = (c) => c, banco = 'gepi_cp_origem', dados = linhas() } = {}) {
  const raiz = novaRaiz();
  const dirs = {};
  for (const d of ['imagens', 'preparacoes', 'dumps', 'publicados', 'bin', 'seg']) { dirs[d] = path.join(raiz, d); fs.mkdirSync(dirs[d], { mode: 0o700 }); }
  const pgDump = path.join(dirs.bin, 'pg_dump');
  const pgRestore = path.join(dirs.bin, 'pg_restore');
  for (const b of [pgDump, pgRestore]) fs.writeFileSync(b, '#!/bin/sh\nexit 99\n', { mode: 0o755 });
  const pgpass = path.join(dirs.seg, 'pgpass');
  fs.writeFileSync(pgpass, '*:5432:*:gepi_cp:fictia\n', { mode: 0o600 });
  const armazenamento = criarArmazenamentoImagens({ diretorio: dirs.imagens });
  const regs = {
    padrao: dados.padrao.map((l) => ({ id: l.id, sha256: l.sha256, sha256Miniatura: l.sha256_miniatura, sha256Exibicao: l.sha256_exibicao, formato: l.formato, bytesMestre: l.bytes_mestre, bytesMiniatura: l.bytes_miniatura, bytesExibicao: l.bytes_exibicao })),
    empresa: dados.empresa.map((l) => ({ id: l.id, empresaId: l.empresa_id, sha256: l.sha256, sha256Mestre: l.sha256_mestre, sha256Exibicao: l.sha256_exibicao, sha256Miniatura: l.sha256_miniatura, formato: l.formato, bytesMestre: l.bytes_mestre, bytesExibicao: l.bytes_exibicao, bytesMiniatura: l.bytes_miniatura })),
  };
  for (const item of planejarArquivos(regs)) await armazenamento.gravar(item.chave, conteudos.find((c) => sha(c) === item.sha256), { maxBytes: 4096, sha256Esperado: item.sha256 });
  const fonteDeChaves = criarFonteDeChaves({ origem: 'TESTE_CONTROLADO', chaves: [{ id: 'k-1', segredo: crypto.randomBytes(32) }] });
  const spawn = portasExtras.spawn ?? spawnFalso().spawn;
  const config = alterarConfig({
    postgres: { pgDump, pgRestore, host: '127.0.0.1', porta: 5432, usuario: 'gepi_cp', arquivoDeSenha: pgpass, banco: { nome: banco, oid: '16384' } },
    conexao: { criarConexao: () => clienteFalso(banco, dados), finalizacaoMs: 5000 },
    armazenamento: { imagens: dirs.imagens, preparacoes: dirs.preparacoes, dumps: dirs.dumps, publicados: dirs.publicados },
    chaves: { fonteDeChaves, chaveId: 'k-1' },
    // a capacidade RECONHECIDA da trava de janela (ponto de integração autorizado); o arquivo da trava fica no diretório temporário do teste
    janela: criarJanelaDeBackup({ arquivo: path.join(raiz, 'janela.lock'), raizArmazenamento: dirs.imagens }),
    ...(relatorio === 'teste' ? { relatorio: { produtor: criarProdutorDeRelatorio({ origem: 'TESTE_CONTROLADO', decidir: () => ({ ok: true }) }), origensAceitas: ['TESTE_CONTROLADO'] } } : {}),
    prazos: { ...PRAZOS },
    maxBytesPorArquivo: 4096,
    portas: { spawn, observarGrupo: async () => false, temporizador: temporizadorInerte, ...portasExtras },
  });
  return { raiz, dirs, config, fonteDeChaves, spawn };
}
const executar = (cfg, nome = 'prep-1') => criarBackupDeProducao(cfg).executar({ nomeDaPreparacao: nome, conjuntoId: 'conjunto-cp-0001' });

// ----------------------------------------------------------------------------------------------------------------------- caminho positivo e estado
describe('[CP-A] composição de produção: caminho com dependências controladas', () => {
  teste('CP-A01 — pipeline completo com teste controlado: publicado como NÃO operacional; dimensões do estado SEPARADAS; veredito do coordenador preservado (INVALIDO); prontidão bloqueada; hash do dump não independente', async () => {
    const falso = spawnFalso();
    const a = await ambiente({ portasExtras: { spawn: falso.spawn } });
    const composto = await executar(a.config);
    const estado = classificarEstadoDoBackup(composto);
    assert.equal(estado.reconhecido, true);
    assert.equal(estado.correlacaoContratual, true);
    assert.equal(estado.pacotePublicado, true);
    assert.equal(estado.publicacaoOperacional, false);
    assert.equal(estado.prontidaoOperacional, false);
    assert.deepEqual([...estado.pendenciasDaProntidao].sort(), ['DESTINO_AUTORIZADO', 'FONTE_OPERACIONAL_DE_CHAVES']);
    assert.deepEqual({ ...estado.coordenador }, { saida: 9, valido: false }, 'o veredito do coordenador NÃO é alterado');
    assert.equal(estado.backupOperacionalValido, false);
    assert.equal(estado.recuperabilidadeComprovada, false);
    assert.equal(estado.hashDoDumpIndependente, false);
    assert.equal(estado.homologacaoTecnica.determinavelPeloCodigo, false);
    const h = composto.proveniencia.hashDoDump;
    assert.deepEqual({ origem: h.origem, correspondem: h.correspondem, independente: h.independenteDaCorrecaoInternaDoPgDump, atesta: h.atestaConteudoLogico, fsync: h.fsyncConcluido }, { origem: 'FLUXO_STDOUT_DURANTE_A_ESCRITA', correspondem: true, independente: false, atesta: false, fsync: true });
    assert.equal(h.SHA256_FLUXO_RECEBIDO, sha(DUMP_BYTES));
    assert.equal(h.SHA256_ARQUIVO_PERSISTIDO, sha(DUMP_BYTES));
    assert.deepEqual([h.bytesRecebidos, h.bytesGravados], [DUMP_BYTES.length, DUMP_BYTES.length]);
    assert.deepEqual({ ...estado.hashDoDump }, { capturadoNoFluxo: true, fluxoCorrespondeAoArquivo: true, atestaConteudoLogico: false });
    // o pg_dump emite pelo stdout (pipe): o arquivo final não vai ao processo
    assert.deepEqual(falso.chamadas[0].stdio, ['ignore', 'pipe', 'pipe']);
    assert.deepEqual([composto.proveniencia.chaves.origem, composto.proveniencia.processosDoDump.estado], ['TESTE_CONTROLADO', 'INICIADO']);
    // processos: um pg_dump e uma listagem, ambos sem shell; o pg_dump com ambiente fechado
    assert.deepEqual(falso.chamadas.map((c) => c.nome), ['pg_dump', 'pg_restore']);
    assert.equal(falso.chamadas.every((c) => c.shell === false), true);
    assert.deepEqual(Object.keys(falso.chamadas[0].env).sort(), ['PGHOST', 'PGPASSFILE', 'PGPORT', 'PGUSER']);
    assert.deepEqual(Object.keys(falso.chamadas[1].env), [], 'a listagem estrutural roda com ambiente vazio');
  });

  teste('CP-A02 — PADRÃO DE PRODUÇÃO (sem produtor configurado): produtor operacional bloqueado, nada é publicado e as pendências são devolvidas', async () => {
    const a = await ambiente({ relatorio: null });
    const composto = await executar(a.config);
    const pub = composto.resultado.publicacao;
    assert.deepEqual([pub.publicada, pub.motivo], [false, 'RELATORIO_SEM_PROVENIENCIA']);
    assert.deepEqual([...pub.pendencias].sort(), ['DESTINO_AUTORIZADO', 'FONTE_OPERACIONAL_DE_CHAVES']);
    assert.deepEqual(fs.readdirSync(a.dirs.publicados), []);
    const estado = classificarEstadoDoBackup(composto);
    assert.deepEqual([estado.pacotePublicado, estado.backupOperacionalValido, estado.prontidaoOperacional], [false, false, false]);
    assert.equal(estado.correlacaoContratual, true);
  });

  teste('CP-A03 — a classificação só reconhece o resultado PRODUZIDO pela composição: literal, clone e promoção manual de campos não valem', async () => {
    const a = await ambiente();
    const composto = await executar(a.config);
    const literal = { resultado: { coordenador: { valido: true, saida: 0 }, publicacao: { publicada: true, publicacaoOperacional: true }, correlacao: {}, pacote: { ok: true, consistencia: { demonstrada: true } } }, prontidao: { pronta: true, pendencias: [] } };
    for (const falso of [literal, { ...composto }, structuredClone({ resultado: 1 }), null, undefined, 42]) {
      const e = classificarEstadoDoBackup(falso);
      assert.deepEqual([e.reconhecido, e.backupOperacionalValido, e.prontidaoOperacional, e.publicacaoOperacional, e.recuperabilidadeComprovada, e.correlacaoContratual], [false, false, false, false, false, false]);
      assert.equal(e.motivo, 'RESULTADO_NAO_RECONHECIDO');
    }
    assert.throws(() => { 'use strict'; composto.prontidao.pronta = true; }, TypeError, 'o resultado é congelado');
  });

  teste('CP-A04 — nenhuma decisão usa NODE_ENV e a composição não lê o ambiente; fonte operacional de chaves e destino operacional continuam inexistentes', () => {
    const base = path.join(__dirname, '..', '..', 'src', 'services');
    for (const nome of ['imagem-backup-composicao-producao.service.js', 'imagem-backup-portas-sistema.service.js']) {
      const codigo = fs.readFileSync(path.join(base, nome), 'utf8').split('\n').filter((l) => !l.trimStart().startsWith('*') && !l.trimStart().startsWith('//')).join('\n');
      assert.equal(/process\.env|NODE_ENV/.test(codigo), false, nome);
    }
    assert.throws(() => criarFonteOperacionalDeChaves({ provedor: 'cofre', adaptador: { obter() {} } }), (e) => e.code === 'FONTE_OPERACIONAL_INDISPONIVEL');
    assert.deepEqual([...DESTINOS_OPERACIONAIS_AUTORIZADOS], []);
  });
});

// ----------------------------------------------------------------------------------------------------------------------- contrato de configuração e dependências
describe('[CP-B] configuração e dependências: falha fechada antes de qualquer efeito', () => {
  const invalidas = [
    ['porta ausente', (c) => { delete c.postgres.porta; return c; }],
    ['porta 0', (c) => { c.postgres.porta = 0; return c; }],
    ['porta 70000', (c) => { c.postgres.porta = 70000; return c; }],
    ['porta como texto', (c) => { c.postgres.porta = '5432'; return c; }],
    ['host ausente', (c) => { delete c.postgres.host; return c; }],
    ['host com espaço', (c) => { c.postgres.host = 'a b'; return c; }],
    ['socket relativo', (c) => { c.postgres.host = 'relativo/dir'; return c; }],
    ['pg_dump relativo', (c) => { c.postgres.pgDump = 'pg_dump'; return c; }],
    ['pg_dump com outro nome', (c) => { c.postgres.pgDump = '/usr/bin/psql'; return c; }],
    ['banco sem oid', (c) => { c.postgres.banco = { nome: 'x' }; return c; }],
    ['arquivo de senha relativo', (c) => { c.postgres.arquivoDeSenha = 'senha'; return c; }],
    ['chave extra no postgres', (c) => { c.postgres.senha = 'x'; return c; }],
    ['fonte de chaves falsa', (c) => { c.chaves.fonteDeChaves = { origem: 'OPERACIONAL', obter: () => ({}) }; return c; }],
    ['sem chaves', (c) => { delete c.chaves; return c; }],
    ['produtor literal', (c) => { c.relatorio = { produtor: async () => ({ ok: true, origem: 'OPERACIONAL' }), origensAceitas: ['OPERACIONAL'] }; return c; }],
    ['prazo ausente', (c) => { delete c.prazos.totalMs; return c; }],
    ['diretório relativo', (c) => { c.armazenamento.dumps = 'dumps'; return c; }],
    ['opção desconhecida', (c) => { c.extra = 1; return c; }],
    ['porta de sistema desconhecida', (c) => { c.portas.processoReal = () => {}; return c; }],
    ['janela ausente', (c) => { delete c.janela; return c; }],
    ['janela: função arbitrária', (c) => { c.janela = async () => ({}); return c; }],
    ['janela: objeto literal com adquirir', (c) => { c.janela = { async adquirir() { return { async confirmarPosse() { return { confirmada: true }; }, async liberar() { return { liberada: true }; } }; } }; return c; }],
    ['janela: clone de uma janela genuína', (c) => { c.janela = { ...c.janela }; return c; }],
    ['janela: porta antiga adquirirJanela', (c) => { c.portas.adquirirJanela = () => ({}); return c; }],
    ['criação de conexão ausente', (c) => { delete c.conexao.criarConexao; return c; }],
  ];
  for (const [rotulo, mutar] of invalidas) {
    teste(`CP-B01 (${rotulo}) — CONFIGURACAO_INVALIDA sem criar diretório, arquivo nem processo`, async () => {
      const falso = spawnFalso();
      const a = await ambiente({ portasExtras: { spawn: falso.spawn }, alterarConfig: mutar });
      assert.throws(() => criarBackupDeProducao(a.config), (e) => e instanceof TypeError && e.code === 'CONFIGURACAO_INVALIDA' && !/gepi-cp-test/.test(e.message));
      assert.equal(falso.chamadas.length, 0);
      assert.deepEqual(fs.readdirSync(a.dirs.dumps), []);
    });
  }

  teste('CP-B02 — dependências verificáveis: binário ausente, não executável, é diretório; senha com acesso de grupo; diretório de dumps inexistente => DEPENDENCIA_INDISPONIVEL nomeando o item, sem spawn', async () => {
    const casos = [
      ['PG_DUMP', (a) => fs.unlinkSync(a.config.postgres.pgDump)],
      ['PG_DUMP', (a) => fs.chmodSync(a.config.postgres.pgDump, 0o644)],
      ['PG_RESTORE', (a) => { fs.unlinkSync(a.config.postgres.pgRestore); fs.mkdirSync(a.config.postgres.pgRestore); }],
      ['ARQUIVO_DE_SENHA', (a) => fs.chmodSync(a.config.postgres.arquivoDeSenha, 0o640)],
      ['DUMPS', (a) => fs.rmdirSync(a.dirs.dumps)],
      ['IMAGENS', (a) => fs.rmSync(a.dirs.imagens, { recursive: true })],
    ];
    for (const [item, quebrar] of casos) {
      const falso = spawnFalso();
      const a = await ambiente({ portasExtras: { spawn: falso.spawn } });
      quebrar(a);
      const b = criarBackupDeProducao(a.config);
      await assert.rejects(() => b.verificarDependencias(), (e) => e.code === 'DEPENDENCIA_INDISPONIVEL' && e.item === item);
      await assert.rejects(() => b.executar({ nomeDaPreparacao: 'prep-1', conjuntoId: 'c' }), (e) => e.code === 'DEPENDENCIA_INDISPONIVEL');
      assert.equal(falso.chamadas.length, 0, item);
    }
    const ok = await ambiente();
    assert.equal((await criarBackupDeProducao(ok.config).verificarDependencias()).ok, true);
  });

  teste('CP-B03 — entrada da execução estrita: nome da preparação inválido, conjunto vazio e chaves extras são recusados', async () => {
    const a = await ambiente();
    const b = criarBackupDeProducao(a.config);
    for (const entrada of [{ nomeDaPreparacao: '../x', conjuntoId: 'c' }, { nomeDaPreparacao: 'ok', conjuntoId: '' }, { nomeDaPreparacao: 'ok', conjuntoId: 'c', extra: 1 }, {}, null]) {
      await assert.rejects(() => b.executar(entrada), (e) => e.code === 'CONFIGURACAO_INVALIDA');
    }
  });
});

// ----------------------------------------------------------------------------------------------------------------------- falhas do pipeline
describe('[CP-C] contraprovas do pipeline de produção', () => {
  const naoPublicou = (composto) => {
    const pub = composto.resultado.publicacao;
    return pub === null || pub === undefined || pub.publicada !== true;
  };
  const tudoFalso = (composto) => {
    const e = classificarEstadoDoBackup(composto);
    return [e.pacotePublicado, e.publicacaoOperacional, e.prontidaoOperacional, e.backupOperacionalValido, e.recuperabilidadeComprovada].every((v) => v === false);
  };

  teste('CP-C01 — CRIAÇÃO NÃO EXCLUSIVA do dump: criador que reaproveita/falha por arquivo existente nunca resulta em backup publicado; o criador padrão recusa arquivo existente, link, modo diferente de 0600, diretório relativo ou com link', async () => {
    const a = await ambiente({ portasExtras: { criarExclusivo: () => { throw Object.assign(new Error('x'), { code: 'ARQUIVO_EXISTENTE' }); } } });
    const composto = await executar(a.config);
    assert.equal(naoPublicou(composto), true);
    assert.equal(tudoFalso(composto), true);

    const raiz = novaRaiz();
    const criador = criarCriadorExclusivoDeArquivo();
    const spec = (extra = {}) => ({ diretorio: raiz, nome: 'dump.pgdump', modo: 0o600, semSeguirLinks: true, ...extra });
    const { descritor, fechar } = criador.criarExclusivo(spec());
    fechar();
    assert.equal(typeof descritor, 'number');
    assert.equal(criador.ultimoCaminho(), path.join(raiz, 'dump.pgdump'));
    assert.equal(fs.statSync(path.join(raiz, 'dump.pgdump')).mode & 0o777, 0o600);
    assert.throws(() => criador.criarExclusivo(spec()), (e) => e.code === 'ARQUIVO_EXISTENTE', 'existente');
    fs.symlinkSync(path.join(raiz, 'dump.pgdump'), path.join(raiz, 'elo.pgdump'));
    assert.throws(() => criador.criarExclusivo(spec({ nome: 'elo.pgdump' })), (e) => ['ARQUIVO_EXISTENTE', 'CRIACAO_FALHOU'].includes(e.code), 'link');
    assert.equal(fs.readFileSync(path.join(raiz, 'dump.pgdump')).length, 0, 'nada foi truncado');
    for (const ruim of [spec({ modo: 0o644 }), spec({ semSeguirLinks: false }), spec({ diretorio: 'relativo' }), spec({ nome: '../fora' }), spec({ nome: '' })]) assert.throws(() => criador.criarExclusivo(ruim), (e) => e.code === 'SPEC_INVALIDO');
    const elo = path.join(novaRaiz(), 'elo-dir');
    fs.symlinkSync(raiz, elo);
    assert.throws(() => criador.criarExclusivo(spec({ diretorio: elo, nome: 'novo.pgdump' })), (e) => e.code === 'SPEC_INVALIDO', 'diretório que é link');
  });

  teste('CP-C02 — FALHA NA SUPERVISÃO: pg_dump que sai com código 1 não publica e nada é válido', async () => {
    const a = await ambiente({ portasExtras: { spawn: spawnFalso({ dump: 'falha' }).spawn } });
    const composto = await executar(a.config);
    assert.equal(naoPublicou(composto), true);
    assert.equal(tudoFalso(composto), true);
    assert.notEqual(composto.resultado.coordenador.saida, 0);
  });

  teste('CP-C03 — TIMEOUT/PROCESSO INCERTO: pg_dump que não termina (prazos vencidos) e verificação estrutural que não termina nunca publicam', async () => {
    const trava = await ambiente({ portasExtras: { spawn: spawnFalso({ dump: 'trava' }).spawn, temporizador: temporizadorQueExpira } });
    const c1 = await executar(trava.config);
    assert.equal(naoPublicou(c1), true);
    assert.equal(tudoFalso(c1), true);
    const listaTrava = await ambiente({ portasExtras: { spawn: spawnFalso({ lista: 'trava' }).spawn, temporizador: temporizadorQueExpira } });
    const c2 = await executar(listaTrava.config);
    assert.equal(naoPublicou(c2), true);
    assert.equal(tudoFalso(c2), true);
    const listaFalha = await ambiente({ portasExtras: { spawn: spawnFalso({ lista: 'falha' }).spawn } });
    const c3 = await executar(listaFalha.config);
    assert.equal(naoPublicou(c3), true);
    assert.equal(classificarEstadoDoBackup(c3).correlacaoContratual, false);
  });

  teste('CP-C04 — PERDA DA JANELA durante a operação: a trava (genuína) é removida do disco no meio do dump; a posse deixa de ser confirmada, nada é publicado e o resultado nunca é válido', async () => {
    let travaDaJanela = null;
    const falso = spawnFalso({ aposDump: () => { fs.unlinkSync(travaDaJanela); } });
    const a = await ambiente({ portasExtras: { spawn: falso.spawn } });
    travaDaJanela = path.join(a.raiz, 'janela.lock');
    const composto = await executar(a.config);
    assert.equal(naoPublicou(composto), true);
    assert.equal(tudoFalso(composto), true);
    assert.equal(composto.resultado.coordenador.valido, false);
    assert.equal(composto.resultado.coordenador.janela, 'PERDIDA');
  });

  teste('CP-C05 — SHA256 do FLUXO x do ARQUIVO PERSISTIDO: o arquivo alterado depois da captura e antes de T1 (durante a conferência do grupo) diverge do hash recebido do pg_dump e impede a composição e a publicação', async () => {
    let dumpsDir = null;
    let alterou = false;
    const observarGrupo = async () => { if (!alterou && dumpsDir !== null) { const l = fs.readdirSync(dumpsDir); if (l.length > 0) { alterou = true; fs.appendFileSync(path.join(dumpsDir, l[0]), 'x'); } } return false; };
    const a = await ambiente({ portasExtras: { observarGrupo } });
    dumpsDir = a.dirs.dumps;
    const composto = await executar(a.config);
    assert.equal(alterou, true, 'a alteração ocorreu depois da captura');
    assert.equal(naoPublicou(composto), true);
    assert.equal(tudoFalso(composto), true);
    assert.equal(classificarEstadoDoBackup(composto).correlacaoContratual, false);
    assert.equal(composto.proveniencia.hashDoDump.correspondem, false, 'fluxo recebido != arquivo persistido');
  });

  teste('CP-C05b — T1/T2 DIVERGENTES: alteração do arquivo ENTRE as observações (depois de T1) também impede a publicação', async () => {
    let dumpsDir = null;
    let alterou = false;
    // a verificação estrutural (`pg_restore --list`) acontece depois de T1: nessa altura o arquivo recebe mais um byte
    const falso = spawnFalso({ aoListar: () => { const l = fs.readdirSync(dumpsDir); alterou = l.length > 0; if (alterou) fs.appendFileSync(path.join(dumpsDir, l[0]), 'y'); } });
    const a = await ambiente({ portasExtras: { spawn: falso.spawn } });
    dumpsDir = a.dirs.dumps;
    const composto = await executar(a.config);
    assert.equal(alterou, true, 'a alteração ocorreu entre as observações');
    assert.equal(naoPublicou(composto), true);
    assert.equal(tudoFalso(composto), true);
  });

  teste('CP-C06 — FALTA DE FONTE OPERACIONAL e DESTINO NÃO AUTORIZADO: a prontidão lista as duas pendências; promover o teste não as remove (origem aceita OPERACIONAL com produtor de teste = não publica)', async () => {
    const a = await ambiente({ alterarConfig: (c) => { c.relatorio = { produtor: criarProdutorDeRelatorio({ origem: 'TESTE_CONTROLADO', decidir: () => ({ ok: true }) }), origensAceitas: ['OPERACIONAL'] }; return c; } });
    const composto = await executar(a.config);
    assert.equal(naoPublicou(composto), true, 'a decisão de teste não é aceita como operacional');
    assert.equal(composto.resultado.publicacao.motivo, 'RELATORIO_SEM_PROVENIENCIA');
    assert.deepEqual([...composto.prontidao.pendencias].sort(), ['DESTINO_AUTORIZADO', 'FONTE_OPERACIONAL_DE_CHAVES']);
    assert.equal(composto.prontidao.pronta, false);
    assert.throws(() => criarProdutorDeRelatorio({ origem: 'OPERACIONAL', decidir: () => ({ ok: true }) }));
    assert.equal(typeof criarProdutorOperacional(), 'function');
  });
});

describe('[CP-J] janela de escrita na composição de produção', () => {
  teste('CP-J01 — a trava é liberada depois do SUCESSO e depois da FALHA; uma segunda operação com a trava ocupada (por outro dono) não executa nada', async () => {
    const ok = await ambiente();
    await executar(ok.config);
    assert.equal(fs.existsSync(path.join(ok.raiz, 'janela.lock')), false, 'liberada após sucesso');
    // falha DEPOIS de o dump terminar com tudo confirmado (a listagem estrutural falha): a trava é liberada
    const falha = await ambiente({ portasExtras: { spawn: spawnFalso({ lista: 'falha' }).spawn } });
    const cFalha = await executar(falha.config);
    assert.equal(cFalha.resultado.coordenador.valido, false);
    assert.equal(cFalha.resultado.coordenador.janela, 'LIBERADA');
    assert.equal(fs.existsSync(path.join(falha.raiz, 'janela.lock')), false, 'liberada após falha confirmada');
    // dump que falha com fluxos incompletos (supervisão sem confirmação): a trava é RETIDA por segurança (TRAVA_RETIDA), para decisão humana
    const retida = await ambiente({ portasExtras: { spawn: spawnFalso({ dump: 'falha' }).spawn } });
    const cRetida = await executar(retida.config);
    assert.equal(cRetida.resultado.coordenador.saida, 11);
    assert.equal(cRetida.resultado.coordenador.janela, 'RETIDA');
    assert.equal(fs.existsSync(path.join(retida.raiz, 'janela.lock')), true, 'retida por segurança');

    const falso = spawnFalso();
    const ocupado = await ambiente({ portasExtras: { spawn: falso.spawn } });
    const dono = await ocupado.config.janela.adquirir({ tipo: 'BACKUP' });
    const composto = await executar(ocupado.config);
    assert.equal(composto.resultado.publicacao === null || composto.resultado.publicacao === undefined, true);
    assert.equal(composto.resultado.coordenador.janela, 'OCUPADA');
    assert.equal(falso.chamadas.length, 0, 'nenhum processo foi lançado sem a posse da janela');
    assert.equal(fs.existsSync(path.join(ocupado.raiz, 'janela.lock')), true, 'a trava do outro dono permanece');
    await dono.liberar();
  });

  teste('CP-J02 — FALHA NA LIBERAÇÃO: se a trava não pode ser removida, o resultado nunca é válido e a trava retida é sinalizada (TRAVA_RETIDA)', async () => {
    let raiz = null;
    const falso = spawnFalso({ aposDump: () => { fs.chmodSync(raiz, 0o500); } });
    const a = await ambiente({ portasExtras: { spawn: falso.spawn } });
    raiz = a.raiz;
    try {
      const composto = await executar(a.config);
      assert.equal(composto.resultado.coordenador.valido, false);
      assert.equal(composto.resultado.coordenador.saida, 1, 'erro na liberação = ERRO (não é a retenção por segurança, que é 11)');
      assert.equal(composto.resultado.coordenador.janela, 'NAO_LIBERADA');
      assert.equal(classificarEstadoDoBackup(composto).backupOperacionalValido, false);
    } finally {
      fs.chmodSync(a.raiz, 0o700);
    }
    assert.equal(fs.existsSync(path.join(a.raiz, 'janela.lock')), true, 'a trava ficou retida para decisão humana');
  });

  teste('CP-J03 — nenhuma janela simulada autoriza: objeto literal, clone, função, janela de OUTRO tipo de objeto e a porta antiga são recusados na configuração sem lançar nada', async () => {
    const falso = spawnFalso();
    const base = await ambiente({ portasExtras: { spawn: falso.spawn } });
    const literal = { async adquirir() { return Object.freeze({ tipo: 'BACKUP', async confirmarPosse() { return { confirmada: true }; }, async liberar() { return { liberada: true }; } }); } };
    for (const janela of [literal, { ...base.config.janela }, Object.create(base.config.janela), async () => literal, undefined]) {
      const cfg = { ...base.config, janela };
      if (janela === undefined) delete cfg.janela;
      assert.throws(() => criarBackupDeProducao(cfg), (e) => e.code === 'CONFIGURACAO_INVALIDA');
    }
    assert.equal(falso.chamadas.length, 0);
  });
});

// ----------------------------------------------------------------------------------------------------------------------- restauração de produção
const DESTINO = Object.freeze({ banco: 'gepi_cp_restaurado', host: '127.0.0.1', porta: 5432, usuario: 'gepi_cp', arquivoDeSenha: '/tmp/senha-ficticia' });

async function pacotePublicado() {
  const a = await ambiente();
  const composto = await executar(a.config);
  assert.equal(composto.resultado.publicacao.publicada, true);
  return { a, composto, nome: 'prep-1' };
}
function restauracao(p, { spawn = spawnFalso().spawn, dados = linhas(), alterar = (c) => c, fonte = p.a.fonteDeChaves } = {}) {
  const clientes = [];
  const cfg = alterar({
    postgres: { pgRestore: p.a.config.postgres.pgRestore },
    politicaDeDestino: { ...POLITICA },
    fonteDeChaves: fonte,
    criarConexaoDoBanco: (banco) => { const c = clienteFalso(banco, dados); clientes.push(c); return c; },
    prazos: { ...PRAZOS },
    portas: { spawn, observarGrupo: async () => false, temporizador: temporizadorInerte },
  });
  return { r: criarRestauracaoDeProducao(cfg), clientes };
}
const consultas = (clientes) => clientes.filter((c) => c.sqls.includes('PADRAO')).length;
const pedido = (p, extras = {}) => ({ raizAutorizada: p.a.dirs.publicados, nome: p.nome, imagens: { raiz: novaRaiz(), nome: 'img' }, destino: DESTINO, ...extras });

describe('[CP-D] restauração de produção (processo e banco SIMULADOS)', () => {
  teste('CP-D01 — fluxo completo C -> D pela composição: pacote publicado -> abertura -> imagens -> pg_restore (spawn falso, política imposta) -> adaptador de consistência; estados reais NÃO são promovidos', async () => {
    const p = await pacotePublicado();
    const falso = spawnFalso();
    const { r, clientes } = restauracao(p, { spawn: falso.spawn });
    const out = await r.restaurar(pedido(p));
    assert.equal(out.restauracao.ok, true, out.restauracao.motivo);
    assert.deepEqual(falso.chamadas.map((c) => c.nome), ['pg_restore']);
    assert.deepEqual(falso.chamadas[0].args, ['--exit-on-error', '--no-owner', '--no-privileges', '--single-transaction', '--dbname=gepi_cp_restaurado']);
    assert.equal(falso.chamadas[0].shell, false);
    assert.equal(out.restauracao.consistenciaLogica.contratual, true);
    assert.equal(out.restauracao.consistenciaLogica.verificada, false);
    assert.deepEqual([out.restauracao.restauracaoReal, out.restauracao.recuperavel, out.restauracao.aptidaoOperacional.apta], [false, false, false]);
    assert.equal(out.proveniencia.processoDoPgRestore.estado, 'INICIADO');
    assert.equal(out.proveniencia.origemDaChave, 'TESTE_CONTROLADO');
    assert.equal(consultas(clientes), 1, 'uma consulta lógica ao banco restaurado');
    assert.equal(clientes.length, 3, 'sonda antes, consulta de referências e sonda depois');
  });

  teste('CP-D02 — MANIFESTO/HMAC INVÁLIDOS no pacote publicado e CHAVE INCORRETA: AUTENTICACAO_INVALIDA sem pg_restore nem consulta', async () => {
    const p = await pacotePublicado();
    const alvo = path.join(p.a.dirs.publicados, p.nome, 'manifesto.json');
    const original = fs.readFileSync(alvo);
    const forjado = JSON.parse(original.toString());
    forjado.autenticacao.mac = (forjado.autenticacao.mac[0] === '0' ? '1' : '0') + forjado.autenticacao.mac.slice(1);
    const bytes = Buffer.from(JSON.stringify(forjado));
    fs.chmodSync(alvo, 0o600);
    fs.writeFileSync(alvo, bytes);
    fs.writeFileSync(path.join(p.a.dirs.publicados, p.nome, 'manifesto.sha256'), `${sha(bytes)}  manifesto.json\n`);
    const falso = spawnFalso();
    const { r, clientes } = restauracao(p, { spawn: falso.spawn });
    const out = await r.restaurar(pedido(p));
    assert.deepEqual([out.restauracao.ok, out.restauracao.motivo], [false, 'AUTENTICACAO_INVALIDA']);
    assert.deepEqual([falso.chamadas.length, consultas(clientes)], [0, 0]);

    fs.writeFileSync(alvo, original);
    fs.writeFileSync(path.join(p.a.dirs.publicados, p.nome, 'manifesto.sha256'), `${sha(original)}  manifesto.json\n`);
    const outra = criarFonteDeChaves({ origem: 'TESTE_CONTROLADO', chaves: [{ id: 'k-1', segredo: crypto.randomBytes(32) }] });
    const errada = restauracao(p, { spawn: falso.spawn, fonte: outra });
    assert.equal((await errada.r.restaurar(pedido(p))).restauracao.motivo, 'AUTENTICACAO_INVALIDA');
    assert.equal(falso.chamadas.length, 0);
  });

  teste('CP-D03 — DESTINO NÃO AUTORIZADO pela política imposta (banco protegido, prefixo errado, host fora da lista): DESTINO_NAO_AUTORIZADO, nenhum pg_restore, nenhuma imagem restaurada', async () => {
    const p = await pacotePublicado();
    for (const destino of [{ ...DESTINO, banco: 'gestao_epi' }, { ...DESTINO, banco: 'outro_banco' }, { ...DESTINO, host: '10.0.0.9' }]) {
      const falso = spawnFalso();
      const { r, clientes } = restauracao(p, { spawn: falso.spawn });
      const ped = pedido(p, { destino });
      const out = await r.restaurar(ped);
      assert.deepEqual([out.restauracao.ok, out.restauracao.motivo], [false, 'DESTINO_NAO_AUTORIZADO']);
      assert.deepEqual([falso.chamadas.length, clientes.length], [0, 0]);
      assert.equal(fs.existsSync(path.join(ped.imagens.raiz, 'img')), false);
    }
  });

  teste('CP-D04 — FALHA DO pg_restore e PROCESSO INCERTO: saída não zero e processo que não termina nunca dão ok e não consultam o banco', async () => {
    const p = await pacotePublicado();
    const falha = restauracao(p, { spawn: spawnFalso({ restore: 'falha' }).spawn });
    const a = await falha.r.restaurar(pedido(p));
    assert.deepEqual([a.restauracao.ok, a.restauracao.motivo], [false, 'SAIDA_NAO_ZERO']);
    assert.equal(consultas(falha.clientes), 0);
    const trava = restauracao(p, { spawn: spawnFalso({ restore: 'trava' }).spawn, alterar: (c) => { c.portas.temporizador = temporizadorQueExpira; return c; } });
    const b = await trava.r.restaurar(pedido(p));
    assert.equal(b.restauracao.ok, false);
    assert.equal(consultas(trava.clientes), 0);
  });

  teste('CP-D05 — DIVERGÊNCIA entre banco restaurado (simulado) e imagens: referência sem imagem, imagem divergente e consulta de outro banco falham na conferência lógica', async () => {
    const p = await pacotePublicado();
    const extra = linhas();
    extra.padrao.push({ ...extra.padrao[0], id: '9', sha256: H('9'), sha256_miniatura: H('8') });
    assert.equal((await restauracao(p, { dados: extra }).r.restaurar(pedido(p))).restauracao.motivo, 'REFERENCIA_SEM_IMAGEM');
    const diverge = linhas();
    diverge.padrao[0].sha256_miniatura = H('7');
    assert.equal((await restauracao(p, { dados: diverge }).r.restaurar(pedido(p))).restauracao.motivo, 'IMAGEM_DIVERGENTE_DA_REFERENCIA');
    const outroBanco = restauracao(p, { alterar: (c) => { c.criarConexaoDoBanco = () => clienteFalso('gepi_cp_outro'); return c; } });
    const out = await outroBanco.r.restaurar(pedido(p));
    assert.equal(out.restauracao.ok, false);
    assert.equal(out.restauracao.consistenciaLogica.contratual, false);
  });

  teste('CP-D06 — configuração da restauração: política ausente/inválida, fonte falsa, porta de sistema desconhecida e pedido com chave extra são recusados', async () => {
    const p = await pacotePublicado();
    const base = (extra) => restauracao(p, { alterar: (c) => extra(c) });
    assert.throws(() => base((c) => { delete c.politicaDeDestino; return c; }), (e) => e.code === 'CONFIGURACAO_INVALIDA');
    assert.throws(() => base((c) => { c.politicaDeDestino = { ...POLITICA, prefixoDoBanco: 'x_' }; return c; }), (e) => e.code === 'CONFIGURACAO_INVALIDA');
    assert.throws(() => base((c) => { c.politicaDeDestino = { ...POLITICA, hostsAutorizados: ['relativo/dir'] }; return c; }), (e) => e.code === 'CONFIGURACAO_INVALIDA');
    assert.throws(() => base((c) => { c.fonteDeChaves = { origem: 'OPERACIONAL', obter() {} }; return c; }), (e) => e.code === 'CONFIGURACAO_INVALIDA');
    assert.throws(() => base((c) => { c.portas.novo = () => {}; return c; }), (e) => e.code === 'CONFIGURACAO_INVALIDA');
    const { r } = restauracao(p);
    await assert.rejects(() => r.restaurar({ ...pedido(p), autenticacao: { autenticado: true } }), (e) => e.code === 'CONFIGURACAO_INVALIDA');
  });
});

describe('[CP-P] proveniência da restauração real: infraestrutura pronta, estados bloqueados enquanto faltar prova genuína', () => {
  const todosGenuinos = () => criarAvaliadorDeRestauracaoReal({ ehSpawnGenuino: () => true, ehClienteGenuino: () => true });
  const entradasDe = (out, destino = { banco: 'gepi_cp_restaurado', host: '127.0.0.1' }) => ({
    restauracao: out.restauracao,
    processo: out.proveniencia.processoDoPgRestore,
    instanciaAntes: out.proveniencia.instanciaAntes,
    instanciaDepois: out.proveniencia.instanciaDepois,
    consulta: out.proveniencia.consulta,
    destino,
  });

  teste('CP-P01 — fluxo SIMULADO completo: todos os itens de código passam, MAS spawn e clientes não são genuínos; por isso restauracaoReal, consistência verificada e recuperabilidade ficam FALSOS, derivados da proveniência (não de afirmações)', async () => {
    const p = await pacotePublicado();
    const { r } = restauracao(p);
    const out = await r.restaurar(pedido(p));
    assert.equal(out.restauracao.ok, true);
    assert.deepEqual([...out.proveniencia.avaliacao.pendencias].sort(), ['CLIENTE_GENUINO', 'CONSULTAS_REAIS', 'SPAWN_GENUINO']);
    assert.equal(out.proveniencia.avaliacao.reconhecida, false);
    assert.deepEqual({ ...out.estado }, { restauracaoReal: false, consistenciaLogicaVerificada: false, recuperavelEmProducao: false, publicacaoOperacional: false });
    assert.equal(out.restauracao.restauracaoReal, false);
    assert.equal(out.restauracao.consistenciaLogica.verificada, false);
    assert.equal(out.proveniencia.processoDoPgRestore.spawnGenuino, false);
    assert.equal(out.proveniencia.instanciaAntes.clienteGenuino, false);
    assert.equal(out.proveniencia.consulta.clienteGenuino, false);
    assert.equal(out.proveniencia.avaliacao.atestaRecuperabilidadeEmProducao, false);
    assert.equal(ehAvaliacaoReconhecida(out.proveniencia.avaliacao), true, 'produzida pelo avaliador de produção, com pendências');
  });

  teste('CP-P02 — a LÓGICA do avaliador: com genuinidade INJETADA (só em teste) e as evidências reais do fluxo simulado, todos os itens fecham — mas o resultado NUNCA é reconhecido pelo código de produção', async () => {
    const p = await pacotePublicado();
    const out = await restauracao(p).r.restaurar(pedido(p));
    const a = todosGenuinos().avaliar(entradasDe(out));
    assert.equal(a.reconhecida, true, `pendências: ${a.pendencias}`);
    assert.equal(ehAvaliacaoReconhecida(a), false, 'saída de avaliador de teste não é reconhecida pela produção');
    assert.equal(avaliarRestauracaoReal(entradasDe(out)).reconhecida, false);
    assert.throws(() => criarAvaliadorDeRestauracaoReal({}), TypeError);
  });

  teste('CP-P03 — evidência LITERAL, CLONADA ou booleano declarado não são provas: cada peça adulterada derruba os itens que dela dependem', async () => {
    const p = await pacotePublicado();
    const out = await restauracao(p).r.restaurar(pedido(p));
    const base = entradasDe(out);
    const av = todosGenuinos();
    const sem = (campo, valor) => av.avaliar({ ...base, [campo]: valor });
    assert.equal(sem('restauracao', { ...out.restauracao }).reconhecida, false);
    assert.equal(sem('restauracao', { ok: true, restauracaoReal: true, etapas: out.restauracao.etapas }).reconhecida, false);
    assert.equal(sem('processo', { ...base.processo }).itens.PG_RESTORE_PELO_LANCADOR, false);
    assert.equal(sem('processo', { estado: 'INICIADO', terminou: true, fluxosFechados: true, grupo: 'VAZIO_OBSERVADO', spawnGenuino: true, pid: 1234 }).reconhecida, false);
    assert.equal(sem('instanciaAntes', { ...base.instanciaAntes }).itens.INSTANCIA_FISICA, false);
    assert.equal(sem('instanciaDepois', { ...base.instanciaDepois }).itens.IDENTIDADE_DO_BANCO_RESTAURADO, false);
    assert.equal(sem('consulta', { ...base.consulta }).itens.CONSULTAS_REAIS, false);
    assert.equal(sem('consulta', undefined).itens.CORRELACAO, false);
    for (const lixo of [undefined, null, {}, { restauracaoReal: true, verificada: true, recuperavel: true }, 'OPERACIONAL', 42]) assert.equal(avaliarRestauracaoReal(lixo).reconhecida, false);
    assert.equal(avaliarRestauracaoReal({ restauracao: { restauracaoReal: true }, processo: { spawnGenuino: true }, destino: { banco: 'x', host: 'y' } }).pendencias.length, 14);
  });

  teste('CP-P04 — PROCESSO DE OUTRA OPERAÇÃO, BANCO NÃO AUTORIZADO, INSTÂNCIA DIVERGENTE e RESULTADO TERMINAL INCONCLUSIVO derrubam o item correspondente', async () => {
    const p = await pacotePublicado();
    const a1 = await restauracao(p).r.restaurar(pedido(p));
    const a2 = await restauracao(p, { spawn: spawnFalso({ pidBase: 9100 }).spawn }).r.restaurar(pedido(p));
    const av = todosGenuinos();
    const base = entradasDe(a1);
    // processo da OUTRA restauração
    const outro = av.avaliar({ ...base, processo: a2.proveniencia.processoDoPgRestore });
    assert.deepEqual([outro.itens.PG_RESTORE_PELO_LANCADOR, outro.itens.CORRELACAO, outro.reconhecida], [false, false, false]);
    // destino diferente do autorizado
    assert.equal(av.avaliar({ ...base, destino: { banco: 'gepi_cp_outro', host: '127.0.0.1' } }).itens.DESTINO_IDENTIFICADO, false);
    // destino por socket exige o socket correspondente na instância sondada
    assert.equal(av.avaliar({ ...base, destino: { banco: 'gepi_cp_restaurado', host: '/tmp/outro-socket' } }).itens.INSTANCIA_FISICA, false);
    // instância diferente antes/depois
    const outraInstancia = await criarSondaDeInstancia({ criarConexao: () => { const c = clienteFalso('gepi_cp_restaurado'); const q = c.query.bind(c); c.query = async (sql, par) => { const rr = await q(sql, par); return /data_directory/.test(String(sql)) ? { rows: [{ ...rr.rows[0], data_directory: '/outra/instancia' }] } : rr; }; return c; } }).sondar({ banco: 'gepi_cp_restaurado' });
    assert.equal(outraInstancia.ok, true);
    assert.equal(av.avaliar({ ...base, instanciaDepois: outraInstancia }).itens.IDENTIDADE_DO_BANCO_RESTAURADO, false);
    // versão diferente de 16 e listen_addresses não vazio
    const v15 = await criarSondaDeInstancia({ criarConexao: () => { const c = clienteFalso('gepi_cp_restaurado'); const q = c.query.bind(c); c.query = async (sql, par) => { const rr = await q(sql, par); return /data_directory/.test(String(sql)) ? { rows: [{ ...rr.rows[0], versao: '150004', listen: '*' }] } : rr; }; return c; } }).sondar({ banco: 'gepi_cp_restaurado' });
    assert.deepEqual([v15.versao16, v15.listenVazio], [false, false]);
    assert.equal(av.avaliar({ ...base, instanciaAntes: v15 }).itens.INSTANCIA_FISICA, false);
    // resultado terminal inconclusivo: processo que não termina
    const trava = await restauracao(p, { spawn: spawnFalso({ restore: 'trava' }).spawn, alterar: (c) => { c.portas.temporizador = temporizadorQueExpira; return c; } }).r.restaurar(pedido(p));
    assert.equal(trava.restauracao.ok, false);
    const inconclusivo = av.avaliar(entradasDe(trava));
    assert.deepEqual([inconclusivo.itens.RESULTADO_TERMINAL, inconclusivo.reconhecida], [false, false]);
    assert.deepEqual({ ...trava.estado }, { restauracaoReal: false, consistenciaLogicaVerificada: false, recuperavelEmProducao: false, publicacaoOperacional: false });
  });

  teste('CP-P05 — falhas de dump, manifesto, imagem e consulta mantêm todos os estados bloqueados e a avaliação sem reconhecimento', async () => {
    const p = await pacotePublicado();
    const falha = await restauracao(p, { spawn: spawnFalso({ restore: 'falha' }).spawn }).r.restaurar(pedido(p));
    const diverge = linhas();
    diverge.padrao[0].sha256_miniatura = H('7');
    const logica = await restauracao(p, { dados: diverge }).r.restaurar(pedido(p));
    for (const out of [falha, logica]) {
      assert.equal(out.restauracao.ok, false);
      assert.equal(out.proveniencia.avaliacao.reconhecida, false);
      assert.deepEqual({ ...out.estado }, { restauracaoReal: false, consistenciaLogicaVerificada: false, recuperavelEmProducao: false, publicacaoOperacional: false });
    }
    assert.equal(todosGenuinos().avaliar(entradasDe(falha)).itens.RESULTADO_TERMINAL, false);
    assert.equal(todosGenuinos().avaliar(entradasDe(logica)).itens.REFERENCIAS_X_ARQUIVOS, false);
    // imagem divergente: recusada na abertura do pacote, antes de qualquer restauração
    const alvoImg = path.join(p.a.dirs.publicados, p.nome, 'imagens');
    const primeiro = (function achar(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const c = path.join(d, e.name); if (e.isDirectory()) { const r = achar(c); if (r) return r; } else return c; } return null; })(alvoImg);
    fs.chmodSync(primeiro, 0o600);
    fs.appendFileSync(primeiro, 'x');
    const img = await restauracao(p).r.restaurar(pedido(p));
    assert.equal(img.restauracao.ok, false);
    assert.equal(img.proveniencia.avaliacao.reconhecida, false);
  });

  teste('CP-P06 — a proveniência não depende de NODE_ENV nem do ambiente, e as sondas só leem: SQL de escrita é recusado; cliente simulado é marcado como não genuíno; sonda inválida falha fechada', async () => {
    const base = path.join(__dirname, '..', '..', 'src', 'services');
    const codigo = fs.readFileSync(path.join(base, 'imagem-backup-proveniencia-restauracao.service.js'), 'utf8').split('\n').filter((l) => !l.trimStart().startsWith('*') && !l.trimStart().startsWith('//')).join('\n');
    assert.equal(/process\.env|NODE_ENV/.test(codigo), false);
    const cliente = clienteFalso('gepi_cp_restaurado');
    const ok = await criarSondaDeInstancia({ criarConexao: () => cliente }).sondar({ banco: 'gepi_cp_restaurado' });
    assert.deepEqual([ok.ok, ok.clienteGenuino, ok.versao16, ok.listenVazio, ok.semEnderecoTcp], [true, false, true, true, true]);
    assert.deepEqual(cliente.sqls, ['BEGIN', 'SONDA', 'ROLLBACK']);
    const invalida = await criarSondaDeInstancia({ criarConexao: () => { const c = clienteFalso('x'); c.query = async (sql) => (/data_directory/.test(String(sql)) ? { rows: [] } : { rows: [] }); return c; } }).sondar({ banco: 'gepi_cp_restaurado' });
    assert.deepEqual([invalida.ok, invalida.motivo], [false, 'SONDA_INVALIDA']);
    const lanca = await criarSondaDeInstancia({ criarConexao: () => { throw new Error('SEGREDO'); } }).sondar({ banco: 'gepi_cp_restaurado' });
    assert.deepEqual([lanca.ok, lanca.motivo], [false, 'CONEXAO_INDISPONIVEL']);
    assert.throws(() => criarSondaDeInstancia({}), TypeError);
  });
});

describe('[CP-X] identidade da EXECUÇÃO de restauração: correlação forte, sem depender só do PID', () => {
  const novoAvaliador = () => criarAvaliadorDeRestauracaoReal({ ehSpawnGenuino: () => true, ehClienteGenuino: () => true });
  const entradasDe = (out, destino = { banco: 'gepi_cp_restaurado', host: '127.0.0.1' }) => ({
    restauracao: out.restauracao,
    processo: out.proveniencia.processoDoPgRestore,
    instanciaAntes: out.proveniencia.instanciaAntes,
    instanciaDepois: out.proveniencia.instanciaDepois,
    consulta: out.proveniencia.consulta,
    destino,
  });
  const ID = /^[0-9a-f]{32}$/;
  async function duasExecucoes() {
    const p = await pacotePublicado();
    const a = await restauracao(p, { spawn: spawnFalso({ pidBase: 7000 }).spawn }).r.restaurar(pedido(p));
    const b = await restauracao(p, { spawn: spawnFalso({ pidBase: 7000 }).spawn }).r.restaurar(pedido(p));
    return { p, a, b };
  }

  teste('CP-X01 — POSITIVO: a identidade nasce na composição ANTES do lançamento e é a mesma em controle, restaurador, resultado do banco, consulta e sondas; o item CORRELACAO fecha com PID, execução, emissão e não reutilização', async () => {
    const p = await pacotePublicado();
    const out = await restauracao(p).r.restaurar(pedido(p));
    const id = out.proveniencia.execucaoId;
    assert.match(id, ID);
    assert.deepEqual(
      [out.proveniencia.processoDoPgRestore.execucaoId, out.restauracao.execucaoId, out.restauracao.etapas.banco.execucaoId, out.proveniencia.consulta.execucaoId, out.proveniencia.instanciaAntes.execucaoId, out.proveniencia.instanciaDepois.execucaoId],
      [id, id, id, id, id, id],
    );
    assert.equal(out.proveniencia.processoDoPgRestore.pid, out.restauracao.etapas.banco.pgid, 'o PID continua verificado');
    const a = novoAvaliador().avaliar(entradasDe(out));
    assert.equal(a.itens.CORRELACAO, true);
    // a composição (avaliador de produção) já CONCLUIU a execução; o avaliador de teste só relê a lógica, sem gravar nada
    assert.deepEqual({ ...a.correlacao }, { pidConfere: true, execucaoConfere: true, execucaoEmitida: true, execucaoNaoReutilizada: true, estadoDaExecucao: 'CONCLUIDA' });
    assert.equal(a.reconhecida, true, `pendências: ${a.pendencias}`);
    assert.equal(ehAvaliacaoReconhecida(a), false, 'avaliador de teste nunca é reconhecido pela produção');
    // o avaliador padrão (genuinidade de código) continua bloqueado na simulação, pelos outros itens
    assert.equal(out.proveniencia.avaliacao.itens.CORRELACAO, true);
    assert.deepEqual([...out.proveniencia.avaliacao.pendencias].sort(), ['CLIENTE_GENUINO', 'CONSULTAS_REAIS', 'SPAWN_GENUINO']);
    assert.deepEqual({ ...out.estado }, { restauracaoReal: false, consistenciaLogicaVerificada: false, recuperavelEmProducao: false, publicacaoOperacional: false });
  });

  teste('CP-X02 — o identificador NÃO é escolhido pelo chamador: pedido com `execucaoId`, construtores com valor inválido e cada execução com identidade nova e distinta são recusados/garantidos', async () => {
    const p = await pacotePublicado();
    const { r } = restauracao(p);
    await assert.rejects(() => r.restaurar({ ...pedido(p), execucaoId: 'a'.repeat(32) }), (e) => e.code === 'CONFIGURACAO_INVALIDA');
    const ids = new Set();
    for (let i = 0; i < 3; i += 1) ids.add((await restauracao(p).r.restaurar(pedido(p))).proveniencia.execucaoId);
    assert.equal(ids.size, 3);
    for (const ruim of ['', 'zz', 'A'.repeat(32), 'a'.repeat(31), 123, {}]) {
      assert.throws(() => criarControleDeProcesso({ spawn: () => {}, observarGrupo: async () => false, execucaoId: ruim }), TypeError, String(ruim));
      assert.throws(() => criarRestaurador({ execucaoId: ruim }), (e) => e.code === 'PARAMETROS_INVALIDOS', String(ruim));
    }
    assert.throws(() => criarRestauradorDoBanco({ execucaoId: 'zz' }), TypeError);
  });

  teste('CP-X03 — REUTILIZAÇÃO DE PID: duas execuções sequenciais com o MESMO PID simulado e identidades diferentes não se misturam; processo, resultado e consulta de uma não valem para a outra', async () => {
    const { a, b } = await duasExecucoes();
    assert.equal(a.proveniencia.processoDoPgRestore.pid, b.proveniencia.processoDoPgRestore.pid, 'mesmo PID simulado');
    assert.notEqual(a.proveniencia.execucaoId, b.proveniencia.execucaoId);
    const mistos = [
      { ...entradasDe(a), processo: b.proveniencia.processoDoPgRestore },
      { ...entradasDe(a), restauracao: b.restauracao },
      { ...entradasDe(a), consulta: b.proveniencia.consulta },
      { ...entradasDe(a), instanciaAntes: b.proveniencia.instanciaAntes },
      { ...entradasDe(a), instanciaDepois: b.proveniencia.instanciaDepois },
    ];
    for (const entrada of mistos) {
      const r = novoAvaliador().avaliar(entrada);
      assert.equal(r.itens.CORRELACAO, false);
      assert.equal(r.reconhecida, false);
      assert.equal(r.correlacao.execucaoConfere, false);
    }
    assert.equal(novoAvaliador().avaliar(entradasDe(a)).correlacao.pidConfere, true, 'o PID sozinho confere e não basta');
  });

  teste('CP-X04 — EXECUÇÃO CONCLUÍDA REAPRESENTADA: o registro (e não a instância do avaliador) guarda a conclusão; repetir a avaliação, por qualquer instância de produção, devolve resultado NÃO reconhecido e o original continua consultável e imutável', async () => {
    const p = await pacotePublicado();
    const out = await restauracao(p).r.restaurar(pedido(p));
    const id = out.proveniencia.execucaoId;
    const original = consultarAvaliacaoDaExecucao(id);
    assert.equal(original, out.proveniencia.avaliacao, 'o resultado imutável já produzido, sem reexecutar');
    assert.equal(Object.isFrozen(original), true);
    for (const avaliador of [{ avaliar: avaliarRestauracaoReal }, criarAvaliadorPadrao(), criarAvaliadorPadrao()]) {
      const repetida = avaliador.avaliar(entradasDe(out));
      assert.deepEqual([repetida.itens.CORRELACAO, repetida.correlacao.execucaoNaoReutilizada, repetida.correlacao.estadoDaExecucao, repetida.reconhecida, repetida.reapresentada], [false, false, 'CONCLUIDA', false, true]);
      assert.notEqual(repetida, original, 'a repetição não devolve nem refaz a autorização');
    }
    assert.equal(consultarAvaliacaoDaExecucao(id), original, 'a consulta continua devolvendo o mesmo objeto imutável');
    assert.deepEqual({ ...out.estado }, { restauracaoReal: false, consistenciaLogicaVerificada: false, recuperavelEmProducao: false, publicacaoOperacional: false });
    assert.equal(consultarAvaliacaoDaExecucao('0'.repeat(32)), null);
    assert.equal(novoAvaliador().avaliar(entradasDe(out)).reconhecida, true, 'o avaliador de TESTE só relê a lógica (não grava e nunca é reconhecido)');
  });

  teste('CP-X05 — IDENTIFICADOR FABRICADO, AUSENTE e ID COM EVIDÊNCIA CLONADA: o texto igual não prova origem; só objetos reconhecidos emitidos pelos componentes contam', async () => {
    const p = await pacotePublicado();
    const out = await restauracao(p).r.restaurar(pedido(p));
    const id = out.proveniencia.execucaoId;
    // controle REAL com identificador fabricado (não emitido pela fábrica)
    const fabricado = criarControleDeProcesso({ spawn: () => {}, observarGrupo: async () => false, execucaoId: 'f'.repeat(32) }).situacao();
    assert.equal(novoAvaliador().avaliar({ ...entradasDe(out), processo: fabricado }).itens.CORRELACAO, false);
    // controle REAL sem identificador
    const ausente = criarControleDeProcesso({ spawn: () => {}, observarGrupo: async () => false }).situacao();
    assert.equal(ausente.execucaoId, null);
    assert.equal(novoAvaliador().avaliar({ ...entradasDe(out), processo: ausente }).itens.CORRELACAO, false);
    // clone com o MESMO texto de identidade
    const clone = { ...out.proveniencia.processoDoPgRestore };
    assert.equal(clone.execucaoId, id);
    const rClone = novoAvaliador().avaliar({ ...entradasDe(out), processo: clone });
    assert.deepEqual([rClone.itens.CORRELACAO, rClone.itens.PG_RESTORE_PELO_LANCADOR, rClone.itens.RESULTADO_TERMINAL, rClone.reconhecida], [false, false, false, false]);
    // clone do resultado, da consulta e das sondas com o mesmo texto
    for (const campo of ['restauracao', 'consulta', 'instanciaAntes', 'instanciaDepois']) {
      const base = entradasDe(out);
      const r = novoAvaliador().avaliar({ ...base, [campo]: { ...base[campo] } });
      assert.equal(r.reconhecida, false, campo);
    }
    // identificador emitido de verdade, mas anexado a objetos literais
    const emitida = emitirExecucaoDeRestauracao();
    const literal = novoAvaliador().avaliar({ restauracao: { execucaoId: emitida.id, ok: true }, processo: { execucaoId: emitida.id, pid: 1234, spawnGenuino: true }, instanciaAntes: { execucaoId: emitida.id, ok: true }, instanciaDepois: { execucaoId: emitida.id, ok: true }, consulta: { execucaoId: emitida.id, ok: true }, destino: { banco: 'x', host: 'y' } });
    assert.equal(literal.reconhecida, false);
    assert.equal(literal.pendencias.length, 14);
  });

  teste('CP-X06 — CONSULTA DE OUTRO BANCO e MISTURA DE EVIDÊNCIAS DE A E B: banco e execução diferentes derrubam DESTINO_IDENTIFICADO/CORRELACAO; a consulta ecoa a execução e o adaptador valida o formato', async () => {
    const { a, b } = await duasExecucoes();
    const r = novoAvaliador().avaliar({ ...entradasDe(a), consulta: b.proveniencia.consulta, instanciaDepois: b.proveniencia.instanciaDepois, destino: { banco: 'gepi_cp_restaurado', host: '127.0.0.1' } });
    assert.equal(r.itens.CORRELACAO, false);
    const outroBanco = await criarAdaptadorDeReferencias({ criarConexao: () => clienteFalso('gepi_cp_outro') }).consultar({ banco: 'gepi_cp_restaurado', conjuntoId: a.proveniencia.consulta.conjuntoId, sha256Manifesto: a.proveniencia.consulta.sha256Manifesto, execucaoId: a.proveniencia.execucaoId });
    assert.deepEqual([outroBanco.ok, outroBanco.motivo], [false, 'BANCO_DIFERENTE']);
    const ecoa = await criarAdaptadorDeReferencias({ criarConexao: () => clienteFalso('gepi_cp_restaurado') }).consultar({ banco: 'gepi_cp_restaurado', conjuntoId: 'c', sha256Manifesto: H('a'), execucaoId: 'ab'.repeat(16) });
    assert.equal(ecoa.execucaoId, 'ab'.repeat(16));
    await assert.rejects(() => criarAdaptadorDeReferencias({ criarConexao: () => clienteFalso('x') }).consultar({ banco: 'gepi_cp_restaurado', conjuntoId: 'c', sha256Manifesto: H('a'), execucaoId: 'XYZ' }), TypeError);
    const sondaSemId = await criarSondaDeInstancia({ criarConexao: () => clienteFalso('gepi_cp_restaurado') }).sondar({ banco: 'gepi_cp_restaurado' });
    assert.equal(sondaSemId.execucaoId, null);
    await assert.rejects(() => criarSondaDeInstancia({ criarConexao: () => clienteFalso('x') }).sondar({ banco: 'gepi_cp_restaurado', execucaoId: 'nao-hex' }), TypeError);
  });

  teste('CP-X07 — o restaurador recusa a consulta que responde com OUTRA execução (CONSULTA_DE_OUTRA_OPERACAO); sem identidade configurada o comportamento anterior é o mesmo', async () => {
    const p = await pacotePublicado();
    const executor = { autorizarDestino: () => true, async restaurar() { return { ok: true, origem: 'EXECUTOR_INJETADO', restauracaoReal: false, banco: 'gepi_cp_restaurado', codigoDoProcesso: 0 }; } };
    const consultaDe = (execucaoIdDevolvido) => ({ async consultar(ctx) { const real = await criarAdaptadorDeReferencias({ criarConexao: () => clienteFalso(ctx.banco) }).consultar(ctx); return execucaoIdDevolvido === undefined ? real : { ...real, execucaoId: execucaoIdDevolvido }; } });
    const rodar = (opcoes) => criarRestaurador({ fonteDeChaves: p.a.fonteDeChaves, restauradorDoBanco: executor, ...opcoes }).restaurarPacote({ raizAutorizada: p.a.dirs.publicados, nome: p.nome, imagens: { raiz: novaRaiz(), nome: 'img' }, banco: { destino: DESTINO } });
    const id = 'ab'.repeat(16);
    assert.equal((await rodar({ execucaoId: id, consultaDeReferencias: consultaDe('cd'.repeat(16)) })).motivo, 'CONSULTA_DE_OUTRA_OPERACAO');
    assert.equal((await rodar({ execucaoId: id, consultaDeReferencias: consultaDe(null) })).motivo, 'CONSULTA_DE_OUTRA_OPERACAO');
    const ok = await rodar({ execucaoId: id, consultaDeReferencias: consultaDe(undefined) });
    assert.equal(ok.ok, true);
    assert.equal(ok.execucaoId, id);
    const antigo = await rodar({ consultaDeReferencias: consultaDe(undefined) });
    assert.equal(antigo.ok, true);
    assert.equal(antigo.execucaoId, null);
  });

  teste('CP-X08 — estados operacionais permanecem bloqueados em todas as combinações da correlação: nenhuma mistura promove restauração real, publicação, backup válido ou recuperabilidade', async () => {
    const { a, b } = await duasExecucoes();
    for (const out of [a, b]) {
      assert.deepEqual({ ...out.estado }, { restauracaoReal: false, consistenciaLogicaVerificada: false, recuperavelEmProducao: false, publicacaoOperacional: false });
      assert.equal(out.proveniencia.avaliacao.atestaRecuperabilidadeEmProducao, false);
    }
    const base = novoAvaliador().avaliar(entradasDe(a));
    assert.equal(base.atestaRecuperabilidadeEmProducao, false);
    const codigo = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'services', 'imagem-backup-proveniencia-restauracao.service.js'), 'utf8').split('\n').filter((l) => !l.trimStart().startsWith('*') && !l.trimStart().startsWith('//')).join('\n');
    assert.equal(/process\.env|NODE_ENV/.test(codigo), false);
  });
});

describe('[CP-R] ciclo de vida da identidade: conclusão única no REGISTRO, expiração, falha parcial e legado', () => {
  const inj = { ehSpawnGenuino: () => true, ehClienteGenuino: () => true };
  const relogioFalso = () => { let t = 1000; return { agora: () => t, avancar: (ms) => { t += ms; } }; };
  const registroDeTeste = (extra = {}) => { const c = relogioFalso(); return { c, R: criarRegistroDeExecucoes({ capacidade: 50, ttlAtivaMs: 1000, retencaoTerminalMs: 5000, relogio: c.agora, ...extra }) }; };

  /** Os MESMOS passos da composição, com um registro de teste (identidade emitida por ele, levada a todos os componentes reais). `legado`: sem identidade em nenhum componente. */
  async function restaurarManual(p, registro, { spawn = spawnFalso().spawn, temporizador = temporizadorInerte, legado = false } = {}) {
    const execucao = legado ? { id: null } : registro.emitir();
    const opcoesId = legado ? {} : { execucaoId: execucao.id };
    const politica = { ...POLITICA };
    const controle = criarControleDeProcesso({ spawn, observarGrupo: async () => false, ...opcoesId, criarLancador: ({ spawn: s }) => criarLancadorDeRestauracaoComSpawn({ spawn: s, politicaDeDestino: politica }) });
    const restauradorDoBanco = criarRestauradorDoBanco({ alvo: { executavel: p.a.config.postgres.pgRestore }, lancador: controle.lancador, sistema: controle.sistema, temporizador, prazos: { ...PRAZOS }, politicaDeDestino: politica, ...opcoesId });
    const adaptador = criarAdaptadorDeReferencias({ criarConexao: () => clienteFalso(DESTINO.banco) });
    let consulta = null;
    const restaurador = criarRestaurador({ fonteDeChaves: p.a.fonteDeChaves, ...opcoesId, restauradorDoBanco, consultaDeReferencias: { async consultar(ctx) { consulta = await adaptador.consultar(ctx); return consulta; } } });
    const sonda = criarSondaDeInstancia({ criarConexao: () => clienteFalso(DESTINO.banco) });
    const antes = await sonda.sondar({ banco: DESTINO.banco, ...opcoesId });
    const restauracaoFeita = await restaurador.restaurarPacote({ raizAutorizada: p.a.dirs.publicados, nome: p.nome, imagens: { raiz: novaRaiz(), nome: 'img' }, banco: { destino: DESTINO } });
    const depois = restauracaoFeita.ok === true ? await sonda.sondar({ banco: DESTINO.banco, ...opcoesId }) : null;
    return { id: execucao.id, entradas: { restauracao: restauracaoFeita, processo: controle.situacao(), instanciaAntes: antes, instanciaDepois: depois, consulta, destino: { banco: DESTINO.banco, host: DESTINO.host } } };
  }
  const avaliadorDoRegistro = (R) => criarAvaliadorDeRestauracaoReal(inj, { registro: R });

  teste('CP-R01 — a PRIMEIRA avaliação conclui a execução no REGISTRO; a repetição, pela mesma ou por OUTRA instância do avaliador, não gera nova autorização e o resultado original segue imutável e consultável', async () => {
    const p = await pacotePublicado();
    const { R } = registroDeTeste();
    const x = await restaurarManual(p, R);
    assert.equal(R.estado(x.id), 'ATIVA');
    const primeira = avaliadorDoRegistro(R).avaliar(x.entradas);
    assert.equal(primeira.reconhecida, true, `pendências: ${primeira.pendencias}`);
    assert.equal(ehAvaliacaoReconhecida(primeira), false, 'avaliador de teste nunca é reconhecido pela produção');
    assert.equal(R.estado(x.id), 'CONCLUIDA');
    assert.equal(R.resultado(x.id), primeira);
    for (const av of [avaliadorDoRegistro(R), avaliadorDoRegistro(R)]) {
      const repetida = av.avaliar(x.entradas);
      assert.deepEqual([repetida.reconhecida, repetida.reapresentada, repetida.correlacao.estadoDaExecucao, repetida.itens.CORRELACAO], [false, true, 'CONCLUIDA', false]);
      assert.notEqual(repetida, primeira);
    }
    assert.equal(R.resultado(x.id), primeira, 'o original não foi substituído');
  });

  teste('CP-R02 — IDENTIDADE EXPIRADA: depois do prazo a execução não pode mais ser avaliada; removida pela retenção, a identidade é DESCONHECIDA e a evidência antiga não é aceita como nova; nada disso toca processo ou janela', async () => {
    const p = await pacotePublicado();
    const { c, R } = registroDeTeste();
    const x = await restaurarManual(p, R);
    c.avancar(1000);
    assert.equal(R.estado(x.id), 'EXPIRADA');
    const expirada = avaliadorDoRegistro(R).avaliar(x.entradas);
    assert.deepEqual([expirada.reconhecida, expirada.itens.CORRELACAO, expirada.correlacao.estadoDaExecucao], [false, false, 'EXPIRADA']);
    assert.equal(R.concluir(x.id, expirada), false);
    c.avancar(5000);
    R.manter();
    assert.equal(R.estado(x.id), null);
    const removida = avaliadorDoRegistro(R).avaliar(x.entradas);
    assert.deepEqual([removida.reconhecida, removida.itens.CORRELACAO, removida.correlacao.execucaoEmitida, removida.correlacao.estadoDaExecucao], [false, false, false, null]);
    assert.equal(x.entradas.processo.estado, 'INICIADO', 'o retrato do processo é só dado: expirar a identidade não o altera');
  });

  teste('CP-R03 — FALHA APÓS AVALIAÇÃO PARCIAL: erro no meio da avaliação de uma execução coerente a CONCLUI de forma negativa (fail-closed) e ela não volta a ser avaliável como nova', async () => {
    const p = await pacotePublicado();
    const { R } = registroDeTeste();
    const x = await restaurarManual(p, R);
    const destinoQueFalha = new Proxy({ banco: DESTINO.banco, host: DESTINO.host }, { get() { throw new Error('quebrou'); } });
    const parcial = avaliadorDoRegistro(R).avaliar({ ...x.entradas, destino: destinoQueFalha });
    assert.deepEqual([parcial.reconhecida, parcial.falhaNaAvaliacao, parcial.pendencias.length], [false, true, 14]);
    assert.equal(R.estado(x.id), 'CONCLUIDA');
    const depois = avaliadorDoRegistro(R).avaliar(x.entradas);
    assert.deepEqual([depois.reconhecida, depois.reapresentada], [false, true]);
    assert.equal(R.resultado(x.id), parcial);
  });

  teste('CP-R04 — apresentação MISTURADA (processo de B com resultado de A) não consome nenhuma das duas identidades; a avaliação correta de cada uma continua possível', async () => {
    const p = await pacotePublicado();
    const { R } = registroDeTeste();
    const a = await restaurarManual(p, R);
    const b = await restaurarManual(p, R);
    const mista = avaliadorDoRegistro(R).avaliar({ ...a.entradas, processo: b.entradas.processo });
    assert.deepEqual([mista.reconhecida, mista.itens.CORRELACAO, mista.correlacao.execucaoConfere], [false, false, false]);
    assert.deepEqual([R.estado(a.id), R.estado(b.id)], ['ATIVA', 'ATIVA']);
    assert.equal(avaliadorDoRegistro(R).avaliar(a.entradas).reconhecida, true);
    assert.equal(avaliadorDoRegistro(R).avaliar(b.entradas).reconhecida, true);
    assert.deepEqual([R.estado(a.id), R.estado(b.id)], ['CONCLUIDA', 'CONCLUIDA']);
  });

  teste('CP-R05 — TÉRMINO INCONCLUSIVO: processo que não termina conclui a execução COM resultado negativo; reapresentar não autoriza; as proteções (janela/posse) não dependem do registro', async () => {
    const p = await pacotePublicado();
    const { R } = registroDeTeste();
    const x = await restaurarManual(p, R, { spawn: spawnFalso({ restore: 'trava' }).spawn, temporizador: temporizadorQueExpira });
    assert.equal(x.entradas.restauracao.ok, false);
    const r = avaliadorDoRegistro(R).avaliar(x.entradas);
    assert.deepEqual([r.reconhecida, r.itens.RESULTADO_TERMINAL], [false, false]);
    assert.equal(R.estado(x.id), 'CONCLUIDA');
    const codigo = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'services', 'imagem-backup-execucoes.service.js'), 'utf8').split('\n').filter((l) => !l.trimStart().startsWith('*')).join('\n');
    assert.equal(/require\('(?!node:crypto)/.test(codigo), false, 'o registro só conhece crypto: não toca processo, arquivo nem janela');
  });

  teste('CP-R06 — LEGADO: sem identidade em nenhum componente (execucaoId ausente/null) a proveniência operacional nunca é satisfeita, em modo de teste ou de produção', async () => {
    const p = await pacotePublicado();
    const { R } = registroDeTeste();
    const x = await restaurarManual(p, R, { legado: true });
    assert.equal(x.entradas.processo.execucaoId, null);
    assert.equal(x.entradas.restauracao.execucaoId, null);
    for (const av of [criarAvaliadorDeRestauracaoReal(inj), avaliadorDoRegistro(R)]) {
      const r = av.avaliar(x.entradas);
      assert.deepEqual([r.reconhecida, r.itens.CORRELACAO, r.correlacao.execucaoConfere, r.correlacao.estadoDaExecucao], [false, false, false, null]);
    }
    assert.equal(avaliarRestauracaoReal(x.entradas).reconhecida, false);
  });

  teste('CP-R07 — contrato do avaliador de teste com registro: opções desconhecidas ou registro falso são recusados', () => {
    for (const ruim of [{}, { registro: {} }, { registro: { estado() {}, concluir() {} }, extra: 1 }, 'x', null]) assert.throws(() => criarAvaliadorDeRestauracaoReal(inj, ruim), TypeError);
    assert.throws(() => criarAvaliadorDeRestauracaoReal({}), TypeError);
  });
});

describe('[CP-E] portas reais do sistema (sem processos)', () => {
  teste('CP-E01 — observarGrupoReal recusa pgid inválido; grupo inexistente = vazio; temporizadorReal expira e cancela', async () => {
    for (const ruim of [0, 1, -5, 1.5, '12', undefined]) await assert.rejects(() => observarGrupoReal(ruim), TypeError);
    assert.equal(await observarGrupoReal(2 ** 22 - 7), false, 'pgid inexistente');
    const t = temporizadorReal.prazo(10);
    await t.promessa;
    const c = temporizadorReal.prazo(60000);
    c.cancelar();
    await temporizadorReal.intervalo(1);
  });
});

describe('[CP-F] D-F7: TLS opt-in do PostgreSQL na composição', () => {
  const comTlsCfg = (tls, host = 'db.interno.exemplo') => (c) => { c.postgres.host = host; if (tls !== undefined) c.postgres.tls = tls; return c; };
  teste('CP-F01 — sem tls nada muda; com tls verify-full + CA absoluta e host por NOME a configuração é aceita', async () => {
    const sem = await ambiente({});
    assert.doesNotThrow(() => criarBackupDeProducao(sem.config));
    const com = await ambiente({ alterarConfig: comTlsCfg({ modo: 'verify-full', raizCa: path.join(sem.raiz, 'ca.pem') }) });
    assert.doesNotThrow(() => criarBackupDeProducao(com.config));
  });

  teste('CP-F02 — tls com modo fraco, caminho relativo, chave extra ou host por socket Unix é recusado na criação', async () => {
    const ca = '/tmp/ca.pem';
    for (const [tls, host] of [
      [{ modo: 'require', raizCa: ca }, undefined],
      [{ modo: 'verify-full', raizCa: 'ca.pem' }, undefined],
      [{ modo: 'verify-full', raizCa: ca, extra: 1 }, undefined],
      [{ modo: 'verify-full' }, undefined],
      [{ modo: 'verify-full', raizCa: ca }, '/var/run/postgresql'],
    ]) {
      const a = await ambiente({ alterarConfig: comTlsCfg(tls, host) });
      assert.throws(() => criarBackupDeProducao(a.config), `${JSON.stringify(tls)} ${host}`);
    }
  });

  teste('CP-F03 — certificado raiz ausente é dependência indisponível antes de qualquer execução (sem spawn)', async () => {
    const falso = spawnFalso();
    const a = await ambiente({ portasExtras: { spawn: falso.spawn }, alterarConfig: comTlsCfg({ modo: 'verify-full', raizCa: '/nao/existe/ca.pem' }) });
    await assert.rejects(() => executar(a.config), (e) => /CERTIFICADO_RAIZ|DEPENDENCIA/.test(`${e.code} ${e.message}`));
    assert.equal(falso.chamadas.length, 0);
  });
});

describe('[CP-G] adaptador producao-l2 sobre a composição REAL (spawn falso)', () => {
  const { criarProducaoL2 } = require('../../src/services/backup-executor-producao-l2.service');
  const LIDO = { identidade: { sha256Manifesto: 'd'.repeat(64) } };
  const OP = 'e'.repeat(32);

  teste('CP-G01 — resultado reconhecido e publicado: ok com dir sob a raiz de publicados e o manifesto lido pelo leitor injetado', async () => {
    const falso = spawnFalso();
    const a = await ambiente({ portasExtras: { spawn: falso.spawn } });
    let pedidoDeLeitura;
    const p = criarProducaoL2({ composicao: criarBackupDeProducao(a.config), raizPublicados: a.dirs.publicados, lerPacote: async (e) => { pedidoDeLeitura = e; return LIDO; } });
    const r = await p.produzir({ operacaoId: OP, conjuntoId: 'conjunto-cp-0001' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.pacote.dir, path.join(a.dirs.publicados, `l2-${OP}`));
    assert.equal(r.pacote.lido, LIDO);
    assert.deepEqual({ ...pedidoDeLeitura }, { dir: r.pacote.dir, nome: `l2-${OP}` });
    assert.equal(fs.statSync(r.pacote.dir).isDirectory(), true);
    assert.deepEqual(falso.chamadas.map((c) => c.nome), ['pg_dump', 'pg_restore'], 'só os dois processos da supervisão existente');
  });

  teste('CP-G02 — leitor que falha ou devolve manifesto sem hash: PRODUCAO_PACOTE_ILEGIVEL, sem vazar a causa', async () => {
    for (const leitor of [async () => { throw new Error('SEGREDO'); }, async () => ({}), async () => ({ identidade: { sha256Manifesto: 'x' } })]) {
      const a = await ambiente({ portasExtras: { spawn: spawnFalso().spawn } });
      const p = criarProducaoL2({ composicao: criarBackupDeProducao(a.config), raizPublicados: a.dirs.publicados, lerPacote: leitor });
      const r = await p.produzir({ operacaoId: OP, conjuntoId: 'conjunto-cp-0001' });
      assert.deepEqual({ ...r }, { ok: false, codigo: 'PRODUCAO_PACOTE_ILEGIVEL' });
    }
  });

  teste('CP-G03 — falha do pg_dump na composição real: ok false com código fixo e nenhum pacote publicado', async () => {
    const a = await ambiente({ portasExtras: { spawn: spawnFalso({ dump: 'falha' }).spawn } });
    const p = criarProducaoL2({ composicao: criarBackupDeProducao(a.config), raizPublicados: a.dirs.publicados, lerPacote: async () => LIDO });
    const r = await p.produzir({ operacaoId: OP, conjuntoId: 'conjunto-cp-0001' });
    assert.equal(r.ok, false);
    assert.match(r.codigo, /^PRODUCAO_[A-Z_]+$/);
    assert.equal(fs.existsSync(path.join(a.dirs.publicados, `l2-${OP}`)), false);
  });
});
