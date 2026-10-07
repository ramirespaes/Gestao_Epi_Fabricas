'use strict';

const svc = require('../src/services/alerta-disponibilidade.service');
const { dataOperacional } = require('../src/utils/data-operacional');

/**
 * Processador do aviso de disponibilidade para entrega (Bloco 12, 12G-6),
 * para um agendador EXTERNO (cron do sistema, EventBridge): nunca um timer
 * dentro do processo da API.
 *
 *   npm run alertas:processar
 *
 * Cada execução reivindica os agendamentos vencidos, recalcula, envia e
 * conclui. Duas execuções ao mesmo tempo são seguras: uma não pega o que a
 * outra já reivindicou. Credenciais só pelo ambiente. A saída é só contagem
 * por estado: nenhum e-mail, nome, empresa ou item.
 */

const SAIDAS = Object.freeze({ OK: 0, ERRO: 1 });

function contarPorEstado(processados) {
  const porEstado = {};
  for (const { estado } of processados) porEstado[estado] = (porEstado[estado] ?? 0) + 1;
  return porEstado;
}

async function executar({
  pool, servicoEmail, agora = new Date(), saida = console,
}) {
  const { processados, abandonados } = await svc.processarVencidos(pool, { agora, hoje: dataOperacional(agora), servicoEmail });
  saida.log('[alertas-estoque]', {
    evento: 'processamento_concluido', processados: processados.length, abandonados, porEstado: contarPorEstado(processados),
  });
  return SAIDAS.OK;
}

async function principal() {
  // Carregados só aqui: o pool e o transporte leem o ambiente ao serem criados.
  const { pool } = require('../src/config/database');
  const { servicoPadrao } = require('../src/email/servico-email');
  const servicoEmail = servicoPadrao();
  try {
    return await executar({ pool, servicoEmail });
  } finally {
    await servicoEmail.fechar();
    await pool.end();
  }
}

if (require.main === module) {
  principal()
    .then((saida) => { process.exitCode = saida; })
    .catch((erro) => {
      console.error('[alertas-estoque]', { evento: 'processamento_falhou', motivo: erro && erro.name });
      process.exitCode = SAIDAS.ERRO;
    });
}

module.exports = { executar, SAIDAS };
