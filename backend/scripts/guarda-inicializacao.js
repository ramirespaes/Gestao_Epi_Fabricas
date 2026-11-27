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
  // Rejeição inesperada: erro técnico (1), com código fixo; nunca a mensagem nem a pilha, que podem trazer a configuração do banco.
  executar().then((codigo) => { process.exitCode = codigo; }, () => {
    console.error('[guarda] GUARDA_FALHA_INESPERADA: o backend NÃO foi iniciado');
    process.exitCode = 1;
  });
}

module.exports = { executar };
