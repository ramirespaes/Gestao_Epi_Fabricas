const express = require('express');
const cors = require('cors');

const healthRoutes = require('./routes/health.routes');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');

const app = express();

app.use(cors({ origin: process.env.CORS_ORIGIN?.split(',') || '*' }));
app.use(express.json());

app.use('/api', healthRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
