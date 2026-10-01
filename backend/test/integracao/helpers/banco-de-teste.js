'use strict';

/**
 * Único banco em que os testes de integração podem escrever. É uma allowlist
 * de um nome só: qualquer outro banco é recusado, esteja ou não entre os
 * protegidos do projeto.
 *
 * São duas conferências, nesta ordem: o nome no ambiente, antes de abrir a
 * conexão, e o banco real informado pelo próprio PostgreSQL, antes da
 * primeira escrita. A mensagem de recusa leva só o nome do banco.
 */

const BANCO_DE_TESTE = 'gestao_epi_teste_local';
const CODIGO_RECUSA = 'BANCO_DE_TESTE_RECUSADO';

const descrever = (nome) => (typeof nome === 'string' ? JSON.stringify(nome) : 'ausente ou inválido');

function recusa(origem, nome) {
  const erro = new Error(`banco recusado para testes de integração: ${origem}=${descrever(nome)}; único permitido: ${BANCO_DE_TESTE}`);
  erro.code = CODIGO_RECUSA;
  return erro;
}

function exigirNomeDoBancoDeTeste(nome) {
  if (nome !== BANCO_DE_TESTE) {
    throw recusa('DB_NAME', nome);
  }
}

/** Pergunta ao PostgreSQL em que banco a conexão está. Só lê. */
async function confirmarBancoDeTeste(executor) {
  const { rows } = await executor.query('SELECT current_database() AS banco');
  const real = rows[0]?.banco;
  if (real !== BANCO_DE_TESTE) {
    throw recusa('current_database()', real);
  }
  return real;
}

/** Configuração de conexão dos testes; não existe para outro nome de banco. */
function configuracaoDoBancoDeTeste() {
  exigirNomeDoBancoDeTeste(process.env.DB_NAME);
  return {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    database: BANCO_DE_TESTE,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    connectionTimeoutMillis: 8000,
  };
}

module.exports = { BANCO_DE_TESTE, CODIGO_RECUSA, exigirNomeDoBancoDeTeste, confirmarBancoDeTeste, configuracaoDoBancoDeTeste };
