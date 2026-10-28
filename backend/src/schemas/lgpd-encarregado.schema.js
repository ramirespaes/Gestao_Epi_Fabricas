'use strict';

const { z } = require('zod');
const {
  idParametro, email, textoCurto, dataCalendario, cnpjComDigitosVerificadores,
} = require('./campos.schema');

/**
 * Schemas do encarregado (DPO), LGPD-1. Só formato e coerência interna; regra, existência, autoridade e isolamento são do
 * serviço. Empresa, ator, situação, versão nova e datas de encerramento automáticas NUNCA vêm do cliente: strictObject recusa
 * qualquer chave não declarada (inclusive cpf, documentos ou empresaId). Em PJ, `razaoSocial` e `cnpj` (regra canônica do
 * SafeWork, com dígitos verificadores; migration 095) são obrigatórios e `nome` é a pessoa natural responsável; em PF,
 * `razaoSocial` e `cnpj` não são aceitos. Em "corrigir contato", `cnpj` só serve para COMPLETAR o legado PJ sem CNPJ
 * (regra do serviço): trocar um CNPJ gravado é Substituição.
 */

const FUNCOES = Object.freeze(['PRINCIPAL', 'SUBSTITUTO']);
const TIPOS_PESSOA = Object.freeze(['PF', 'PJ']);
const VINCULOS = Object.freeze(['INTERNO', 'EXTERNO']);
const CONFLITOS = Object.freeze(['NAO_AVALIADO', 'SEM_CONFLITO', 'COM_CONFLITO_MITIGADO']);
const TELEFONE = /^[0-9()+\-. ]{8,20}$/;

function issue(ctx, path, codigo, message) {
  ctx.addIssue({ code: z.ZodIssueCode.custom, path, params: { codigo }, message });
}

const telefone = z.string().transform((valor, ctx) => {
  const t = valor.trim();
  if (!TELEFONE.test(t)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, params: { codigo: 'TELEFONE_INVALIDO' }, message: 'Telefone profissional inválido' });
    return z.NEVER;
  }
  return t;
});

const versao = z.number().int().positive();

/** Campos de uma designação (usados por designar e por substituir). */
const camposDesignacao = {
  funcao: z.enum(FUNCOES),
  tipoPessoa: z.enum(TIPOS_PESSOA),
  nome: textoCurto(150, 'NOME_INVALIDO', 'Nome inválido (1 a 150 caracteres)'),
  razaoSocial: textoCurto(150, 'RAZAO_SOCIAL_INVALIDA', 'Razão social inválida (1 a 150 caracteres)').optional(),
  cnpj: cnpjComDigitosVerificadores.optional(),
  vinculo: z.enum(VINCULOS),
  cargo: textoCurto(100, 'CARGO_INVALIDO', 'Cargo inválido (1 a 100 caracteres)').optional(),
  email,
  telefone: telefone.optional(),
  inicioEm: dataCalendario('DATA_INVALIDA', 'Data de início inválida'),
  atoReferencia: textoCurto(200, 'ATO_INVALIDO', 'Referência ao ato formal inválida (1 a 200 caracteres)').optional(),
  atoData: dataCalendario('DATA_INVALIDA', 'Data do ato formal inválida').optional(),
  conflitoInteresses: z.enum(CONFLITOS).default('NAO_AVALIADO'),
  conflitoNota: textoCurto(500, 'NOTA_INVALIDA', 'Nota inválida (1 a 500 caracteres)').optional(),
};

function coerenciaPessoa(dados, ctx) {
  if (dados.tipoPessoa === 'PJ' && dados.razaoSocial === undefined) {
    issue(ctx, ['razaoSocial'], 'RAZAO_SOCIAL_OBRIGATORIA', 'Encarregado pessoa jurídica exige a razão social (e o nome da pessoa natural responsável)');
  }
  if (dados.tipoPessoa === 'PF' && dados.razaoSocial !== undefined) {
    issue(ctx, ['razaoSocial'], 'RAZAO_SOCIAL_NAO_SE_APLICA', 'Pessoa física não tem razão social');
  }
  if (dados.tipoPessoa === 'PJ' && dados.cnpj === undefined) {
    issue(ctx, ['cnpj'], 'CNPJ_OBRIGATORIO', 'Encarregado pessoa jurídica exige o CNPJ');
  }
  if (dados.tipoPessoa === 'PF' && dados.cnpj !== undefined) {
    issue(ctx, ['cnpj'], 'CNPJ_NAO_SE_APLICA', 'Pessoa física não tem CNPJ');
  }
  if (dados.atoData !== undefined && dados.atoReferencia === undefined) {
    issue(ctx, ['atoData'], 'ATO_REFERENCIA_OBRIGATORIA', 'A data do ato formal exige a referência ao ato');
  }
}

const designar = {
  body: z.strictObject(camposDesignacao).superRefine(coerenciaPessoa),
};

const substituir = {
  params: z.strictObject({ id: idParametro }),
  body: z.strictObject({
    versao,
    fimAnteriorEm: dataCalendario('DATA_INVALIDA', 'Data de encerramento do anterior inválida').optional(),
    ...camposDesignacao,
  }).superRefine(coerenciaPessoa),
};

const contato = {
  params: z.strictObject({ id: idParametro }),
  body: z.strictObject({
    versao,
    email: email.optional(),
    telefone: telefone.nullable().optional(),
    cargo: textoCurto(100, 'CARGO_INVALIDO', 'Cargo inválido (1 a 100 caracteres)').nullable().optional(),
    cnpj: cnpjComDigitosVerificadores.optional(), // só para completar o legado PJ sem CNPJ (regra do serviço)
  }).refine((c) => ['email', 'telefone', 'cargo', 'cnpj'].some((k) => c[k] !== undefined), { message: 'Informe ao menos um contato a corrigir', params: { codigo: 'ALTERACAO_VAZIA' } }),
};

const encerrar = {
  params: z.strictObject({ id: idParametro }),
  body: z.strictObject({
    versao,
    fimEm: dataCalendario('DATA_INVALIDA', 'Data de encerramento inválida').optional(),
  }),
};

module.exports = {
  designar, substituir, contato, encerrar, FUNCOES, TIPOS_PESSOA, VINCULOS, CONFLITOS,
};
