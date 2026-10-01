'use strict';

const { ipParaGravar, dispositivoParaGravar } = require('../utils/origem-requisicao');

/**
 * Solicitações de recuperação de senha (recuperacao_senha_solicitacoes,
 * migration 063): primitivas do limite por e-mail.
 *
 * Entra só a chave HMAC do e-mail (security/cooldown) e o escopo. A linha é
 * a mesma exista ou não a conta, e nada aqui consulta conta alguma: quem
 * decide quantas solicitações cabem na janela é o serviço. A purga por
 * retenção fica para a rotina de manutenção.
 *
 * O executor chega por parâmetro; o pool nunca é importado.
 */

const ESCOPOS = Object.freeze({ PORTAL: 'PORTAL', PLATAFORMA: 'PLATAFORMA' });
const FORMATO_CHAVE = /^[0-9a-f]{64}$/;
const JANELA_MAXIMA_MINUTOS = 1440;

function exigirEscopo(escopo) {
  if (typeof escopo !== 'string' || !Object.hasOwn(ESCOPOS, escopo)) {
    throw new TypeError('escopo de solicitação inválido');
  }
}

function exigirChave(chave) {
  if (typeof chave !== 'string' || !FORMATO_CHAVE.test(chave)) {
    throw new TypeError('chave da solicitação com formato inválido');
  }
}

function exigirJanela(minutos) {
  if (!Number.isInteger(minutos) || minutos < 1 || minutos > JANELA_MAXIMA_MINUTOS) {
    throw new TypeError('janela de contagem inválida');
  }
}

/** Registra uma solicitação e devolve o identificador (string decimal). */
async function registrar(executor, { escopo, chave, ip = null, dispositivo = null }) {
  exigirEscopo(escopo);
  exigirChave(chave);
  const ipGravado = ipParaGravar(ip);
  const dispositivoGravado = dispositivoParaGravar(dispositivo);

  const { rows } = await executor.query(
    `INSERT INTO recuperacao_senha_solicitacoes (escopo, chave, ip, dispositivo)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [escopo, chave, ipGravado, dispositivoGravado],
  );
  return rows[0].id;
}

/** Quantas solicitações da chave, no escopo, caem na janela contada pelo relógio do banco. */
async function contarRecentes(executor, { escopo, chave, janelaMinutos }) {
  exigirEscopo(escopo);
  exigirChave(chave);
  exigirJanela(janelaMinutos);

  const { rows } = await executor.query(
    `SELECT count(*)::int AS total
       FROM recuperacao_senha_solicitacoes
      WHERE escopo = $1 AND chave = $2 AND criado_em > now() - ($3 * INTERVAL '1 minute')`,
    [escopo, chave, janelaMinutos],
  );
  return rows[0].total;
}

module.exports = { ESCOPOS, registrar, contarRecentes };
