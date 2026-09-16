const express = require('express');

const healthRoutes = require('./routes/health.routes');
const { cabecalhosSeguranca, semCache } = require('./middleware/cabecalhos');
const { corsApi } = require('./middleware/cors');
const { exigirJson, parserJson } = require('./middleware/conteudo');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');

const app = express();

// Nunca anunciar a tecnologia do servidor.
app.disable('x-powered-by');

// Cabeçalhos de segurança em toda resposta, inclusive erros e 404.
app.use(cabecalhosSeguranca);

// Namespace /api: CORS com allowlist (preflight permitido termina aqui, com
// Max-Age e sem no-store), sem cache, política de conteúdo (exige
// application/json quando há corpo em POST/PUT/PATCH e interpreta JSON com o
// limite do projeto) e rotas. Endpoints fora de /api não recebem nada disso.
app.use('/api', corsApi, semCache, exigirJson, parserJson, healthRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
