'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { criarSentinelaPostmaster } = require('../services/imagem-backup-postmaster-sentinela.service');
const { avaliarIdentidadeDoPostmaster, interpretarLinhaDoPs, interpretarPostmasterPid } = require('../services/imagem-backup-postmaster-identidade.service');
const { abrirEscritor, lerTentativa, observarProcessoReal } = require('../services/imagem-backup-diario-execucao.service');
const { temporizadorReal, observarGrupoReal } = require('../services/imagem-backup-portas-sistema.service');

/**
 * Processo da SENTINELA DO POSTMASTER (Biblioteca de Imagens, D-ORF-6): entra aqui quando o runner lança `node imagem-backup-postmaster.worker.js <configuração-base64>` com um canal IPC no quarto descritor. Liga as portas reais à lógica de `imagem-backup-postmaster-sentinela.service`: o lançamento do
 * `postgres` (com o ambiente, os fluxos e os argumentos que o runner entregou), a leitura da identidade (`ps` e `postmaster.pid`, só leitura), a espera pelos clientes (pelo diário e por sonda de existência, sem sinal) e o grupo. Este processo NUNCA escreve na saída padrão nem na de erro: elas são os fluxos
 * do POSTMASTER (o log do servidor) e tudo o que precisa ser dito vai para o diário durável e para o canal. Os utilitários de leitura (`ps`) são filhos DESTE processo, com prazo, e nunca recebem sinal além do que o próprio Node aplica no prazo.
 */

const SINAIS_DO_WORKER = Object.freeze(['SIGINT', 'SIGTERM', 'SIGHUP']);
const SAIDA_INTERNA = 70;
const ESPERA_DO_CANAL_MS = 1500;
const PRAZO_PS_MS = 10000;
const AMBIENTE_DO_PS = Object.freeze({ PATH: '/usr/bin:/bin', LC_ALL: 'C', LANG: 'C' });

function lerConfiguracao(argumento) {
  if (typeof argumento !== 'string' || argumento === '' || argumento.length > 1024 * 1024) return null;
  try {
    const c = JSON.parse(Buffer.from(argumento, 'base64').toString('utf8'));
    if (c === null || typeof c !== 'object' || c.v !== 1) return null;
    return c;
  } catch {
    return null;
  }
}

function ambienteDoPostmaster() {
  const ambiente = { ...process.env };
  for (const chave of Object.keys(ambiente)) if (chave.startsWith('NODE_CHANNEL')) delete ambiente[chave];
  return ambiente;
}

function criarCanalReal() {
  let pendentes = 0;
  return {
    enviar(mensagem) {
      if (process.connected !== true || typeof process.send !== 'function') return false;
      pendentes += 1;
      try {
        process.send(mensagem, undefined, undefined, () => { pendentes -= 1; });
        return true;
      } catch {
        pendentes -= 1;
        return false;
      }
    },
    aoMensagem: (cb) => { process.on('message', cb); },
    aoDesconectar: (cb) => { process.on('disconnect', cb); },
    conectado: () => process.connected === true,
    async descarregar() {
      const limite = Date.now() + ESPERA_DO_CANAL_MS;
      while (pendentes > 0 && Date.now() < limite) await new Promise((r) => setTimeout(r, 10));
    },
  };
}

/** `ps` do pid (só leitura, com prazo, ambiente fixo). Qualquer falha, prazo ou saída fora da forma exata vale `null` (nunca presunção). */
function lerPs(identificador) {
  return new Promise((resolver) => {
    if (!Number.isSafeInteger(identificador) || identificador <= 1) { resolver(null); return; }
    execFile('/bin/ps', ['-o', 'uid=,ppid=,lstart=,command=', '-p', String(identificador)], { env: AMBIENTE_DO_PS, timeout: PRAZO_PS_MS, maxBuffer: 1024 * 1024, windowsHide: true }, (falha, saida) => {
      resolver(falha ? null : interpretarLinhaDoPs(saida));
    });
  });
}

function lerPostmasterPid(pgdata) {
  try { return interpretarPostmasterPid(fs.readFileSync(path.join(pgdata, 'postmaster.pid'), 'utf8')); } catch { return null; }
}

/** Há sentinela de CLIENTE viva sem término? `PENDENTES` (alguma viva), `INCONCLUSIVO` (não se sabe) ou `NENHUM`. Só lê o diário e sonda a existência (sonda que não entrega sinal): nunca sinaliza. */
async function clientesPendentes({ raiz, tentativaId, lancamentoId }) {
  let leitura;
  try { leitura = lerTentativa({ raiz, tentativaId }); } catch { return 'INCONCLUSIVO'; }
  if (leitura.problemas.length > 0) return 'INCONCLUSIVO';
  const todos = Object.values(leitura.escritores);
  if (todos.some((e) => e.estado !== 'INTEGRO')) return 'INCONCLUSIVO';
  const eventos = todos.flatMap((e) => e.eventos);
  const ids = [...new Set(eventos.filter((e) => e.k === 'INTENCAO_LANCAMENTO' && e.d.papel !== 'postgres').map((e) => e.d.lancamentoId))].filter((x) => x !== lancamentoId);
  let inconclusivo = false;
  for (const id of ids) {
    const meus = eventos.filter((e) => e.d.lancamentoId === id);
    if (meus.some((e) => e.k === 'LANCAMENTO_NAO_INICIADO' || e.k === 'LANCAMENTO_FALHOU' || e.k === 'SENTINELA_FIM')) continue;
    const pidDaSentinela = (meus.filter((e) => e.k === 'SENTINELA_ATIVA' || e.k === 'SENTINELA_LANCADA').at(-1) ?? { d: {} }).d.sentinelaPid;
    if (pidDaSentinela === undefined) { inconclusivo = true; continue; }
    const r = await observarProcessoReal(pidDaSentinela);
    if (r === 'VIVO') return 'PENDENTES';
    if (r !== 'AUSENTE') inconclusivo = true;
  }
  return inconclusivo ? 'INCONCLUSIVO' : 'NENHUM';
}

/** Espelha o desfecho do postmaster: o mesmo sinal (depois de devolver o comportamento padrão) ou o mesmo código. */
function espelhar({ codigo, sinal }) {
  if (typeof sinal === 'string' && sinal !== '') {
    for (const s of SINAIS_DO_WORKER) process.removeAllListeners(s);
    const numero = os.constants.signals[sinal];
    try { process.kill(process.pid, sinal); } catch { /* cai no código de reserva abaixo */ }
    setTimeout(() => process.exit(128 + (Number.isInteger(numero) ? numero : 0)), 1000);
    return;
  }
  process.exit(Number.isInteger(codigo) ? codigo : SAIDA_INTERNA);
}

async function principal() {
  const c = lerConfiguracao(process.argv[2]);
  if (c === null || typeof c.raiz !== 'string' || typeof c.tentativaId !== 'string' || typeof c.lancamentoId !== 'string' || c.esperado === null || typeof c.esperado !== 'object') process.exit(2);
  const diario = abrirEscritor({ raiz: c.raiz, tentativaId: c.tentativaId, escritor: `sentinela-${c.lancamentoId}` });
  const canal = criarCanalReal();
  let inicioBase = null;
  const sentinela = criarSentinelaPostmaster({
    config: { lancamentoId: c.lancamentoId, token: c.token, comando: c.comando, argumentos: c.argumentos, prazos: c.prazos, grupo: c.grupo, identificacao: c.identificacao },
    spawn: require('node:child_process').spawn,
    diario,
    canal,
    temporizador: temporizadorReal,
    sondaGrupo: observarGrupoReal,
    pidProprio: process.pid,
    ambiente: ambienteDoPostmaster(),
    capturarBase: async (identificador) => {
      const ps = await lerPs(identificador);
      if (ps === null) return false;
      inicioBase = ps.inicio;
      return true;
    },
    identificar: async ({ pid, filho }) => {
      const esperado = { pid, pgdata: c.esperado.pgdata, porta: c.esperado.porta, socket: c.esperado.socket, uid: process.getuid(), ppid: process.pid, inicio: inicioBase ?? '', executavel: path.basename(c.comando) };
      return avaliarIdentidadeDoPostmaster({ esperado, observado: { filho, pidArquivo: lerPostmasterPid(c.esperado.pgdata), ps: await lerPs(pid) } });
    },
    clientesPendentes: () => clientesPendentes({ raiz: c.raiz, tentativaId: c.tentativaId, lancamentoId: c.lancamentoId }),
  });
  for (const s of SINAIS_DO_WORKER) process.on(s, () => { sentinela.pedirParada('SINAL_AO_SENTINELA'); });
  const resultado = await sentinela.executar();
  await canal.descarregar();
  diario.fechar();
  espelhar(resultado);
}

// Só como processo principal: carregar o módulo (por exemplo, um teste que varre src/) não pode lançar nada nem encerrar o processo.
if (require.main === module) principal().catch(() => { process.exit(SAIDA_INTERNA); });

module.exports = { lerConfiguracao };
