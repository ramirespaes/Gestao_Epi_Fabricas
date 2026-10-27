'use strict';

const { z } = require('zod');
const {
  idParametro, paginacaoQuery, textoCurto, inteiroQuery, booleanoQuery,
} = require('./campos.schema');

/**
 * Schemas do Suporte (Portal Empresarial e Painel Privado). Só formato; regra, existência e isolamento são do serviço.
 * Empresa, usuário, e-mail do solicitante, destinatário e situação inicial NUNCA vêm do cliente: o strictObject recusa qualquer
 * chave não declarada. Os textos livres são canônicos (aparados, NFC, limite em code points, sem controle exceto quebra de linha)
 * e só vão para as tabelas de suporte; nunca para auditoria nem para log.
 */

const CATEGORIAS = Object.freeze(['ERRO', 'LENTIDAO', 'ACESSO', 'DUVIDA', 'SUGESTAO', 'OUTRO']);
const SITUACOES = Object.freeze(['ABERTO', 'EM_ATENDIMENTO', 'RESPONDIDO', 'ENCERRADO']);
const CANAIS = Object.freeze({ almoxarifado: 'ALMOXARIFADO', sst: 'SST' });

const LIMITE_ASSUNTO = 150;
const LIMITE_TEXTO = 4000;
const CONTROLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function issue(ctx, code, message) {
  ctx.addIssue({ code: z.ZodIssueCode.custom, params: { codigo: code }, message });
  return z.NEVER;
}

/** Texto multilinha: aparado, NFC, 1..maximo code points, quebras de linha CRLF → LF, sem outros caracteres de controle. */
const textoLongo = (maximo) => z.string().transform((valor, ctx) => {
  const texto = valor.replace(/\r\n?/g, '\n').trim().normalize('NFC');
  const tamanho = Array.from(texto).length;
  if (tamanho === 0 || tamanho > maximo || CONTROLE.test(texto)) {
    return issue(ctx, 'TEXTO_INVALIDO', `Texto de 1 a ${maximo} caracteres, sem caracteres de controle`);
  }
  return texto;
});

/** Chave de idempotência gerada pelo navegador: UUID minúsculo. */
const chaveIdempotencia = z.string().transform((valor, ctx) => (UUID.test(valor) ? valor : issue(ctx, 'CHAVE_INVALIDA', 'Chave de idempotência inválida')));

const assunto = textoCurto(LIMITE_ASSUNTO, 'ASSUNTO_INVALIDO', `Assunto de 1 a ${LIMITE_ASSUNTO} caracteres`);

const criarChamado = {
  body: z.strictObject({
    assunto,
    categoria: z.enum(CATEGORIAS),
    descricao: textoLongo(LIMITE_TEXTO),
    chaveIdempotencia,
  }),
};

const enviarContato = {
  params: z.strictObject({ canal: z.enum(['almoxarifado', 'sst']) }),
  body: z.strictObject({ assunto, mensagem: textoLongo(LIMITE_TEXTO), chaveIdempotencia }),
};

const buscarChamado = { params: z.strictObject({ id: idParametro }) };
const listarMeusChamados = { query: z.strictObject({ ...paginacaoQuery }) };
// Conversa: `aposId` é o id da última mensagem que a tela já tem (0 = todas).
const novasMensagens = { params: z.strictObject({ id: idParametro }), query: z.strictObject({ aposId: inteiroQuery(0, 2147483647).default(0) }) };
const enviarMensagem = { params: z.strictObject({ id: idParametro }), body: z.strictObject({ texto: textoLongo(LIMITE_TEXTO), chaveIdempotencia }) };

// Painel Privado
const listarChamadosPlataforma = {
  query: z.strictObject({
    ...paginacaoQuery,
    situacao: z.enum(SITUACOES).optional(),
    empresaId: idParametro.optional(),
    busca: textoCurto(100, 'BUSCA_INVALIDA', 'Busca inválida').optional(),
    naoLidas: booleanoQuery.optional(),
  }),
};
const buscarChamadoPlataforma = { params: z.strictObject({ id: idParametro }) };
const responderChamado = {
  params: z.strictObject({ id: idParametro }),
  body: z.strictObject({ texto: textoLongo(LIMITE_TEXTO), chaveIdempotencia: chaveIdempotencia.optional() }),
};
const alterarSituacao = { params: z.strictObject({ id: idParametro }), body: z.strictObject({ situacao: z.enum(SITUACOES) }) };

module.exports = {
  CATEGORIAS,
  SITUACOES,
  CANAIS,
  LIMITE_ASSUNTO,
  LIMITE_TEXTO,
  criarChamado,
  enviarContato,
  buscarChamado,
  listarMeusChamados,
  novasMensagens,
  enviarMensagem,
  listarChamadosPlataforma,
  buscarChamadoPlataforma,
  responderChamado,
  alterarSituacao,
};
