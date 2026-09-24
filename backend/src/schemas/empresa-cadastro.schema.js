'use strict';

const { z } = require('zod');
const {
  idParametro, booleanoQuery, paginacaoQuery, textoCurto, cnpjComDigitosVerificadores, email,
} = require('./campos.schema');

/**
 * Schemas das rotas de cadastro de empresas do Painel Privado (Pacote 3).
 * Só formato: duplicidade de CNPJ, coerência da IE e existência são do
 * serviço. Mesmo desenho de funcionario.schema.js.
 *
 * CNPJ IMUTÁVEL: `cnpj` existe SÓ em `criar`. Em `alterar` a chave não é
 * declarada — strictObject devolve 400 CAMPO_NAO_PERMITIDO para qualquer
 * presença dela (mesma disciplina do CPF de funcionário).
 *
 * `situacaoInscricaoEstadual` é um conjunto fechado NA APLICAÇÃO (aqui);
 * no banco o CHECK é só de formato (migration 032) — um rótulo novo entra
 * por esta lista, sem migration. NUNCA há valor padrão: ausente é ausente,
 * nunca "ISENTO" presumido.
 */

const SITUACOES_IE = ['CONTRIBUINTE', 'ISENTO', 'NAO_CONTRIBUINTE'];
const UF_FORMATO = /^[A-Za-z]{2}$/;
const CEP_FORMATO = /^[0-9]{5}-?[0-9]{3}$/;

const razaoSocial = textoCurto(150, 'RAZAO_SOCIAL_INVALIDA', 'Razão social inválida');
const nomeFantasia = textoCurto(150, 'NOME_FANTASIA_INVALIDO', 'Nome fantasia inválido');
const inscricaoEstadual = textoCurto(20, 'INSCRICAO_ESTADUAL_INVALIDA', 'Inscrição estadual inválida');
const situacaoInscricaoEstadual = z.enum(SITUACOES_IE);
const endereco = textoCurto(200, 'ENDERECO_INVALIDO', 'Endereço inválido');
const numero = textoCurto(20, 'NUMERO_INVALIDO', 'Número inválido');
const complemento = textoCurto(100, 'COMPLEMENTO_INVALIDO', 'Complemento inválido');
const bairro = textoCurto(100, 'BAIRRO_INVALIDO', 'Bairro inválido');
const cidade = textoCurto(100, 'CIDADE_INVALIDA', 'Cidade inválida');
const uf = z.string().transform((valor, ctx) => {
  const aparado = valor.trim();
  if (!UF_FORMATO.test(aparado)) {
    ctx.addIssue({ code: 'custom', message: 'UF inválida', params: { codigo: 'UF_INVALIDA' } });
    return z.NEVER;
  }
  return aparado.toUpperCase();
});
const cep = z.string().transform((valor, ctx) => {
  const aparado = valor.trim();
  if (!CEP_FORMATO.test(aparado)) {
    ctx.addIssue({ code: 'custom', message: 'CEP inválido', params: { codigo: 'CEP_INVALIDO' } });
    return z.NEVER;
  }
  return aparado;
});
const telefone = textoCurto(20, 'TELEFONE_INVALIDO', 'Telefone inválido');
const nomeContato = textoCurto(150, 'NOME_CONTATO_INVALIDO', 'Nome de contato inválido');
const cargo = textoCurto(100, 'CARGO_INVALIDO', 'Cargo inválido');
const busca = textoCurto(100, 'BUSCA_INVALIDA', 'Termo de busca inválido');

const opcionais = {
  nomeFantasia: nomeFantasia.nullable().optional(),
  inscricaoEstadual: inscricaoEstadual.nullable().optional(),
  situacaoInscricaoEstadual: situacaoInscricaoEstadual.nullable().optional(),
  endereco: endereco.nullable().optional(),
  numero: numero.nullable().optional(),
  complemento: complemento.nullable().optional(),
  bairro: bairro.nullable().optional(),
  cidade: cidade.nullable().optional(),
  uf: uf.nullable().optional(),
  cep: cep.nullable().optional(),
  telefone: telefone.nullable().optional(),
  email: email.nullable().optional(),
  representanteNome: nomeContato.nullable().optional(),
  representanteCargo: cargo.nullable().optional(),
  representanteEmail: email.nullable().optional(),
  representanteTelefone: telefone.nullable().optional(),
  financeiroNome: nomeContato.nullable().optional(),
  financeiroEmail: email.nullable().optional(),
  financeiroTelefone: telefone.nullable().optional(),
};

const CAMPOS_OPCIONAIS = Object.freeze(Object.keys(opcionais));

const paramsComId = z.strictObject({ id: idParametro });

const criar = { body: z.strictObject({ razaoSocial, cnpj: cnpjComDigitosVerificadores, ...opcionais }) };

const listar = {
  query: z.strictObject({ ...paginacaoQuery, ativo: booleanoQuery.optional(), busca: busca.optional() }),
};

const buscar = { params: paramsComId };
const provisionamento = { params: paramsComId };

const alterar = {
  params: paramsComId,
  // sem `cnpj`: imutável após o cadastro (ver cabeçalho)
  body: z.strictObject({ razaoSocial: razaoSocial.optional(), ...opcionais }),
};

const semCorpo = z.strictObject({});
const inativar = { params: paramsComId, body: semCorpo };
const reativar = { params: paramsComId, body: semCorpo };

module.exports = { criar, listar, buscar, provisionamento, alterar, inativar, reativar, CAMPOS_OPCIONAIS, SITUACOES_IE };
