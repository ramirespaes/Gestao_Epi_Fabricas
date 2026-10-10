'use strict';

/**
 * Recuperação de pacotes de fiscalização abandonados (12K-D6), para um agendador EXTERNO (cron do sistema, EventBridge): nunca um
 * timer dentro do processo da API.
 *
 *   npm run fiscalizacao:recuperar
 *
 * Uma geração é abandonada quando fica GERANDO sem heartbeat por mais de FISCALIZACAO_ABANDONO_SEGUNDOS (padrão 120). A rotina
 * reclama as tentativas, remove o temporário e o ZIP final órfãos e só então marca FALHA (GERACAO_ABANDONADA); nunca promove a
 * CONCLUIDO. Duas execuções ao mesmo tempo são seguras. A saída é só a contagem: nenhum nome, empresa ou caminho.
 */

const SAIDAS = Object.freeze({ OK: 0, ERRO: 1 });

async function executar({ servico, saida = console }) {
  const { recuperados } = await servico.recuperarAbandonados();
  saida.log('[fiscalizacao]', { evento: 'recuperacao_concluida', recuperados });
  return SAIDAS.OK;
}

async function principal() {
  // Carregados só aqui: o pool lê o ambiente ao ser criado.
  const { pool } = require('../src/config/database');
  const { criarServicoDoAmbiente } = require('../src/services/fiscalizacao-pacote.ambiente');
  try {
    const servico = criarServicoDoAmbiente(pool);
    if (!servico) {
      console.error('[fiscalizacao]', { evento: 'recuperacao_indisponivel', motivo: 'FISCALIZACAO_ARMAZENAMENTO_DIRETORIO ausente' });
      return SAIDAS.ERRO;
    }
    return await executar({ servico });
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  principal()
    .then((saida) => { process.exitCode = saida; })
    .catch((erro) => {
      console.error('[fiscalizacao]', { evento: 'recuperacao_falhou', motivo: erro && erro.name });
      process.exitCode = SAIDAS.ERRO;
    });
}

module.exports = { executar, SAIDAS };
