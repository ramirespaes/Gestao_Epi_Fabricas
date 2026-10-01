'use strict';

// Carregado com --require pelo comando oficial de integração, depois do
// dotenv. Cada processo de teste recusa um DB_NAME diferente do banco de
// teste antes de carregar qualquer arquivo de teste, inclusive os que abrem
// conexão sem passar por helpers/schema-temporario.
const { exigirNomeDoBancoDeTeste } = require('./helpers/banco-de-teste');

try {
  exigirNomeDoBancoDeTeste(process.env.DB_NAME);
} catch (erro) {
  process.stderr.write(`${erro.message}\n`);
  process.exit(1);
}
