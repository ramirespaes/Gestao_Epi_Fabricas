function notFoundHandler(req, res, next) {
  res.status(404).json({
    status: 'error',
    message: `Rota não encontrada: ${req.method} ${req.originalUrl}`,
  });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  console.error('[error]', err);
  res.status(err.status || 500).json({
    status: 'error',
    message: err.message || 'Erro interno do servidor',
  });
}

module.exports = { notFoundHandler, errorHandler };
