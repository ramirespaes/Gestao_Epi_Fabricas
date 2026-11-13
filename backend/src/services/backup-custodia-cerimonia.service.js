'use strict';

const { dividirSegredo, reconstruirSegredo, codificarPacote } = require('./backup-custodia-xor.service');

/**
 * D-ORF-6, D3 / H9-d (F1): LÓGICA PURA DA CERIMÔNIA DE CUSTÓDIA — preparação (sorteio dos segredos MAC e KEK, divisão XOR 2 de 3 e cartões dos três custodiantes) e
 * conferência da transcrição (reconstrução por uma dupla, contra o registro). Reutiliza `backup-custodia-xor` sem alterá-lo. Não lê terminal, arquivo, rede nem ambiente,
 * não chama KMS e NÃO tem gerador de aleatoriedade: `aleatorio(n)` é injetado por quem chama e é obrigatório. A cerimônia real, o provisionamento e a ferramenta de
 * linha de comando não fazem parte deste módulo.
 *
 * `prepararCerimonia({ mac: { chaveId, bytes }, cifra: { chaveId }, aleatorio })` -> `{ ok, registro, custodiantes }`. O `registro` (ids, tamanhos e valores de
 * verificação) não contém segredo nem partes; `custodiantes[k]` traz os dois cartões em texto do custodiante k+1 e é material SENSÍVEL. O segredo nunca é devolvido.
 * `conferirCerimonia({ registro, apresentados: { mac: [pacotes], cifra: [pacotes] } })` -> `{ ok, mac, cifra }` só com ids e valores de verificação.
 *
 * Falha fechada e tudo ou nada: toda recusa é `{ ok: false, motivo }` com motivo de `MOTIVOS`, sem nenhum outro campo; as funções não lançam. Cada campo da entrada é
 * lido uma vez. Os buffers entregues por `aleatorio` passam a ser do módulo, que os zera; zerar em JavaScript é melhor esforço.
 *
 * ALEATORIEDADE DEGENERADA. O sigilo da divisão depende de a e b serem uniformes e independentes. Um valor zerado ou repetido entre segredos e partes entrega o segredo a
 * um custodiante sozinho (por exemplo, a = 0 faz o custodiante 2 guardar b e S xor b; b = S faz c = a). Essas saídas de um gerador defeituoso são recusadas; a
 * recusa não mede a qualidade do gerador, que continua sendo responsabilidade de quem o injeta.
 */

const CHAVE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const BYTES_KEK = 32;
const BYTES_MAC_MIN = 32;
const BYTES_MAC_MAX = 128;
const FAMILIAS = Object.freeze(['mac', 'cifra']);
const MOTIVOS = Object.freeze([
  'ENTRADA_INVALIDA', 'ID_REPETIDO', 'ALEATORIEDADE_INVALIDA', 'ALEATORIEDADE_DEGENERADA', 'CHAVES_NAO_SEPARADAS',
  'PACOTE_FORMATO', 'PARTE_COM_ERRO_DE_TRANSCRICAO', 'PACOTES_INSUFICIENTES', 'PACOTES_DE_CHAVES_DIFERENTES', 'CUSTODIANTES_REPETIDOS', 'PARTE_DIVERGENTE',
  'VALOR_DE_VERIFICACAO_DIVERGENTE', 'CHAVE_DIFERENTE_DA_ESPERADA', 'SEGREDO_INVALIDO',
]);

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const chavesExatas = (o, esperadas) => {
  const proprias = Reflect.ownKeys(o);
  return proprias.length === esperadas.length && proprias.every((k) => typeof k === 'string' && esperadas.includes(k));
};
const recusa = (motivo) => Object.freeze({ ok: false, motivo });
const idValido = (v) => typeof v === 'string' && CHAVE_ID.test(v);
const bytesValidos = (familia, n) => Number.isInteger(n) && (familia === 'cifra' ? n === BYTES_KEK : n >= BYTES_MAC_MIN && n <= BYTES_MAC_MAX);
const iguais = (a, b) => Buffer.compare(a, b) === 0;
const zerado = (b) => b.every((x) => x === 0);

/** Lê o pedido uma vez; devolve `{ mac: { chaveId, bytes }, cifra: { chaveId, bytes }, aleatorio }` ou null. */
function lerPedido(opcoes) {
  if (!ehObjeto(opcoes) || !chavesExatas(opcoes, ['mac', 'cifra', 'aleatorio'])) return null;
  const { mac, cifra, aleatorio } = opcoes;
  if (!ehObjeto(mac) || !chavesExatas(mac, ['chaveId', 'bytes']) || !ehObjeto(cifra) || !chavesExatas(cifra, ['chaveId'])) return null;
  const pedido = { mac: { chaveId: mac.chaveId, bytes: mac.bytes }, cifra: { chaveId: cifra.chaveId, bytes: BYTES_KEK }, aleatorio };
  return FAMILIAS.every((f) => idValido(pedido[f].chaveId) && bytesValidos(f, pedido[f].bytes)) ? pedido : null;
}

function prepararCerimonia(opcoes) {
  const usados = [];
  let motivo = 'ENTRADA_INVALIDA';
  try {
    const pedido = lerPedido(opcoes);
    if (pedido === null) return recusa(motivo);
    if (pedido.mac.chaveId === pedido.cifra.chaveId) return recusa('ID_REPETIDO');
    motivo = 'ALEATORIEDADE_INVALIDA';
    const sortear = (n) => {
      const entregue = pedido.aleatorio(n);
      if (!(entregue instanceof Uint8Array)) throw new TypeError('sorteio');
      const copia = Buffer.from(entregue);
      entregue.fill(0);
      usados.push(copia);
      if (copia.length !== n) throw new TypeError('sorteio');
      return copia;
    };
    const segredos = { mac: sortear(pedido.mac.bytes), cifra: sortear(BYTES_KEK) };
    if (iguais(segredos.mac, segredos.cifra)) return recusa('CHAVES_NAO_SEPARADAS');
    const divisoes = {};
    for (const f of FAMILIAS) {
      divisoes[f] = dividirSegredo({ chaveId: pedido[f].chaveId, segredo: segredos[f], aleatorio: sortear });
      usados.push(Buffer.from(divisoes[f].pacotes[1].partes[1].valor, 'hex'));
    }
    if (usados.some((b, i) => zerado(b) || usados.some((outro, j) => j < i && iguais(b, outro)))) return recusa('ALEATORIEDADE_DEGENERADA');
    const registro = Object.freeze(Object.fromEntries(FAMILIAS.map((f) => [f, Object.freeze({ chaveId: pedido[f].chaveId, bytes: pedido[f].bytes, valorDeVerificacao: divisoes[f].valorDeVerificacao })])));
    const custodiantes = Object.freeze([0, 1, 2].map((i) => Object.freeze({ custodiante: i + 1, mac: codificarPacote(divisoes.mac.pacotes[i]), cifra: codificarPacote(divisoes.cifra.pacotes[i]) })));
    return Object.freeze({ ok: true, registro, custodiantes });
  } catch {
    return recusa(motivo);
  } finally {
    for (const b of usados) b.fill(0);
  }
}

/** Lê o registro uma vez; devolve a cópia validada ou null. */
function lerRegistro(registro) {
  if (!ehObjeto(registro) || !chavesExatas(registro, ['mac', 'cifra'])) return null;
  const lido = {};
  for (const f of FAMILIAS) {
    const r = registro[f];
    if (!ehObjeto(r) || !chavesExatas(r, ['chaveId', 'bytes', 'valorDeVerificacao'])) return null;
    const { chaveId, bytes, valorDeVerificacao } = r;
    if (!idValido(chaveId) || !bytesValidos(f, bytes) || typeof valorDeVerificacao !== 'string' || !HEX64.test(valorDeVerificacao)) return null;
    lido[f] = { chaveId, bytes, valorDeVerificacao };
  }
  return lido.mac.chaveId === lido.cifra.chaveId ? null : lido;
}

function conferirCerimonia(opcoes) {
  const obtidos = [];
  try {
    if (!ehObjeto(opcoes) || !chavesExatas(opcoes, ['registro', 'apresentados'])) return recusa('ENTRADA_INVALIDA');
    const { registro, apresentados } = opcoes;
    const esperado = lerRegistro(registro);
    if (esperado === null || !ehObjeto(apresentados) || !chavesExatas(apresentados, ['mac', 'cifra'])) return recusa('ENTRADA_INVALIDA');
    for (const f of FAMILIAS) {
      const r = reconstruirSegredo({ pacotes: apresentados[f] });
      if (!r.ok) return recusa(r.motivo);
      obtidos.push(r.segredo);
      if (r.chaveId !== esperado[f].chaveId) return recusa('CHAVE_DIFERENTE_DA_ESPERADA');
      if (r.valorDeVerificacao !== esperado[f].valorDeVerificacao) return recusa('VALOR_DE_VERIFICACAO_DIVERGENTE');
      if (r.segredo.length !== esperado[f].bytes) return recusa('SEGREDO_INVALIDO');
    }
    if (iguais(obtidos[0], obtidos[1])) return recusa('CHAVES_NAO_SEPARADAS');
    return Object.freeze({ ok: true, ...Object.fromEntries(FAMILIAS.map((f) => [f, Object.freeze({ chaveId: esperado[f].chaveId, valorDeVerificacao: esperado[f].valorDeVerificacao })])) });
  } catch {
    return recusa('ENTRADA_INVALIDA');
  } finally {
    for (const b of obtidos) b.fill(0);
  }
}

module.exports = { prepararCerimonia, conferirCerimonia, MOTIVOS, BYTES_KEK, BYTES_MAC_MIN, BYTES_MAC_MAX };
