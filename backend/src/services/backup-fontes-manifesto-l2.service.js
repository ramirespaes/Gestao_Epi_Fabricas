'use strict';

const crypto = require('node:crypto');
const { criarLeitorV2: criarLeitorL1, ehFonteDeChaves, ARQUIVO_DO_DUMP } = require('./imagem-backup-manifesto-autenticado.service');
const R = require('./backup-fontes-regras.service');
const { validarBlocoPostgres, blocoN0, CHAVES_DO_BLOCO, NIVEIS } = require('./backup-fontes-postgres-cobertura.service');

/**
 * D-ORF-6, P5 (R2 seção 8 — M2; adendo P0-R2 seção 6 — DEC-6; junção J1 com o contrato `cobertura.postgres` v1 do P4): MANIFESTO EVOLUTIVO `versao: 2`, `layout: 2`.
 * Camada ADITIVA: o manifesto V1 e o V2/layout 1 (`imagem-backup-manifesto*.service.js`) não são alterados; o leitor daqui lê os dois layouts e NORMALIZA o
 * layout 1 para a mesma forma (`fontes` com a fonte virtual `imagens`, M2-8), de modo que a restauração tenha um caminho único.
 *
 * FORMA CANÔNICA (JSON compacto UTF-8, chaves em ordem lexicográfica em TODOS os níveis, sem BOM):
 *   { autenticacao:{algoritmo,chaveId,mac}, banco:{nome,oid},
 *     cobertura:{ catalogo:{versao,sha256,fontes:[projeção de P1]}, declaracao, excluidas:[{fonteId,decisao,relevancia}], motivos:[...],
 *                 pendencias:[{fonteId,codigo}], postgres:<bloco v1 do P4>, universo:{raizesConfiguradas,raizesSemRegistro}, verificacoes:{fonteId:'APROVADO'|'REPROVADO'} },
 *     conjuntoId, dump:{arquivo:'dump/postgres.dump',bytes,sha256},
 *     fontes:[{id,versaoContrato,arquivos:[{bytes,chave,sha256}],total:{arquivos,bytes}}], layout:2, versao:2 }
 *   Nomes de campo seguem a R2 8.2 com a direção DEC-6 (`cobertura.catalogo` por valor, no lugar de `registro`) e `verificacoes` (resultado dinâmico por
 *   fonte no momento do backup, necessário para recomputar a declaração): confirmação formal em D-F12.
 *
 * REGRAS: MAC HMAC-SHA256 sobre o DOMÍNIO PRÓPRIO `SAFEWORK-BACKUP-MANIFESTO-V2-L2\n` + corpo canônico sem `mac` (M2-1, M2-2: um MAC de L1 nunca vale em L2 e
 * vice-versa); algoritmo fechado (M2-3); chave só pelo chaveiro/fonte injetada (M2-4); nenhum caminho, credencial ou conteúdo (M2-6); caminho no pacote
 * `arquivos/<fonteId>/<chave>` (M2-7); conjunto exato e SHA-256 por arquivo (M2-9); `cobertura.catalogo.fontes` lista TODAS as fontes do catálogo (M2-10);
 * `declaracao` é função pura dos campos autenticados e é RECOMPUTADA na leitura (M2-11: divergência = `COBERTURA_INCOERENTE`); texto humano sempre relativo
 * (M2-12); `catalogo.sha256` = hash do catálogo completo (M2-13); excluídas sempre listadas (M2-14). Comportamento IDENTIFICADO, nunca embutido: `formatoChaveId`
 * e `verificadorId` precisam existir no conjunto fechado do código (R-6.2/R-6.3: `COMPORTAMENTO_NAO_SUPORTADO`); o catálogo atual só gera informação (R-6.4).
 *
 * LEITURA (8.7): hash → JSON → `versao` 2 → `layout` aceito e ≥ `layoutMinimo` da operação (anti-rebaixamento, antes de qualquer confiança) → bloco de
 * autenticação exato → chave → MAC em tempo constante → SÓ ENTÃO estrutura completa com conjunto EXATO de chaves em todo nível (`CAMPO_DESCONHECIDO`/
 * `CAMPO_AUSENTE`), limites, formatos, ordem canônica (bytes idênticos: chave JSON duplicada ou ordem diferente é recusada) e coerência da cobertura.
 * LIMITES: 64 MiB; ≤ 16 fontes; ≤ 200 000 arquivos por fonte e ≤ 400 000 no total; textos ≤ 200; projeção do catálogo ≤ 256 KiB.
 *
 * O que NÃO está aqui: gravação em disco (selagem/publicação, módulos históricos), registro durável do SHA-256 na publicação (8.6, [NV], P6/P10),
 * criptografia (seção 13), prova de recuperabilidade.
 */

const VERSAO = 2;
const LAYOUT = 2;
const ALGORITMO = 'HMAC-SHA256';
const DOMINIO = Buffer.from('SAFEWORK-BACKUP-MANIFESTO-V2-L2\n', 'utf8');
const LAYOUTS_ACEITOS = Object.freeze([1, 2]);
const DECLARACOES = Object.freeze(['COMPLETA', 'PARCIAL', 'NAO_COMPROVADA']);
const RESULTADOS_DINAMICOS = Object.freeze(['APROVADO', 'REPROVADO']);
const LIMITES = Object.freeze({ bytesDoManifesto: 64 * 1024 * 1024, fontes: R.LIMITE_DE_FONTES, arquivosPorFonte: 200000, arquivosTotal: 400000, texto: 200, projecaoBytes: 256 * 1024, motivos: 200 });
const MOTIVOS = Object.freeze(['HASH_DIVERGENTE', 'ESTRUTURA_INVALIDA', 'VERSAO_NAO_AUTENTICADA', 'VERSAO_DESCONHECIDA', 'LAYOUT_DESCONHECIDO', 'LAYOUT_INSUFICIENTE', 'AUTENTICACAO_AUSENTE',
  'ALGORITMO_INVALIDO', 'CHAVE_INDISPONIVEL', 'CHAVE_REVOGADA', 'MAC_INVALIDO', 'CAMPO_DESCONHECIDO', 'CAMPO_AUSENTE', 'LIMITE_EXCEDIDO', 'CAMINHO_DO_DUMP_INVALIDO',
  'COMPORTAMENTO_NAO_SUPORTADO', 'FONTE_NAO_CATALOGADA', 'FONTE_INCLUIDA_AUSENTE', 'CHAVE_DE_ARQUIVO_INVALIDA', 'COBERTURA_INCOERENTE', 'POSTGRES_INVALIDO', 'FONTE_INVALIDA']);

const CHAVES = Object.freeze({
  raiz: ['autenticacao', 'banco', 'cobertura', 'conjuntoId', 'dump', 'fontes', 'layout', 'versao'],
  autenticacao: ['algoritmo', 'chaveId', 'mac'],
  banco: ['nome', 'oid'],
  cobertura: ['catalogo', 'declaracao', 'excluidas', 'motivos', 'pendencias', 'postgres', 'universo', 'verificacoes'],
  catalogo: ['fontes', 'sha256', 'versao'],
  fonteDoCatalogo: ['classe', 'escopo', 'estadoCobertura', 'formatoChaveId', 'id', 'incluida', 'motivo', 'referencias', 'tipo', 'verificadorId', 'versaoContrato'],
  escopo: ['regraEmpresa', 'tipo'],
  referencia: ['colunas', 'tabela'],
  excluida: ['decisao', 'fonteId', 'relevancia'],
  pendencia: ['codigo', 'fonteId'],
  universo: ['raizesConfiguradas', 'raizesSemRegistro'],
  dump: ['arquivo', 'bytes', 'sha256'],
  fonte: ['arquivos', 'id', 'total', 'versaoContrato'],
  arquivo: ['bytes', 'chave', 'sha256'],
  total: ['arquivos', 'bytes'],
});

const SHA256 = /^[0-9a-f]{64}$/;
const OID = /^[0-9]{1,20}$/;
const CHAVE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ID = /^[a-z0-9-]{1,40}$/;
// Códigos simples (`NAO_COMPROVADA`) ou compostos com identificador (`PENDENCIA:email-arquivo`, `COMPONENTE_PARCIAL:verificador`).
const CODIGO = /^[A-Z][A-Z0-9_]{1,60}(?::[A-Za-z0-9_.-]{1,60})?$/;
const VARIAVEL = /^[A-Z][A-Z0-9_]{2,63}$/;
const IDENTIFICADOR_SQL = /^[a-z][a-z0-9_]{0,62}$/;
const DECISAO = /^(?:D-F(?:[1-9]|1[0-7])|P0-CF-[1-3])$/;
const CONTROLE = /[\u0000-\u001f\u007f-\u009f]/;

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const inteiroPositivo = (v) => Number.isSafeInteger(v) && v >= 1;
const inteiroNaoNegativo = (v) => Number.isSafeInteger(v) && v >= 0;
const textoLimpo = (v) => typeof v === 'string' && v.trim() !== '' && v.length <= LIMITES.texto && !CONTROLE.test(v) && v.isWellFormed();
const compararTexto = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const chavesOrdenadas = (o) => Object.keys(o).sort(compararTexto);

function recusa(motivo) {
  const falha = new Error('manifesto de backup inválido');
  falha.code = 'MANIFESTO_INVALIDO';
  falha.motivo = motivo;
  return falha;
}
function entradaInvalida(motivo) {
  const falha = new TypeError('entrada do manifesto inválida');
  falha.code = 'ENTRADA_INVALIDA';
  falha.motivo = motivo;
  return falha;
}

/** Conjunto EXATO de chaves (falha fechada nos dois sentidos). */
function exigirChaves(objeto, esperadas, motivoAusente = 'CAMPO_AUSENTE') {
  if (!ehObjeto(objeto)) throw recusa('ESTRUTURA_INVALIDA');
  const proprias = Reflect.ownKeys(objeto);
  for (const k of proprias) if (typeof k !== 'string' || !esperadas.includes(k)) throw recusa('CAMPO_DESCONHECIDO');
  for (const k of esperadas) if (!proprias.includes(k)) throw recusa(motivoAusente);
}

/** Serialização canônica: chaves ordenadas em todos os níveis; só null, boolean, inteiro seguro, string, array e objeto plano. */
function ordenarProfundo(valor) {
  if (valor === null || typeof valor === 'boolean' || typeof valor === 'string') return valor;
  if (typeof valor === 'number') { if (!Number.isSafeInteger(valor)) throw recusa('ESTRUTURA_INVALIDA'); return valor; }
  if (Array.isArray(valor)) return valor.map(ordenarProfundo);
  if (ehObjeto(valor)) { const saida = {}; for (const k of chavesOrdenadas(valor)) saida[k] = ordenarProfundo(valor[k]); return saida; }
  throw recusa('ESTRUTURA_INVALIDA');
}
const serializarCanonico = (valor) => Buffer.from(JSON.stringify(ordenarProfundo(valor)), 'utf8');
const calcularMac = (segredo, corpoSemMac) => crypto.createHmac('sha256', segredo).update(DOMINIO).update(corpoSemMac).digest('hex');
function iguaisEmTempoConstante(esperadoHex, recebidoHex) {
  const a = Buffer.from(esperadoHex, 'hex');
  const b = Buffer.from(recebidoHex, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function congelarProfundo(valor) {
  if (Array.isArray(valor)) { valor.forEach(congelarProfundo); return Object.freeze(valor); }
  if (ehObjeto(valor)) { for (const k of Object.keys(valor)) congelarProfundo(valor[k]); return Object.freeze(valor); }
  return valor;
}

const COBERTAS = new Set(['PROTEGIDA_COMPROVADA', 'DERIVAVEL_COMPROVADA']);
const PENDENTES = new Set(['PENDENTE_DECISAO', 'CANDIDATA', 'IMPLEMENTACAO_PARCIAL', 'IMPLEMENTADA_NAO_COMPROVADA', 'SUSPENSA']);
const NIVEIS_SUFICIENTES = new Set(['N1', 'N2a', 'N2b', 'N3']);

/**
 * Declaração de cobertura como FUNÇÃO PURA dos campos autenticados do manifesto (M2-11), espelhando `avaliarCobertura` das regras do catálogo, mas sem
 * depender do catálogo do código (R-6.1). O escritor exige igualdade com as regras; o leitor recomputa e compara com o declarado.
 */
function declararCobertura({ catalogo, excluidas, universo, postgres, verificacoes }) {
  const motivos = new Set();
  let efetivas = 0;
  for (const f of catalogo.fontes) {
    if (COBERTAS.has(f.estadoCobertura)) {
      const dinamica = Object.hasOwn(verificacoes, f.id) ? verificacoes[f.id] : undefined;
      if (dinamica === 'APROVADO') {
        if (f.tipo === 'POSTGRES' && !NIVEIS_SUFICIENTES.has(postgres.nivelAtingido)) motivos.add(`NIVEL_POSTGRES_INSUFICIENTE:${f.id}`);
        else efetivas += 1;
      } else motivos.add(`${dinamica === 'REPROVADO' ? 'DINAMICA_REPROVADA' : 'DINAMICA_AUSENTE'}:${f.id}`);
    } else if (PENDENTES.has(f.estadoCobertura)) motivos.add(`PENDENCIA:${f.id}`);
  }
  const estadoDe = new Map(catalogo.fontes.map((f) => [f.id, f.estadoCobertura]));
  for (const e of excluidas) if (e.relevancia === 'PERSISTENTE_RELEVANTE' && estadoDe.get(e.fonteId) === 'DECLARADA_EXCLUIDA') motivos.add(`EXCLUSAO_RELEVANTE:${e.fonteId}`);
  if (universo.raizesConfiguradas === null) motivos.add('UNIVERSO_NAO_VERIFICADO');
  else if (universo.raizesSemRegistro.length > 0) motivos.add('RAIZ_SEM_REGISTRO');
  if (!catalogo.fontes.some((f) => f.tipo === 'POSTGRES' && f.classe === 'PROTEGIDA')) motivos.add('FONTE_RELEVANTE_AUSENTE');
  if (efetivas === 0) { motivos.add('NENHUMA_FONTE_COMPROVADA'); return Object.freeze({ declaracao: 'NAO_COMPROVADA', motivos: Object.freeze([...motivos].sort()) }); }
  return Object.freeze({ declaracao: motivos.size === 0 ? 'COMPLETA' : 'PARCIAL', motivos: Object.freeze([...motivos].sort()) });
}

/** Texto humano SEMPRE relativo (M2-12). */
function descreverDeclaracao(declaracao) {
  if (!DECLARACOES.includes(declaracao)) throw entradaInvalida('DECLARACAO_INVALIDA');
  const base = 'em relação às fontes registradas e às guardas vigentes no momento do backup';
  if (declaracao === 'COMPLETA') return `cobertura completa ${base}; não é prova de recuperabilidade`;
  if (declaracao === 'PARCIAL') return `cobertura parcial ${base}`;
  return `cobertura não comprovada ${base}`;
}

// ----------------------------------------------------------------------------------------------------------------------------------- validação da estrutura L2
function validarFonteDoCatalogo(f) {
  exigirChaves(f, CHAVES.fonteDoCatalogo);
  if (!ID.test(f.id) || !R.TIPOS.includes(f.tipo) || !(f.classe === null || R.CLASSES.includes(f.classe)) || typeof f.estadoCobertura !== 'string' || !CODIGO.test(f.estadoCobertura)) throw recusa('ESTRUTURA_INVALIDA');
  if (typeof f.incluida !== 'boolean' || !(f.motivo === null || (typeof f.motivo === 'string' && CODIGO.test(f.motivo))) || !inteiroPositivo(f.versaoContrato)) throw recusa('ESTRUTURA_INVALIDA');
  if (!(f.formatoChaveId === null || typeof f.formatoChaveId === 'string') || !(f.verificadorId === null || typeof f.verificadorId === 'string')) throw recusa('ESTRUTURA_INVALIDA');
  // Comportamento identificado: identificador desconhecido para ESTE código é falha fechada (R-6.2/R-6.3).
  if (f.formatoChaveId !== null && !Object.hasOwn(R.FORMATOS_DE_CHAVE, f.formatoChaveId)) throw recusa('COMPORTAMENTO_NAO_SUPORTADO');
  if (f.verificadorId !== null && !R.VERIFICADORES.includes(f.verificadorId)) throw recusa('COMPORTAMENTO_NAO_SUPORTADO');
  exigirChaves(f.escopo, CHAVES.escopo);
  if (!R.ESCOPOS.includes(f.escopo.tipo) || !(f.escopo.regraEmpresa === null || R.REGRAS_DE_EMPRESA.includes(f.escopo.regraEmpresa))) throw recusa('ESTRUTURA_INVALIDA');
  if (!Array.isArray(f.referencias) || f.referencias.length > 50) throw recusa('ESTRUTURA_INVALIDA');
  for (const r of f.referencias) {
    exigirChaves(r, CHAVES.referencia);
    if (!IDENTIFICADOR_SQL.test(r.tabela) || !Array.isArray(r.colunas) || r.colunas.length > 100 || !r.colunas.every((c) => IDENTIFICADOR_SQL.test(c))) throw recusa('ESTRUTURA_INVALIDA');
  }
  if (f.incluida && !COBERTAS.has(f.estadoCobertura)) throw recusa('COBERTURA_INCOERENTE');
}

function validarCobertura(c) {
  exigirChaves(c, CHAVES.cobertura);
  exigirChaves(c.catalogo, CHAVES.catalogo);
  if (!inteiroPositivo(c.catalogo.versao) || !SHA256.test(c.catalogo.sha256) || !Array.isArray(c.catalogo.fontes) || c.catalogo.fontes.length > LIMITES.fontes) throw recusa('ESTRUTURA_INVALIDA');
  if (serializarCanonico(c.catalogo).length > LIMITES.projecaoBytes) throw recusa('LIMITE_EXCEDIDO');
  let anterior = null;
  for (const f of c.catalogo.fontes) {
    validarFonteDoCatalogo(f);
    if (anterior !== null && compararTexto(anterior, f.id) >= 0) throw recusa('ESTRUTURA_INVALIDA');
    anterior = f.id;
  }
  const ids = new Set(c.catalogo.fontes.map((f) => f.id));
  if (!DECLARACOES.includes(c.declaracao)) throw recusa('ESTRUTURA_INVALIDA');
  if (!Array.isArray(c.motivos) || c.motivos.length > LIMITES.motivos || !c.motivos.every((m) => typeof m === 'string' && CODIGO.test(m))) throw recusa('ESTRUTURA_INVALIDA');
  if (!Array.isArray(c.excluidas) || !Array.isArray(c.pendencias) || c.excluidas.length > LIMITES.fontes || c.pendencias.length > LIMITES.fontes * 4) throw recusa('ESTRUTURA_INVALIDA');
  for (const e of c.excluidas) {
    exigirChaves(e, CHAVES.excluida);
    if (!ids.has(e.fonteId) || !(e.decisao === null || DECISAO.test(e.decisao)) || !R.RELEVANCIAS.includes(e.relevancia)) throw recusa('ESTRUTURA_INVALIDA');
  }
  for (const p of c.pendencias) {
    exigirChaves(p, CHAVES.pendencia);
    if (!ids.has(p.fonteId) || typeof p.codigo !== 'string' || !CODIGO.test(p.codigo)) throw recusa('ESTRUTURA_INVALIDA');
  }
  exigirChaves(c.universo, CHAVES.universo);
  const { raizesConfiguradas, raizesSemRegistro } = c.universo;
  const listaDeVariaveis = (l) => Array.isArray(l) && l.length <= 200 && l.every((n) => typeof n === 'string' && VARIAVEL.test(n));
  if (!(raizesConfiguradas === null || listaDeVariaveis(raizesConfiguradas)) || !listaDeVariaveis(raizesSemRegistro)) throw recusa('ESTRUTURA_INVALIDA');
  if (raizesConfiguradas === null && raizesSemRegistro.length > 0) throw recusa('ESTRUTURA_INVALIDA');
  if (!ehObjeto(c.verificacoes)) throw recusa('ESTRUTURA_INVALIDA');
  for (const [k, v] of Object.entries(c.verificacoes)) if (!ids.has(k) || !RESULTADOS_DINAMICOS.includes(v)) throw recusa('ESTRUTURA_INVALIDA');
  exigirChaves(c.postgres, CHAVES_DO_BLOCO, 'POSTGRES_INVALIDO');
  const bloco = validarBlocoPostgres(c.postgres);
  if (!bloco.valido || !NIVEIS.includes(c.postgres.nivelAtingido)) throw recusa('POSTGRES_INVALIDO');
  // (8.7 passo 8) recompute: a declaração gravada tem de ser exatamente a função pura dos campos autenticados
  const recomputada = declararCobertura({ catalogo: c.catalogo, excluidas: c.excluidas, universo: c.universo, postgres: c.postgres, verificacoes: c.verificacoes });
  if (recomputada.declaracao !== c.declaracao || recomputada.motivos.length !== c.motivos.length || recomputada.motivos.some((m, i) => m !== c.motivos[i])) throw recusa('COBERTURA_INCOERENTE');
  return ids;
}

function validarFontesDeDados(fontes, catalogo) {
  if (!Array.isArray(fontes) || fontes.length > LIMITES.fontes) throw recusa(Array.isArray(fontes) ? 'LIMITE_EXCEDIDO' : 'ESTRUTURA_INVALIDA');
  const porId = new Map(catalogo.fontes.map((f) => [f.id, f]));
  let total = 0;
  let anterior = null;
  const presentes = new Set();
  for (const fonte of fontes) {
    exigirChaves(fonte, CHAVES.fonte);
    if (!ID.test(fonte.id) || presentes.has(fonte.id)) throw recusa('ESTRUTURA_INVALIDA');
    if (anterior !== null && compararTexto(anterior, fonte.id) >= 0) throw recusa('ESTRUTURA_INVALIDA');
    anterior = fonte.id;
    presentes.add(fonte.id);
    const registrada = porId.get(fonte.id);
    if (registrada === undefined) throw recusa('FONTE_NAO_CATALOGADA');
    // Só fonte ARQUIVOS com implementação (classe PROTEGIDA) e formato de chave conhecido pode trazer dados no pacote.
    if (registrada.tipo !== 'ARQUIVOS' || registrada.classe !== 'PROTEGIDA' || registrada.formatoChaveId === null) throw recusa('FONTE_INVALIDA');
    if (!inteiroPositivo(fonte.versaoContrato) || fonte.versaoContrato !== registrada.versaoContrato) throw recusa('ESTRUTURA_INVALIDA');
    const formato = R.FORMATOS_DE_CHAVE[registrada.formatoChaveId];
    if (!Array.isArray(fonte.arquivos)) throw recusa('ESTRUTURA_INVALIDA');
    if (fonte.arquivos.length > LIMITES.arquivosPorFonte) throw recusa('LIMITE_EXCEDIDO');
    total += fonte.arquivos.length;
    if (total > LIMITES.arquivosTotal) throw recusa('LIMITE_EXCEDIDO');
    let bytes = 0;
    let chaveAnterior = null;
    for (const a of fonte.arquivos) {
      exigirChaves(a, CHAVES.arquivo);
      if (typeof a.chave !== 'string' || a.chave.length > 1024 || !formato.test(a.chave)) throw recusa('CHAVE_DE_ARQUIVO_INVALIDA');
      if (!SHA256.test(a.sha256) || !inteiroPositivo(a.bytes)) throw recusa('ESTRUTURA_INVALIDA');
      if (chaveAnterior !== null && compararTexto(chaveAnterior, a.chave) >= 0) throw recusa('ESTRUTURA_INVALIDA');
      chaveAnterior = a.chave;
      bytes += a.bytes;
      if (!Number.isSafeInteger(bytes)) throw recusa('LIMITE_EXCEDIDO');
    }
    exigirChaves(fonte.total, CHAVES.total);
    if (fonte.total.arquivos !== fonte.arquivos.length || fonte.total.bytes !== bytes) throw recusa('ESTRUTURA_INVALIDA');
  }
  for (const f of catalogo.fontes) if (f.incluida && f.tipo === 'ARQUIVOS' && !presentes.has(f.id)) throw recusa('FONTE_INCLUIDA_AUSENTE');
}

function validarEstruturaL2(objeto) {
  exigirChaves(objeto, CHAVES.raiz);
  exigirChaves(objeto.autenticacao, CHAVES.autenticacao);
  exigirChaves(objeto.banco, CHAVES.banco);
  if (!textoLimpo(objeto.banco.nome) || typeof objeto.banco.oid !== 'string' || !OID.test(objeto.banco.oid)) throw recusa('ESTRUTURA_INVALIDA');
  if (!textoLimpo(objeto.conjuntoId)) throw recusa('ESTRUTURA_INVALIDA');
  exigirChaves(objeto.dump, CHAVES.dump);
  if (objeto.dump.arquivo !== ARQUIVO_DO_DUMP) throw recusa('CAMINHO_DO_DUMP_INVALIDO');
  if (!inteiroPositivo(objeto.dump.bytes) || !SHA256.test(objeto.dump.sha256)) throw recusa('ESTRUTURA_INVALIDA');
  validarCobertura(objeto.cobertura);
  validarFontesDeDados(objeto.fontes, objeto.cobertura.catalogo);
}

// ------------------------------------------------------------------------------------------------------------------------------------------------- resultado
const resultadosProduzidos = new WeakSet();
const caminhoL2 = (fonteId, chave) => `arquivos/${fonteId}/${chave}`;
const caminhoL1 = (fonteId, chave) => (fonteId === 'imagens' ? `imagens/${chave}` : null);

function produzirResultado({ bytes, sha256, manifesto, layout, fontes, cobertura, postgres, origemDaChave, avisos, catalogoAtualDiverge }) {
  const interno = Buffer.from(bytes);
  const identidade = Object.freeze({ conjuntoId: manifesto.conjuntoId, sha256Manifesto: sha256 });
  const autenticacao = Object.freeze({ versao: VERSAO, layout, autenticado: true, algoritmo: ALGORITMO, chaveId: manifesto.autenticacao.chaveId, origemDaChave });
  const caminho = layout === LAYOUT ? caminhoL2 : caminhoL1;
  const saida = {
    manifesto, sha256, identidade, autenticacao, layout, fontes, cobertura, postgres,
    avisos: Object.freeze([...avisos].sort()),
    catalogoAtualDiverge,
    caminhoDe(fonteId, chave) {
      const fonte = fontes.find((f) => f.id === fonteId);
      if (fonte === undefined || !fonte.arquivos.some((a) => a.chave === chave)) return null;
      return caminho(fonteId, chave);
    },
  };
  Object.defineProperty(saida, 'bytes', { enumerable: true, get: () => Buffer.from(interno) });
  Object.freeze(saida);
  resultadosProduzidos.add(saida);
  return saida;
}
const ehResultadoDoLeitor = (v) => v !== null && typeof v === 'object' && resultadosProduzidos.has(v);

// -------------------------------------------------------------------------------------------------------------------------------------------------- escritor
/**
 * `criarEscritorL2({ fonteDeChaves, chaveId })` -> `{ construir(entrada) }`. Entrada: `{ banco:{nome,oid}, conjuntoId, dump:{bytes,sha256}, catalogo (completo, de P1),
 * fontes:[{id, arquivos:[{chave,sha256,bytes}]}], contexto:{raizesConfiguradas|null, resultadosDinamicos}, postgres: bloco v1 do P4 (ou `blocoN0()`) }`.
 * A declaração vem das regras do catálogo (`avaliarCobertura`) E da função pura sobre a projeção; as duas têm de coincidir.
 */
function criarEscritorL2({ fonteDeChaves, chaveId }) {
  if (!ehFonteDeChaves(fonteDeChaves) || typeof chaveId !== 'string' || !CHAVE_ID.test(chaveId)) throw entradaInvalida('FONTE_INVALIDA');
  if (fonteDeChaves.obter(chaveId).situacao !== 'ATIVA') throw entradaInvalida('CHAVE_INDISPONIVEL');

  function construir(entrada) {
    if (!ehObjeto(entrada)) throw entradaInvalida('ENTRADA');
    const esperadas = ['banco', 'conjuntoId', 'dump', 'catalogo', 'fontes', 'contexto', 'postgres'];
    const proprias = Reflect.ownKeys(entrada);
    if (proprias.length !== esperadas.length || !proprias.every((k) => esperadas.includes(k))) throw entradaInvalida('ENTRADA');
    const { banco, conjuntoId, dump, catalogo, fontes, contexto, postgres } = entrada;
    if (!R.validarCatalogo(catalogo).valido) throw entradaInvalida('CATALOGO_INVALIDO');
    if (!ehObjeto(contexto) || !Reflect.ownKeys(contexto).every((k) => k === 'raizesConfiguradas' || k === 'resultadosDinamicos')) throw entradaInvalida('CONTEXTO_INVALIDO');
    const raizesConfiguradas = contexto.raizesConfiguradas === undefined ? null : contexto.raizesConfiguradas;
    const resultadosDinamicos = contexto.resultadosDinamicos === undefined ? {} : contexto.resultadosDinamicos;
    if (!ehObjeto(resultadosDinamicos)) throw entradaInvalida('CONTEXTO_INVALIDO');
    if (!ehObjeto(dump) || !Reflect.ownKeys(dump).every((k) => k === 'bytes' || k === 'sha256')) throw entradaInvalida('DUMP_INVALIDO');
    if (!Array.isArray(fontes)) throw entradaInvalida('FONTES_INVALIDAS');

    const projecao = R.projetarParaManifesto(catalogo);
    const porId = new Map(catalogo.fontes.map((f) => [f.id, f]));
    const registradas = new Set(catalogo.fontes.map((f) => f.raiz.variavel).filter((v) => v !== null));
    const universo = { raizesConfiguradas, raizesSemRegistro: raizesConfiguradas === null ? [] : raizesConfiguradas.filter((n) => !registradas.has(n)).sort() };
    const excluidas = [...catalogo.fontes].filter((f) => f.classe === 'EXCLUIDA').sort((a, b) => compararTexto(a.id, b.id)).map((f) => ({ fonteId: f.id, decisao: f.decisaoRef ?? null, relevancia: f.relevancia }));
    const pendencias = R.pendenciasDeCobertura(catalogo).map((p) => ({ fonteId: p.fonteId, codigo: p.codigo }));
    const verificacoes = {};
    for (const k of Object.keys(resultadosDinamicos).sort(compararTexto)) { if (!porId.has(k)) throw entradaInvalida('CONTEXTO_INVALIDO'); verificacoes[k] = resultadosDinamicos[k]; }
    const contextoDasRegras = { ...(raizesConfiguradas === null ? {} : { raizesConfiguradas }), nivelPostgres: postgres?.nivelAtingido, resultadosDinamicos };
    const pelasRegras = R.avaliarCobertura(catalogo, contextoDasRegras);
    if (pelasRegras.motivos.includes('CONTEXTO_INVALIDO') || pelasRegras.motivos.includes('CATALOGO_INVALIDO')) throw entradaInvalida('CONTEXTO_INVALIDO');

    const fontesDeDados = [...fontes].map((f) => {
      if (!ehObjeto(f) || !Reflect.ownKeys(f).every((k) => k === 'id' || k === 'arquivos') || !Array.isArray(f.arquivos)) throw entradaInvalida('FONTES_INVALIDAS');
      const registrada = porId.get(f.id);
      if (registrada === undefined) throw entradaInvalida('FONTE_NAO_CATALOGADA');
      const arquivos = [...f.arquivos].map((a) => {
        if (!ehObjeto(a) || !Reflect.ownKeys(a).every((k) => ['chave', 'sha256', 'bytes'].includes(k))) throw entradaInvalida('FONTES_INVALIDAS');
        return { bytes: a.bytes, chave: a.chave, sha256: a.sha256 };
      }).sort((a, b) => compararTexto(a.chave, b.chave));
      return { arquivos, id: f.id, total: { arquivos: arquivos.length, bytes: arquivos.reduce((s, a) => s + a.bytes, 0) }, versaoContrato: registrada.versaoContrato };
    }).sort((a, b) => compararTexto(a.id, b.id));

    const cobertura = {
      catalogo: projecao, declaracao: pelasRegras.teto, excluidas, motivos: [...pelasRegras.motivos], pendencias, postgres, universo, verificacoes,
    };
    const corpo = {
      autenticacao: { algoritmo: ALGORITMO, chaveId },
      banco: { nome: banco?.nome, oid: banco?.oid },
      cobertura,
      conjuntoId,
      dump: { arquivo: ARQUIVO_DO_DUMP, bytes: dump.bytes, sha256: dump.sha256 },
      fontes: fontesDeDados,
      layout: LAYOUT,
      versao: VERSAO,
    };
    // Toda a validação de leitura roda sobre o próprio corpo ANTES de assinar: o escritor nunca produz o que o leitor recusaria.
    let semMac;
    try {
      semMac = serializarCanonico(corpo);
      validarEstruturaL2({ ...JSON.parse(semMac.toString('utf8')), autenticacao: { algoritmo: ALGORITMO, chaveId, mac: '0'.repeat(64) } });
    } catch (falha) {
      throw entradaInvalida(falha.motivo ?? 'ESTRUTURA_INVALIDA');
    }
    const atual = fonteDeChaves.obter(chaveId);
    if (atual.situacao !== 'ATIVA') throw entradaInvalida('CHAVE_INDISPONIVEL');
    const mac = calcularMac(atual.segredo, semMac);
    const bytes = serializarCanonico({ ...corpo, autenticacao: { algoritmo: ALGORITMO, chaveId, mac } });
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    const manifesto = congelarProfundo(JSON.parse(bytes.toString('utf8')));
    return produzirResultado({ bytes, sha256, manifesto, layout: LAYOUT, fontes: manifesto.fontes, cobertura: manifesto.cobertura, postgres: manifesto.cobertura.postgres, origemDaChave: fonteDeChaves.origem, avisos: [], catalogoAtualDiverge: null });
  }
  return Object.freeze({ construir });
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------- leitor
/**
 * `criarLeitorL2({ fonteDeChaves, layoutMinimo, catalogoAtual? })` -> `ler({ bytes, sha256 })`. `layoutMinimo` vem da OPERAÇÃO (1 = verificação/ensaio aceita L1
 * normalizado; 2 = exige layout 2); nunca do pacote. `catalogoAtual` (opcional) só produz `catalogoAtualDiverge` informativo (R-6.4).
 */
function criarLeitorL2({ fonteDeChaves, layoutMinimo, catalogoAtual }) {
  if (!ehFonteDeChaves(fonteDeChaves) || !LAYOUTS_ACEITOS.includes(layoutMinimo)) throw entradaInvalida('LEITOR_INVALIDO');
  let hashDoCatalogoAtual = null;
  if (catalogoAtual !== undefined) { if (!R.validarCatalogo(catalogoAtual).valido) throw entradaInvalida('CATALOGO_INVALIDO'); hashDoCatalogoAtual = R.hashCatalogo(catalogoAtual); }
  const lerL1 = criarLeitorL1({ fonteDeChaves });

  function normalizarL1(lido) {
    const arquivos = lido.manifesto.arquivos.map((a) => Object.freeze({ bytes: a.bytes, chave: a.chave, sha256: a.sha256 }));
    const fontes = Object.freeze([Object.freeze({ arquivos: Object.freeze(arquivos), id: 'imagens', total: Object.freeze({ arquivos: arquivos.length, bytes: arquivos.reduce((s, a) => s + a.bytes, 0) }), versaoContrato: 1 })]);
    return produzirResultado({
      bytes: lido.bytes, sha256: lido.sha256, manifesto: lido.manifesto, layout: 1, fontes, cobertura: null, postgres: blocoN0('LAYOUT_1'),
      origemDaChave: lido.autenticacao.origemDaChave, avisos: ['COBERTURA_NAO_DECLARADA', 'NIVEL_N0'], catalogoAtualDiverge: null,
    });
  }

  return function ler(entrada) {
    // (1) forma e hash
    if (!ehObjeto(entrada) || !Reflect.ownKeys(entrada).every((k) => k === 'bytes' || k === 'sha256') || !('bytes' in entrada) || !('sha256' in entrada)) throw recusa('ESTRUTURA_INVALIDA');
    const { bytes, sha256 } = entrada;
    if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > LIMITES.bytesDoManifesto || typeof sha256 !== 'string' || !SHA256.test(sha256)) throw recusa(bytes instanceof Uint8Array && bytes.length > LIMITES.bytesDoManifesto ? 'LIMITE_EXCEDIDO' : 'ESTRUTURA_INVALIDA');
    const copia = Buffer.from(bytes);
    if (crypto.createHash('sha256').update(copia).digest('hex') !== sha256) throw recusa('HASH_DIVERGENTE');
    // (2) JSON
    let objeto;
    try { objeto = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(copia)); } catch { throw recusa('ESTRUTURA_INVALIDA'); }
    if (!ehObjeto(objeto)) throw recusa('ESTRUTURA_INVALIDA');
    // (3) versão e (4) layout aceito e >= mínimo da operação — rejeições, não confiança
    if (objeto.versao === 1) throw recusa('VERSAO_NAO_AUTENTICADA');
    if (objeto.versao !== VERSAO) throw recusa('VERSAO_DESCONHECIDA');
    const layout = objeto.layout;
    if (!LAYOUTS_ACEITOS.includes(layout)) throw recusa('LAYOUT_DESCONHECIDO');
    if (layout < layoutMinimo) throw recusa('LAYOUT_INSUFICIENTE');
    if (layout === 1) return normalizarL1(lerL1({ bytes: copia, sha256 }));
    // (5) bloco de autenticação exato, chave e MAC — antes de qualquer outro campo
    const auth = objeto.autenticacao;
    if (!ehObjeto(auth)) throw recusa('AUTENTICACAO_AUSENTE');
    const chavesAuth = Reflect.ownKeys(auth);
    if (chavesAuth.length !== 3 || !chavesAuth.every((k) => CHAVES.autenticacao.includes(k)) || typeof auth.mac !== 'string' || !SHA256.test(auth.mac) || typeof auth.chaveId !== 'string' || !CHAVE_ID.test(auth.chaveId)) throw recusa('AUTENTICACAO_AUSENTE');
    if (auth.algoritmo !== ALGORITMO) throw recusa('ALGORITMO_INVALIDO');
    let consulta;
    try { consulta = fonteDeChaves.obter(auth.chaveId); } catch { throw recusa('CHAVE_INDISPONIVEL'); }
    if (!ehObjeto(consulta) || (consulta.situacao !== 'REVOGADA' && consulta.situacao !== 'ATIVA')) throw recusa('CHAVE_INDISPONIVEL');
    if (consulta.situacao === 'REVOGADA') throw recusa('CHAVE_REVOGADA');
    if (!(consulta.segredo instanceof Uint8Array) || consulta.segredo.length < 32) throw recusa('CHAVE_INDISPONIVEL');
    let semMac;
    try { semMac = serializarCanonico({ ...objeto, autenticacao: { algoritmo: auth.algoritmo, chaveId: auth.chaveId } }); } catch { throw recusa('MAC_INVALIDO'); }
    if (!iguaisEmTempoConstante(calcularMac(consulta.segredo, semMac), auth.mac)) throw recusa('MAC_INVALIDO');
    // (6) só agora: estrutura completa, limites, formatos, coerência; e forma canônica única (ordem e ausência de chave duplicada)
    validarEstruturaL2(objeto);
    const canonico = serializarCanonico(objeto);
    if (!canonico.equals(copia)) throw recusa('ESTRUTURA_INVALIDA');
    const manifesto = congelarProfundo(JSON.parse(canonico.toString('utf8')));
    const avisos = [];
    if (!NIVEIS_SUFICIENTES.has(manifesto.cobertura.postgres.nivelAtingido)) avisos.push('NIVEL_N0');
    if (fonteDeChaves.origem !== 'OPERACIONAL') avisos.push('CHAVE_NAO_OPERACIONAL');
    const diverge = hashDoCatalogoAtual === null ? null : hashDoCatalogoAtual !== manifesto.cobertura.catalogo.sha256;
    return produzirResultado({ bytes: copia, sha256, manifesto, layout: LAYOUT, fontes: manifesto.fontes, cobertura: manifesto.cobertura, postgres: manifesto.cobertura.postgres, origemDaChave: fonteDeChaves.origem, avisos, catalogoAtualDiverge: diverge });
  };
}

module.exports = {
  criarEscritorL2, criarLeitorL2, declararCobertura, descreverDeclaracao, serializarCanonico, ehResultadoDoLeitor,
  VERSAO, LAYOUT, ALGORITMO, DOMINIO, LAYOUTS_ACEITOS, DECLARACOES, LIMITES, MOTIVOS, CHAVES,
};
