'use strict';

// Detector de segredos fora do lugar para linhas de tabela (texto do row_to_json ou objeto). Cada segredo é procurado por
// substring em cada valor, descendo em JSONB (valores e chaves); números contam pelo texto. A única exceção é para
// segredos curtos (menos de 16 caracteres, como um código TOTP de 6 dígitos) numa coluna de primeiro nível cujo tipo foi
// declarado por quem chama a partir do schema e cujo valor tem exatamente o formato desse tipo: aí um trecho de dígitos
// é coincidência, não vazamento (um hash de 64 hex, um timestamp com microssegundos). Fora disso, inclusive em coluna
// desconhecida ou valor fora do formato, a inspeção é completa. O resultado diz onde, nunca o valor do segredo.
// A linha pode chegar como texto (row_to_json(t)::text): ela é interpretada aqui guardando o texto original de cada
// número, porque um JSON.parse comum arredonda inteiros acima de 2^53 e escreve decimais pequenos em notação científica.
const TAMANHO_DE_SEGREDO_LONGO = 16;
const FORMATOS_DOS_TIPOS = Object.freeze({
  timestamptz: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/,
  digest_hex64: /^[0-9a-f]{64}$/,
});
// As duas formas do pg_get_constraintdef para `coluna ~ '^[0-9a-f]{64}$'`: sem conversão ou com (coluna)::text/bpchar.
const CHECK_DIGEST_HEX64 = /^CHECK \(\((?:\(([a-z_][a-z0-9_]*)\)::(?:text|bpchar)|([a-z_][a-z0-9_]*)) ~ '\^\[0-9a-f\]\{64\}\$'::text\)\)$/;

class NumeroJson {
  constructor(fonte) { this.fonte = fonte; }
}

function colunaDoDigestHex64(definicao) {
  const m = typeof definicao === 'string' ? CHECK_DIGEST_HEX64.exec(definicao) : null;
  return m ? m[1] || m[2] : null;
}

function interpretarLinha(texto) {
  let linha;
  try {
    linha = JSON.parse(texto, (chave, valor, contexto) => {
      if (typeof valor !== 'number') return valor;
      if (!contexto || typeof contexto.source !== 'string') throw new TypeError('o texto original dos números exige JSON.parse com contexto (Node 22 ou mais novo)');
      return new NumeroJson(contexto.source);
    });
  } catch (falha) {
    if (falha instanceof TypeError && /texto original/.test(falha.message)) throw falha;
    linha = undefined;
  }
  if (linha === null || typeof linha !== 'object' || Array.isArray(linha) || linha instanceof NumeroJson) throw new TypeError('cada linha tem de ser um objeto JSON');
  return linha;
}

function textosDe(valor, saida) {
  if (valor === null || valor === undefined) return saida;
  if (valor instanceof NumeroJson) { saida.push(valor.fonte); return saida; }
  if (Array.isArray(valor)) { for (const v of valor) textosDe(v, saida); return saida; }
  if (typeof valor === 'object') {
    for (const [chave, v] of Object.entries(valor)) { saida.push(chave); textosDe(v, saida); }
    return saida;
  }
  saida.push(String(valor));
  return saida;
}

function segredosEmLinhas({ linhas, segredos, colunasGeradas = {} } = {}) {
  if (!Array.isArray(segredos) || segredos.some((s) => typeof s !== 'string' || s === '')) throw new TypeError('cada segredo tem de ser um texto não vazio');
  if (colunasGeradas === null || typeof colunasGeradas !== 'object') throw new TypeError('colunas geradas: tipo desconhecido');
  for (const [coluna, tipo] of Object.entries(colunasGeradas)) {
    if (!Object.hasOwn(FORMATOS_DOS_TIPOS, tipo)) throw new TypeError(`coluna ${coluna}: tipo desconhecido`);
  }
  if (!Array.isArray(linhas)) throw new TypeError('as linhas têm de vir numa lista');
  const objetos = linhas.map((l) => (typeof l === 'string' ? interpretarLinha(l) : l));
  if (objetos.some((l) => l === null || typeof l !== 'object' || Array.isArray(l) || l instanceof NumeroJson)) throw new TypeError('cada linha tem de ser um objeto');
  const achados = [];
  objetos.forEach((linha, indiceDaLinha) => {
    for (const [coluna, valor] of Object.entries(linha)) {
      const tipo = Object.hasOwn(colunasGeradas, coluna) ? colunasGeradas[coluna] : null;
      const doTipo = tipo !== null && typeof valor === 'string' && FORMATOS_DOS_TIPOS[tipo].test(valor);
      const textos = textosDe(valor, []);
      segredos.forEach((segredo, indice) => {
        if (doTipo && segredo.length < TAMANHO_DE_SEGREDO_LONGO) return;
        if (textos.some((t) => t.includes(segredo))) achados.push({ linha: indiceDaLinha, coluna, indice });
      });
    }
  });
  return achados;
}

module.exports = { segredosEmLinhas, colunaDoDigestHex64, interpretarLinha, TAMANHO_DE_SEGREDO_LONGO, FORMATOS_DOS_TIPOS };
