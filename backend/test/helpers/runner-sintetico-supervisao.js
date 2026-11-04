'use strict';

/**
 * RUNNER SINTÉTICO da bateria de supervisão (D-ORF-6). Processo Node descartável, criado SÓ pela suíte `imagem-backup-supervisao-integrada.test.js`, que faz o papel do runner de homologação diante da supervisão: abre a tentativa, lança clientes SINTÉTICOS pelo supervisor de sentinelas
 * real (sentinela real, diário real, canal IPC real) e, conforme o modo, termina normalmente, encerra os clientes, ou MORRE de forma abrupta (SIGKILL de si mesmo) em momentos escolhidos. Nenhum PostgreSQL, nenhum pg_dump/pg_restore reais.
 * Recebe um JSON em argv[2] e escreve uma linha JSON por evento na saída padrão (lida pela suíte).
 */

const path = require('node:path');
const crypto = require('node:crypto');

const RAIZ_BACKEND = path.join(__dirname, '..', '..');
const diarioModulo = require(path.join(RAIZ_BACKEND, 'src/services/imagem-backup-diario-execucao.service'));
const lancadorModulo = require(path.join(RAIZ_BACKEND, 'src/services/imagem-backup-sentinela-lancador.service'));
const { criarLancadorComSpawn } = require(path.join(RAIZ_BACKEND, 'src/services/imagem-backup-pgdump-lancador.service'));
const WORKER = path.join(RAIZ_BACKEND, 'src/workers/imagem-backup-sentinela.worker.js');

const cfg = JSON.parse(process.argv[2]);
const dizer = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const morrer = () => process.kill(process.pid, 'SIGKILL');

async function esperarCliente(raiz, tentativaId, prazoMs = 15000) {
  const limite = Date.now() + prazoMs;
  while (Date.now() < limite) {
    try {
      const leitura = diarioModulo.lerTentativa({ raiz, tentativaId });
      for (const [nome, e] of Object.entries(leitura.escritores)) {
        const lancado = e.eventos.find((ev) => ev.k === 'CLIENTE_LANCADO');
        if (nome.startsWith('sentinela-') && lancado !== undefined) return lancado.d.clientePid;
      }
    } catch { /* ainda não existe */ }
    await esperar(25);
  }
  throw new Error('CLIENTE_NAO_LANCADO');
}

/** O cliente sintético avisa por um arquivo que já instalou o seu tratador de sinal (sem isso o SIGTERM poderia chegar antes e matá-lo pelo comportamento padrão). */
async function esperarProntidaoDoCliente(prontoArquivo, prazoMs = 15000) {
  if (prontoArquivo === undefined) return;
  const fs = require('node:fs');
  const limite = Date.now() + prazoMs;
  while (Date.now() < limite) { if (fs.existsSync(prontoArquivo)) return; await esperar(20); }
  throw new Error('CLIENTE_NAO_PRONTO');
}

async function principal() {
  const { raiz, tentativaId, modo } = cfg;
  const runner = diarioModulo.iniciarTentativa({ raiz, tentativaId, runnerPid: process.pid });
  const opcoesDoSupervisor = { raiz, tentativaId, diario: runner, scriptDaSentinela: WORKER, cortesiaMs: cfg.cortesiaMs ?? 500, esperaPosKillMs: cfg.esperaPosKillMs ?? 3000, grupo: { tentativas: 5, intervaloMs: 100 } };
  const realSpawn = require('node:child_process').spawn;
  let spawnDoNode;
  if (modo === 'morrer-apos-intencao') spawnDoNode = () => { morrer(); };
  if (modo === 'morrer-apos-spawn-da-sentinela') spawnDoNode = (...args) => { const f = realSpawn(...args); morrer(); return f; };
  const sup = lancadorModulo.criarSupervisorDeProcessos({ ...opcoesDoSupervisor, ...(spawnDoNode === undefined ? {} : { spawnDoNode }) });
  const ambiente = { PATH: '/usr/bin:/bin' };
  const argumentosDoCliente = ['-e', cfg.script];

  if (modo === 'dump-capturado') {
    // lançador REAL do pg_dump sobre o spawn do supervisor, com um "pg_dump" sintético (script) e a captura real por pipe
    const fs = require('node:fs');
    const lancador = criarLancadorComSpawn({ spawn: sup.spawn });
    const fd = fs.openSync(cfg.arquivoDoDump, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    const processo = await lancador.lancar({
      executavel: cfg.pgDumpSintetico,
      argumentos: ['--format=custom', '--no-password', '--snapshot=00000003-0000001B-1', '--dbname=gepi_hom_origem'],
      ambiente: { PGPASSFILE: cfg.pgpass, PGHOST: cfg.socketDir, PGPORT: '55433', PGUSER: 'gepi_hom' },
      opcoes: { shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
      saida: { descritor: fd },
    });
    const termino = await processo.saida;
    await processo.fluxosFechados;
    const grupoOcupado = await sup.observarGrupo(processo.pid);
    const captura = typeof lancador.capturaDaSaida === 'function' ? await lancador.capturaDaSaida() : null;
    try { fs.closeSync(fd); } catch { /* a captura pode já ter fechado o descritor */ }
    const bytes = fs.readFileSync(cfg.arquivoDoDump);
    runner.registrar('TENTATIVA_FIM', { resultado: 'SUCESSO' });
    dizer({ e: 'FIM', termino, grupoOcupado, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), capturaOk: captura === null ? null : captura.ok === true });
    return;
  }

  const filho = sup.spawn(process.execPath, argumentosDoCliente, { env: ambiente, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  if (filho === undefined) return;
  const partes = { stdout: [], stderr: [] };
  filho.stdout.on('data', (b) => partes.stdout.push(b));
  filho.stderr.on('data', (b) => partes.stderr.push(b));
  const saida = new Promise((resolver) => { filho.on('exit', (codigo, sinal) => resolver({ codigo, sinal })); });
  const fechado = new Promise((resolver) => { filho.on('close', () => resolver(true)); });
  dizer({ e: 'LANCADO', sentinelaPid: filho.pid });

  if (modo === 'morrer-com-cliente') {
    const clientePid = await esperarCliente(raiz, tentativaId);
    await esperarProntidaoDoCliente(cfg.prontoArquivo);
    dizer({ e: 'CLIENTE', clientePid });
    await esperar(cfg.antesDeMorrerMs ?? 50);
    morrer();
    return;
  }
  if (modo === 'encerrar-clientes') {
    const clientePid = await esperarCliente(raiz, tentativaId);
    await esperarProntidaoDoCliente(cfg.prontoArquivo);
    dizer({ e: 'CLIENTE', clientePid });
    const r = await sup.encerrarClientes({ cortesiaMs: cfg.cortesiaMs ?? 500, esperaMs: cfg.esperaPosKillMs ?? 3000 });
    runner.registrar('TENTATIVA_FIM', { resultado: r.resultado === 'ENCERRADOS' ? 'SUCESSO' : 'FALHA' });
    dizer({ e: 'ENCERRADOS', resultado: r.resultado, clientes: r.clientes.map((c) => ({ encerrado: c.encerrado, grupoVazio: c.grupoVazio, sinal: c.sinal, codigo: c.codigo })) });
    return;
  }
  if (modo === 'kill-do-handle') {
    await esperarCliente(raiz, tentativaId);
    await esperarProntidaoDoCliente(cfg.prontoArquivo);
    const aceito = filho.kill(cfg.sinal);
    const termino = await saida;
    await fechado;
    runner.registrar('TENTATIVA_FIM', { resultado: 'FALHA' });
    dizer({ e: 'FIM', aceito, termino });
    return;
  }
  // modo "normal"
  const termino = await saida;
  await fechado;
  const grupoOcupado = await sup.observarGrupo(filho.pid);
  runner.registrar('TENTATIVA_FIM', { resultado: 'SUCESSO' });
  dizer({ e: 'FIM', termino, grupoOcupado, stdout: Buffer.concat(partes.stdout).toString('utf8'), stderrBytes: Buffer.concat(partes.stderr).length });
}

principal().then(() => process.exit(0), (falha) => { dizer({ e: 'ERRO', codigo: falha && falha.code ? falha.code : 'ERRO' }); process.exit(1); });
