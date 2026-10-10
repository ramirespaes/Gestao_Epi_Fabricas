'use strict';

const express = require('express');
const { HttpError } = require('../errors/HttpError');
const { JSON_LIMITE, JSON_LIMITE_IMPORTACAO_GHE } = require('../config/http');

/**
 * Política de conteúdo do namespace /api.
 *
 * exigirJson: para POST, PUT e PATCH com corpo, aceita exclusivamente o tipo
 * de mídia application/json (a comparação é feita por req.is(), não por
 * igualdade de string) com contrato estreito de parâmetros: nenhum, ou
 * exatamente charset=utf-8 em qualquer caixa. O body-parser decodificaria
 * UTF-16 e UTF-32 e ignoraria parâmetros desconhecidos, mas nada disso faz
 * parte do contrato da API. A existência de corpo
 * é decidida SÓ pelos cabeçalhos, sem ler o stream: Transfer-Encoding
 * presente ou Content-Length maior que zero indicam corpo; ausência de ambos
 * ou Content-Length: 0 indicam ausência. GET, HEAD e OPTIONS não são
 * verificados. As respostas 415 são fixas e nunca ecoam o Content-Type ou o
 * charset recebidos.
 *
 * parserJson: express.json com o limite único do projeto (config/http.js),
 * modo estrito e sem descompressão (inflate: false), para reduzir a
 * superfície de abuso por compressão. Erros do parser são traduzidos pelo
 * errorHandler.
 *
 * EXCEÇÕES DE TAMANHO (duas, e só estas): o preview e a confirmação da importação GHE/EPI aceitam até 512 KiB
 * (parserJsonImportacaoGhe). Para isso o parserJson isenta EXATAMENTE `POST /api/grupos-homogeneos/importacao/preview` e
 * `POST /api/grupos-homogeneos/importacao/confirmar` (comparação de igualdade, nunca prefixo; qualquer variação de caminho
 * cai no limite de 32 KiB), e a PRÓPRIA ROTA aplica o parser de 512 KiB depois da sessão e da permissão. Assim um corpo grande nunca é lido antes de autenticar e autorizar. exigirJson (tipo e codificação) vale para todos.
 */

const METODOS_COM_CORPO = new Set(['POST', 'PUT', 'PATCH']);
const CONTENT_LENGTH_FORMATO = /^[0-9]+$/;

function temCorpo(req) {
  if (req.headers['transfer-encoding'] !== undefined) {
    return true;
  }
  const contentLength = req.headers['content-length'];
  return typeof contentLength === 'string' && CONTENT_LENGTH_FORMATO.test(contentLength) && Number(contentLength) > 0;
}

// Contrato estreito dos parâmetros do Content-Type, lidos SÓ do valor do
// cabeçalho: zero parâmetros, ou exatamente um parâmetro charset=utf-8
// (nome e valor sem distinção de caixa, valor opcionalmente entre aspas).
// Qualquer outra combinação (charset vazio, sem "=", repetido, diferente de
// utf-8, ou parâmetro desconhecido) é inválida. Nunca loga o valor.
function parametrosPermitidos(contentType) {
  if (typeof contentType !== 'string') {
    return false;
  }
  const parametros = contentType.split(';').slice(1).map((parametro) => parametro.trim());
  if (parametros.length === 0) {
    return true;
  }
  if (parametros.length !== 1) {
    return false;
  }
  const separador = parametros[0].indexOf('=');
  if (separador === -1) {
    return false;
  }
  const nome = parametros[0].slice(0, separador).trim().toLowerCase();
  const valor = parametros[0].slice(separador + 1).trim().replace(/^"(.*)"$/, '$1').toLowerCase();
  return nome === 'charset' && valor === 'utf-8';
}

function exigirJson(req, res, next) {
  if (!METODOS_COM_CORPO.has(req.method) || !temCorpo(req)) {
    next();
    return;
  }
  if (!req.is('application/json')) {
    next(new HttpError(415, 'TIPO_CONTEUDO_NAO_SUPORTADO', 'Content-Type deve ser application/json'));
    return;
  }
  if (!parametrosPermitidos(req.headers['content-type'])) {
    next(new HttpError(415, 'CODIFICACAO_NAO_SUPORTADA', 'Charset ou codificação do corpo não suportados: envie JSON em UTF-8 sem compressão'));
    return;
  }
  next();
}

const parserJsonPadrao = express.json({ limit: JSON_LIMITE, strict: true, inflate: false });
const parserJsonImportacaoGhe = express.json({ limit: JSON_LIMITE_IMPORTACAO_GHE, strict: true, inflate: false });

const ROTAS_COM_LIMITE_PROPRIO = Object.freeze([
  Object.freeze({ metodo: 'POST', caminho: '/api/grupos-homogeneos/importacao/preview' }),
  Object.freeze({ metodo: 'POST', caminho: '/api/grupos-homogeneos/importacao/confirmar' }),
]);

// baseUrl + path = caminho completo, esteja o parser montado em /api (app.js) ou na raiz (app de teste).
const ehRotaComLimiteProprio = (req) => ROTAS_COM_LIMITE_PROPRIO.some((rota) => req.method === rota.metodo && `${req.baseUrl}${req.path}` === rota.caminho);

function parserJson(req, res, next) {
  if (ehRotaComLimiteProprio(req)) {
    next();
    return;
  }
  parserJsonPadrao(req, res, next);
}

module.exports = { exigirJson, parserJson, parserJsonImportacaoGhe, ROTAS_COM_LIMITE_PROPRIO };
