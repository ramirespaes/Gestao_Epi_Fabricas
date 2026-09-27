'use strict';

// A data operacional é o dia civil em São Paulo. Eu não uso o relógio do
// banco nem o fuso do servidor: na AWS eles costumam estar em UTC, e às 21h de
// Brasília já seria o dia seguinte.
const FUSO = 'America/Sao_Paulo';
const FORMATO = new Intl.DateTimeFormat('en-CA', { timeZone: FUSO, year: 'numeric', month: '2-digit', day: '2-digit' });
const DATA_ISO = /^\d{4}-\d{2}-\d{2}$/;

function dataOperacional(agora = new Date()) {
  if (!(agora instanceof Date) || Number.isNaN(agora.getTime())) {
    throw new TypeError('data inválida para calcular a data operacional');
  }
  return FORMATO.format(agora);
}

function exigirDataOperacional(hoje) {
  const valida = typeof hoje === 'string' && DATA_ISO.test(hoje)
    && new Date(`${hoje}T00:00:00Z`).toISOString().slice(0, 10) === hoje;
  if (!valida) {
    throw new TypeError('data operacional inválida');
  }
}

module.exports = { dataOperacional, exigirDataOperacional, FUSO };
