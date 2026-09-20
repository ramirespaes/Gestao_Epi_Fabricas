'use strict';

const { HttpError } = require('../errors/HttpError');

/**
 * Validação de entrada com Zod 4 para Express 5.
 *
 * validar({ params, query, body }) devolve um middleware que valida somente
 * as partes configuradas, todas antes de responder (params, depois query,
 * depois body), e só em sucesso completo define req.validado: objeto raiz
 * congelado, cada parte congelada, propriedade não gravável. Em qualquer
 * falha a propriedade não é criada. req.body, req.params e req.query nunca
 * são substituídos (no Express 5 a atribuição a req.query é ignorada em
 * silêncio); controllers leem exclusivamente de req.validado.
 *
 * Falha vira HttpError.validacao(detalhes) -> HTTP 400. Cada detalhe tem
 * campo ("body.email", "params.id", "query.limite"), codigo e mensagem, e
 * opcionalmente limite quando o schema define mínimo/máximo nativo.
 *
 * SEGURANÇA DA TRADUÇÃO
 * - issues nativas do Zod recebem mensagens FIXAS deste módulo; issue.message
 *   só é usada em issues 'custom' com params.codigo, que são strings fixas
 *   dos nossos schemas;
 * - CAMPO_OBRIGATORIO x TIPO_INVALIDO é decidido pela EXISTÊNCIA da
 *   propriedade no objeto original ao longo do caminho, sem ler issue.input
 *   e sem levar o valor a mensagem, detalhe ou log;
 * - nomes de chaves desconhecidas só aparecem se forem segmentos estruturais
 *   seguros; caso contrário o detalhe fica genérico na origem;
 * - nunca serializa a issue, nunca inclui valores recebidos.
 * Nada aqui loga nem acessa banco.
 */

const ORIGENS = ['params', 'query', 'body'];
const DETALHES_MAXIMO = 20;
const CHAVES_DESCONHECIDAS_MAXIMO = 5;
const SEGMENTO_SEGURO = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const CODIGO_FORMATO = /^[A-Z][A-Z0-9_]{0,59}$/;

const MENSAGENS = Object.freeze({
  CORPO_INVALIDO: 'Corpo da requisição deve ser um objeto JSON',
  ENTRADA_INVALIDA: 'Entrada inválida',
  CAMPO_OBRIGATORIO: 'Campo obrigatório',
  TIPO_INVALIDO: 'Tipo inválido',
  TAMANHO_MINIMO: 'Valor abaixo do limite permitido',
  TAMANHO_MAXIMO: 'Valor acima do limite permitido',
  VALOR_NAO_PERMITIDO: 'Valor não permitido',
  FORMATO_INVALIDO: 'Formato inválido',
  CAMPO_NAO_PERMITIDO: 'Campo não permitido',
  VALOR_INVALIDO: 'Valor inválido',
});

function segmentoSeguro(segmento) {
  if (typeof segmento === 'number' && Number.isInteger(segmento) && segmento >= 0) {
    return String(segmento);
  }
  return typeof segmento === 'string' && SEGMENTO_SEGURO.test(segmento) ? segmento : '?';
}

function campoDe(origem, path) {
  return path.length === 0 ? origem : `${origem}.${path.map(segmentoSeguro).join('.')}`;
}

// Só existência da propriedade ao longo do caminho; o valor nunca é lido
// para fora desta função.
function propriedadeExiste(dado, path) {
  let atual = dado;
  for (const segmento of path) {
    if (atual === null || typeof atual !== 'object' || !Object.hasOwn(atual, segmento)) {
      return false;
    }
    atual = atual[segmento];
  }
  return true;
}

function detalhe(campo, codigo, mensagem = MENSAGENS[codigo], extra) {
  return extra ? { campo, codigo, mensagem, ...extra } : { campo, codigo, mensagem };
}

function limiteDe(valor) {
  return typeof valor === 'number' && Number.isFinite(valor) ? { limite: valor } : undefined;
}

function descreverIssue(origem, issue, dado) {
  const campo = campoDe(origem, issue.path);
  switch (issue.code) {
    case 'invalid_type':
      if (issue.path.length === 0) {
        return [detalhe(origem, origem === 'body' ? 'CORPO_INVALIDO' : 'ENTRADA_INVALIDA')];
      }
      return [detalhe(campo, propriedadeExiste(dado, issue.path) ? 'TIPO_INVALIDO' : 'CAMPO_OBRIGATORIO')];
    case 'too_small':
      return [detalhe(campo, 'TAMANHO_MINIMO', undefined, limiteDe(issue.minimum))];
    case 'too_big':
      return [detalhe(campo, 'TAMANHO_MAXIMO', undefined, limiteDe(issue.maximum))];
    case 'invalid_value':
      return [detalhe(campo, 'VALOR_NAO_PERMITIDO')];
    case 'invalid_format':
      return [detalhe(campo, 'FORMATO_INVALIDO')];
    case 'unrecognized_keys': {
      const chaves = Array.isArray(issue.keys) ? issue.keys : [];
      const detalhes = chaves.slice(0, CHAVES_DESCONHECIDAS_MAXIMO).map((chave) => detalhe(
        typeof chave === 'string' && SEGMENTO_SEGURO.test(chave) ? campoDe(origem, [...issue.path, chave]) : campo,
        'CAMPO_NAO_PERMITIDO',
      ));
      if (chaves.length > CHAVES_DESCONHECIDAS_MAXIMO || detalhes.length === 0) {
        detalhes.push(detalhe(campo, 'CAMPO_NAO_PERMITIDO'));
      }
      return detalhes;
    }
    case 'custom': {
      const codigo = issue.params && typeof issue.params.codigo === 'string' && CODIGO_FORMATO.test(issue.params.codigo)
        ? issue.params.codigo
        : null;
      if (codigo === null) {
        return [detalhe(campo, 'VALOR_INVALIDO')];
      }
      // Mensagem fixa definida pelos nossos schemas (convenção: sempre acompanha params.codigo).
      return [detalhe(campo, codigo, typeof issue.message === 'string' ? issue.message : MENSAGENS.VALOR_INVALIDO)];
    }
    default:
      return [detalhe(campo, 'VALOR_INVALIDO')];
  }
}

function conferirSchemas(schemas) {
  if (schemas === null || typeof schemas !== 'object' || Array.isArray(schemas)) {
    throw new TypeError('validar() exige um objeto com params, query e/ou body');
  }
  const origens = Object.keys(schemas);
  if (origens.length === 0) {
    throw new TypeError('validar() exige ao menos um schema');
  }
  for (const origem of origens) {
    if (!ORIGENS.includes(origem)) {
      throw new TypeError('validar() aceita somente as origens params, query e body');
    }
    const schema = schemas[origem];
    if (schema === null || typeof schema !== 'object' || typeof schema.safeParse !== 'function') {
      throw new TypeError(`validar(): schema de ${origem} inválido`);
    }
  }
}

function validar(schemas) {
  conferirSchemas(schemas);
  const origensAtivas = ORIGENS.filter((origem) => schemas[origem]);

  return function validarRequisicao(req, res, next) {
    const validado = {};
    const detalhes = [];

    for (const origem of origensAtivas) {
      // Body ausente com schema de body: objeto vazio, para apontar cada
      // campo obrigatório. Array, string ou null seguem para erro da raiz.
      const dado = origem === 'body' && req.body === undefined ? {} : req[origem];
      const resultado = schemas[origem].safeParse(dado);
      if (resultado.success) {
        validado[origem] = Object.freeze(resultado.data);
      } else {
        for (const issue of resultado.error.issues) {
          detalhes.push(...descreverIssue(origem, issue, dado));
        }
      }
    }

    if (detalhes.length > 0) {
      next(HttpError.validacao(detalhes.slice(0, DETALHES_MAXIMO)));
      return;
    }

    Object.defineProperty(req, 'validado', {
      value: Object.freeze(validado),
      writable: false,
      enumerable: true,
      configurable: false,
    });
    next();
  };
}

/**
 * Converte o resultado de validarPoliticaSenha() para o mesmo formato de
 * detalhes do 400. Só reformata: a política é executada pelo service, com o
 * contexto da sessão, que então lança HttpError.validacao(detalhes).
 */
function detalhesDePoliticaSenha(resultado, campo = 'body.novaSenha') {
  return resultado.erros.map((erro) => detalhe(campo, erro.codigo, erro.mensagem));
}

module.exports = { validar, detalhesDePoliticaSenha, MENSAGENS_VALIDACAO: MENSAGENS };
