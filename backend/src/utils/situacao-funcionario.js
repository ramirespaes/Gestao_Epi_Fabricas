'use strict';

const { HttpError } = require('../errors/HttpError');

/**
 * Situação funcional do funcionário (S2; coluna `funcionarios.situacao`, migration 084): fonte única das situações,
 * das transições permitidas e da elegibilidade para EPI.
 *
 * Só ATIVO solicita e recebe EPI. AFASTADO e INATIVO ficam fora, cada um com o seu código (nunca "inativo" para quem
 * está afastado). A decisão administrativa de uma solicitação já criada não depende de AFASTADO (ver
 * `exigirNaoInativo`).
 */

const SITUACOES = Object.freeze(['ATIVO', 'AFASTADO', 'INATIVO']);

const TRANSICOES = Object.freeze({
  ATIVO: Object.freeze(['AFASTADO', 'INATIVO']),
  AFASTADO: Object.freeze(['ATIVO', 'INATIVO']),
  INATIVO: Object.freeze(['ATIVO']),
});

const MSG_AFASTADO = 'Trabalhador afastado não solicita nem recebe EPI';
const MSG_INATIVO = 'Trabalhador inativo não recebe EPI';

// Linha lida do repositório: `situacao` é a verdade; `ativo` só cobre objetos antigos sem a coluna.
const situacaoDe = (funcionario) => funcionario.situacao ?? (funcionario.ativo === true ? 'ATIVO' : 'INATIVO');

/** Solicitar e receber EPI: só ATIVO. AFASTADO → 409 FUNCIONARIO_AFASTADO; INATIVO → 409 FUNCIONARIO_INATIVO. */
function exigirPodeReceberEpi(funcionario) {
  const situacao = situacaoDe(funcionario);
  if (situacao === 'ATIVO') return;
  if (situacao === 'AFASTADO') throw HttpError.conflict('FUNCIONARIO_AFASTADO', MSG_AFASTADO);
  throw HttpError.conflict('FUNCIONARIO_INATIVO', MSG_INATIVO);
}

/** Decisão administrativa (aprovar): só o INATIVO é recusado; o afastado pode ter a solicitação decidida. */
function exigirNaoInativo(funcionario) {
  if (situacaoDe(funcionario) === 'INATIVO') throw HttpError.conflict('FUNCIONARIO_INATIVO', MSG_INATIVO);
}

module.exports = {
  SITUACOES, TRANSICOES, situacaoDe, exigirPodeReceberEpi, exigirNaoInativo, MSG_AFASTADO, MSG_INATIVO,
};
