'use strict';

/**
 * Gerador pseudoaleatório determinístico (mulberry32): o mesmo roteiro em toda
 * execução, para os testes embaralharem ordens e quantidades sem ficarem
 * instáveis.
 */
function gerador(semente) {
  let estado = semente >>> 0;
  return () => {
    estado = (estado + 0x6D2B79F5) >>> 0;
    let t = estado;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

module.exports = { gerador };
