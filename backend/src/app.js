const express = require('express');
const cors = require('cors');

const healthRoutes = require('./routes/health.routes');
const { exigirJson, parserJson } = require('./middleware/conteudo');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');

const app = express();

app.use(cors({ origin: process.env.CORS_ORIGIN?.split(',') || '*' }));

// Política de conteúdo só dentro de /api: exige application/json quando há
// corpo em POST/PUT/PATCH e interpreta JSON com o limite do projeto, antes
// do roteamento. Endpoints fora de /api não a recebem.
app.use('/api', exigirJson, parserJson, healthRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
