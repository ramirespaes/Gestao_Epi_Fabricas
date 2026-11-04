'use strict';

/**
 * RUNNER SINTÉTICO da bateria do PostgreSQL efêmero supervisionado (D-ORF-6). Processo Node descartável, criado SÓ pela suíte `imagem-backup-postmaster-integrada.test.js`, que faz o papel do runner de homologação diante da supervisão do POSTMASTER: abre a tentativa, adquire as travas, pede à sentinela do postmaster
 * (real, com canal IPC e diário reais) que lance o POSTMASTER SINTÉTICO (`postgres-sintetico.js`), opcionalmente lança um cliente sintético pela sentinela de clientes e, conforme o modo, encerra tudo na ordem da finalização ou MORRE de forma abrupta (SIGKILL de si mesmo) em momentos escolhidos.
 * Nenhum PostgreSQL, nenhum pg_dump/pg_restore reais. Recebe um JSON em argv[2] e escreve uma linha JSON por evento na saída padrão (lida pela suíte).
 */

const fs = require('node:fs');
const path = require('node:path');

const RAIZ_BACKEND = path.join(__dirname, '..', '..');
const diarioModulo = require(path.join(RAIZ_BACKEND, 'src/services/imagem-backup-diario-execucao.service'));
const lancadorClientes = require(path.join(RAIZ_BACKEND, 'src/services/imagem-backup-sentinela-lancador.service'));
const lancadorPostmaster = require(path.join(RAIZ_BACKEND, 'src/services/imagem-backup-postmaster-lancador.service'));
const WORKER_CLIENTES = path.join(RAIZ_BACKEND, 'src/workers/imagem-backup-sentinela.worker.js');
const WORKER_POSTMASTER = path.join(RAIZ_BACKEND, 'src/workers/imagem-backup-postmaster.worker.js');
const POSTGRES_SINTETICO = path.join(__dirname, 'postgres-sintetico.js');

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
        const intencao = e.eventos.find((ev) => ev.k === 'SENTINELA_ATIVA');
        if (nome.startsWith('sentinela-') && lancado !== undefined && intencao !== undefined && lancado.d.lancamentoId !== cfg.postmasterLancamento) {
          // o cliente é o lançamento cujo papel não é postgres (as sentinelas dos dois tipos escrevem CLIENTE_LANCADO)
          const todos = Object.values(leitura.escritores).flatMap((x) => x.eventos);
          const papel = todos.find((x) => x.k === 'INTENCAO_LANCAMENTO' && x.d.lancamentoId === lancado.d.lancamentoId);
          if (papel === undefined || papel.d.papel !== 'postgres') return lancado.d.clientePid;
        }
      }
    } catch { /* ainda não existe */ }
    await esperar(25);
  }
  throw new Error('CLIENTE_NAO_LANCADO');
}

async function principal() {
  const { raiz, tentativaId, modo, area, pgdata, socket, porta } = cfg;
  const runner = diarioModulo.iniciarTentativa({ raiz, tentativaId, runnerPid: process.pid, area, pgdata });
  if (cfg.travas === true) {
    diarioModulo.adquirirTentativa({ raiz, tentativaId });
    diarioModulo.adquirirRecursos({ raiz, tentativaId, recursos: [{ tipo: 'area', id: area }, { tipo: 'pgdata', id: pgdata }, { tipo: 'socket', id: socket }, { tipo: 'porta', id: String(porta) }] });
  }
  const realSpawn = require('node:child_process').spawn;
  let spawnDoNode;
  if (modo === 'morrer-apos-intencao') spawnDoNode = () => { morrer(); };
  if (modo === 'morrer-apos-spawn-da-sentinela') spawnDoNode = (...args) => { const f = realSpawn(...args); morrer(); return f; };
  const clientes = lancadorClientes.criarSupervisorDeProcessos({ raiz, tentativaId, diario: runner, scriptDaSentinela: WORKER_CLIENTES, cortesiaMs: cfg.cortesiaMs ?? 400, esperaPosKillMs: 3000, grupo: { tentativas: 5, intervaloMs: 100 } });
  const supervisorPg = lancadorPostmaster.criarSupervisorDePostmaster({
    raiz, tentativaId, diario: runner, scriptDoPostmaster: WORKER_POSTMASTER, prazos: cfg.prazos, grupo: { tentativas: 5, intervaloMs: 100 }, identificacao: cfg.identificacao ?? { tentativas: 5, intervaloMs: 100 }, prazoIdentidadeMs: 15000, margemMs: 5000,
    ...(spawnDoNode === undefined ? {} : { spawnDoNode }),
  });

  let clientePid = null;
  if (cfg.comCliente === true) {
    const processo = clientes.spawn(process.execPath, ['-e', cfg.clienteScript], { env: { PATH: '/usr/bin:/bin' }, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    processo.stdout.on('data', () => {});
    processo.stderr.on('data', () => {});
    dizer({ e: 'CLIENTE_LANCADO_PELO_RUNNER', sentinelaPid: processo.pid });
  }

  runner.registrar('POSTGRES_INTENCAO', {});
  const logFd = fs.openSync(cfg.logArquivo, 'a', 0o600);
  let identidade;
  try {
    identidade = await supervisorPg.iniciar({
      comando: process.execPath,
      argumentos: [POSTGRES_SINTETICO, '-D', pgdata, '-c', `port=${porta}`],
      env: { PATH: '/usr/bin:/bin', PG_SINTETICO: JSON.stringify({ porta, socket, ...cfg.pg }) },
      stdio: ['ignore', logFd, logFd],
      esperado: { pgdata, porta, socket },
    });
  } finally { fs.closeSync(logFd); }
  runner.registrar('POSTGRES_IDENTIDADE', { pid: identidade.postmasterPid, area });
  dizer({ e: 'PG', ...identidade });

  if (cfg.comCliente === true) {
    clientePid = await esperarCliente(raiz, tentativaId);
    await esperarProntidaoDoCliente();
    dizer({ e: 'CLIENTE', clientePid });
  }
  if (cfg.prontoPostmaster !== undefined) await esperarArquivo(cfg.prontoPostmaster);

  if (modo === 'morrer-apos-identidade') { await esperar(cfg.antesDeMorrerMs ?? 50); morrer(); return; }
  if (modo === 'aguardar') { await new Promise(() => {}); return; }

  // modos que encerram: na ordem da finalização (clientes, depois o postmaster)
  if (cfg.antesDeEncerrarMs !== undefined) await esperar(cfg.antesDeEncerrarMs);
  dizer({ e: 'ENCERRANDO' });
  const rc = await clientes.encerrarClientes({ cortesiaMs: cfg.cortesiaMs ?? 400, esperaMs: 3000 });
  dizer({ e: 'CLIENTES', resultado: rc.resultado });
  const enc = await supervisorPg.encerrar();
  runner.registrar('POSTGRES_ENCERRADO', { resultado: enc.resultado });
  runner.registrar('TENTATIVA_FIM', { resultado: enc.resultado === 'ENCERRADA' && (rc.resultado === 'ENCERRADOS' || rc.resultado === 'NENHUM') ? 'FINALIZADA' : 'FINALIZADA_COM_PENDENCIAS' });
  dizer({ e: 'ENCERRADO', resultado: enc.resultado, sinais: enc.sinais, falhas: enc.falhas });
}

async function esperarArquivo(arquivo, prazoMs = 15000) {
  const limite = Date.now() + prazoMs;
  while (Date.now() < limite) { if (fs.existsSync(arquivo)) return; await esperar(20); }
  throw new Error('ARQUIVO_NAO_APARECEU');
}
async function esperarProntidaoDoCliente() {
  if (cfg.clientePronto !== undefined) await esperarArquivo(cfg.clientePronto);
}

principal().then(() => process.exit(0), (falha) => { dizer({ e: 'ERRO', codigo: falha && falha.code ? falha.code : 'ERRO' }); process.exit(1); });
