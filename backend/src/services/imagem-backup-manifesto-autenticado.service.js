'use strict';

const crypto = require('node:crypto');
const { lerManifesto: lerManifestoV1 } = require('./imagem-backup-manifesto.service');
const { criarSelagem } = require('./imagem-backup-selagem.service');

/**
 * Backup permanente da Biblioteca de Imagens (D-ORF-6, MANIFESTO V2 AUTENTICADO). Camada ADITIVA sobre o manifesto V1 (que não é alterado nem reinterpretado): o V2 declara o layout e o caminho do dump e carrega uma AUTENTICAÇÃO
 * HMAC-SHA256 calculada com um segredo que NUNCA está no pacote. Funções síncronas, sem disco, rede, banco, processo, relógio nem ambiente (o segredo só chega por uma FONTE DE CHAVES injetada).
 *
 * FORMATO (JSON canônico: compacto UTF-8, chaves em ordem lexicográfica, sem BOM): { arquivos:[{bytes,chave,sha256}], autenticacao:{algoritmo:'HMAC-SHA256', chaveId, mac}, banco:{nome,oid}, conjuntoId,
 * dump:{arquivo:'dump/postgres.dump', bytes, sha256}, layout:1, versao:2 }. O MAC cobre o prefixo de domínio e TODO o objeto sem `mac` (inclusive `algoritmo` e `chaveId`, então trocar a chave ou o algoritmo declarados invalida o MAC).
 *
 * LEITURA (`criarLeitorV2({ fonteDeChaves })` -> ({ bytes, sha256 }) => { manifesto, sha256, identidade, autenticacao }): ordem OBRIGATÓRIA: (1) SHA-256 dos bytes; (2) JSON; (3) `versao` 2 e bloco `autenticacao` EXATO (V1 e downgrade
 * são recusados aqui, antes de qualquer outra coisa); (4) a chave é obtida pela fonte (indisponível/revogada = recusa); (5) MAC recomputado e comparado em tempo constante; SÓ ENTÃO (6) estrutura, layout, caminho do dump, chaves de imagem e
 * forma canônica são validados e confiados. Nada de caminho, layout ou hash declarado é usado antes do passo 5. Qualquer falha lança Error `code: 'MANIFESTO_INVALIDO'`, mensagem fixa e `motivo` de um conjunto fechado, sem eco de valores.
 *
 * FONTE DE CHAVES: `criarFonteDeChaves({ origem, chaves:[{id, segredo, revogada?}] })`. Hoje SÓ a origem `TESTE_CONTROLADO` é produzível (e só com NODE_ENV=test): NÃO existe fonte operacional (cofre de segredos) nesta etapa, então um
 * manifesto autenticado por chave de teste nunca autoriza publicação nem restauração operacional. Os leitores e autenticadores só aceitam fontes produzidas por esta fábrica.
 *
 * LIMITES: o MAC prova posse do segredo, não a ORIGEM do conteúdo (quem tem a chave forja); segredo e rotação operacionais dependem de uma fonte que não existe aqui; a comparação não esconde o tamanho do MAC (fixo).
 */

const VERSAO = 2;
const LAYOUT = 1;
const ALGORITMO = 'HMAC-SHA256';
const ARQUIVO_DO_DUMP = 'dump/postgres.dump';
const DOMINIO = Buffer.from('SAFEWORK-BACKUP-MANIFESTO-V2\n', 'utf8');
const CHAVE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAC = /^[0-9a-f]{64}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const BYTES_MINIMOS_DO_SEGREDO = 32;
const ORIGENS_PRODUZIVEIS = new Set(['TESTE_CONTROLADO']);
const MOTIVOS = Object.freeze(['VERSAO_NAO_AUTENTICADA', 'AUTENTICACAO_AUSENTE', 'ALGORITMO_INVALIDO', 'CHAVE_INDISPONIVEL', 'CHAVE_REVOGADA', 'MAC_INVALIDO', 'ESTRUTURA_INVALIDA', 'LAYOUT_DESCONHECIDO', 'CAMINHO_DO_DUMP_INVALIDO', 'HASH_DIVERGENTE', 'FONTE_INVALIDA']);

const fontesProduzidas = new WeakSet();
const autenticacoesProduzidas = new WeakSet();

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const chavesExatas = (o, esperadas) => {
  const proprias = Reflect.ownKeys(o);
  return proprias.length === esperadas.length && proprias.every((k) => typeof k === 'string' && esperadas.includes(k));
};

function recusa(motivo) {
  const falha = new Error('manifesto de backup inválido');
  falha.code = 'MANIFESTO_INVALIDO';
  falha.motivo = motivo;
  return falha;
}
function fonteInvalida() {
  const falha = new TypeError('fonte de chaves inválida');
  falha.code = 'FONTE_INVALIDA';
  return falha;
}

function criarFonteDeChaves(opcoes) {
  if (!ehObjeto(opcoes) || !chavesExatas(opcoes, ['origem', 'chaves'])) throw fonteInvalida();
  const { origem, chaves } = opcoes;
  if (typeof origem !== 'string' || !ORIGENS_PRODUZIVEIS.has(origem)) throw fonteInvalida();
  if (origem === 'TESTE_CONTROLADO' && process.env.NODE_ENV !== 'test') throw fonteInvalida();
  if (!Array.isArray(chaves) || chaves.length === 0) throw fonteInvalida();
  const mapa = new Map();
  for (const item of chaves) {
    const proprias = ehObjeto(item) ? Reflect.ownKeys(item) : [];
    if (!ehObjeto(item) || !proprias.every((k) => ['id', 'segredo', 'revogada'].includes(k)) || !proprias.includes('id') || !proprias.includes('segredo')) throw fonteInvalida();
    if (typeof item.id !== 'string' || !CHAVE_ID.test(item.id) || mapa.has(item.id)) throw fonteInvalida();
    if (!(item.segredo instanceof Uint8Array) || item.segredo.length < BYTES_MINIMOS_DO_SEGREDO) throw fonteInvalida();
    if (proprias.includes('revogada') && typeof item.revogada !== 'boolean') throw fonteInvalida();
    mapa.set(item.id, { segredo: Buffer.from(item.segredo), revogada: item.revogada === true });
  }
  // O segredo nunca sai por propriedade enumerável nem por serialização: só `obter` o entrega (cópia nova).
  const fonte = Object.freeze({
    origem,
    obter(chaveId) {
      const item = typeof chaveId === 'string' ? mapa.get(chaveId) : undefined;
      if (item === undefined) return { situacao: 'INDISPONIVEL' };
      if (item.revogada) return { situacao: 'REVOGADA' };
      return { situacao: 'ATIVA', segredo: Buffer.from(item.segredo) };
    },
    toJSON() { return { origem }; },
  });
  fontesProduzidas.add(fonte);
  return fonte;
}
function bloqueada() {
  const falha = new Error('fonte operacional de chaves indisponível');
  falha.code = 'FONTE_OPERACIONAL_INDISPONIVEL';
  return falha;
}

/**
 * PROVEDORES OPERACIONAIS APROVADOS: lista fechada e VAZIA. Nenhum serviço de segredos foi escolhido ou configurado (decisão do responsável); enquanto a lista estiver vazia, `criarFonteOperacionalDeChaves` falha fechada e
 * nenhuma chave é considerada OPERACIONAL. A origem OPERACIONAL não é aceita por nenhuma outra fábrica nem declarada pelo chamador: só nasce aqui, para um provedor APROVADO neste código.
 */
const PROVEDORES_OPERACIONAIS_APROVADOS = Object.freeze([]);

/**
 * Contrato do PROVEDOR externo de chaves (síncrono, porque a leitura do manifesto é síncrona): `{ obter(chaveId) -> { situacao: 'ATIVA'|'REVOGADA'|'INDISPONIVEL', segredo? } }`. Identificação, disponibilidade, revogação e rotação são do provedor
 * (várias chaves com ids distintos; revogar = `REVOGADA`). A fonte FALHA FECHADA: exceção, resposta fora do contrato, segredo curto ou situação desconhecida viram INDISPONIVEL; nada é guardado em cache nem persistido; o segredo só é entregue por cópia.
 */
function fonteDoProvedor(origem, provedor) {
  if (!ehObjeto(provedor) || typeof provedor.obter !== 'function') throw fonteInvalida();
  const obter = provedor.obter;
  const fonte = Object.freeze({
    origem,
    obter(chaveId) {
      try {
        if (typeof chaveId !== 'string' || !CHAVE_ID.test(chaveId)) return { situacao: 'INDISPONIVEL' };
        const resposta = obter.call(provedor, chaveId);
        if (!ehObjeto(resposta)) return { situacao: 'INDISPONIVEL' };
        if (resposta.situacao === 'REVOGADA') return { situacao: 'REVOGADA' };
        if (resposta.situacao === 'ATIVA' && resposta.segredo instanceof Uint8Array && resposta.segredo.length >= BYTES_MINIMOS_DO_SEGREDO) return { situacao: 'ATIVA', segredo: Buffer.from(resposta.segredo) };
        return { situacao: 'INDISPONIVEL' };
      } catch {
        return { situacao: 'INDISPONIVEL' };
      }
    },
    toJSON() { return { origem }; },
  });
  fontesProduzidas.add(fonte);
  return fonte;
}

/**
 * Fonte DERIVADA e mais restrita: só uma fonte já produzida por esta fábrica pode ser restringida, e a ORIGEM é herdada (nunca declarada pelo chamador). `decidir(chaveId)` devolve 'PERMITIR' (a base responde),
 * 'REVOGADA' ou qualquer outra coisa (INDISPONIVEL). Exceção ou resposta fora do contrato = INDISPONIVEL. Usada pelo chaveiro: a política de uso por id (assinar, só verificar, revogada) é imposta antes de a base entregar o segredo.
 */
function restringirFonteDeChaves(fonte, decidir) {
  if (!ehFonteDeChaves(fonte) || typeof decidir !== 'function') throw fonteInvalida();
  const derivada = Object.freeze({
    origem: fonte.origem,
    obter(chaveId) {
      let decisao;
      try { decisao = decidir(chaveId); } catch { return { situacao: 'INDISPONIVEL' }; }
      if (decisao === 'PERMITIR') return fonte.obter(chaveId);
      if (decisao === 'REVOGADA') return { situacao: 'REVOGADA' };
      return { situacao: 'INDISPONIVEL' };
    },
    toJSON() { return { origem: fonte.origem }; },
  });
  fontesProduzidas.add(derivada);
  return derivada;
}

/** Fonte de TESTE sobre um provedor injetado (a mesma lógica de falha fechada que a operacional usará). */
function criarFonteDeProvedor(opcoes) {
  if (!ehObjeto(opcoes) || !chavesExatas(opcoes, ['origem', 'provedor']) || opcoes.origem !== 'TESTE_CONTROLADO' || process.env.NODE_ENV !== 'test') throw fonteInvalida();
  return fonteDoProvedor('TESTE_CONTROLADO', opcoes.provedor);
}

/** Fonte OPERACIONAL: BLOQUEADA enquanto não houver provedor aprovado em `PROVEDORES_OPERACIONAIS_APROVADOS`. */
function criarFonteOperacionalDeChaves(opcoes) {
  if (!ehObjeto(opcoes) || !chavesExatas(opcoes, ['provedor', 'adaptador']) || typeof opcoes.provedor !== 'string' || !PROVEDORES_OPERACIONAIS_APROVADOS.includes(opcoes.provedor)) throw bloqueada();
  return fonteDoProvedor('OPERACIONAL', opcoes.adaptador);
}

const ehAutenticacaoReconhecida = (v) => v !== null && typeof v === 'object' && autenticacoesProduzidas.has(v);
const ehFonteDeChaves = (v) => v !== null && typeof v === 'object' && fontesProduzidas.has(v);

const compararTexto = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Texto canônico do corpo SEM `mac` (a entrada do HMAC) e com `mac` (os bytes do manifesto). */
function serializar(corpo, mac) {
  const objeto = {
    arquivos: corpo.arquivos.map((a) => ({ bytes: a.bytes, chave: a.chave, sha256: a.sha256 })),
    autenticacao: mac === undefined ? { algoritmo: corpo.algoritmo, chaveId: corpo.chaveId } : { algoritmo: corpo.algoritmo, chaveId: corpo.chaveId, mac },
    banco: { nome: corpo.banco.nome, oid: corpo.banco.oid },
    conjuntoId: corpo.conjuntoId,
    dump: { arquivo: corpo.dump.arquivo, bytes: corpo.dump.bytes, sha256: corpo.dump.sha256 },
    layout: corpo.layout,
    versao: VERSAO,
  };
  return Buffer.from(JSON.stringify(objeto), 'utf8');
}
const calcularMac = (segredo, textoSemMac) => crypto.createHmac('sha256', segredo).update(DOMINIO).update(textoSemMac).digest('hex');

function iguaisEmTempoConstante(esperadoHex, recebidoHex) {
  const a = Buffer.from(esperadoHex, 'hex');
  const b = Buffer.from(recebidoHex, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function resultado(bytes, hash, manifesto, origemDaChave) {
  const identidade = Object.freeze({ conjuntoId: manifesto.conjuntoId, sha256Manifesto: hash });
  const interno = Buffer.from(bytes);
  const autenticacao = Object.freeze({ versao: VERSAO, autenticado: true, algoritmo: ALGORITMO, chaveId: manifesto.autenticacao.chaveId, origemDaChave });
  autenticacoesProduzidas.add(autenticacao); // só o leitor/autenticador produz evidência de autenticação RECONHECIDA; um literal ou clone não é reconhecido
  const saida = { manifesto, sha256: hash, identidade, autenticacao };
  Object.defineProperty(saida, 'bytes', { enumerable: true, get: () => Buffer.from(interno) });
  return Object.freeze(saida);
}
function congelar(manifesto) {
  for (const a of manifesto.arquivos) Object.freeze(a);
  Object.freeze(manifesto.arquivos);
  Object.freeze(manifesto.autenticacao);
  Object.freeze(manifesto.banco);
  Object.freeze(manifesto.dump);
  return Object.freeze(manifesto);
}

/**
 * Autentica um manifesto V1 já CONSTRUÍDO e validado (o resultado de `construirManifesto`): reaproveita todas as suas regras de plano, cópia e dump e produz o V2 (mesma forma de resultado, mais `autenticacao`).
 */
function criarAutenticador({ fonteDeChaves, chaveId }) {
  if (!ehFonteDeChaves(fonteDeChaves) || typeof chaveId !== 'string' || !CHAVE_ID.test(chaveId)) throw fonteInvalida();
  const consulta = fonteDeChaves.obter(chaveId);
  if (consulta.situacao !== 'ATIVA') throw fonteInvalida();
  function autenticar(construidoV1) {
    try {
      if (!ehObjeto(construidoV1) || !ehObjeto(construidoV1.manifesto) || construidoV1.manifesto.versao !== 1) throw recusa('ESTRUTURA_INVALIDA');
      const v1 = construidoV1.manifesto;
      // Revalida o V1 pelos bytes canônicos antes de promovê-lo (nunca confia só no objeto recebido).
      lerManifestoV1({ bytes: construidoV1.bytes, sha256: construidoV1.sha256 });
      const corpo = { arquivos: v1.arquivos, algoritmo: ALGORITMO, chaveId, banco: v1.banco, conjuntoId: v1.conjuntoId, dump: { arquivo: ARQUIVO_DO_DUMP, bytes: v1.dump.bytes, sha256: v1.dump.sha256 }, layout: LAYOUT };
      const atual = fonteDeChaves.obter(chaveId);
      if (atual.situacao !== 'ATIVA') throw recusa('CHAVE_INDISPONIVEL');
      const mac = calcularMac(atual.segredo, serializar(corpo));
      const bytes = serializar(corpo, mac);
      const hash = crypto.createHash('sha256').update(bytes).digest('hex');
      return resultado(bytes, hash, congelar(JSON.parse(bytes.toString('utf8'))), fonteDeChaves.origem);
    } catch {
      throw recusa('ESTRUTURA_INVALIDA');
    }
  }
  return Object.freeze({ autenticar });
}

function criarLeitorV2({ fonteDeChaves }) {
  if (!ehFonteDeChaves(fonteDeChaves)) throw fonteInvalida();
  return function lerManifestoV2(entrada) {
    // (1) forma da entrada e hash dos bytes
    if (!ehObjeto(entrada) || !chavesExatas(entrada, ['bytes', 'sha256'])) throw recusa('ESTRUTURA_INVALIDA');
    const { bytes, sha256 } = entrada;
    if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > 64 * 1024 * 1024 || typeof sha256 !== 'string' || !SHA256.test(sha256)) throw recusa('ESTRUTURA_INVALIDA');
    const copia = Buffer.from(bytes);
    if (crypto.createHash('sha256').update(copia).digest('hex') !== sha256) throw recusa('HASH_DIVERGENTE');
    // (2) JSON
    let objeto;
    try { objeto = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(copia)); } catch { throw recusa('ESTRUTURA_INVALIDA'); }
    if (!ehObjeto(objeto)) throw recusa('ESTRUTURA_INVALIDA');
    // (3) versão e bloco de autenticação, ANTES de qualquer outro campo
    if (objeto.versao === 1) throw recusa('VERSAO_NAO_AUTENTICADA');
    if (objeto.versao !== VERSAO) throw recusa('ESTRUTURA_INVALIDA');
    const auth = objeto.autenticacao;
    if (!ehObjeto(auth)) throw recusa('AUTENTICACAO_AUSENTE');
    if (!chavesExatas(auth, ['algoritmo', 'chaveId', 'mac']) || typeof auth.mac !== 'string' || !MAC.test(auth.mac) || typeof auth.chaveId !== 'string' || !CHAVE_ID.test(auth.chaveId)) throw recusa('AUTENTICACAO_AUSENTE');
    if (auth.algoritmo !== ALGORITMO) throw recusa('ALGORITMO_INVALIDO');
    // (4) chave
    let consulta;
    try { consulta = fonteDeChaves.obter(auth.chaveId); } catch { throw recusa('CHAVE_INDISPONIVEL'); }
    if (!ehObjeto(consulta) || consulta.situacao === 'INDISPONIVEL' || (consulta.situacao !== 'REVOGADA' && consulta.situacao !== 'ATIVA')) throw recusa('CHAVE_INDISPONIVEL');
    if (consulta.situacao === 'REVOGADA') throw recusa('CHAVE_REVOGADA');
    if (!(consulta.segredo instanceof Uint8Array) || consulta.segredo.length < BYTES_MINIMOS_DO_SEGREDO) throw recusa('CHAVE_INDISPONIVEL');
    // (5) MAC sobre o objeto sem `mac`, reserializado a partir do que foi lido (nenhum campo é interpretado antes da verificação)
    const semMac = { ...objeto, autenticacao: { algoritmo: auth.algoritmo, chaveId: auth.chaveId } };
    const esperado = calcularMac(consulta.segredo, Buffer.from(JSON.stringify(semMac), 'utf8'));
    if (!iguaisEmTempoConstante(esperado, auth.mac)) throw recusa('MAC_INVALIDO');
    // (6) só agora a estrutura é confiada
    return validarEstrutura(objeto, copia, sha256, fonteDeChaves.origem);
  };
}

const CHAVE_DE_IMAGEM = /^(?:[1-9][0-9]{0,14}|padrao)\/[0-9a-f]{64}\/(?:mestre\.(?:png|jpg|webp)|(?:exibicao|miniatura)\.webp)$/;
const OID = /^[0-9]{1,20}$/;
const CONTROLE = /[\u0000-\u001f\u007f-\u009f]/;
const textoLimpo = (v) => typeof v === 'string' && v.trim() !== '' && v.length <= 200 && !CONTROLE.test(v) && v.isWellFormed();
const inteiroPositivo = (v) => Number.isSafeInteger(v) && v >= 1;

function validarEstrutura(objeto, copia, hash, origemDaChave) {
  if (!chavesExatas(objeto, ['arquivos', 'autenticacao', 'banco', 'conjuntoId', 'dump', 'layout', 'versao'])) throw recusa('ESTRUTURA_INVALIDA');
  if (objeto.layout !== LAYOUT) throw recusa('LAYOUT_DESCONHECIDO');
  if (!textoLimpo(objeto.conjuntoId)) throw recusa('ESTRUTURA_INVALIDA');
  const { banco, dump } = objeto;
  if (!ehObjeto(banco) || !chavesExatas(banco, ['nome', 'oid']) || !textoLimpo(banco.nome) || typeof banco.oid !== 'string' || !OID.test(banco.oid)) throw recusa('ESTRUTURA_INVALIDA');
  if (!ehObjeto(dump) || !chavesExatas(dump, ['arquivo', 'bytes', 'sha256'])) throw recusa('ESTRUTURA_INVALIDA');
  if (dump.arquivo !== ARQUIVO_DO_DUMP) throw recusa('CAMINHO_DO_DUMP_INVALIDO');
  if (!inteiroPositivo(dump.bytes) || typeof dump.sha256 !== 'string' || !SHA256.test(dump.sha256)) throw recusa('ESTRUTURA_INVALIDA');
  if (!Array.isArray(objeto.arquivos)) throw recusa('ESTRUTURA_INVALIDA');
  let anterior = null;
  for (const item of objeto.arquivos) {
    if (!ehObjeto(item) || !chavesExatas(item, ['bytes', 'chave', 'sha256']) || typeof item.chave !== 'string' || !CHAVE_DE_IMAGEM.test(item.chave) || typeof item.sha256 !== 'string' || !SHA256.test(item.sha256) || !inteiroPositivo(item.bytes)) throw recusa('ESTRUTURA_INVALIDA');
    if (anterior !== null && compararTexto(anterior, item.chave) >= 0) throw recusa('ESTRUTURA_INVALIDA');
    anterior = item.chave;
  }
  const canonico = serializar({ arquivos: objeto.arquivos, algoritmo: objeto.autenticacao.algoritmo, chaveId: objeto.autenticacao.chaveId, banco, conjuntoId: objeto.conjuntoId, dump, layout: objeto.layout }, objeto.autenticacao.mac);
  if (!canonico.equals(copia)) throw recusa('ESTRUTURA_INVALIDA');
  return resultado(copia, hash, congelar(JSON.parse(canonico.toString('utf8'))), origemDaChave);
}

/** Selagem do pipeline do backup com manifesto V2: o mesmo `selar`/`verificar` da selagem, lendo SÓ V2 autenticado, mais o `autenticar` que a composição aplica ao manifesto construído. */
function criarSelagemAutenticada({ fonteDeChaves, chaveId, operacoes }) {
  const leitor = criarLeitorV2({ fonteDeChaves });
  const { autenticar } = criarAutenticador({ fonteDeChaves, chaveId });
  const base = criarSelagem(operacoes === undefined ? { leitor } : { leitor, operacoes });
  return Object.freeze({ selar: base.selar, verificar: base.verificar, autenticar });
}

module.exports = { ehAutenticacaoReconhecida, restringirFonteDeChaves, criarFonteDeProvedor, criarFonteOperacionalDeChaves, PROVEDORES_OPERACIONAIS_APROVADOS, criarSelagemAutenticada, criarFonteDeChaves, ehFonteDeChaves, criarAutenticador, criarLeitorV2, VERSAO, LAYOUT, ALGORITMO, ARQUIVO_DO_DUMP, MOTIVOS };
