'use strict';

const { HttpError } = require('../errors/HttpError');
const { normalizarEmail } = require('./normalizacao');

/**
 * Regras de normalização dos campos cadastrais opcionais da empresa, em UM lugar só: o Painel Privado
 * (empresa-cadastro.service) e o Portal (empresa-dados.service) importam daqui, então o mesmo valor
 * produz a mesma representação gravada, qualquer que seja a porta de entrada.
 */

const SITUACOES_IE = Object.freeze(['CONTRIBUINTE', 'ISENTO', 'NAO_CONTRIBUINTE']);
const UF_FORMATO = /^[A-Z]{2}$/;
const CEP_FORMATO = /^[0-9]{5}-?[0-9]{3}$/;
const CAMPOS_EMAIL = new Set(['email', 'representanteEmail', 'financeiroEmail', 'emailSst', 'emailAlmoxarifado']);
const MENSAGEM_IE_EXIGIDA = 'Situação CONTRIBUINTE exige o número da inscrição estadual';

/**
 * Normaliza um campo opcional pela sua natureza. Devolve `null` para ausência/vazio, o valor canônico quando
 * válido, e `undefined` quando INVÁLIDO (o chamador transforma em 400).
 */
function normalizarOpcional(chave, valor, tamanhoMaximo) {
  if (valor === null || valor === undefined) {
    return null;
  }
  if (typeof valor !== 'string') {
    throw new TypeError(`${chave} deve ser string ou null`);
  }
  const aparado = valor.trim();
  if (aparado.length === 0) {
    return null;
  }
  if (CAMPOS_EMAIL.has(chave)) {
    return normalizarEmail(aparado) ?? undefined;
  }
  if (chave === 'uf') {
    const uf = aparado.toUpperCase();
    return UF_FORMATO.test(uf) ? uf : undefined;
  }
  if (chave === 'cep') {
    return CEP_FORMATO.test(aparado) ? aparado.replace('-', '') : undefined;
  }
  if (chave === 'situacaoInscricaoEstadual') {
    const situacao = aparado.toUpperCase();
    return SITUACOES_IE.includes(situacao) ? situacao : undefined;
  }
  const texto = aparado.normalize('NFC');
  return Array.from(texto).length > tamanhoMaximo ? undefined : texto;
}

function exigirCoerenciaIe(dados) {
  if (dados.situacaoInscricaoEstadual === 'CONTRIBUINTE' && dados.inscricaoEstadual === null) {
    throw HttpError.badRequest('EMPRESA_IE_EXIGIDA', MENSAGEM_IE_EXIGIDA);
  }
}

module.exports = { SITUACOES_IE, UF_FORMATO, CEP_FORMATO, CAMPOS_EMAIL, normalizarOpcional, exigirCoerenciaIe };
