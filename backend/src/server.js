require('dotenv').config();

const app = require('./app');
const { servicoPadrao } = require('./email/servico-email');
const { criarEncerramento } = require('./encerramento');
const { processadorDoProcesso } = require('./services/imagem-processador.ambiente');
const { enderecoDeEscuta, escutar } = require('./config/bind');

const PORT = process.env.PORT || 3000;
const ENDERECO = enderecoDeEscuta(process.env);

const servidor = escutar(app, PORT, ENDERECO, (erro) => {
  const onde = `porta ${PORT}${ENDERECO === undefined ? '' : ` (endereço ${ENDERECO})`}`;
  if (erro) {
    // O Express 5 também chama esta função quando a escuta falha (EADDRINUSE, EADDRNOTAVAIL). Nada foi aceito ainda: sai com erro, sem declarar sucesso.
    console.error(`[server] gestao-epi-api não conseguiu escutar na ${onde}: ${String(erro.code ?? 'ERRO_DE_ESCUTA').replace(/[^A-Z0-9_]/g, '?')}`);
    process.exit(1);
  }
  console.log(`[server] gestao-epi-api rodando na ${onde}`);
});

criarEncerramento({ servidor, servico: servicoPadrao(), processos: processadorDoProcesso() }).instalar();
