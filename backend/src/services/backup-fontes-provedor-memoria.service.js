'use strict';

/**
 * D-ORF-6, R-D45: PROVEDOR DE CHAVES EM MEMÓRIA com o contrato SÍNCRONO que as fontes de chaves do manifesto e da cifra exigem: `{ obter(chaveId) -> { situacao, segredo? } }`.
 * Os segredos ficam só no fechamento deste módulo (nenhuma propriedade, nenhum JSON, nenhuma inspeção os mostra); `obter` entrega sempre uma CÓPIA; `zerar` sobrescreve
 * com zeros o que o provedor guarda e o encerra (cópias já entregues são de quem as recebeu). Zerar em JavaScript é melhor esforço, não garantia. Sem arquivo, rede ou ambiente.
 */

function criarProvedorEmMemoria() {
  const mapa = new Map();
  let encerrado = false;
  const provedor = Object.freeze({
    obter(chaveId) {
      const item = !encerrado && typeof chaveId === 'string' ? mapa.get(chaveId) : undefined;
      if (item === undefined) return { situacao: 'INDISPONIVEL' };
      if (item.estado === 'REVOGADA') return { situacao: 'REVOGADA' };
      return { situacao: 'ATIVA', segredo: Buffer.from(item.segredo) };
    },
    zerar() {
      for (const item of mapa.values()) if (item.segredo !== null) item.segredo.fill(0);
      mapa.clear();
      encerrado = true;
    },
    toJSON() { return { provedor: 'memoria' }; },
  });
  /** `entradas`: `[{ chaveId, estado: 'ATIVA' | 'REVOGADA', segredo? }]`; o segredo é COPIADO (quem chama zera o original). */
  function carregar(entradas) {
    if (encerrado) throw Object.assign(new Error('provedor encerrado'), { code: 'PROVEDOR_ENCERRADO' });
    for (const e of entradas) mapa.set(e.chaveId, { estado: e.estado, segredo: e.estado === 'ATIVA' ? Buffer.from(e.segredo) : null });
  }
  return Object.freeze({ provedor, carregar });
}

module.exports = { criarProvedorEmMemoria };
