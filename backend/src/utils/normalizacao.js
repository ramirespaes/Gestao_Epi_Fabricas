'use strict';

/**
 * Normalizações de identidade usadas em autenticação, cooldown e cadastro.
 * Fonte única: a mesma entrada precisa virar a mesma representação em
 * qualquer ponto do sistema. Nenhum controller, service ou repository deve
 * repetir estas regras.
 *
 * CNPJ
 * ----
 * Suporta desde já os dois formatos da Receita Federal, sempre com 14
 * posições:
 *   numérico tradicional : 12.345.678/0001-95  -> 12345678000195
 *   alfanumérico         : 00.000.000/E08G-12  -> 00000000E08G12
 * Regras: posições 1 a 12 aceitam 0-9 e A-Z; posições 13 e 14 (dígitos
 * verificadores) aceitam somente 0-9. Letras são normalizadas para
 * maiúsculas, nunca convertidas em números nem eliminadas. Só os
 * caracteres de formatação '.', '/' e '-' e os espaços externos são
 * removidos; qualquer outro caractere invalida a entrada.
 *
 * Normalização e validação estrutural (normalizarCnpj) são separadas da
 * validação dos dígitos verificadores (cnpjTemDigitosVerificadoresValidos).
 * O login usa apenas a primeira; o cadastro deve usar as duas.
 *
 * CONTRATO ATUAL DO BANCO: empresas.cnpj ainda tem CHECK '^[0-9]{14}$'
 * (migration 001). Até a migration que amplie esse CHECK, o cadastro de
 * empresa com CNPJ alfanumérico é rejeitado pelo banco; o login com CNPJ
 * alfanumérico apenas não encontra empresa e cai na resposta genérica.
 *
 * E-MAIL
 * ------
 * usuarios.email -> VARCHAR(150), unicidade por lower(email) (migration 005).
 * LIMITAÇÃO DOCUMENTADA: aceito somente ASCII visível, para que
 * toLowerCase() aqui e lower() no PostgreSQL coincidam. Endereços
 * internacionalizados (IDN/EAI) são rejeitados nesta etapa.
 *
 * As funções de normalização são idempotentes
 * (normalizar(normalizar(x)) === normalizar(x)), devolvem a forma
 * normalizada ou null, nunca lançam por causa do valor recebido, nunca
 * incluem o valor em mensagens e nunca logam.
 */

const CNPJ_TAMANHO = 14;
// Únicos caracteres de formatação removidos da entrada.
const CNPJ_FORMATACAO = /[./-]/g;
// 12 posições alfanuméricas + 2 dígitos verificadores numéricos.
const CNPJ_FORMATO_ARMAZENADO = /^[0-9A-Z]{12}[0-9]{2}$/;
// Pesos do módulo 11 para o primeiro e o segundo dígito verificador.
const CNPJ_PESOS_DV1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
const CNPJ_PESOS_DV2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
// Valor de cada posição no cálculo: código ASCII menos 48
// ('0'..'9' -> 0..9, 'A'..'Z' -> 17..42), conforme a Receita Federal.
const CNPJ_BASE_ASCII = 48;

const EMAIL_TAMANHO_MAXIMO = 150;
const EMAIL_ASCII_VISIVEL = /^[\x21-\x7e]+$/;
const EMAIL_FORMATO = /^[^@]+@[^@]+\.[^@]+$/;

/**
 * Normaliza e valida a ESTRUTURA do CNPJ. Devolve as 14 posições em
 * maiúsculas ou null. Não valida dígitos verificadores.
 */
function normalizarCnpj(valor) {
  if (typeof valor !== 'string') {
    return null;
  }
  const semFormatacao = valor.trim().replace(CNPJ_FORMATACAO, '').toUpperCase();
  return CNPJ_FORMATO_ARMAZENADO.test(semFormatacao) ? semFormatacao : null;
}

function calcularDigitoVerificador(posicoes, pesos) {
  let soma = 0;
  for (let i = 0; i < pesos.length; i += 1) {
    soma += (posicoes.charCodeAt(i) - CNPJ_BASE_ASCII) * pesos[i];
  }
  const resto = soma % 11;
  return resto < 2 ? 0 : 11 - resto;
}

/**
 * Valida os dígitos verificadores de um CNPJ JÁ normalizado
 * (saída de normalizarCnpj). Devolve false para qualquer outra entrada,
 * sem tentar normalizá-la. Função pura, separada da normalização de
 * propósito: o login não precisa dela; cadastro e alteração de empresa
 * precisam.
 */
function cnpjTemDigitosVerificadoresValidos(cnpjNormalizado) {
  if (typeof cnpjNormalizado !== 'string' || normalizarCnpj(cnpjNormalizado) !== cnpjNormalizado) {
    return false;
  }
  const dv1 = calcularDigitoVerificador(cnpjNormalizado.slice(0, 12), CNPJ_PESOS_DV1);
  const dv2 = calcularDigitoVerificador(cnpjNormalizado.slice(0, 13), CNPJ_PESOS_DV2);
  return cnpjNormalizado.charCodeAt(12) - CNPJ_BASE_ASCII === dv1
    && cnpjNormalizado.charCodeAt(13) - CNPJ_BASE_ASCII === dv2;
}

/**
 * CPF (Bloco 9, Etapa B — funcionarios.cpf VARCHAR(11), CHECK '^[0-9]{11}$',
 * migration 006). Mesma separação do CNPJ: normalizarCpf valida só a
 * ESTRUTURA (11 dígitos, removendo '.', '-' e espaços externos);
 * cpfTemDigitosVerificadoresValidos valida o módulo 11 sobre a saída
 * normalizada e recusa as sequências de um único dígito repetido
 * ('00000000000' … '99999999999'), que passam no módulo 11 mas não são CPFs.
 */
const CPF_TAMANHO = 11;
const CPF_FORMATACAO = /[.-]/g;
const CPF_FORMATO_ARMAZENADO = /^[0-9]{11}$/;
const CPF_DIGITO_REPETIDO = /^(\d)\1{10}$/;

function normalizarCpf(valor) {
  if (typeof valor !== 'string') {
    return null;
  }
  const semFormatacao = valor.trim().replace(CPF_FORMATACAO, '');
  return CPF_FORMATO_ARMAZENADO.test(semFormatacao) ? semFormatacao : null;
}

function calcularDigitoVerificadorCpf(digitos, pesoInicial) {
  let soma = 0;
  for (let i = 0; i < digitos.length; i += 1) {
    soma += Number(digitos[i]) * (pesoInicial - i);
  }
  const resto = soma % 11;
  return resto < 2 ? 0 : 11 - resto;
}

/** Valida os DV de um CPF JÁ normalizado; false para qualquer outra entrada. */
function cpfTemDigitosVerificadoresValidos(cpfNormalizado) {
  if (typeof cpfNormalizado !== 'string' || normalizarCpf(cpfNormalizado) !== cpfNormalizado) {
    return false;
  }
  if (CPF_DIGITO_REPETIDO.test(cpfNormalizado)) {
    return false;
  }
  const dv1 = calcularDigitoVerificadorCpf(cpfNormalizado.slice(0, 9), 10);
  const dv2 = calcularDigitoVerificadorCpf(cpfNormalizado.slice(0, 10), 11);
  return Number(cpfNormalizado[9]) === dv1 && Number(cpfNormalizado[10]) === dv2;
}

/**
 * '  Luis@Empresa.com ' -> 'luis@empresa.com'; senão null.
 */
function normalizarEmail(valor) {
  if (typeof valor !== 'string') {
    return null;
  }
  const email = valor.trim().toLowerCase();
  if (email.length === 0 || email.length > EMAIL_TAMANHO_MAXIMO) {
    return null;
  }
  if (!EMAIL_ASCII_VISIVEL.test(email) || !EMAIL_FORMATO.test(email)) {
    return null;
  }
  return email;
}

module.exports = {
  CNPJ_TAMANHO,
  CPF_TAMANHO,
  EMAIL_TAMANHO_MAXIMO,
  normalizarCnpj,
  cnpjTemDigitosVerificadoresValidos,
  normalizarCpf,
  cpfTemDigitosVerificadoresValidos,
  normalizarEmail,
};
