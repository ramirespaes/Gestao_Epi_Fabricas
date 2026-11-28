'use strict';

/**
 * S2819 — duplas de teste da ponte da prévia do Totem por MessageChannel, lado da Central.
 * `filhaComPorta` imita o iframe: a janela (contentWindow) nunca deve receber postMessage; a porta transferida no handshake
 * registra o que a Central envia. `abrirPonte` faz o handshake (PONTE_ABRIR pela janela, com a porta em `ports`).
 */

const CANAL = 'safework-previa-totem';
const ID_PONTE = 'ponte-0001';

function portaFalsa() {
  const porta = {
    enviadas: [],
    fechada: false,
    onmessage: null,
    postMessage(m) {
      if (porta.fechada) return;
      porta.enviadas.push({ m: m && typeof m === 'object' && !(m.blob) ? JSON.parse(JSON.stringify(m)) : m, alvo: 'porta' });
    },
    start() {},
    close() { porta.fechada = true; },
  };
  return porta;
}

// `segredo`: o nome do iframe (atributo `name`, que vira window.name do documento; S2819, segredo de uso único). Sem ele o handshake sai sem o campo.
function filhaComPorta(segredo) {
  const porta = portaFalsa();
  const diretas = [];
  return { porta, diretas, segredo, enviadas: porta.enviadas, postMessage(m, alvo) { diretas.push({ m, alvo }); } };
}

const segredoDe = (quadro) => { const n = quadro.getAttribute('name'); return n == null ? undefined : n; };

const abertura = (extra = {}) => ({ canal: CANAL, versao: 1, tipo: 'PONTE_ABRIR', id: ID_PONTE, ...extra });

async function abrirPonte(pg, filha, opcoes = {}) {
  const data = abertura(filha.segredo === undefined ? {} : { segredo: filha.segredo });
  await pg.eventoDaJanela('message', { data, source: filha, origin: 'null', ports: [filha.porta], ...opcoes });
  const i = filha.enviadas.findIndex((e) => e.m && e.m.tipo === 'PONTE_PRONTA');
  const pronta = i === -1 ? null : filha.enviadas.splice(i, 1)[0].m;
  return pronta;
}

async function doPorta(pg, porta, data) {
  if (typeof porta.onmessage === 'function') await porta.onmessage({ data, ports: [] });
  await pg.esperar();
}

module.exports = { CANAL, ID_PONTE, portaFalsa, filhaComPorta, segredoDe, abertura, abrirPonte, doPorta };
