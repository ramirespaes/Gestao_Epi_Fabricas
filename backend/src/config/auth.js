'use strict';

const { z } = require('zod');

/**
 * Configuração da autenticação, lida e validada UMA vez na subida do
 * processo. Falha cedo, com o NOME da variável e a regra violada, nunca com
 * o valor recebido. Nenhum valor deste módulo pode ir para log, auditoria
 * ou resposta HTTP.
 *
 * SEGREDO DO HMAC (LOGIN_COOLDOWN_HMAC_SECRET)
 * O Buffer fica privado neste módulo. Ele NÃO faz parte de authConfig,
 * nem como propriedade oculta: JSON.stringify(authConfig) e
 * util.inspect(authConfig) não têm acesso a ele. O único caminho é
 * obterLoginCooldownHmacSecret(), que devolve uma cópia defensiva.
 *
 * ARGON2
 * memoryCost 65536 KiB, timeCost 3, parallelism 1 e hashLength 32 são a
 * configuração ESCOLHIDA PELO PROJETO para esta etapa, não a reprodução
 * exata de uma recomendação completa da RFC 9106. Os mínimos aceitos
 * (19456 KiB e timeCost 2) seguem o piso da OWASP. Benchmark posterior
 * pode ajustar os padrões via .env; hashLength é fixo.
 *
 * COOKIE DE SESSÃO
 * A emissão do cookie fica no bloco de sessão. Quando for emitido:
 * HttpOnly sempre; Secure conforme authConfig.sessao.cookieSecure;
 * nome com prefixo __Host- exigirá Path=/ e ausência de Domain;
 * nome com prefixo __Secure- e __Host- exigem Secure=true (validado aqui).
 */

// HMAC-SHA-256: chave com pelo menos o tamanho da saída (32 bytes = 256 bits).
const HMAC_SECRET_BYTES_MINIMO = 32;
const HMAC_SECRET_HEX_MINIMO = HMAC_SECRET_BYTES_MINIMO * 2;
const ARGON2_HASH_LENGTH = 32;

// Limites e padrões das variáveis inteiras. Usados tanto para montar o
// esquema quanto para compor as mensagens de erro (nunca a partir do input).
const INTEIROS = Object.freeze({
  SESSAO_EXPIRACAO_MINUTOS: { min: 5, max: 43200, padrao: 720 },
  SESSAO_INATIVIDADE_MINUTOS: { min: 1, max: 43200, padrao: 30 },
  ARGON2_MEMORY_KIB: { min: 19456, max: 1048576, padrao: 65536 },
  ARGON2_TIME_COST: { min: 2, max: 20, padrao: 3 },
  ARGON2_PARALLELISM: { min: 1, max: 8, padrao: 1 },
  LOGIN_COOLDOWN_NIVEL1_FALHAS: { min: 1, max: 100, padrao: 5 },
  LOGIN_COOLDOWN_NIVEL1_JANELA_MINUTOS: { min: 1, max: 1440, padrao: 15 },
  LOGIN_COOLDOWN_NIVEL1_DURACAO_MINUTOS: { min: 1, max: 1440, padrao: 15 },
  LOGIN_COOLDOWN_NIVEL2_FALHAS: { min: 1, max: 100, padrao: 10 },
  LOGIN_COOLDOWN_NIVEL2_JANELA_MINUTOS: { min: 1, max: 1440, padrao: 60 },
  LOGIN_COOLDOWN_NIVEL2_DURACAO_MINUTOS: { min: 1, max: 1440, padrao: 60 },
  LOGIN_TENTATIVAS_RETENCAO_DIAS: { min: 1, max: 365, padrao: 30 },
});

const OPCOES = Object.freeze({
  NODE_ENV: ['development', 'test', 'production'],
  SESSAO_COOKIE_SECURE: ['true', 'false'],
  SESSAO_COOKIE_SAMESITE: ['strict', 'lax', 'none'],
});

const COOKIE_NOME_FORMATO = /^(__Host-|__Secure-)?[A-Za-z0-9_-]{1,64}$/;
const COOKIE_NOME_PADRAO = 'gepi_sessao';
const HEX = /^[0-9a-fA-F]+$/;

const inteiro = ({ min, max, padrao }) =>
  z.coerce.number().int().min(min).max(max).default(padrao);

const esquema = z
  .object({
    NODE_ENV: z.enum(OPCOES.NODE_ENV).default('development'),

    // Gerar com: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
    // Três regras, sem fallback em nenhum ambiente.
    LOGIN_COOLDOWN_HMAC_SECRET: z
      .string()
      .refine((v) => HEX.test(v), 'deve conter apenas caracteres hexadecimais')
      .refine(
        (v) => v.length >= HMAC_SECRET_HEX_MINIMO,
        `mínimo ${HMAC_SECRET_HEX_MINIMO} caracteres hexadecimais (${HMAC_SECRET_BYTES_MINIMO} bytes)`,
      )
      .refine((v) => v.length % 2 === 0, 'quantidade de caracteres hexadecimais deve ser par'),

    SESSAO_COOKIE_NOME: z.string().regex(COOKIE_NOME_FORMATO).default(COOKIE_NOME_PADRAO),
    // z.coerce.boolean() trataria 'false' como true; por isso enum explícito.
    SESSAO_COOKIE_SECURE: z.enum(OPCOES.SESSAO_COOKIE_SECURE).transform((v) => v === 'true').optional(),
    SESSAO_COOKIE_SAMESITE: z.enum(OPCOES.SESSAO_COOKIE_SAMESITE).default('lax'),
    SESSAO_EXPIRACAO_MINUTOS: inteiro(INTEIROS.SESSAO_EXPIRACAO_MINUTOS),
    SESSAO_INATIVIDADE_MINUTOS: inteiro(INTEIROS.SESSAO_INATIVIDADE_MINUTOS),

    ARGON2_MEMORY_KIB: inteiro(INTEIROS.ARGON2_MEMORY_KIB),
    ARGON2_TIME_COST: inteiro(INTEIROS.ARGON2_TIME_COST),
    ARGON2_PARALLELISM: inteiro(INTEIROS.ARGON2_PARALLELISM),

    // Limiares do cooldown (migration 015): falhas dentro da janela -> bloqueio pela duração.
    LOGIN_COOLDOWN_NIVEL1_FALHAS: inteiro(INTEIROS.LOGIN_COOLDOWN_NIVEL1_FALHAS),
    LOGIN_COOLDOWN_NIVEL1_JANELA_MINUTOS: inteiro(INTEIROS.LOGIN_COOLDOWN_NIVEL1_JANELA_MINUTOS),
    LOGIN_COOLDOWN_NIVEL1_DURACAO_MINUTOS: inteiro(INTEIROS.LOGIN_COOLDOWN_NIVEL1_DURACAO_MINUTOS),
    LOGIN_COOLDOWN_NIVEL2_FALHAS: inteiro(INTEIROS.LOGIN_COOLDOWN_NIVEL2_FALHAS),
    LOGIN_COOLDOWN_NIVEL2_JANELA_MINUTOS: inteiro(INTEIROS.LOGIN_COOLDOWN_NIVEL2_JANELA_MINUTOS),
    LOGIN_COOLDOWN_NIVEL2_DURACAO_MINUTOS: inteiro(INTEIROS.LOGIN_COOLDOWN_NIVEL2_DURACAO_MINUTOS),
    LOGIN_TENTATIVAS_RETENCAO_DIAS: inteiro(INTEIROS.LOGIN_TENTATIVAS_RETENCAO_DIAS),
  })
  .refine((e) => e.SESSAO_INATIVIDADE_MINUTOS <= e.SESSAO_EXPIRACAO_MINUTOS, {
    message: 'não pode ser maior que SESSAO_EXPIRACAO_MINUTOS',
    path: ['SESSAO_INATIVIDADE_MINUTOS'],
  })
  .refine((e) => e.LOGIN_COOLDOWN_NIVEL2_FALHAS > e.LOGIN_COOLDOWN_NIVEL1_FALHAS, {
    message: 'deve ser maior que LOGIN_COOLDOWN_NIVEL1_FALHAS',
    path: ['LOGIN_COOLDOWN_NIVEL2_FALHAS'],
  })
  .refine((e) => e.LOGIN_COOLDOWN_NIVEL2_JANELA_MINUTOS >= e.LOGIN_COOLDOWN_NIVEL1_JANELA_MINUTOS, {
    message: 'deve ser maior ou igual a LOGIN_COOLDOWN_NIVEL1_JANELA_MINUTOS',
    path: ['LOGIN_COOLDOWN_NIVEL2_JANELA_MINUTOS'],
  })
  .refine((e) => !(e.NODE_ENV === 'production' && e.SESSAO_COOKIE_SECURE === false), {
    message: 'não pode ser false em produção',
    path: ['SESSAO_COOKIE_SECURE'],
  })
  .refine((e) => !(e.SESSAO_COOKIE_SAMESITE === 'none' && !cookieSecureEfetivo(e)), {
    message: 'SameSite=None exige cookie Secure',
    path: ['SESSAO_COOKIE_SAMESITE'],
  })
  .refine((e) => !(e.SESSAO_COOKIE_NOME.startsWith('__Secure-') && !cookieSecureEfetivo(e)), {
    message: 'prefixo __Secure- exige cookie Secure',
    path: ['SESSAO_COOKIE_NOME'],
  })
  .refine((e) => !(e.SESSAO_COOKIE_NOME.startsWith('__Host-') && !cookieSecureEfetivo(e)), {
    message: 'prefixo __Host- exige cookie Secure',
    path: ['SESSAO_COOKIE_NOME'],
  });

function cookieSecureEfetivo(e) {
  return e.SESSAO_COOKIE_SECURE ?? e.NODE_ENV === 'production';
}

const VARIAVEIS_CONHECIDAS = new Set(Object.keys(esquema.shape));

// Variável vazia ou só com espaços conta como não definida (cai no padrão
// ou em "obrigatória").
function somenteDefinidas(origem) {
  const saida = {};
  for (const [chave, valor] of Object.entries(origem)) {
    if (typeof valor === 'string' && valor.trim() !== '') {
      saida[chave] = valor.trim();
    }
  }
  return saida;
}

/**
 * Converte uma issue do Zod em "NOME_DA_VARIAVEL: regra", usando SOMENTE o
 * nome conhecido da variável e textos fixos deste módulo. Não serializa a
 * issue, não usa input e nunca inclui o valor recebido. Mensagens de
 * refinamentos (code 'custom') são as strings fixas definidas acima.
 */
function descreverProblema(issue) {
  const nome = VARIAVEIS_CONHECIDAS.has(issue.path[0]) ? issue.path[0] : 'configuracao';
  const limites = INTEIROS[nome];
  let regra;
  switch (issue.code) {
    case 'invalid_type':
      regra = nome === 'LOGIN_COOLDOWN_HMAC_SECRET'
        ? 'obrigatória'
        : (limites ? 'deve ser um número inteiro' : 'ausente ou tipo inválido');
      break;
    case 'too_small':
      regra = limites ? `abaixo do mínimo permitido (${limites.min})` : 'abaixo do mínimo permitido';
      break;
    case 'too_big':
      regra = limites ? `acima do máximo permitido (${limites.max})` : 'acima do máximo permitido';
      break;
    case 'invalid_format':
      regra = 'formato inválido';
      break;
    case 'invalid_value':
      regra = OPCOES[nome] ? `deve ser um de: ${OPCOES[nome].join(', ')}` : 'valor fora das opções permitidas';
      break;
    case 'custom':
      regra = issue.message;
      break;
    default:
      regra = 'valor inválido';
  }
  return `${nome}: ${regra}`;
}

function congelarProfundo(valor) {
  if (valor === null || typeof valor !== 'object') {
    return valor;
  }
  for (const item of Object.values(valor)) {
    congelarProfundo(item);
  }
  return Object.freeze(valor);
}

// Valida o ambiente e separa a configuração pública do segredo.
function analisarConfigAuth(origem) {
  const resultado = esquema.safeParse(somenteDefinidas(origem));
  if (!resultado.success) {
    const problemas = resultado.error.issues.map(descreverProblema);
    throw new Error(`Configuração de autenticação inválida:\n  - ${problemas.join('\n  - ')}`);
  }

  const e = resultado.data;

  const config = congelarProfundo({
    ambiente: e.NODE_ENV,
    sessao: {
      cookieNome: e.SESSAO_COOKIE_NOME,
      cookieSecure: cookieSecureEfetivo(e),
      cookieSameSite: e.SESSAO_COOKIE_SAMESITE,
      expiracaoMinutos: e.SESSAO_EXPIRACAO_MINUTOS,
      inatividadeMinutos: e.SESSAO_INATIVIDADE_MINUTOS,
    },
    argon2: {
      memoryKib: e.ARGON2_MEMORY_KIB,
      timeCost: e.ARGON2_TIME_COST,
      parallelism: e.ARGON2_PARALLELISM,
      hashLength: ARGON2_HASH_LENGTH,
    },
    cooldown: {
      niveis: [
        {
          falhas: e.LOGIN_COOLDOWN_NIVEL1_FALHAS,
          janelaMinutos: e.LOGIN_COOLDOWN_NIVEL1_JANELA_MINUTOS,
          duracaoMinutos: e.LOGIN_COOLDOWN_NIVEL1_DURACAO_MINUTOS,
        },
        {
          falhas: e.LOGIN_COOLDOWN_NIVEL2_FALHAS,
          janelaMinutos: e.LOGIN_COOLDOWN_NIVEL2_JANELA_MINUTOS,
          duracaoMinutos: e.LOGIN_COOLDOWN_NIVEL2_DURACAO_MINUTOS,
        },
      ],
      retencaoDias: e.LOGIN_TENTATIVAS_RETENCAO_DIAS,
    },
  });

  return { config, segredo: Buffer.from(e.LOGIN_COOLDOWN_HMAC_SECRET, 'hex') };
}

/**
 * Valida um ambiente arbitrário e devolve apenas a configuração pública.
 * Existe para testes; o segredo desse ambiente é descartado.
 */
function carregarConfigAuth(origem = process.env) {
  return analisarConfigAuth(origem).config;
}

// Carga única, na subida do processo. O segredo fica só nesta closure.
const carregado = analisarConfigAuth(process.env);
const authConfig = carregado.config;
const segredoHmacInterno = carregado.segredo;

/** Cópia defensiva do segredo: o chamador não alcança o Buffer interno. */
function obterLoginCooldownHmacSecret() {
  return Buffer.from(segredoHmacInterno);
}

module.exports = {
  authConfig,
  obterLoginCooldownHmacSecret,
  carregarConfigAuth,
  HMAC_SECRET_BYTES_MINIMO,
};
