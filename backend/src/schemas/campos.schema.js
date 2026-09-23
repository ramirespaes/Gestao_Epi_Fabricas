'use strict';

const { z } = require('zod');
const {
  normalizarCnpj,
  cnpjTemDigitosVerificadoresValidos,
  normalizarCpf,
  cpfTemDigitosVerificadoresValidos,
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
  CPF_ENTRADA_MAXIMO: 32, // Bloco 9, Etapa B — mesma folga de máscara/espaços do CNPJ
  EMAIL_ENTRADA_MAXIMO: EMAIL_TAMANHO_MAXIMO + 50,
  // Unidades UTF-16, proteção técnica; a regra em code points é da política.
  SENHA_ENTRADA_MAXIMO: 1024,
  ID_MAXIMO: 2147483647, // SERIAL (int4)
  INTEGER_MAXIMO: 2147483647, // qualquer coluna INTEGER (int4) do banco — mesmo teto de SERIAL, nome próprio para não confundir com identificador
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

/**
 * Identificador em CORPO JSON (nunca em params/query, que chegam como
 * string e usam `idParametro`): número inteiro positivo, mesmo teto de
 * `idParametro` (SERIAL/int4) e o mesmo código de erro (`ID_INVALIDO`),
 * para que um identificador malformado produza o mesmo vocabulário de
 * erro esteja ele numa URL ou num corpo. Tipo errado (string, float,
 * booleano) já é recusado pelo `z.number()` de base, com o
 * `invalid_type` nativo do Zod, antes de chegar a este transform.
 */
const idCorpo = z.number().transform((valor, ctx) => (
  Number.isInteger(valor) && valor > 0 && valor <= LIMITES.ID_MAXIMO
    ? valor
    : issue(ctx, 'ID_INVALIDO', 'Identificador inválido')
));

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

/**
 * CPF (Bloco 9, Etapa B): mesma divisão do CNPJ — `cpf` exige só estrutura
 * (11 dígitos, saída normalizada); `cpfComDigitosVerificadores` é a regra de
 * cadastro/alteração de funcionário. Nenhuma regex de CPF vive aqui.
 */
const cpf = z.string().transform((valor, ctx) => {
  if (valor.length > LIMITES.CPF_ENTRADA_MAXIMO) {
    return issue(ctx, 'CPF_INVALIDO', 'CPF inválido');
  }
  return normalizarCpf(valor) ?? issue(ctx, 'CPF_INVALIDO', 'CPF inválido');
});

const cpfComDigitosVerificadores = cpf.transform((normalizado, ctx) =>
  (cpfTemDigitosVerificadoresValidos(normalizado)
    ? normalizado
    : issue(ctx, 'CPF_DV_INVALIDO', 'CPF com dígitos verificadores inválidos')));

const DATA_ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
const DIAS_POR_MES = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Regra completa do gregoriano: 2000 é bissexto; 1900 não é. */
function ehAnoBissexto(ano) {
  return (ano % 4 === 0 && ano % 100 !== 0) || ano % 400 === 0;
}

/**
 * Calendário real, não Date.parse(): Date.parse('2026-02-30') "rola" para
 * 2026-03-02 em vez de recusar. Ano mínimo 1: o formato YYYY aceita "0000",
 * e a aritmética de bissexto até o consideraria bissexto (0 % 400 === 0).
 */
function dataDeCalendarioValida(ano, mes, dia) {
  if (ano < 1 || mes < 1 || mes > 12) {
    return false;
  }
  const diasNoMes = mes === 2 && ehAnoBissexto(ano) ? 29 : DIAS_POR_MES[mes - 1];
  return dia >= 1 && dia <= diasNoMes;
}

/**
 * Data `YYYY-MM-DD` com verificação estrita de calendário. Nasceu privada em
 * material.schema.js (Bloco 9, Etapa A, `caValidade`) e foi promovida para
 * cá na Etapa B, quando `dataNascimento` de funcionário passou a precisar
 * da mesma regra — uma única definição, dois consumidores. Formato apenas;
 * plausibilidade (ex.: nascimento no futuro) é do service, se houver regra.
 */
function dataCalendario(codigo, mensagem) {
  return z.string().transform((valor, ctx) => {
    const encontrado = DATA_ISO.exec(valor);
    if (encontrado === null) {
      return issue(ctx, codigo, mensagem);
    }
    const [, ano, mes, dia] = encontrado;
    return dataDeCalendarioValida(Number(ano), Number(mes), Number(dia)) ? valor : issue(ctx, codigo, mensagem);
  });
}

module.exports = {
  LIMITES,
  cnpj,
  cnpjComDigitosVerificadores,
  cpf,
  cpfComDigitosVerificadores,
  dataCalendario,
  email,
  senhaEntrada,
  idParametro,
  idCorpo,
  inteiroQuery,
  booleanoQuery,
  paginacaoQuery,
  textoCurto,
  codigoCatalogo,
};
