'use strict';

/**
 * Sonar S9383 (lote 04): prova de que uma Promise iniciada por evento não escapa como rejeição sem tratamento.
 * A camada HTTP nunca rejeita (falha de rede vira envelope), então a falha é injetada na função já carregada na página.
 */

const FALHA = 'FALHA-SINTETICA-S9383';
const rejeitar = () => Promise.reject(new Error(FALHA));

async function rejeicoesEscapadas(pg, acao) {
  const escapadas = [];
  const ouvir = (motivo) => { escapadas.push(motivo); };
  process.on('unhandledRejection', ouvir);
  try {
    await acao();
    await pg.esperar();
    await new Promise((r) => { setImmediate(r); });
  } finally {
    process.off('unhandledRejection', ouvir);
  }
  return escapadas.map((m) => (m && m.message) || String(m));
}

module.exports = { FALHA, rejeitar, rejeicoesEscapadas };
