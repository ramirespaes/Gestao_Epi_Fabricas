'use strict';

/**
 * POSTMASTER SINTÉTICO da bateria de supervisão do PostgreSQL efêmero (D-ORF-6). Processo Node descartável, criado SÓ pelas suítes de teste, que imita o que a sentinela observa e comanda no `postgres` real: aceita `-D <pgdata>`, escreve o `postmaster.pid` (pid, diretório de dados, instante,
 * porta, socket, listen_addresses vazio), trata SIGINT (desligamento rápido) e SIGQUIT (imediato) e pode se comportar mal (ignorar sinais, demorar, escrever identidade errada, deixar um descendente vivo). NÃO é PostgreSQL: não abre socket nem porta, não toca em dados.
 * Comportamento por JSON no ambiente `PG_SINTETICO`:
 *   porta, socket                 — o que vai para a linha 4 e 5 do postmaster.pid
 *   pidArquivo                    — 'normal' (padrão), 'tarde' (escreve depois de `atrasoPidMs`), 'ausente', 'pgdata-errado', número (pid de outro processo, p.ex. um chamariz)
 *   sigint                        — 'sair' (padrão), 'ignorar', número (sai depois desse tempo em ms)
 *   sigquit                       — 'sair' (padrão), 'ignorar'
 *   neto                          — true: cria um descendente no mesmo grupo (pid em `<pgdata>/neto.pid`); ele morre com o postmaster, salvo 'sobrevive'
 *   prontoArquivo                 — arquivo que recebe 'ok' quando os tratadores de sinal já estão instalados
 *   chamariz                      — true: faz-de-conta que é outro PostgreSQL (mesma linha de comando, nunca escreve postmaster.pid, nunca trata sinal além de existir)
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const cfg = JSON.parse(process.env.PG_SINTETICO ?? '{}');
const iDir = process.argv.indexOf('-D');
const pgdata = iDir >= 0 ? process.argv[iDir + 1] : null;
const pronto = () => { if (cfg.prontoArquivo !== undefined) fs.writeFileSync(cfg.prontoArquivo, 'ok'); };

if (cfg.chamariz === true) {
  process.on('SIGINT', () => {});
  process.on('SIGQUIT', () => {});
  pronto();
  setInterval(() => {}, 1000);
} else {
  let neto = null;
  if (cfg.neto !== undefined && cfg.neto !== false) {
    neto = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    fs.writeFileSync(path.join(pgdata, 'neto.pid'), String(neto.pid));
  }
  const pidParaArquivo = typeof cfg.pidArquivo === 'number' ? cfg.pidArquivo : process.pid;
  const dirParaArquivo = cfg.pidArquivo === 'pgdata-errado' ? path.join(path.dirname(pgdata), 'outro-pgdata') : pgdata;
  const escrever = () => fs.writeFileSync(path.join(pgdata, 'postmaster.pid'), `${pidParaArquivo}\n${dirParaArquivo}\n${Math.floor(Date.now() / 1000)}\n${cfg.porta}\n${cfg.socket}\n\n  123 456\nready\n`);
  if (cfg.pidArquivo === 'tarde') setTimeout(escrever, cfg.atrasoPidMs ?? 300);
  else if (cfg.pidArquivo !== 'ausente') escrever();

  const encerrar = (codigo) => {
    if (neto !== null && cfg.neto !== 'sobrevive') { try { neto.kill('SIGKILL'); } catch { /* já encerrado */ } }
    process.exit(codigo);
  };
  if (cfg.sigint === 'ignorar') process.on('SIGINT', () => {});
  else process.on('SIGINT', () => { const atraso = typeof cfg.sigint === 'number' ? cfg.sigint : 0; setTimeout(() => encerrar(0), atraso); });
  if (cfg.sigquit === 'ignorar') process.on('SIGQUIT', () => {});
  else process.on('SIGQUIT', () => encerrar(2));
  pronto();
  setInterval(() => {}, 1000);
}
