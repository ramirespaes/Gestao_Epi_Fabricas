'use strict';

/**
 * Parâmetros NUMÉRICOS do processamento de imagem (Biblioteca de Imagens, Unidade 5C-4): a única coisa, além dos bytes do envio, que o processo filho recebe (um
 * argumento JSON). A validação é ESTRITA e vale dos dois lados: chave desconhecida, tipo errado ou número fora de faixa é TypeError. Função pura: sem ambiente, arquivo ou rede.
 *
 *   { ladoMin, ladoMax, pixelsMax, entradaMaxBytes, timeoutSegundos,
 *     mestre: { lado, bytesMax }, exibicao: { lado, bytesMax }, miniatura: { lado, bytesMax } }
 */

const MIB = 1024 * 1024;
const FAIXA_INTEIRO = (min, max) => (v) => Number.isSafeInteger(v) && v >= min && v <= max;
const RAIZ = Object.freeze({
  ladoMin: FAIXA_INTEIRO(1, 65535),
  ladoMax: FAIXA_INTEIRO(1, 65535),
  pixelsMax: FAIXA_INTEIRO(1, 268402689),
  entradaMaxBytes: FAIXA_INTEIRO(1, 64 * MIB),
  timeoutSegundos: FAIXA_INTEIRO(1, 600),
});
const SECOES = Object.freeze(['mestre', 'exibicao', 'miniatura']);
const SECAO = Object.freeze({ lado: FAIXA_INTEIRO(1, 8192), bytesMax: FAIXA_INTEIRO(1, 256 * MIB) });

function verificarObjeto(valor, nome, chaves) {
  if (valor === null || typeof valor !== 'object' || Array.isArray(valor)) throw new TypeError(`parâmetros de imagem: ${nome} deve ser um objeto`);
  const reais = Object.keys(valor).sort();
  const esperadas = [...chaves].sort();
  if (reais.length !== esperadas.length || reais.some((c, i) => c !== esperadas[i])) throw new TypeError(`parâmetros de imagem: chaves de ${nome} diferentes das combinadas`);
}

function validarParametros(parametros) {
  verificarObjeto(parametros, 'parâmetros', [...Object.keys(RAIZ), ...SECOES]);
  for (const [chave, valida] of Object.entries(RAIZ)) if (!valida(parametros[chave])) throw new TypeError(`parâmetros de imagem: ${chave} fora da faixa`);
  if (parametros.ladoMin > parametros.ladoMax) throw new TypeError('parâmetros de imagem: ladoMin maior que ladoMax');
  for (const secao of SECOES) {
    verificarObjeto(parametros[secao], secao, Object.keys(SECAO));
    for (const [chave, valida] of Object.entries(SECAO)) if (!valida(parametros[secao][chave])) throw new TypeError(`parâmetros de imagem: ${secao}.${chave} fora da faixa`);
  }
  return parametros;
}

function lerParametros(texto) {
  if (typeof texto !== 'string') throw new TypeError('parâmetros de imagem: o argumento deve ser um texto JSON');
  let objeto;
  try { objeto = JSON.parse(texto); } catch { throw new TypeError('parâmetros de imagem: JSON inválido'); }
  return validarParametros(objeto);
}

module.exports = { validarParametros, lerParametros, SECOES };
