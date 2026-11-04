'use strict';

const os = require('node:os');
const { criarSentinela } = require('../services/imagem-backup-sentinela.service');
const { abrirEscritor } = require('../services/imagem-backup-diario-execucao.service');
const { temporizadorReal, observarGrupoReal } = require('../services/imagem-backup-portas-sistema.service');

/**
 * Processo da SENTINELA (Biblioteca de Imagens, D-ORF-6): entra aqui quando o runner lança `node imagem-backup-sentinela.worker.js <configuração-base64>` com um canal IPC no quarto descritor. Liga as portas reais à lógica de `imagem-backup-sentinela.service`
 * e SAI espelhando o cliente (mesmo código ou o mesmo sinal). Este processo NUNCA escreve na saída padrão nem na de erro: elas são os fluxos do CLIENTE (o stdout do pg_dump é o dump) e qualquer byte a mais as corromperia; tudo o que precisa ser dito vai para o diário durável e para o canal.
 * Não lê ambiente além do que repassa ao cliente (o ambiente do cliente é exatamente o que o runner entregou, sem as variáveis internas do canal do Node).
 */

const SINAIS_DO_SENTINELA = Object.freeze(['SIGINT', 'SIGTERM', 'SIGHUP']);
const SAIDA_INTERNA = 70;
const ESPERA_DO_CANAL_MS = 1500;

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

function ambienteDoCliente() {
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

/** Espelha o desfecho do cliente: o mesmo sinal (depois de devolver o comportamento padrão) ou o mesmo código. */
function espelhar({ codigo, sinal }) {
  if (typeof sinal === 'string' && sinal !== '') {
    for (const s of SINAIS_DO_SENTINELA) process.removeAllListeners(s);
    const numero = os.constants.signals[sinal];
    try { process.kill(process.pid, sinal); } catch { /* cai no código de reserva abaixo */ }
    setTimeout(() => process.exit(128 + (Number.isInteger(numero) ? numero : 0)), 1000);
    return;
  }
  process.exit(Number.isInteger(codigo) ? codigo : SAIDA_INTERNA);
}

async function principal() {
  const c = lerConfiguracao(process.argv[2]);
  if (c === null || typeof c.raiz !== 'string' || typeof c.tentativaId !== 'string' || typeof c.lancamentoId !== 'string') process.exit(2);
  const diario = abrirEscritor({ raiz: c.raiz, tentativaId: c.tentativaId, escritor: `sentinela-${c.lancamentoId}` });
  const canal = criarCanalReal();
  const sentinela = criarSentinela({
    config: { lancamentoId: c.lancamentoId, token: c.token, comando: c.comando, argumentos: c.argumentos, cortesiaMs: c.cortesiaMs, esperaPosKillMs: c.esperaPosKillMs, grupo: c.grupo },
    spawn: require('node:child_process').spawn,
    diario,
    canal,
    temporizador: temporizadorReal,
    sondaGrupo: observarGrupoReal,
    pidProprio: process.pid,
    ambiente: ambienteDoCliente(),
  });
  for (const s of SINAIS_DO_SENTINELA) process.on(s, () => { sentinela.pedirParada('SINAL_AO_SENTINELA', s === 'SIGHUP' ? 'SIGTERM' : s); });
  const resultado = await sentinela.executar();
  await canal.descarregar();
  diario.fechar();
  espelhar(resultado);
}

// Só como processo principal: carregar o módulo (por exemplo, um teste que varre src/) não pode lançar nada nem encerrar o processo.
if (require.main === module) principal().catch(() => { process.exit(SAIDA_INTERNA); });

module.exports = { lerConfiguracao };
