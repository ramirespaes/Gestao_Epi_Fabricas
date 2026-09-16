const express = require('express');
const cors = require('cors');

const healthRoutes = require('./routes/health.routes');
const { cabecalhosSeguranca, semCache } = require('./middleware/cabecalhos');
const { exigirJson, parserJson } = require('./middleware/conteudo');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');

const app = express();

// Nunca anunciar a tecnologia do servidor.
app.disable('x-powered-by');

// Cabeçalhos de segurança em toda resposta, inclusive erros e 404.
app.use(cabecalhosSeguranca);

app.use(cors({ origin: process.env.CORS_ORIGIN?.split(',') || '*' }));

// Namespace /api: sem cache, política de conteúdo (exige application/json
// quando há corpo em POST/PUT/PATCH e interpreta JSON com o limite do
// projeto) e rotas. Endpoints fora de /api não recebem essa política.
app.use('/api', semCache, exigirJson, parserJson, healthRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
