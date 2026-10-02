require('dotenv').config();

const app = require('./app');
const { servicoPadrao } = require('./email/servico-email');
const { criarEncerramento } = require('./encerramento');

const PORT = process.env.PORT || 3000;

const servidor = app.listen(PORT, () => {
  console.log(`[server] gestao-epi-api rodando na porta ${PORT}`);
});

criarEncerramento({ servidor, servico: servicoPadrao() }).instalar();
