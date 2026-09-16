const { HttpError } = require('../errors/HttpError');

// Erro do body-parser ao interpretar JSON. NUNCA usar err.message (contém
// trecho do corpo) nem logar err (carrega o corpo bruto em err.body).
const TIPO_JSON_INVALIDO = 'entity.parse.failed';

const CORPO_JSON_INVALIDO = Object.freeze({
  status: 'error',
  codigo: 'JSON_INVALIDO',
  message: 'JSON inválido',
});

const MENSAGEM_INTERNA = 'Erro interno do servidor';

// Metadados de log de erro interno: SOMENTE valores com formato controlado.
// Nunca message, stack, cause.message, propriedades extras (ex.: err.body do
// body-parser, err.detail do pg) nem qualquer dado da requisição. Sem
// mascaramento por regex: o que não tem formato garantido não é registrado.
const NOME_ERRO_FORMATO = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;
const CODIGO_APP_FORMATO = /^[A-Z][A-Z0-9_]{0,59}$/; // HttpError.codigo
const CODIGO_LIB_FORMATO = /^[A-Za-z0-9_.]{1,40}$/; // SQLSTATE do pg, type do body-parser, code do Node
const METODO_FORMATO = /^[A-Z]{3,10}$/;
const CAUSAS_MAXIMO = 3;

function notFoundHandler(req, res, next) {
  res.status(404).json({
    status: 'error',
    message: `Rota não encontrada: ${req.method} ${req.originalUrl}`,
  });
}

function nomeDoErro(err) {
  const nome = err && err.constructor && err.constructor.name;
  return typeof nome === 'string' && NOME_ERRO_FORMATO.test(nome) ? nome : 'Error';
}

function descreverErroParaLog(err, req) {
  if (!(err instanceof Error)) {
    return { nome: 'NaoErro', tipoValor: typeof err };
  }
  const descricao = { nome: nomeDoErro(err) };
  if (typeof err.codigo === 'string' && CODIGO_APP_FORMATO.test(err.codigo)) {
    descricao.codigo = err.codigo;
  }
  if (typeof err.code === 'string' && CODIGO_LIB_FORMATO.test(err.code)) {
    descricao.codigoBiblioteca = err.code;
  }
  if (typeof err.type === 'string' && CODIGO_LIB_FORMATO.test(err.type)) {
    descricao.tipo = err.type;
  }
  if (Number.isInteger(err.status)) {
    descricao.status = err.status;
  }
  const causas = [];
  let causa = err.cause;
  while (causa !== undefined && causas.length < CAUSAS_MAXIMO) {
    causas.push(causa instanceof Error ? nomeDoErro(causa) : 'NaoErro');
    causa = causa instanceof Error ? causa.cause : undefined;
  }
  if (causas.length > 0) {
    descricao.causas = causas;
  }
  // Localização: método e PADRÃO da rota (definido no código), nunca a URL.
  if (req && typeof req.method === 'string' && METODO_FORMATO.test(req.method)) {
    descricao.metodo = req.method;
  }
  if (req && req.route && typeof req.route.path === 'string') {
    descricao.rota = req.route.path;
  }
  return descricao;
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (res.headersSent) {
    next(err);
    return;
  }

  if (err && err.type === TIPO_JSON_INVALIDO) {
    res.status(400).json(CORPO_JSON_INVALIDO);
    return;
  }

  if (HttpError.ehHttpError(err)) {
    if (err.headers) {
      res.set(err.headers);
    }
    if (err.expose) {
      res.status(err.status).json(err.corpoResposta());
      return;
    }
    console.error('[error]', descreverErroParaLog(err, req));
    res.status(err.status).json({ status: 'error', codigo: err.codigo, message: MENSAGEM_INTERNA });
    return;
  }

  // Erro inesperado: registra só metadados, responde só o genérico.
  console.error('[error]', descreverErroParaLog(err, req));
  res.status(500).json({ status: 'error', codigo: 'ERRO_INTERNO', message: MENSAGEM_INTERNA });
}

module.exports = { notFoundHandler, errorHandler };
