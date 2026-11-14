'use strict';

const { validarFicha } = require('./backup-armazenamento-duravel-fichas.service');
const { conferirCerimonia, MOTIVOS: MOTIVOS_DA_CERIMONIA } = require('./backup-custodia-cerimonia.service');
const { reconstruirSegredo } = require('./backup-custodia-xor.service');
const { contextoDeCriptografia } = require('./backup-fontes-kms-pre-resolvido.service');

/**
 * D-ORF-6, D3 / H9-d (F2, primeira fatia): LÓGICA PURA DO EMBRULHO das chaves MAC e KEK para o KMS. Depois de a cerimônia conferir os cartões de uma dupla de
 * custodiantes contra o registro, reconstrói cada segredo, entrega-o a um `cliente` de cifragem INJETADO e devolve os blobs no formato que o provedor KMS
 * pré-resolvido já consome (`{ chaveId, estado, blob, vc }`). Não lê terminal, arquivo, rede nem ambiente e não conhece o SDK: a porta real da AWS, a credencial,
 * o papel da cerimônia e a operação não fazem parte deste módulo. Reutiliza a conferência (F1), a reconstrução XOR, a ficha e o contexto de criptografia sem alterá-los.
 *
 * `embrulharChaves({ ficha, registro, apresentados: { mac: [cartões], cifra: [cartões] }, cliente, prazoMs? })` -> `Promise<{ ok: true, chaves: { mac: [item], cifra: [item] } }>`.
 * Porta `cliente`: `{ cifrar({ chaveArn, contexto, segredo }) -> Promise<{ chaveArn, blob }> }`. São duas chamadas, MAC e depois KEK, cada uma com o ARN da ficha
 * (`chaveMac`, `chaveCifra`) e o contexto da própria finalidade e id; o `segredo` entregue é um buffer exclusivo, zerado quando a chamada termina ou o prazo vence.
 *
 * Falha fechada e tudo ou nada: toda recusa é `{ ok: false, motivo }` com motivo de `MOTIVOS`, sem blob, causa ou mensagem do cliente; a função não lança nem rejeita.
 * O objeto devolvido (sucesso ou recusa) é congelado e NÃO tem protótipo, para que um `then` posto em `Object.prototype` não transforme o retorno em rejeição.
 * Cada campo da entrada é lido uma vez e os cartões são copiados (só texto) antes da conferência, de modo que o que foi conferido é o que é embrulhado. A chave que
 * respondeu tem de ser a pedida. O blob é medido e copiado pelos campos internos do Uint8Array (não por `length` nem `valueOf`, que o dono pode redefinir) para um
 * buffer próprio; fora de 1..`BLOB_MAXIMO` bytes, contendo o segredo ou repetido entre as duas chaves, é recusado.
 *
 * PRAZO. `prazoMs` limita a ESPERA pela resposta; resposta que chega depois é ignorada. Ele não interrompe código síncrono do cliente (um cliente que bloqueia sem
 * devolver o controle segura a função além do prazo) nem cancela a operação: o pedido ao KMS pode ter sido efetivado mesmo quando a recusa é `KMS_INDISPONIVEL`, e uma
 * falha na KEK deixa no KMS o registro da cifragem da MAC, cujo blob é descartado. O prazo não é repassado ao cliente.
 *
 * O BUFFER ENTREGUE é do módulo: tem memória própria (fora do pool compartilhado do Node). Se, ao fim da chamada, ele estiver diferente do segredo reconstruído, a
 * recusa é `SEGREDO_ALTERADO`. LIMITES: essa comparação só enxerga o que ainda está alterado no retorno e NÃO comprova o conteúdo do blob, que vem de um serviço
 * externo; isso só o valor de verificação comprova, quando o host decifra (não há Decrypt na cerimônia). A zeragem, a comparação e a medida e cópia do blob usam
 * intrínsecos guardados na carga do módulo e não dependem da instância nem de protótipo ou função global trocados depois. Zerar é melhor esforço: não alcança cópias
 * feitas pelo cliente, memória que ele tenha transferido, os buffers internos dos módulos XOR e da cerimônia (que usam o protótipo), nem um processo adulterado antes
 * da carga. Os demais intrínsecos da linguagem (Promise, Object, Reflect, temporizadores) não são protegidos.
 *
 * CONTRATO PARA A PORTA REAL (`cliente.cifrar`), a ser cumprido por quem a implementar:
 *  - consumir o `segredo` de imediato, de forma síncrona, antes do primeiro ponto de espera: depois do prazo ele está zerado, e reler numa nova tentativa cifraria zeros;
 *  - não alterar nem zerar o buffer (quem zera é este módulo), não o transferir e não guardar a referência nem visões dela (`subarray`, `.buffer`) além da chamada;
 *  - as cópias que a porta ou o SDK fizerem (por exemplo, o corpo da requisição) são responsabilidade da porta: mantê-las pelo menor tempo e nunca registrá-las;
 *  - responder com um objeto que tenha EXATAMENTE as chaves próprias `chaveArn` (texto idêntico ao ARN pedido) e `blob` (Uint8Array de 1..`BLOB_MAXIMO` bytes),
 *    sem metadados do SDK;
 *  - em erro, rejeitar ou lançar: aqui toda falha vira `KMS_INDISPONIVEL` e a causa é descartada. Se a causa precisar de registro, é a porta que o faz, só com código
 *    fixo, sem o segredo, o pedido ou a mensagem do fornecedor;
 *  - as chamadas são sequenciais (MAC, depois KEK), nunca concorrentes.
 */

const BLOB_MAXIMO = 4096;
const PRAZO_PADRAO_MS = 10000;
const PRAZO_MAXIMO_MS = 60000;
const FAMILIAS = Object.freeze([Object.freeze(['MAC', 'mac', 'chaveMac']), Object.freeze(['CIFRA', 'cifra', 'chaveCifra'])]);
const OBRIGATORIAS = Object.freeze(['ficha', 'registro', 'apresentados', 'cliente']);
const MOTIVOS = Object.freeze([...MOTIVOS_DA_CERIMONIA, 'FICHA_INVALIDA', 'CLIENTE_INVALIDO', 'PRAZO_INVALIDO', 'KMS_INDISPONIVEL', 'SEGREDO_ALTERADO', 'CHAVE_KMS_DIVERGENTE', 'RESPOSTA_INVALIDA']);

// Intrínsecos das verificações de segurança, guardados na carga: o cliente recebe um buffer do módulo e roda no mesmo processo, e não pode desligá-las trocando-os depois.
const TIPADO = Object.getPrototypeOf(Uint8Array.prototype);
const marcaDe = Object.getOwnPropertyDescriptor(TIPADO, Symbol.toStringTag).get;
const bytesDe = Object.getOwnPropertyDescriptor(TIPADO, 'byteLength').get;
const copiarPara = TIPADO.set;
const preencher = Buffer.prototype.fill;
const indiceDe = Buffer.prototype.indexOf;
const comparar = Buffer.compare;
const alocar = Buffer.alloc;

/** Não lança: `fill` sobre memória que o cliente transferiu lança, e a limpeza dos demais buffers tem de continuar. */
const zerar = (b) => { try { preencher.call(b, 0); } catch { /* memória transferida: nada a zerar aqui */ } };
/** Cópia exclusiva, fora do pool, medida e lida pelos campos internos do Uint8Array (nunca por `length`, `valueOf` ou outro campo que o dono possa redefinir). */
const copiaDe = (bytes) => { const copia = alocar(bytesDe.call(bytes)); copiarPara.call(copia, bytes); return copia; };
/** Sem protótipo: a resolução de uma promessa procura `then` no valor, e um `Object.prototype.then` posto pelo cliente faria a recusa virar rejeição. */
const resultado = (campos) => Object.freeze(Object.assign(Object.create(null), campos));
const recusa = (motivo) => resultado({ ok: false, motivo });
const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const chavesExatas = (o, esperadas) => {
  const proprias = Reflect.ownKeys(o);
  return proprias.length === esperadas.length && proprias.every((k) => typeof k === 'string' && esperadas.includes(k));
};

/** Ficha congelada e válida, lida pelos descritores (um campo com getter poderia mudar depois de validado); devolve `{ ambiente, chaveMac, chaveCifra }` ou null. */
function lerFicha(ficha) {
  if (!ehObjeto(ficha) || !Object.isFrozen(ficha)) return null;
  const lida = {};
  for (const campo of ['ambiente', 'chaveMac', 'chaveCifra']) {
    const d = Object.getOwnPropertyDescriptor(ficha, campo);
    if (d === undefined || !Object.hasOwn(d, 'value')) return null;
    lida[campo] = d.value;
  }
  try { validarFicha(ficha); } catch { return null; }
  return lida;
}

/** Lê a entrada uma vez; devolve o motivo da recusa (texto) ou o pedido validado. */
function lerOpcoes(opcoes) {
  if (!ehObjeto(opcoes)) return 'ENTRADA_INVALIDA';
  const nomes = Reflect.ownKeys(opcoes);
  if (!nomes.every((k) => OBRIGATORIAS.includes(k) || k === 'prazoMs') || !OBRIGATORIAS.every((k) => nomes.includes(k))) return 'ENTRADA_INVALIDA';
  const { ficha, registro, apresentados, cliente } = opcoes;
  const prazoMs = nomes.includes('prazoMs') ? opcoes.prazoMs : PRAZO_PADRAO_MS;
  if (!ehObjeto(apresentados) || !chavesExatas(apresentados, ['mac', 'cifra'])) return 'ENTRADA_INVALIDA';
  const cartoes = {};
  for (const [, familia] of FAMILIAS) {
    const lista = apresentados[familia];
    if (!Array.isArray(lista)) return 'ENTRADA_INVALIDA';
    const copia = Object.freeze(Array.from(lista));
    if (copia.length < 1 || copia.length > 3 || !copia.every((c) => typeof c === 'string')) return 'ENTRADA_INVALIDA';
    cartoes[familia] = copia;
  }
  const fichaLida = lerFicha(ficha);
  if (fichaLida === null) return 'FICHA_INVALIDA';
  if (!ehObjeto(cliente)) return 'CLIENTE_INVALIDO';
  const cifrar = cliente.cifrar;
  if (typeof cifrar !== 'function') return 'CLIENTE_INVALIDO';
  if (!Number.isSafeInteger(prazoMs) || prazoMs < 1 || prazoMs > PRAZO_MAXIMO_MS) return 'PRAZO_INVALIDO';
  return { ficha: fichaLida, registro, cartoes, cifrar: (pedido) => cifrar.call(cliente, pedido), prazoMs };
}

const comPrazo = (promessa, prazoMs) => new Promise((resolver, rejeitar) => {
  const timer = setTimeout(() => rejeitar(new Error('prazo')), prazoMs);
  promessa.then((v) => { clearTimeout(timer); resolver(v); }, (e) => { clearTimeout(timer); rejeitar(e); });
});

async function embrulharChaves(opcoes) {
  const controlados = [];
  let motivo = 'ENTRADA_INVALIDA';
  try {
    const pedido = lerOpcoes(opcoes);
    if (typeof pedido === 'string') return recusa(pedido);
    const conferido = conferirCerimonia({ registro: pedido.registro, apresentados: pedido.cartoes });
    if (!conferido.ok) return recusa(conferido.motivo);
    const chaves = {};
    const blobs = [];
    for (const [finalidade, familia, campoDoArn] of FAMILIAS) {
      motivo = 'ENTRADA_INVALIDA';
      const r = reconstruirSegredo({ pacotes: pedido.cartoes[familia] });
      if (!r.ok) return recusa(r.motivo);
      const entregue = copiaDe(r.segredo);
      controlados.push(r.segredo, entregue);
      const chaveArn = pedido.ficha[campoDoArn];
      const contexto = contextoDeCriptografia({ ambiente: pedido.ficha.ambiente, finalidade, chaveId: r.chaveId });
      motivo = 'KMS_INDISPONIVEL';
      const resposta = await comPrazo(Promise.resolve().then(() => pedido.cifrar(Object.freeze({ chaveArn, contexto, segredo: entregue }))), pedido.prazoMs);
      if (comparar(entregue, r.segredo) !== 0) return recusa('SEGREDO_ALTERADO');
      motivo = 'RESPOSTA_INVALIDA';
      if (!ehObjeto(resposta) || !chavesExatas(resposta, ['chaveArn', 'blob'])) return recusa(motivo);
      const { chaveArn: respondeu, blob } = resposta;
      if (typeof respondeu !== 'string' || marcaDe.call(blob) !== 'Uint8Array' || bytesDe.call(blob) < 1 || bytesDe.call(blob) > BLOB_MAXIMO) return recusa(motivo);
      if (respondeu !== chaveArn) return recusa('CHAVE_KMS_DIVERGENTE');
      const copia = copiaDe(blob);
      if (copia.length < 1 || copia.length > BLOB_MAXIMO || indiceDe.call(copia, r.segredo) !== -1 || blobs.some((b) => comparar(b, copia) === 0)) return recusa(motivo);
      blobs.push(copia);
      zerar(r.segredo);
      zerar(entregue);
      chaves[familia] = Object.freeze([Object.freeze({ chaveId: r.chaveId, estado: 'ATIVA', blob: copia, vc: r.valorDeVerificacao })]);
    }
    return resultado({ ok: true, chaves: Object.freeze(chaves) });
  } catch {
    return recusa(motivo);
  } finally {
    for (const b of controlados) zerar(b);
  }
}

module.exports = { embrulharChaves, MOTIVOS, BLOB_MAXIMO, PRAZO_PADRAO_MS, PRAZO_MAXIMO_MS };
