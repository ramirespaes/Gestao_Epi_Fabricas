'use strict';

const { reconstruirSegredo } = require('./backup-custodia-xor.service');
const { criarProvedorEmMemoria } = require('./backup-fontes-provedor-memoria.service');

/**
 * D-ORF-6, R-D45 (D-F5): PROVEDOR DE RECUPERAÇÃO OFF-LINE. Monta as duas famílias de chaves (MAC do manifesto e KEK da cifra) a partir das PARTES de custódia (XOR 2 de 3),
 * sem KMS, sem rede e sem arquivo: é o caminho que sobrevive à perda do KMS ou da conta. O contrato é o mesmo do provedor KMS pré-resolvido (síncrono, `{ obter }`, famílias
 * separadas, cópia por chamada, `zerar`). As partes chegam em memória (objetos ou texto) de quem chama; ler do terminal é da cerimônia, fora desta rodada.
 * Tudo ou nada; erros com código e motivo fixos. `PROVEDOR_ID` é o identificador proposto para a lista de provedores; NÃO é incluído em nenhuma lista nesta rodada.
 */

const PROVEDOR_ID = 'recuperacao-offline-v1';
const CHAVE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const POR_FAMILIA = 8;
const BYTES_KEK = 32;
const BYTES_MAC_MIN = 32;
const BYTES_MAC_MAX = 128;

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const chavesExatas = (o, esperadas) => {
  const proprias = Reflect.ownKeys(o);
  return proprias.length === esperadas.length && proprias.every((k) => typeof k === 'string' && esperadas.includes(k));
};
const configuracaoInvalida = () => Object.assign(new TypeError('configuração da recuperação off-line inválida'), { code: 'CONFIGURACAO_INVALIDA' });
const falha = (motivo) => Object.assign(new Error('recuperação off-line falhou'), { code: 'RECUPERACAO_OFFLINE_FALHOU', motivo });

function validarEntradas(opcoes) {
  if (!ehObjeto(opcoes) || !chavesExatas(opcoes, ['chaves']) || !ehObjeto(opcoes.chaves) || !chavesExatas(opcoes.chaves, ['mac', 'cifra'])) throw configuracaoInvalida();
  const ids = new Set();
  for (const nome of ['mac', 'cifra']) {
    const itens = opcoes.chaves[nome];
    if (!Array.isArray(itens) || itens.length < 1 || itens.length > POR_FAMILIA) throw configuracaoInvalida();
    for (const c of itens) {
      if (!ehObjeto(c) || typeof c.chaveId !== 'string' || !CHAVE_ID.test(c.chaveId) || ids.has(c.chaveId)) throw configuracaoInvalida();
      ids.add(c.chaveId);
      if (c.estado === 'ATIVA') {
        if (!chavesExatas(c, ['chaveId', 'estado', 'pacotes']) || !Array.isArray(c.pacotes) || c.pacotes.length < 1 || c.pacotes.length > 3) throw configuracaoInvalida();
      } else if (c.estado !== 'REVOGADA' || !chavesExatas(c, ['chaveId', 'estado'])) throw configuracaoInvalida();
    }
    if (!itens.some((c) => c.estado === 'ATIVA')) throw configuracaoInvalida();
  }
}

function criarProvedoresDeRecuperacaoOffline(opcoes) {
  validarEntradas(opcoes);
  const memoria = { mac: criarProvedorEmMemoria(), cifra: criarProvedorEmMemoria() };
  const obtidos = [];
  let estado = 'PRONTO';
  try {
    const entradas = { mac: [], cifra: [] };
    for (const nome of ['mac', 'cifra']) {
      for (const c of opcoes.chaves[nome]) {
        if (c.estado === 'REVOGADA') { entradas[nome].push({ chaveId: c.chaveId, estado: 'REVOGADA' }); continue; }
        const r = reconstruirSegredo({ pacotes: c.pacotes });
        if (!r.ok) throw falha(r.motivo);
        obtidos.push(r.segredo);
        if (r.chaveId !== c.chaveId) throw falha('CHAVE_DIFERENTE_DA_ESPERADA');
        const tamanhoOk = nome === 'cifra' ? r.segredo.length === BYTES_KEK : r.segredo.length >= BYTES_MAC_MIN && r.segredo.length <= BYTES_MAC_MAX;
        if (!tamanhoOk) throw falha('SEGREDO_INVALIDO');
        entradas[nome].push({ chaveId: c.chaveId, estado: 'ATIVA', segredo: r.segredo });
      }
    }
    for (const m of entradas.mac) for (const k of entradas.cifra) if (m.segredo && k.segredo && m.segredo.equals(k.segredo)) throw falha('CHAVES_NAO_SEPARADAS');
    memoria.mac.carregar(entradas.mac);
    memoria.cifra.carregar(entradas.cifra);
  } catch (e) {
    memoria.mac.provedor.zerar();
    memoria.cifra.provedor.zerar();
    throw e && e.code === 'RECUPERACAO_OFFLINE_FALHOU' ? e : falha('PACOTE_FORMATO');
  } finally {
    for (const b of obtidos) b.fill(0);
  }
  return Object.freeze({
    mac: memoria.mac.provedor,
    cifra: memoria.cifra.provedor,
    zerar() { memoria.mac.provedor.zerar(); memoria.cifra.provedor.zerar(); estado = 'ZERADO'; },
    estado: () => estado,
    toJSON: () => ({ provedor: PROVEDOR_ID, estado }),
  });
}

module.exports = { criarProvedoresDeRecuperacaoOffline, PROVEDOR_ID };
