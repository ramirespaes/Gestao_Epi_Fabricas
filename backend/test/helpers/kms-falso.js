'use strict';

const crypto = require('node:crypto');

/**
 * R-D45: KMS FALSO em memória (sem rede, sem AWS). `cifrar` só existe no teste (a cerimônia real não é implementada nesta rodada); o cliente expõe somente
 * `decifrar({ chaveArn, contexto, blob })`, como a porta do provedor pré-resolvido. Recusa blob desconhecido, chave diferente e contexto diferente, como o KMS real.
 */

const canonico = (o) => JSON.stringify(Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1))));

function criarKmsFalso() {
  const blobs = new Map();
  const chamadas = [];
  let desvio = null;
  const cliente = Object.freeze({
    async decifrar(pedido) {
      chamadas.push({ chaveArn: pedido.chaveArn, contexto: { ...pedido.contexto } });
      if (desvio !== null) {
        const resposta = await desvio(pedido);
        if (resposta !== undefined) return resposta;
      }
      const item = blobs.get(Buffer.from(pedido.blob).toString('hex'));
      if (item === undefined || item.chaveArn !== pedido.chaveArn || item.contexto !== canonico(pedido.contexto)) throw Object.assign(new Error('InvalidCiphertextException'), { code: 'INVALIDO' });
      return { chaveArn: pedido.chaveArn, segredo: Buffer.from(item.segredo) };
    },
  });
  return {
    cliente,
    chamadas,
    cifrar({ chaveArn, contexto, segredo }) {
      const blob = crypto.randomBytes(48);
      blobs.set(blob.toString('hex'), { chaveArn, contexto: canonico(contexto), segredo: Buffer.from(segredo) });
      return blob;
    },
    desviar(fn) { desvio = fn; },
  };
}

module.exports = { criarKmsFalso };
