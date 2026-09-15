'use strict';

/**
 * Erro HTTP previsível. Lançado por controllers, services e middlewares e
 * convertido em resposta JSON pelo errorHandler.
 *
 * Só o que está aqui chega ao cliente:
 *   status   -> código HTTP
 *   codigo   -> identificador estável em SCREAMING_SNAKE (ex.: 'CREDENCIAIS_INVALIDAS')
 *   message  -> texto público e genérico
 *   detalhes -> estrutura pública opcional (ex.: campos inválidos, sem valores)
 *   headers  -> cabeçalhos opcionais (ex.: Retry-After em 429)
 *
 * NUNCA colocar em message/detalhes: valores recebidos do cliente, SQL,
 * stack, caminhos locais, segredos ou qualquer dado que permita enumeração.
 * `causa` (Error.cause) existe só para diagnóstico interno e nunca é
 * enviada ao cliente.
 */
class HttpError extends Error {
  constructor(status, codigo, message, opcoes = {}) {
    super(message, opcoes.causa ? { cause: opcoes.causa } : undefined);
    this.name = 'HttpError';
    this.status = status;
    this.codigo = codigo;
    this.detalhes = opcoes.detalhes;
    this.headers = opcoes.headers;
    // 4xx é erro esperado: message vai ao cliente. 5xx nunca expõe detalhes.
    this.expose = status < 500;
  }

  corpoResposta() {
    const corpo = { status: 'error', codigo: this.codigo, message: this.message };
    if (this.detalhes !== undefined) {
      corpo.detalhes = this.detalhes;
    }
    return corpo;
  }

  static ehHttpError(erro) {
    return erro instanceof HttpError;
  }

  static badRequest(codigo = 'REQUISICAO_INVALIDA', message = 'Requisição inválida', detalhes) {
    return new HttpError(400, codigo, message, { detalhes });
  }

  // detalhes: lista [{ campo, regra, mensagem }] montada pela validação Zod,
  // sem o valor recebido.
  static validacao(detalhes) {
    return new HttpError(400, 'VALIDACAO', 'Dados inválidos', { detalhes });
  }

  static unauthorized(codigo = 'NAO_AUTENTICADO', message = 'Autenticação necessária') {
    return new HttpError(401, codigo, message);
  }

  static forbidden(codigo = 'SEM_PERMISSAO', message = 'Sem permissão para esta ação') {
    return new HttpError(403, codigo, message);
  }

  static notFound(codigo = 'NAO_ENCONTRADO', message = 'Recurso não encontrado') {
    return new HttpError(404, codigo, message);
  }

  static conflict(codigo = 'CONFLITO', message = 'Conflito com o estado atual do recurso') {
    return new HttpError(409, codigo, message);
  }

  static tooManyRequests(
    codigo = 'LIMITE_EXCEDIDO',
    message = 'Muitas tentativas. Tente novamente mais tarde',
    { retryAfterSegundos } = {},
  ) {
    const headers = Number.isInteger(retryAfterSegundos) && retryAfterSegundos > 0
      ? { 'Retry-After': String(retryAfterSegundos) }
      : undefined;
    return new HttpError(429, codigo, message, { headers });
  }

  static internal(causa) {
    return new HttpError(500, 'ERRO_INTERNO', 'Erro interno do servidor', { causa });
  }

  static serviceUnavailable(causa) {
    return new HttpError(503, 'INDISPONIVEL', 'Serviço temporariamente indisponível', { causa });
  }
}

module.exports = { HttpError };
