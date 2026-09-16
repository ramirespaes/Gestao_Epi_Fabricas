'use strict';

const { z } = require('zod');

/**
 * Helpers genéricos para carregar configuração de variáveis de ambiente.
 * Sem regra de domínio: tratamento de variável vazia, schemas de inteiro e
 * booleano, descrição de problemas SEM o valor recebido e congelamento
 * profundo. Usado por config/auth.js e config/http.js.
 */

// Variável vazia ou só com espaços conta como não definida.
function somenteDefinidas(origem) {
  const saida = {};
  for (const [chave, valor] of Object.entries(origem)) {
    if (typeof valor === 'string' && valor.trim() !== '') {
      saida[chave] = valor.trim();
    }
  }
  return saida;
}

function congelarProfundo(valor) {
  if (valor === null || typeof valor !== 'object' || Buffer.isBuffer(valor)) {
    return valor;
  }
  for (const item of Object.values(valor)) {
    congelarProfundo(item);
  }
  return Object.freeze(valor);
}

// Somente decimal canônico não negativo ("0", "120"); nunca "01", "+1",
// "-0", "1.0", "1e1", "0x2" ou "10abc". Após a validação lexical converte
// para número e aplica min/max; ausente ou vazio usa o padrão.
const DECIMAL_CANONICO = /^(0|[1-9][0-9]{0,14})$/;

const inteiroDeAmbiente = ({ min, max, padrao }) =>
  z.string().regex(DECIMAL_CANONICO).transform(Number).pipe(z.number().int().min(min).max(max)).default(padrao);

// z.coerce.boolean() trataria 'false' como true; por isso enum explícito.
const booleanoDeAmbiente = z.enum(['true', 'false']).transform((valor) => valor === 'true');

/**
 * Converte uma issue do Zod em "NOME_DA_VARIAVEL: regra", usando SOMENTE o
 * nome conhecido da variável e textos fixos. Não serializa a issue, não usa
 * input e nunca inclui o valor recebido. A mensagem de uma issue 'custom'
 * só é usada se estiver em `mensagensPermitidas`, a allowlist de strings
 * fixas declarada pelo módulo consumidor; qualquer outra vira
 * "valor inválido".
 */
function descreverProblema(issue, { conhecidas, inteiros = {}, opcoes = {}, obrigatorias = [], mensagensPermitidas = [] }) {
  const primeiro = Array.isArray(issue.path) ? issue.path[0] : undefined;
  const nome = conhecidas.includes(primeiro) ? primeiro : 'configuracao';
  const limites = inteiros[nome];
  let regra;
  switch (issue.code) {
    case 'invalid_type':
      if (obrigatorias.includes(nome)) {
        regra = 'obrigatória';
      } else {
        regra = limites ? 'deve ser um número inteiro' : 'ausente ou tipo inválido';
      }
      break;
    case 'too_small':
      regra = limites ? `abaixo do mínimo permitido (${limites.min})` : 'abaixo do mínimo permitido';
      break;
    case 'too_big':
      regra = limites ? `acima do máximo permitido (${limites.max})` : 'acima do máximo permitido';
      break;
    case 'invalid_format':
      regra = limites ? 'deve ser um número inteiro' : 'formato inválido';
      break;
    case 'invalid_value':
      regra = opcoes[nome] ? `deve ser um de: ${opcoes[nome].join(', ')}` : 'valor fora das opções permitidas';
      break;
    case 'custom':
      regra = typeof issue.message === 'string' && mensagensPermitidas.includes(issue.message)
        ? issue.message
        : 'valor inválido';
      break;
    default:
      regra = 'valor inválido';
  }
  return `${nome}: ${regra}`;
}

/**
 * Valida `origem` com `esquema` e devolve os dados, ou lança Error com o
 * título e uma linha por problema, sem valores recebidos.
 */
function validarAmbiente({ esquema, origem, titulo, ...contexto }) {
  const resultado = esquema.safeParse(somenteDefinidas(origem));
  if (!resultado.success) {
    const problemas = resultado.error.issues.map((issue) => descreverProblema(issue, contexto));
    throw new Error(`${titulo} inválida:\n  - ${problemas.join('\n  - ')}`);
  }
  return resultado.data;
}

module.exports = {
  somenteDefinidas,
  congelarProfundo,
  inteiroDeAmbiente,
  booleanoDeAmbiente,
  descreverProblema,
  validarAmbiente,
};
