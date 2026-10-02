'use strict';

/**
 * Encerramento gracioso do servidor. A fila de e-mail vive na memória do
 * processo: ao receber SIGTERM ou SIGINT o servidor deixa de aceitar conexões
 * e mensagens novas, espera as já aceitas terminarem (até limiteMs), fecha o
 * transporte e só então sai. Sai com 1 se algo ficou para trás ou se o
 * fechamento falhou. O registro leva só o evento e a quantidade, nunca
 * destinatário, conteúdo ou a mensagem do erro.
 */

const ETIQUETA_DE_REGISTRO = '[server]';
const SINAIS = Object.freeze(['SIGTERM', 'SIGINT']);
const LIMITE_PADRAO_MS = 10_000;

const registroPadrao = (etiqueta, campos) => { console.log(etiqueta, campos); };

function criarEncerramento({
  servidor, servico, limiteMs = LIMITE_PADRAO_MS, sair = process.exit, registrar = registroPadrao,
}) {
  let emAndamento = null;

  async function executar(sinal) {
    registrar(ETIQUETA_DE_REGISTRO, { evento: 'encerrando', sinal: SINAIS.includes(sinal) ? sinal : 'DESCONHECIDO' });
    let codigo = 0;
    try {
      servidor.close();
      servico.parar();
      const { pendentes } = await servico.aguardarOciosidade(limiteMs);
      if (pendentes > 0) {
        registrar(ETIQUETA_DE_REGISTRO, { evento: 'encerramento_com_pendentes', pendentes });
        codigo = 1;
      }
      await servico.fechar();
    } catch {
      registrar(ETIQUETA_DE_REGISTRO, { evento: 'encerramento_falhou' });
      codigo = 1;
    }
    sair(codigo);
  }

  /** Idempotente: um segundo sinal durante o encerramento espera o mesmo desfecho. */
  function encerrar(sinal) {
    if (emAndamento === null) {
      emAndamento = executar(sinal);
    }
    return emAndamento;
  }

  function instalar(processo = process) {
    for (const sinal of SINAIS) {
      processo.on(sinal, () => { encerrar(sinal); });
    }
  }

  return { encerrar, instalar };
}

module.exports = { criarEncerramento, SINAIS };
