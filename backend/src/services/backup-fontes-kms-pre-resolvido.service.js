'use strict';

const crypto = require('node:crypto');
const { validarFicha, AMBIENTES } = require('./backup-armazenamento-duravel-fichas.service');
const { valorDeVerificacao } = require('./backup-custodia-xor.service');
const { criarProvedorEmMemoria } = require('./backup-fontes-provedor-memoria.service');

/**
 * D-ORF-6, R-D45 (D-F5): PROVEDOR KMS PRÉ-RESOLVIDO. As fontes de chaves do manifesto (MAC) e da cifra (KEK) são SÍNCRONAS e recebem o segredo bruto; o KMS é assíncrono e
 * não entrega chave de HMAC. A ponte: `resolver()` decifra UMA vez, antes de começar, cada blob de chave (KMS Decrypt, chave KMS FIXADA pelo ARN da ficha e contexto de
 * criptografia com ambiente, finalidade e id) e monta duas famílias em memória, com o contrato síncrono. Nenhum formato do pacote muda.
 *
 * O host NUNCA cifra nem gera chave aqui: só decifra os blobs que a cerimônia de custódia criou. A custódia independente (partes XOR) é o que sobrevive à perda do KMS.
 * Tudo ou nada: qualquer falha (exceção, prazo, resposta fora do contrato, chave KMS diferente da fixada, tamanho do segredo, valor de verificação, MAC igual à KEK)
 * zera o que já foi obtido e deixa as duas famílias INDISPONÍVEIS. Erros trazem só código e motivo fixos. `PROVEDOR_ID` é o identificador proposto para a lista
 * de provedores aprovados; esta rodada NÃO o inclui em nenhuma lista (decisão de Ramires).
 *
 * Porta `cliente`: `{ decifrar({ chaveArn, contexto, blob }) -> Promise<{ chaveArn, segredo }> }`, onde `segredo` é um buffer exclusivo que este módulo zera depois de copiar.
 */

const PROVEDOR_ID = 'aws-kms-pre-resolvido-v1';
const FINALIDADES = Object.freeze(['MAC', 'CIFRA']);
const CHAVE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const BLOB_MAXIMO = 4096;
const POR_FAMILIA = 8;
const PRAZO_PADRAO_MS = 10000;
const PRAZO_MAXIMO_MS = 60000;
const BYTES_KEK = 32;
const BYTES_MAC_MIN = 32;
const BYTES_MAC_MAX = 128;

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const chavesExatas = (o, esperadas) => {
  const proprias = Reflect.ownKeys(o);
  return proprias.length === esperadas.length && proprias.every((k) => typeof k === 'string' && esperadas.includes(k));
};
const configuracaoInvalida = (motivo) => Object.assign(new TypeError('configuração do provedor KMS inválida'), { code: 'CONFIGURACAO_INVALIDA', motivo });
const falhaDeResolucao = (motivo) => Object.assign(new Error('pré-resolução das chaves falhou'), { code: 'KMS_PRE_RESOLUCAO_FALHOU', motivo });

/** Contexto de criptografia do KMS: liga o blob ao ambiente, à finalidade e ao id (um blob de MAC não decifra como KEK). */
function contextoDeCriptografia(entrada) {
  if (!ehObjeto(entrada) || !chavesExatas(entrada, ['ambiente', 'finalidade', 'chaveId']) || !AMBIENTES.includes(entrada.ambiente) || !FINALIDADES.includes(entrada.finalidade) || typeof entrada.chaveId !== 'string' || !CHAVE_ID.test(entrada.chaveId)) throw configuracaoInvalida('CONTEXTO_INVALIDO');
  return Object.freeze({ 'safework:ambiente': entrada.ambiente, 'safework:finalidade': entrada.finalidade, 'safework:chave-id': entrada.chaveId });
}

function validarChaves(chaves) {
  if (!ehObjeto(chaves) || !chavesExatas(chaves, ['mac', 'cifra'])) throw configuracaoInvalida('CHAVES_FORMATO');
  const ids = new Set();
  const lista = {};
  for (const [familia, nome] of [['MAC', 'mac'], ['CIFRA', 'cifra']]) {
    const itens = chaves[nome];
    if (!Array.isArray(itens) || itens.length < 1 || itens.length > POR_FAMILIA) throw configuracaoInvalida('CHAVES_FORMATO');
    lista[familia] = itens.map((c) => {
      if (!ehObjeto(c) || !chavesExatas(c, ['chaveId', 'estado', 'blob', 'vc']) || typeof c.chaveId !== 'string' || !CHAVE_ID.test(c.chaveId) || !['ATIVA', 'REVOGADA'].includes(c.estado)) throw configuracaoInvalida('CHAVE_INVALIDA');
      if (!(c.blob instanceof Uint8Array) || c.blob.length < 1 || c.blob.length > BLOB_MAXIMO || typeof c.vc !== 'string' || !HEX64.test(c.vc)) throw configuracaoInvalida('CHAVE_INVALIDA');
      if (ids.has(c.chaveId)) throw configuracaoInvalida('ID_REPETIDO');
      ids.add(c.chaveId);
      return Object.freeze({ chaveId: c.chaveId, estado: c.estado, blob: Buffer.from(c.blob), vc: c.vc });
    });
    if (!lista[familia].some((c) => c.estado === 'ATIVA')) throw configuracaoInvalida('NENHUMA_CHAVE_ATIVA');
  }
  return lista;
}

function criarProvedoresKmsPreResolvidos(opcoes) {
  if (!ehObjeto(opcoes) || !Reflect.ownKeys(opcoes).every((k) => ['ficha', 'cliente', 'chaves', 'prazoMs'].includes(k)) || !['ficha', 'cliente', 'chaves'].every((k) => Reflect.ownKeys(opcoes).includes(k))) throw configuracaoInvalida('OPCOES_FORMATO');
  const { ficha, cliente, chaves } = opcoes;
  const prazoMs = opcoes.prazoMs === undefined ? PRAZO_PADRAO_MS : opcoes.prazoMs;
  if (!Object.isFrozen(ficha)) throw configuracaoInvalida('FICHA_INVALIDA');
  try { validarFicha(ficha); } catch { throw configuracaoInvalida('FICHA_INVALIDA'); }
  if (!ehObjeto(cliente) || typeof cliente.decifrar !== 'function') throw configuracaoInvalida('CLIENTE_INVALIDO');
  if (!Number.isSafeInteger(prazoMs) || prazoMs < 1 || prazoMs > PRAZO_MAXIMO_MS) throw configuracaoInvalida('PRAZO_INVALIDO');
  const lista = validarChaves(chaves);
  const arnDe = { MAC: ficha.chaveMac, CIFRA: ficha.chaveCifra };
  const memoria = { MAC: criarProvedorEmMemoria(), CIFRA: criarProvedorEmMemoria() };
  let estado = 'NAO_RESOLVIDO';

  const comPrazo = (promessa) => new Promise((resolver, rejeitar) => {
    const timer = setTimeout(() => rejeitar(Object.assign(new Error('prazo'), { code: 'PRAZO' })), prazoMs);
    promessa.then((v) => { clearTimeout(timer); resolver(v); }, (e) => { clearTimeout(timer); rejeitar(e); });
  });

  async function decifrarUma(familia, c) {
    let resposta;
    try {
      resposta = await comPrazo(Promise.resolve().then(() => cliente.decifrar({ chaveArn: arnDe[familia], contexto: contextoDeCriptografia({ ambiente: ficha.ambiente, finalidade: familia, chaveId: c.chaveId }), blob: Buffer.from(c.blob) })));
    } catch { throw falhaDeResolucao('KMS_INDISPONIVEL'); }
    if (!ehObjeto(resposta) || !(resposta.segredo instanceof Uint8Array)) throw falhaDeResolucao('KMS_INDISPONIVEL');
    const segredo = Buffer.from(resposta.segredo);
    resposta.segredo.fill(0);
    return { segredo, chaveArn: resposta.chaveArn, formaExata: chavesExatas(resposta, ['chaveArn', 'segredo']) };
  }

  async function resolver() {
    if (estado !== 'NAO_RESOLVIDO') throw falhaDeResolucao('RESOLUCAO_JA_REALIZADA');
    estado = 'RESOLVENDO';
    const obtidos = [];
    try {
      const entradas = { MAC: [], CIFRA: [] };
      for (const familia of FINALIDADES) {
        for (const c of lista[familia]) {
          if (c.estado === 'REVOGADA') { entradas[familia].push({ chaveId: c.chaveId, estado: 'REVOGADA' }); continue; }
          const r = await decifrarUma(familia, c);
          obtidos.push(r.segredo);
          if (!r.formaExata || typeof r.chaveArn !== 'string') throw falhaDeResolucao('KMS_INDISPONIVEL');
          if (r.chaveArn !== arnDe[familia]) throw falhaDeResolucao('CHAVE_KMS_DIVERGENTE');
          const tamanhoOk = familia === 'CIFRA' ? r.segredo.length === BYTES_KEK : r.segredo.length >= BYTES_MAC_MIN && r.segredo.length <= BYTES_MAC_MAX;
          if (!tamanhoOk) throw falhaDeResolucao('SEGREDO_INVALIDO');
          if (!crypto.timingSafeEqual(Buffer.from(valorDeVerificacao(c.chaveId, r.segredo), 'hex'), Buffer.from(c.vc, 'hex'))) throw falhaDeResolucao('VALOR_DE_VERIFICACAO_DIVERGENTE');
          entradas[familia].push({ chaveId: c.chaveId, estado: 'ATIVA', segredo: r.segredo });
        }
      }
      for (const m of entradas.MAC) for (const k of entradas.CIFRA) if (m.segredo && k.segredo && m.segredo.equals(k.segredo)) throw falhaDeResolucao('CHAVES_NAO_SEPARADAS');
      memoria.MAC.carregar(entradas.MAC);
      memoria.CIFRA.carregar(entradas.CIFRA);
      estado = 'RESOLVIDO';
    } catch (e) {
      memoria.MAC.provedor.zerar();
      memoria.CIFRA.provedor.zerar();
      estado = 'FALHOU';
      throw e && e.code === 'KMS_PRE_RESOLUCAO_FALHOU' ? e : falhaDeResolucao('KMS_INDISPONIVEL');
    } finally {
      for (const b of obtidos) b.fill(0);
    }
  }

  function zerar() {
    memoria.MAC.provedor.zerar();
    memoria.CIFRA.provedor.zerar();
    estado = 'ZERADO';
  }

  return Object.freeze({ mac: memoria.MAC.provedor, cifra: memoria.CIFRA.provedor, resolver, zerar, estado: () => estado, toJSON: () => ({ provedor: PROVEDOR_ID, estado }) });
}

module.exports = { criarProvedoresKmsPreResolvidos, contextoDeCriptografia, PROVEDOR_ID, FINALIDADES };
