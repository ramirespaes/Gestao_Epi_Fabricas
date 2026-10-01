'use strict';

// Preflight do comando oficial de integração (pretest:integracao). Confere o
// nome no ambiente e, só então, pergunta ao próprio PostgreSQL em que banco a
// conexão caiu. Só lê; qualquer divergência ou falha encerra com código 1 e
// o npm não chega a rodar os testes.
const { Client } = require('pg');
const { CODIGO_RECUSA, configuracaoDoBancoDeTeste, confirmarBancoDeTeste } = require('./helpers/banco-de-teste');

const CODIGO_SEGURO = /^[A-Za-z0-9_.]{1,40}$/;

async function confirmar() {
  const cliente = new Client(configuracaoDoBancoDeTeste());
  await cliente.connect();
  try {
    return await confirmarBancoDeTeste(cliente);
  } finally {
    await cliente.end();
  }
}

confirmar().then(
  (banco) => {
    process.stdout.write(`banco de teste confirmado: current_database()=${banco}\n`);
  },
  (erro) => {
    if (erro && erro.code === CODIGO_RECUSA) {
      process.stderr.write(`${erro.message}\n`);
    } else {
      // O erro do pg pode trazer host, porta e usuário: só o código sai daqui.
      const codigo = erro && typeof erro.code === 'string' && CODIGO_SEGURO.test(erro.code) ? erro.code : 'erro sem código';
      process.stderr.write(`não foi possível confirmar o banco de teste (${codigo}); nenhum teste será executado\n`);
    }
    process.exitCode = 1;
  },
);
