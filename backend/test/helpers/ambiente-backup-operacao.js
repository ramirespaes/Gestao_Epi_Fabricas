'use strict';

const { after } = require('node:test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { criarFonteDeChaves } = require('../../src/services/imagem-backup-manifesto-autenticado.service');
const { criarProdutorDeRelatorio } = require('../../src/services/imagem-backup-publicacao.service');
const { criarArmazenamentoImagens } = require('../../src/storage/armazenamento-imagens');
const { planejarArquivos } = require('../../src/services/imagem-backup-plano.service');
const { criarJanelaDeBackup } = require('../../src/services/imagem-backup.service');

/** Ambiente FICTÍCIO da entrada operacional: diretórios temporários, binários de mentira nunca executados, spawn e cliente falsos. Nenhum processo, banco ou diretório real. */
const { criarGerenciadorDeFixtures } = require('./fixtures-descartaveis');
const sha =(b) => crypto.createHash('sha256').update(b).digest('hex');
const H = (c) => c.repeat(64);
const DUMP_BYTES = Buffer.from('dump-ficticio-composicao-0123456789-'.repeat(100));

const PREFIXO = 'gepi-cp-test-';
const PRAZOS = { totalMs: 1000, cortesiaMs: 100, intervaloGrupoMs: 100, tentativasGrupo: 1, consultaGrupoMs: 100 };
const POLITICA = { prefixoDoBanco: 'gepi_cp_', hostsAutorizados: ['127.0.0.1'], bancosProtegidos: ['gestao_epi'] };

// Teardown por IDENTIDADE (descritor guardado na criação), nunca por prefixo (ver fixtures-descartaveis.js)
const fix = criarGerenciadorDeFixtures({ prefixo: PREFIXO });
after(() => { fix.remover(); });
function novaRaiz() {
  return fix.criar();
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

function spawnFalso({ dump = 'ok', lista = 'ok', restore = 'ok', aposDump = null, aoListar = null, pidBase = 7000, pedacos = 1, stderrTexto = null } = {}) {
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
        if (dump !== 'falha') {
          const tamanhoDoPedaco = Math.ceil(DUMP_BYTES.length / pedacos); // `pedacos` > 1 emite o dump em vários pedaços (limite atingido no meio do fluxo)
          for (let i = 0; i < DUMP_BYTES.length; i += tamanhoDoPedaco) filho.stdout.write(DUMP_BYTES.subarray(i, i + tamanhoDoPedaco));
        }
        if (stderrTexto !== null) filho.stderr.write(Buffer.from(stderrTexto, 'utf8'));
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
module.exports = { ambiente, spawnFalso, novaRaiz, DUMP_BYTES, PRAZOS, POLITICA, sha, linhas, clienteFalso, temporizadorInerte };
