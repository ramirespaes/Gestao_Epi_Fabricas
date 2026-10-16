'use strict';

const { executar } = require('../src/db/guarda-inicializacao');

/**
 * CLI da guarda de inicialização. Encadeado em `npm start` e `npm run dev`
 * antes do servidor: código de saída diferente de 0 impede a inicialização.
 * Só leitura; nunca executa migration nem escreve.
 *
 * Saídas: 0 aprovada; 1 erro técnico (sem conexão, sem credencial); 3 reprovada
 * (banco incorreto, migration pendente, estrutura incompatível).
 */

if (require.main === module) {
  executar().then((codigo) => { process.exitCode = codigo; });
}

module.exports = { executar };
