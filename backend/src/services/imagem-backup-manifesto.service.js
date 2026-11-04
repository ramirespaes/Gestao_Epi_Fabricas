'use strict';

const crypto = require('node:crypto');

/**
 * Backup permanente da Biblioteca de Imagens (D-ORF-6, GREEN-MANIFESTO-INTEGRIDADE-1): MANIFESTO DE INTEGRIDADE do conjunto. Funções puras e síncronas: sem relógio, disco, rede, banco ou processo.
 * Contrato PROVISÓRIO. Nada aqui publica o conjunto, prova restauração ou autentica o manifesto.
 *
 * `construirManifesto({ contexto, copia, dump, conjuntoId })` -> { manifesto, bytes, sha256, identidade }, congelado.
 *   - `manifesto` = { arquivos: [{ bytes, chave, sha256 }], banco: { nome, oid }, conjuntoId, dump: { bytes, sha256 }, versao: 1 }; nunca `snapshotId`, caminhos, credenciais nem o próprio hash;
 *   - `bytes` = serialização CANÔNICA (JSON compacto UTF-8, chaves em ordem lexicográfica, `arquivos` por `chave`, sem BOM e sem quebra de linha final). É uma propriedade de LEITURA que devolve um
 *     Buffer NOVO a cada acesso: congelar o objeto não congelaria os bytes de um Buffer, então nenhum Buffer interno é compartilhado e alterar uma cópia não afeta nenhuma outra;
 *   - `sha256` = SHA-256 dos bytes canônicos, mantido FORA do manifesto (`identidade.sha256Manifesto`), sem circularidade.
 *   - EXATIDÃO: a cópia precisa estar completa e seus arquivos serem EXATAMENTE o `contexto.plano` (nenhum faltante, adicional ou repetido; mesmos hashes). O `avaliarConjunto` não rejeita arquivos
 *     adicionais, então esta conferência é daqui.
 *   - DUMP: o construtor NÃO recebe os bytes do dump e portanto NÃO recalcula o SHA-256: recebe a evidência `{ concluido, bytes, sha256Declarado, sha256Recalculado }` (o mesmo contrato do
 *     `avaliarConjunto`), cujo recálculo é de quem leu o arquivo. Aqui só se exige coerência (concluído, tamanho positivo, os dois hashes válidos e iguais): o manifesto REGISTRA essa evidência, não a prova.
 * `lerManifesto({ bytes, sha256 })` -> { manifesto, sha256, identidade }: confere o hash dos bytes, exige a forma canônica e revalida o conteúdo inteiro.
 *
 * LIMITES: SHA-256 sem assinatura ou HMAC NÃO autentica (quem regrava manifesto e hash juntos o forja); o `oid` é metadado de ORIGEM, não identidade estável após restauração; nenhum campo de
 * recuperabilidade existe aqui. Qualquer falha lança Error com `code: 'MANIFESTO_INVALIDO'` e mensagem fixa, sem eco de valores.
 */

const VERSAO = 1;
const CHAVE = /^(?:[1-9][0-9]{0,14}|padrao)\/[0-9a-f]{64}\/(?:mestre\.(?:png|jpg|webp)|(?:exibicao|miniatura)\.webp)$/;
const SHA256 = /^[0-9a-f]{64}$/;
const OID = /^[0-9]{1,20}$/;
const CONTROLE = /[\u0000-\u001f\u007f-\u009f]/;
const LIMITE_IDENTIFICADOR = 200;
const LIMITE_BYTES_DO_MANIFESTO = 64 * 1024 * 1024;

function invalido() {
  const falha = new Error('manifesto de backup inválido');
  falha.code = 'MANIFESTO_INVALIDO';
  return falha;
}
const exigir = (condicao) => { if (!condicao) throw invalido(); };

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const hexValido = (v) => typeof v === 'string' && SHA256.test(v);
const inteiroPositivo = (v) => Number.isSafeInteger(v) && v >= 1;
const chavesExatas = (objeto, esperadas) => {
  const proprias = Reflect.ownKeys(objeto);
  return proprias.length === esperadas.length && proprias.every((k) => typeof k === 'string' && esperadas.includes(k));
};
const textoLimpo = (v) => typeof v === 'string' && v.trim() !== '' && v.length <= LIMITE_IDENTIFICADOR && !CONTROLE.test(v) && v.isWellFormed();
const compararTexto = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function validarBanco(banco) {
  exigir(ehObjeto(banco));
  const { nome, oid } = banco;
  exigir(textoLimpo(nome) && typeof oid === 'string' && OID.test(oid));
  return { nome, oid };
}

/** Monta o manifesto e seus bytes canônicos a partir de valores JÁ validados. */
function montar({ conjuntoId, banco, dump, arquivos }) {
  const ordenados = [...arquivos].sort((a, b) => compararTexto(a.chave, b.chave));
  const arquivosCanonicos = ordenados.map((a) => ({ bytes: a.bytes, chave: a.chave, sha256: a.sha256 }));
  const objeto = {
    arquivos: arquivosCanonicos,
    banco: { nome: banco.nome, oid: banco.oid },
    conjuntoId,
    dump: { bytes: dump.bytes, sha256: dump.sha256 },
    versao: VERSAO,
  };
  const texto = JSON.stringify(objeto);
  const buffer = Buffer.from(texto, 'utf8');
  const manifesto = JSON.parse(texto);
  for (const a of manifesto.arquivos) Object.freeze(a);
  Object.freeze(manifesto.arquivos);
  Object.freeze(manifesto.banco);
  Object.freeze(manifesto.dump);
  Object.freeze(manifesto);
  return { manifesto, buffer };
}

function resultado({ manifesto, buffer }) {
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  const identidade = Object.freeze({ conjuntoId: manifesto.conjuntoId, sha256Manifesto: hash });
  const interno = Buffer.from(buffer);
  const saida = { manifesto, sha256: hash, identidade };
  // Leitura que devolve uma cópia nova: o Buffer interno nunca é exposto.
  Object.defineProperty(saida, 'bytes', { enumerable: true, get: () => Buffer.from(interno) });
  return Object.freeze(saida);
}

function capturarPlano(contexto) {
  exigir(ehObjeto(contexto));
  const plano = contexto.plano;
  exigir(Array.isArray(plano));
  const mapa = new Map();
  for (let i = 0; i < plano.length; i += 1) {
    const item = plano[i];
    exigir(ehObjeto(item) && chavesExatas(item, ['chave', 'sha256']));
    const { chave, sha256 } = item;
    exigir(typeof chave === 'string' && CHAVE.test(chave) && hexValido(sha256) && !mapa.has(chave));
    mapa.set(chave, sha256);
  }
  return mapa;
}

function capturarCopia(copia, mapaDoPlano) {
  exigir(ehObjeto(copia) && chavesExatas(copia, ['arquivos', 'completo', 'copiados', 'falha', 'ok']));
  const { ok, completo, falha, copiados, arquivos } = copia;
  exigir(ok === true && completo === true && falha === null && Array.isArray(arquivos) && copiados === arquivos.length);
  exigir(arquivos.length === mapaDoPlano.size);
  const vistas = new Set();
  const itens = [];
  for (let i = 0; i < arquivos.length; i += 1) {
    const item = arquivos[i];
    exigir(ehObjeto(item) && chavesExatas(item, ['chave', 'sha256', 'bytes']));
    const { chave, sha256, bytes } = item;
    exigir(typeof chave === 'string' && hexValido(sha256) && inteiroPositivo(bytes));
    exigir(mapaDoPlano.get(chave) === sha256 && !vistas.has(chave));
    vistas.add(chave);
    itens.push({ chave, sha256, bytes });
  }
  return itens;
}

function capturarDump(dump) {
  exigir(ehObjeto(dump));
  const { concluido, bytes, sha256Declarado, sha256Recalculado } = dump;
  exigir(concluido === true && inteiroPositivo(bytes) && hexValido(sha256Declarado) && hexValido(sha256Recalculado) && sha256Declarado === sha256Recalculado);
  return { bytes, sha256: sha256Recalculado };
}

function construirManifesto(entrada) {
  try {
    exigir(ehObjeto(entrada) && chavesExatas(entrada, ['contexto', 'copia', 'dump', 'conjuntoId']));
    const { contexto, copia, dump, conjuntoId } = entrada;
    exigir(textoLimpo(conjuntoId));
    exigir(ehObjeto(contexto));
    const banco = validarBanco(contexto.banco);
    const mapa = capturarPlano(contexto);
    const arquivos = capturarCopia(copia, mapa);
    return resultado(montar({ conjuntoId, banco, dump: capturarDump(dump), arquivos }));
  } catch {
    throw invalido();
  }
}

function lerManifesto(entrada) {
  try {
    exigir(ehObjeto(entrada) && chavesExatas(entrada, ['bytes', 'sha256']));
    const { bytes, sha256 } = entrada;
    exigir(bytes instanceof Uint8Array && bytes.length > 0 && bytes.length <= LIMITE_BYTES_DO_MANIFESTO && hexValido(sha256));
    const copia = Buffer.from(bytes); // cópia defensiva: o chamador não altera o que foi validado
    exigir(crypto.createHash('sha256').update(copia).digest('hex') === sha256);

    let objeto;
    try {
      objeto = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(copia));
    } catch {
      throw invalido();
    }
    exigir(ehObjeto(objeto) && chavesExatas(objeto, ['arquivos', 'banco', 'conjuntoId', 'dump', 'versao']) && objeto.versao === VERSAO);
    exigir(textoLimpo(objeto.conjuntoId));
    exigir(ehObjeto(objeto.banco) && chavesExatas(objeto.banco, ['nome', 'oid']));
    const banco = validarBanco(objeto.banco);
    exigir(ehObjeto(objeto.dump) && chavesExatas(objeto.dump, ['bytes', 'sha256']) && inteiroPositivo(objeto.dump.bytes) && hexValido(objeto.dump.sha256));
    exigir(Array.isArray(objeto.arquivos));
    const arquivos = [];
    let anterior = null;
    for (const item of objeto.arquivos) {
      exigir(ehObjeto(item) && chavesExatas(item, ['bytes', 'chave', 'sha256']));
      exigir(typeof item.chave === 'string' && CHAVE.test(item.chave) && hexValido(item.sha256) && inteiroPositivo(item.bytes));
      exigir(anterior === null || compararTexto(anterior, item.chave) < 0); // ordem estrita: sem repetição
      anterior = item.chave;
      arquivos.push({ bytes: item.bytes, chave: item.chave, sha256: item.sha256 });
    }
    const montado = montar({ conjuntoId: objeto.conjuntoId, banco, dump: { bytes: objeto.dump.bytes, sha256: objeto.dump.sha256 }, arquivos });
    exigir(montado.buffer.equals(copia)); // forma canônica única
    const { manifesto, sha256: hash, identidade } = resultado(montado);
    return Object.freeze({ manifesto, sha256: hash, identidade });
  } catch {
    throw invalido();
  }
}

module.exports = { construirManifesto, lerManifesto };
