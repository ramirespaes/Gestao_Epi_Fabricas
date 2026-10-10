'use strict';

/**
 * Período do pacote de fiscalização (12K-D6): datas civis YYYY-MM-DD, as duas pontas incluídas, no máximo 366 dias.
 * A contagem é por data civil (UTC puro, sem fuso nem horário de verão): nunca por diferença de instantes.
 */

const DIAS_MAXIMOS = 366;
const FORMATO = /^(\d{4})-(\d{2})-(\d{2})$/;
const DIA_EM_MS = 86400000;

class ErroPeriodo extends Error {
  constructor(codigo, message) {
    super(message);
    this.name = 'ErroPeriodo';
    this.codigo = codigo;
  }
}

/** Dia civil em milissegundos UTC; recusa formato inválido e datas que não existem (30/02). */
function diaCivil(texto) {
  const m = typeof texto === 'string' ? FORMATO.exec(texto) : null;
  if (!m) throw new ErroPeriodo('DATA_INVALIDA', 'Data inválida');
  const [ano, mes, dia] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const instante = Date.UTC(ano, mes - 1, dia);
  const d = new Date(instante);
  if (d.getUTCFullYear() !== ano || d.getUTCMonth() !== mes - 1 || d.getUTCDate() !== dia) {
    throw new ErroPeriodo('DATA_INVALIDA', 'Data inválida');
  }
  return instante;
}

/** Quantidade de dias do período, contando o primeiro e o último (mesmo dia = 1). */
function diasInclusivos(inicio, fim) {
  return Math.round((diaCivil(fim) - diaCivil(inicio)) / DIA_EM_MS) + 1;
}

function validar(inicio, fim) {
  const dias = diasInclusivos(inicio, fim);
  if (dias < 1) throw new ErroPeriodo('PERIODO_INVERTIDO', 'A data final não pode ser anterior à inicial');
  if (dias > DIAS_MAXIMOS) throw new ErroPeriodo('PERIODO_MAXIMO_EXCEDIDO', 'Período acima do máximo permitido');
  return { dias };
}

module.exports = { DIAS_MAXIMOS, ErroPeriodo, diasInclusivos, validar };
