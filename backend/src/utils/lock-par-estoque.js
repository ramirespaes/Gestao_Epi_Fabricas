'use strict';

const crypto = require('node:crypto');

/**
 * Trava lógica do par (empresa, material, tamanho): advisory lock de 64 bits
 * num espaço próprio, separado dos de idempotência. Serializa quem confere ou
 * consome o saldo livre do par; os lotes sozinhos não bastam, porque o saldo
 * livre depende de outros lotes e da demanda aprovada, e um par pode não ter
 * lote algum.
 *
 * O tamanho ausente tem uma forma canônica só, o texto vazio, a mesma do
 * COALESCE(tamanho, '') dos índices e das consultas. O banco recusa tamanho
 * vazio, então ela não colide com nenhum tamanho real.
 */

const ESPACO_PARES_ESTOQUE = 'estoque_pares';
// VARCHAR(20) dos lotes e dos itens da solicitação.
const TAMANHO_MAXIMO = 20;

function exigirId(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) {
    throw new TypeError(`identificador de ${nome} inválido`);
  }
}

// null (material sem tamanho) ou texto de 1 a 20 caracteres; undefined é esquecimento do chamador.
function exigirTamanho(tamanho) {
  if (tamanho === null) return;
  if (typeof tamanho !== 'string' || tamanho.length === 0 || Array.from(tamanho).length > TAMANHO_MAXIMO) {
    throw new TypeError('tamanho inválido');
  }
}

const chaveDoTamanho = (tamanho) => tamanho ?? '';

/** Lock de 64 bits (texto, para o bigint do PostgreSQL) do par; o separador evita ambiguidade entre os campos. */
function lockDoPar(empresaId, materialId, tamanho) {
  exigirId(empresaId, 'empresa');
  exigirId(materialId, 'material');
  exigirTamanho(tamanho);
  return crypto.createHash('sha256')
    .update(`${ESPACO_PARES_ESTOQUE}\n${empresaId}\n${materialId}\n${chaveDoTamanho(tamanho)}`)
    .digest().readBigInt64BE(0).toString();
}

/**
 * Pares válidos, sem repetição, em ordem canônica: material crescente e, no
 * mesmo material, tamanho ausente primeiro e os demais por código de
 * caractere (não por locale). Quem trava vários pares os pede nessa ordem, e
 * por isso duas transações nunca esperam uma pela outra em ciclo.
 */
function parOrdenados(pares) {
  if (!Array.isArray(pares)) throw new TypeError('lista de pares inválida');
  const unicos = new Map();
  for (const par of pares) {
    if (par === null || typeof par !== 'object') throw new TypeError('par inválido');
    exigirId(par.materialId, 'material');
    exigirTamanho(par.tamanho);
    unicos.set(`${par.materialId}\n${chaveDoTamanho(par.tamanho)}`, { materialId: par.materialId, tamanho: par.tamanho });
  }
  return [...unicos.values()].sort((a, b) => {
    if (a.materialId !== b.materialId) return a.materialId - b.materialId;
    const ta = chaveDoTamanho(a.tamanho);
    const tb = chaveDoTamanho(b.tamanho);
    if (ta === tb) return 0;
    return ta < tb ? -1 : 1;
  });
}

module.exports = { ESPACO_PARES_ESTOQUE, TAMANHO_MAXIMO, chaveDoTamanho, lockDoPar, parOrdenados };
