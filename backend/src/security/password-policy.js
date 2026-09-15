'use strict';

const { normalizarCnpj, normalizarEmail } = require('../utils/normalizacao');

/**
 * Política de senha (NIST SP 800-63B): comprimento e ausência de padrões
 * previsíveis, sem exigir classes de caracteres. Uma senha só de dígitos,
 * por exemplo, é aceita se passar nas regras objetivas abaixo.
 *
 * PREPARAÇÃO: a única transformação é senha.normalize('NFC'), a mesma de
 * password.js. Sem trim, sem alteração de caixa, sem NFKC. Espaços e caixa
 * fazem parte da senha. Toda regra avalia a forma NFC, que é exatamente o
 * que gerarHashSenha() vai hashear.
 *
 * TAMANHO: contado em code points Unicode após o NFC (Array.from), não em
 * unidades UTF-16. Sequências ZWJ contam mais de 1, o que é aceitável.
 *
 * RESULTADO: { ok, erros: [{ codigo, mensagem }] }, com todos os erros
 * aplicáveis. TypeError só para erro de programação (senha não string,
 * contexto.email/cnpj fornecidos mas não normalizáveis). Nenhuma mensagem
 * contém senha, e-mail ou CNPJ. Nada aqui loga.
 *
 * Este módulo não faz hash, não usa Zod, não acessa banco nem requisição.
 */

const POLITICA_SENHA = Object.freeze({
  tamanhoMinimo: 12,
  tamanhoMaximo: 128,
  caracteresDistintosMinimo: 4,
});

const CODIGOS_POLITICA_SENHA = Object.freeze({
  SENHA_CURTA: 'SENHA_CURTA',
  SENHA_LONGA: 'SENHA_LONGA',
  SENHA_CARACTERE_INVALIDO: 'SENHA_CARACTERE_INVALIDO',
  SENHA_POUCOS_CARACTERES_DISTINTOS: 'SENHA_POUCOS_CARACTERES_DISTINTOS',
  SENHA_TRIVIAL: 'SENHA_TRIVIAL',
  SENHA_CONTEM_EMAIL: 'SENHA_CONTEM_EMAIL',
  SENHA_CONTEM_CNPJ: 'SENHA_CONTEM_CNPJ',
});

const MENSAGENS = Object.freeze({
  SENHA_CURTA: `A senha deve ter pelo menos ${POLITICA_SENHA.tamanhoMinimo} caracteres`,
  SENHA_LONGA: `A senha deve ter no máximo ${POLITICA_SENHA.tamanhoMaximo} caracteres`,
  SENHA_CARACTERE_INVALIDO: 'A senha não pode conter caracteres de controle',
  SENHA_POUCOS_CARACTERES_DISTINTOS:
    `A senha deve ter pelo menos ${POLITICA_SENHA.caracteresDistintosMinimo} caracteres diferentes`,
  SENHA_TRIVIAL: 'A senha é muito comum ou previsível',
  SENHA_CONTEM_EMAIL: 'A senha não pode conter o seu e-mail',
  SENHA_CONTEM_CNPJ: 'A senha não pode conter o CNPJ da empresa',
});

// Caracteres de controle (inclui quebra de linha e tab). Espaço é permitido.
const CARACTERE_CONTROLE = /\p{Cc}/u;
const CNPJ_FORMATACAO = /[./-]/g;

// Termos com 5+ caracteres; comparação por "contém", em minúsculas.
const TERMOS_TRIVIAIS = Object.freeze([
  'senha', 'password', 'passw0rd', 'qwerty', 'qwertyuiop', 'asdfgh', 'zxcvbn',
  '1q2w3e', 'abc123', '123abc', 'admin', 'letmein', 'welcome', 'iloveyou',
  'mudar123', 'trocar123', 'gestaoepi',
]);

const EMAIL_PARTE_LOCAL_MINIMO = 4;
const EMAIL_SEGMENTO_MINIMO = 5;
const EMAIL_ROTULO_DOMINIO_MINIMO = 5;
const CNPJ_RAIZ_TAMANHO = 8;

// Progressão com passo +1 ou -1 do início ao fim (abcdefghijkl, lkjihgfedcba).
// Para senhas só de dígitos a progressão é circular (123456789012,
// 210987654321), porque o teclado numérico dá a volta de 9 para 0.
function ehSequencia(codePoints) {
  if (codePoints.length < 2) {
    return false;
  }
  const somenteDigitos = codePoints.every((cp) => cp >= 0x30 && cp <= 0x39);
  const passo = codePoints[1] - codePoints[0];
  const passoCircular = ((passo % 10) + 10) % 10;
  if (passo !== 1 && passo !== -1 && !(somenteDigitos && (passoCircular === 1 || passoCircular === 9))) {
    return false;
  }
  for (let i = 1; i < codePoints.length; i += 1) {
    const delta = codePoints[i] - codePoints[i - 1];
    if (somenteDigitos ? ((delta % 10) + 10) % 10 !== passoCircular : delta !== passo) {
      return false;
    }
  }
  return true;
}

function ehTrivial(senhaMinuscula, codePoints) {
  return TERMOS_TRIVIAIS.some((termo) => senhaMinuscula.includes(termo)) || ehSequencia(codePoints);
}

function contemEmail(senhaMinuscula, emailNormalizado) {
  if (senhaMinuscula.includes(emailNormalizado)) {
    return true;
  }
  const [parteLocal, dominio] = emailNormalizado.split('@');
  if (parteLocal.length >= EMAIL_PARTE_LOCAL_MINIMO && senhaMinuscula.includes(parteLocal)) {
    return true;
  }
  const segmentos = parteLocal.split(/[._+-]/).filter((s) => s.length >= EMAIL_SEGMENTO_MINIMO);
  if (segmentos.some((s) => senhaMinuscula.includes(s))) {
    return true;
  }
  const rotulos = dominio.split('.').filter((r) => r.length >= EMAIL_ROTULO_DOMINIO_MINIMO);
  return rotulos.some((r) => senhaMinuscula.includes(r));
}

function contemCnpj(senhaMaiuscula, cnpjNormalizado) {
  const semFormatacao = senhaMaiuscula.replace(CNPJ_FORMATACAO, '');
  return semFormatacao.includes(cnpjNormalizado)
    || semFormatacao.includes(cnpjNormalizado.slice(0, CNPJ_RAIZ_TAMANHO));
}

// E-mail e CNPJ fornecidos precisam ser normalizáveis pelos contratos do
// projeto; caso contrário é erro de programação do chamador, nunca uma
// checagem ignorada em silêncio.
function normalizarContexto(contexto) {
  if (contexto === null || typeof contexto !== 'object') {
    throw new TypeError('contexto deve ser um objeto');
  }
  const saida = { email: null, cnpj: null };
  if (contexto.email !== undefined && contexto.email !== null) {
    saida.email = normalizarEmail(contexto.email);
    if (saida.email === null) {
      throw new TypeError('contexto.email não é um e-mail normalizável');
    }
  }
  if (contexto.cnpj !== undefined && contexto.cnpj !== null) {
    saida.cnpj = normalizarCnpj(contexto.cnpj);
    if (saida.cnpj === null) {
      throw new TypeError('contexto.cnpj não é um CNPJ normalizável');
    }
  }
  return saida;
}

/**
 * Avalia a senha contra a política. Devolve { ok, erros } com todos os
 * erros aplicáveis; nunca lança por causa do conteúdo da senha.
 */
function validarPoliticaSenha(senha, contexto = {}) {
  if (typeof senha !== 'string') {
    throw new TypeError('senha deve ser uma string');
  }
  const { email, cnpj } = normalizarContexto(contexto);

  const senhaNfc = senha.normalize('NFC');
  const caracteres = Array.from(senhaNfc);
  const codePoints = caracteres.map((c) => c.codePointAt(0));
  const senhaMinuscula = senhaNfc.toLowerCase();
  const senhaMaiuscula = senhaNfc.toUpperCase();
  const erros = [];
  const falhar = (codigo) => erros.push({ codigo, mensagem: MENSAGENS[codigo] });

  if (caracteres.length < POLITICA_SENHA.tamanhoMinimo) {
    falhar(CODIGOS_POLITICA_SENHA.SENHA_CURTA);
  }
  if (caracteres.length > POLITICA_SENHA.tamanhoMaximo) {
    falhar(CODIGOS_POLITICA_SENHA.SENHA_LONGA);
  }
  if (CARACTERE_CONTROLE.test(senhaNfc)) {
    falhar(CODIGOS_POLITICA_SENHA.SENHA_CARACTERE_INVALIDO);
  }
  if (new Set(caracteres).size < POLITICA_SENHA.caracteresDistintosMinimo) {
    falhar(CODIGOS_POLITICA_SENHA.SENHA_POUCOS_CARACTERES_DISTINTOS);
  }
  if (ehTrivial(senhaMinuscula, codePoints)) {
    falhar(CODIGOS_POLITICA_SENHA.SENHA_TRIVIAL);
  }
  if (email !== null && contemEmail(senhaMinuscula, email)) {
    falhar(CODIGOS_POLITICA_SENHA.SENHA_CONTEM_EMAIL);
  }
  if (cnpj !== null && contemCnpj(senhaMaiuscula, cnpj)) {
    falhar(CODIGOS_POLITICA_SENHA.SENHA_CONTEM_CNPJ);
  }

  return { ok: erros.length === 0, erros };
}

module.exports = {
  POLITICA_SENHA,
  CODIGOS_POLITICA_SENHA,
  validarPoliticaSenha,
};
