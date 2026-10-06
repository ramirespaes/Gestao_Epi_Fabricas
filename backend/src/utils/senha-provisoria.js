'use strict';

const { FUSO } = require('./data-operacional');

/**
 * Validade da senha provisória (Gestão de Usuários): 48 horas, ou 72 quando
 * definida numa sexta-feira no fuso operacional. Sábado e domingo seguem as
 * 48 horas; não há calendário de feriados. O prazo é função só do instante
 * de definição: nada o renova.
 */

const HORAS_PADRAO = 48;
const HORAS_SEXTA = 72;
const HORA_MS = 3_600_000;
const DIA_DA_SEMANA = new Intl.DateTimeFormat('en-US', { timeZone: FUSO, weekday: 'short' });

function exigirData(valor, nome) {
  if (!(valor instanceof Date) || Number.isNaN(valor.getTime())) {
    throw new TypeError(`${nome} deve ser uma data válida`);
  }
}

/** 'Mon' … 'Sun', no fuso operacional. */
function diaDaSemana(instante) {
  exigirData(instante, 'instante');
  return DIA_DA_SEMANA.format(instante);
}

function horasDeValidade(definidaEm) {
  return diaDaSemana(definidaEm) === 'Fri' ? HORAS_SEXTA : HORAS_PADRAO;
}

function calcularValidade(definidaEm = new Date()) {
  exigirData(definidaEm, 'definidaEm');
  const horas = horasDeValidade(definidaEm);
  return { definidaEm, expiraEm: new Date(definidaEm.getTime() + horas * HORA_MS), horas };
}

/** No instante exato da expiração a senha provisória já não vale. */
function expirada(expiraEm, agora = new Date()) {
  exigirData(expiraEm, 'expiraEm');
  exigirData(agora, 'agora');
  return agora.getTime() >= expiraEm.getTime();
}

module.exports = { HORAS_PADRAO, HORAS_SEXTA, FUSO, diaDaSemana, horasDeValidade, calcularValidade, expirada };
