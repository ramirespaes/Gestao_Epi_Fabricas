'use strict';

const { z } = require('zod');
const {
  normalizarCnpj,
  cnpjTemDigitosVerificadoresValidos,
  normalizarEmail,
  EMAIL_TAMANHO_MAXIMO,
} = require('../utils/normalizacao');

/**
 * Campos Zod reutilizáveis pelos schemas de rota. Não conhece rotas, domínio,
 * requisição ou banco, e não loga.
 *
 * - CNPJ e e-mail delegam a utils/normalizacao e saem normalizados. Nenhuma
 *   regex de CNPJ ou e-mail vive aqui.
 * - `cnpj` exige só estrutura (login, cooldown: identidade inexistente deve
 *   se comportar como existente). `cnpjComDigitosVerificadores` é a regra de
 *   negócio para cadastro/alteração de empresa.
 * - Senha recebe só proteção técnica de entrada e sai intacta (sem trim, NFC
 *   ou caixa): password.js aplica o NFC e password-policy.js a política, no
 *   service, com contexto.
 * - Números vindos de params/query chegam como string: aceita-se somente a
 *   representação decimal canônica (sem sinal, zero à esquerda, ponto,
 *   expoente ou hexadecimal) e só então converte-se para Number. Nunca
 *   z.coerce.
 * - Toda issue customizada tem mensagem fixa e params.codigo; nunca inclui o
 *   valor recebido.
 */

const LIMITES = Object.freeze({
  CNPJ_ENTRADA_MAXIMO: 32,
  EMAIL_ENTRADA_MAXIMO: EMAIL_TAMANHO_MAXIMO + 50,
  // Unidades UTF-16, proteção técnica; a regra em code points é da política.
  SENHA_ENTRADA_MAXIMO: 1024,
  ID_MAXIMO: 2147483647, // SERIAL (int4)
  PAGINA_MAXIMA: 10000,
  LIMITE_MAXIMO: 100,
  LIMITE_PADRAO: 20,
});

// Decimal canônico positivo: "1", "42"; nunca "0", "007", "+1", "1.5", "1e3".
const ID_TEXTO = /^[1-9][0-9]{0,9}$/;
// Decimal canônico não negativo para query: "0", "20"; nunca "", "007", "1e2".
const INTEIRO_TEXTO = /^(0|[1-9][0-9]{0,9})$/;
const CARACTERE_CONTROLE = /\p{Cc}/u;

function issue(ctx, codigo, message) {
  ctx.addIssue({ code: 'custom', message, params: { codigo } });
  return z.NEVER;
}

const cnpj = z.string().transform((valor, ctx) => {
  if (valor.length > LIMITES.CNPJ_ENTRADA_MAXIMO) {
    return issue(ctx, 'CNPJ_INVALIDO', 'CNPJ inválido');
  }
  return normalizarCnpj(valor) ?? issue(ctx, 'CNPJ_INVALIDO', 'CNPJ inválido');
});

const cnpjComDigitosVerificadores = cnpj.transform((normalizado, ctx) =>
  (cnpjTemDigitosVerificadoresValidos(normalizado)
    ? normalizado
    : issue(ctx, 'CNPJ_DV_INVALIDO', 'CNPJ com dígitos verificadores inválidos')));

const email = z.string().transform((valor, ctx) => {
  if (valor.length > LIMITES.EMAIL_ENTRADA_MAXIMO) {
    return issue(ctx, 'EMAIL_INVALIDO', 'E-mail inválido');
  }
  return normalizarEmail(valor) ?? issue(ctx, 'EMAIL_INVALIDO', 'E-mail inválido');
});

const senhaEntrada = z.string().transform((valor, ctx) => {
  if (valor.length === 0) {
    return issue(ctx, 'SENHA_VAZIA', 'Senha não informada');
  }
  if (valor.length > LIMITES.SENHA_ENTRADA_MAXIMO) {
    return issue(ctx, 'SENHA_MUITO_LONGA', 'Senha excede o tamanho máximo aceito');
  }
  return valor;
});

/** Identificador de rota: string decimal canônica positiva -> Number (int4). */
const idParametro = z.string().transform((valor, ctx) => {
  if (!ID_TEXTO.test(valor) || Number(valor) > LIMITES.ID_MAXIMO) {
    return issue(ctx, 'ID_INVALIDO', 'Identificador inválido');
  }
  return Number(valor);
});

function inteiroQuery(minimo, maximo) {
  return z.string().transform((valor, ctx) => {
    if (!INTEIRO_TEXTO.test(valor)) {
      return issue(ctx, 'INTEIRO_INVALIDO', 'Deve ser um número inteiro');
    }
    const numero = Number(valor);
    if (numero < minimo || numero > maximo) {
      return issue(ctx, 'FORA_DO_INTERVALO', `Deve estar entre ${minimo} e ${maximo}`);
    }
    return numero;
  });
}

const booleanoQuery = z.enum(['true', 'false']).transform((valor) => valor === 'true');

const paginacaoQuery = Object.freeze({
  pagina: inteiroQuery(1, LIMITES.PAGINA_MAXIMA).default(1),
  limite: inteiroQuery(1, LIMITES.LIMITE_MAXIMO).default(LIMITES.LIMITE_PADRAO),
});

/**
 * Texto curto canônico: trim, NFC, 1..maximo code points (mesma contagem do
 * VARCHAR(n) do PostgreSQL), sem caracteres de controle.
 */
function textoCurto(maximo, codigo, mensagem) {
  return z.string().transform((valor, ctx) => {
    const texto = valor.trim().normalize('NFC');
    const tamanho = Array.from(texto).length;
    if (tamanho === 0 || tamanho > maximo || CARACTERE_CONTROLE.test(texto)) {
      return issue(ctx, codigo, mensagem);
    }
    return texto;
  });
}

/** Código de catálogo (perfis.codigo, acoes.codigo): formato apenas; existência é do service. */
function codigoCatalogo(maximo, codigo, mensagem) {
  const formato = new RegExp(`^[A-Z][A-Z0-9_]{0,${maximo - 1}}$`);
  return z.string().transform((valor, ctx) => (formato.test(valor) ? valor : issue(ctx, codigo, mensagem)));
}

module.exports = {
  LIMITES,
  cnpj,
  cnpjComDigitosVerificadores,
  email,
  senhaEntrada,
  idParametro,
  inteiroQuery,
  booleanoQuery,
  paginacaoQuery,
  textoCurto,
  codigoCatalogo,
};
