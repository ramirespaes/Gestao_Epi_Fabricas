'use strict';

const { HttpError } = require('../errors/HttpError');

/**
 * Teto de envios de convite por (empresa, e-mail): no mínimo 60 segundos
 * entre dois envios e no máximo 5 convites em 24 horas. Criação e reenvio
 * contam juntos, porque cancelar e criar de novo não pode contornar o teto.
 *
 * A contagem vem das próprias linhas dos convites (criado_em), lidas pelo
 * repositório dentro da transação que já serializa o par (empresa, e-mail).
 * Convites são raros por empresa, então o filtro por empresa_id basta.
 */

const INTERVALO_MINIMO_SEGUNDOS = 60;
const MAXIMO_NA_JANELA = 5;
const JANELA_HORAS = 24;

const MSG = Object.freeze({
  MUITO_RECENTE: 'Um convite foi enviado para este e-mail há poucos instantes. Aguarde para enviar outro',
  LIMITE_DIARIO: 'Limite de convites para este e-mail atingido. Tente novamente mais tarde',
});

const MS_POR_SEGUNDO = 1000;
const MS_JANELA = JANELA_HORAS * 3600 * MS_POR_SEGUNDO;

const ehData = (valor) => valor instanceof Date && !Number.isNaN(valor.getTime());

function validar(resumo) {
  const valido = resumo !== null
    && typeof resumo === 'object'
    && Number.isInteger(resumo.total)
    && resumo.total >= 0
    && ehData(resumo.agora)
    && (resumo.total === 0 || (ehData(resumo.primeiroEm) && ehData(resumo.ultimoEm)));
  if (!valido) {
    throw new TypeError('resumo de envios inválido');
  }
}

const segundosAte = (instante, agora) => Math.max(1, Math.ceil((instante - agora.getTime()) / MS_POR_SEGUNDO));

/**
 * @param {{total: number, primeiroEm: Date|null, ultimoEm: Date|null, agora: Date}} resumo
 *   envios do par (empresa, e-mail) na janela, com o instante do banco
 * @throws {HttpError} 429 com Retry-After quando o envio não é permitido
 */
function exigirEnvioPermitido(resumo) {
  validar(resumo);
  if (resumo.total === 0) {
    return;
  }
  if (resumo.total >= MAXIMO_NA_JANELA) {
    throw HttpError.tooManyRequests('CONVITE_ENVIO_LIMITE_DIARIO', MSG.LIMITE_DIARIO, {
      retryAfterSegundos: segundosAte(resumo.primeiroEm.getTime() + MS_JANELA, resumo.agora),
    });
  }
  const liberaEm = resumo.ultimoEm.getTime() + INTERVALO_MINIMO_SEGUNDOS * MS_POR_SEGUNDO;
  if (resumo.agora.getTime() < liberaEm) {
    throw HttpError.tooManyRequests('CONVITE_ENVIO_MUITO_RECENTE', MSG.MUITO_RECENTE, {
      retryAfterSegundos: segundosAte(liberaEm, resumo.agora),
    });
  }
}

module.exports = {
  INTERVALO_MINIMO_SEGUNDOS, MAXIMO_NA_JANELA, JANELA_HORAS, exigirEnvioPermitido,
};
