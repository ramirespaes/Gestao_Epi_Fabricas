'use strict';

/**
 * IP e User-Agent vêm do cliente e são gravados em colunas de tamanho fixo:
 * ip VARCHAR(45) e dispositivo VARCHAR(150) (logs_auditoria,
 * logs_auditoria_plataforma, sessões e tentativas de login). Corto aqui,
 * contando caracteres (nunca parto um caractere composto), para que a
 * gravação não falhe por tamanho e derrube a operação auditada (SEC-002).
 *
 * Ausente vira null. Outro tipo que não texto é erro de programação.
 */

const TAMANHO_MAXIMO_IP = 45;
const TAMANHO_MAXIMO_DISPOSITIVO = 150;

function cortar(valor, tamanhoMaximo, nome) {
  if (valor === null || valor === undefined) {
    return null;
  }
  if (typeof valor !== 'string') {
    throw new TypeError(`${nome} deve ser texto ou ausente`);
  }
  const caracteres = Array.from(valor);
  return caracteres.length > tamanhoMaximo ? caracteres.slice(0, tamanhoMaximo).join('') : valor;
}

const ipParaGravar = (valor) => cortar(valor, TAMANHO_MAXIMO_IP, 'ip');
const dispositivoParaGravar = (valor) => cortar(valor, TAMANHO_MAXIMO_DISPOSITIVO, 'dispositivo');

module.exports = {
  TAMANHO_MAXIMO_IP,
  TAMANHO_MAXIMO_DISPOSITIVO,
  ipParaGravar,
  dispositivoParaGravar,
};
