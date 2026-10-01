'use strict';

const assert = require('node:assert/strict');
const { exigirModulo } = require('../../helpers/exigir-modulo');

/**
 * Apoio dos testes de integração do service de recuperação de senha (Bloco
 * 11C): acesso ao service e à entrega, captura das mensagens enfileiradas,
 * coordenação de concorrência por fatos observáveis no PostgreSQL e sondas
 * de trava de linha. Nada aqui escreve fora do schema temporário da suíte.
 */

const servico = () => exigirModulo('src/services/recuperacao-senha.service');
const entrega = () => exigirModulo('src/services/entrega-recuperacao-senha.service');

const LINHA_TRAVADA = '55P03';
const DEADLOCK = '40P01';

function sinal() {
  let resolver;
  const promessa = new Promise((r) => { resolver = r; });
  return { promessa, resolver };
}

/** Troca a entrega por uma caixa em memória; `aoEnfileirar` roda no instante da chamada. */
function capturarEntrega(t, { aoEnfileirar = () => {} } = {}) {
  // Sem o service não há o que capturar: a falha aponta para ele primeiro.
  servico();
  const caixa = { redefinicoes: [], avisos: [] };
  t.mock.method(entrega(), 'enfileirarRedefinicao', (mensagem) => {
    caixa.redefinicoes.push(mensagem);
    aoEnfileirar('REDEFINICAO', mensagem);
  });
  t.mock.method(entrega(), 'enfileirarAvisoSenhaAlterada', (mensagem) => {
    caixa.avisos.push(mensagem);
    aoEnfileirar('AVISO', mensagem);
  });
  return caixa;
}

function espiarConsole(t) {
  const linhas = [];
  for (const metodo of ['log', 'info', 'warn', 'error', 'debug']) {
    t.mock.method(console, metodo, (...argumentos) => { linhas.push({ metodo, texto: JSON.stringify(argumentos) }); });
  }
  return linhas;
}

/**
 * Pool que registra, para cada conexão entregue ao service, o PID do backend
 * e os comandos SQL já concluídos nela. O comando só entra em `concluidos`
 * depois que o PostgreSQL respondeu: comando iniciado ou que falhou não
 * conta. É por aí que um teste prova o que já estava confirmado num dado
 * instante, sem depender de outra conexão.
 */
function poolEspiao(pool) {
  const pids = [];
  const concluidos = [];
  return {
    pids,
    concluidos,
    connect: async () => {
      const cliente = await pool.connect();
      const pid = cliente.processID;
      pids.push(pid);
      return {
        processID: pid,
        query: async (...argumentos) => {
          const resultado = await cliente.query(...argumentos);
          const [comando] = argumentos;
          concluidos.push({ pid, texto: typeof comando === 'string' ? comando : comando?.text });
          return resultado;
        },
        release: (...argumentos) => cliente.release(...argumentos),
      };
    },
    query: (...argumentos) => pool.query(...argumentos),
  };
}

/** Texto dos comandos já concluídos numa conexão do espião, na ordem em que concluíram. */
const concluidosNaConexao = (espiao, pid) => espiao.concluidos.filter((c) => c.pid === pid).map((c) => c.texto);

/**
 * Espera até que `quantidade` conexões do service estejam de fato paradas
 * num lock do tipo `evento` ('advisory', 'transactionid', 'tuple'), lendo
 * pg_stat_activity. Devolve os PIDs que estão esperando.
 */
async function aguardarEmEspera(executor, espiao, quantidade, evento = 'advisory', { tentativas = 400, intervaloMs = 10 } = {}) {
  for (let i = 0; i < tentativas; i += 1) {
    if (espiao.pids.length >= quantidade) {
      const { rows } = await executor.query(
        "SELECT pid FROM pg_stat_activity WHERE pid = ANY($1::int[]) AND wait_event_type = 'Lock' AND wait_event = $2",
        [espiao.pids, evento],
      );
      if (rows.length >= quantidade) return rows.map((l) => l.pid);
    }
    await new Promise((resolve) => { setTimeout(resolve, intervaloMs); });
  }
  throw new Error(`as conexões do service não chegaram a esperar o lock ${evento} dentro do tempo`);
}

/** Abre uma transação numa conexão própria e toma a trava consultiva de 64 bits informada. */
async function segurarTravaConsultiva(pool, chave64) {
  const cliente = await pool.connect();
  await cliente.query('BEGIN');
  await cliente.query('SELECT pg_advisory_xact_lock($1::bigint)', [chave64]);
  let solto = false;
  return {
    soltar: async () => {
      if (solto) return;
      solto = true;
      try { await cliente.query('COMMIT'); } finally { cliente.release(); }
    },
  };
}

/**
 * Tenta travar uma linha a partir de OUTRA conexão, sem esperar. Devolve
 * 'LIVRE' ou 'TRAVADA'; qualquer outro erro é propagado.
 */
async function sondarLinha(pool, tabela, id) {
  assert.match(tabela, /^[a-z_]+$/);
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    try {
      await cliente.query(`SELECT id FROM ${tabela} WHERE id = $1 FOR UPDATE NOWAIT`, [id]);
      return 'LIVRE';
    } catch (erro) {
      if (erro.code === LINHA_TRAVADA) return 'TRAVADA';
      throw erro;
    } finally {
      await cliente.query('ROLLBACK');
    }
  } finally {
    cliente.release();
  }
}

/** Faz uma função de repositório parar, com a transação do service aberta, até o teste liberar. */
function pausarEm(t, objeto, nome) {
  const original = objeto[nome];
  assert.equal(typeof original, 'function', `função ausente: ${nome}`);
  const chegou = sinal();
  const liberar = sinal();
  t.mock.method(objeto, nome, async (...argumentos) => {
    chegou.resolver();
    await liberar.promessa;
    return original(...argumentos);
  });
  return { chegou: chegou.promessa, liberar: liberar.resolver };
}

module.exports = {
  servico, entrega, sinal, capturarEntrega, espiarConsole, poolEspiao, concluidosNaConexao, aguardarEmEspera, segurarTravaConsultiva, sondarLinha,
  pausarEm, LINHA_TRAVADA, DEADLOCK,
};
