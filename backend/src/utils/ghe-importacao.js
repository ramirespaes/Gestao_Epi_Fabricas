'use strict';

const { normalizarCodigoGhe } = require('./codigo-ghe');

/**
 * Núcleo PURO da importação GHE / EPI (evolução GHE / importação GHE-EPI, Incremento 5A): sem banco, sem HTTP, sem
 * efeitos. Recebe as linhas como vieram da planilha e fotografias do banco da empresa (GHEs, tipos de material e
 * vínculos) e devolve, linha a linha, o que a importação faria. NADA aqui grava: o preview usa o resultado como está e a
 * confirmação (5C) refaz a análise no servidor, dentro da transação.
 *
 * Regras (contrato fixado pelos testes de test/utils/ghe-importacao.test.js):
 *   - código do GHE: a regra única de utils/codigo-ghe.js;
 *   - descrição (grupos_homogeneos_exposicao.nome) e EPI (tipos_material.nome): aparar, colapsar espaços, comparar sem
 *     diferenciar maiúsculas nem acentos, PONTUAÇÃO PRESERVADA, SEM aproximação. Normalização própria desta importação:
 *     não é a de utils/normalizacao.normalizarNomeGhe (importação de funcionários);
 *   - classificação: só os dois rótulos conhecidos;
 *   - conflitos nunca são resolvidos em silêncio: nada é renumerado, renomeado nem "a última linha vence";
 *   - a ausência de um GHE ou de um vínculo na planilha não significa exclusão: este módulo nem representa remoção.
 */

const DESCRICAO_MAXIMA = 150;
const CONTROLE = /[\u0000-\u001f\u007f-\u009f]/;

const SITUACAO_GHE = Object.freeze({
  NOVO: 'GHE_NOVO',
  EXISTENTE: 'GHE_EXISTENTE',
  LEGADO: 'LEGADO_RECEBERA_CODIGO',
  CONFLITO: 'CONFLITO_GHE',
  AMBIGUO: 'AMBIGUO',
});

const S = Object.freeze({
  NOVO_VINCULO: 'NOVO_VINCULO',
  EXISTENTE: 'VINCULO_EXISTENTE',
  ALTERADA: 'CLASSIFICACAO_ALTERADA',
  EPI_NAO_ENCONTRADO: 'EPI_NAO_ENCONTRADO',
  EPI_AMBIGUO: 'EPI_AMBIGUO',
  EPI_INATIVO: 'EPI_INATIVO',
  GHE_INATIVO: 'GHE_INATIVO',
  CONFLITO_GHE: 'CONFLITO_GHE',
  GHE_AMBIGUO: 'GHE_AMBIGUO',
  DUPLICADA: 'DUPLICADA_NO_ARQUIVO',
  CONFLITO_ARQUIVO: 'CONFLITO_NO_ARQUIVO',
  INVALIDA: 'LINHA_INVALIDA',
});

const MOTIVO = Object.freeze({
  CODIGO_DESCRICAO_DIFERENTE: 'CODIGO_COM_DESCRICAO_DIFERENTE',
  DESCRICAO_OUTRO_CODIGO: 'DESCRICAO_COM_OUTRO_CODIGO',
  DESCRICAO_DIVERGENTE: 'DESCRICAO_DIVERGENTE_NO_ARQUIVO',
  DESCRICAO_REPETIDA: 'DESCRICAO_REPETIDA_NO_ARQUIVO',
});

// Escrevem algo no 5C; as que não bloqueiam a análise do GHE (inclusive as que já estão em dia ou repetidas).
const APLICAVEIS = new Set([S.NOVO_VINCULO, S.ALTERADA]);
const NAO_BLOQUEADAS = new Set([S.NOVO_VINCULO, S.ALTERADA, S.EXISTENTE, S.DUPLICADA]);

/** Texto limpo: aparado, espaços sequenciais viram um, NFC. Qualquer coisa que não seja texto vira vazio. */
function limparTexto(valor) {
  return typeof valor === 'string' ? valor.normalize('NFC').replace(/\s+/g, ' ').trim() : '';
}

/** Chave de comparação: texto limpo, sem acentos, em minúsculas; pontuação preservada. null se não for texto. */
function chaveCanonica(texto) {
  if (typeof texto !== 'string') return null;
  return limparTexto(texto).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/** 'OBRIGATORIO' | 'NAO_OBRIGATORIO' | null (qualquer outro valor). */
function normalizarClassificacao(valor) {
  const chave = chaveCanonica(valor);
  if (chave === 'obrigatorio') return 'OBRIGATORIO';
  if (chave === 'nao obrigatorio' || chave === 'nao_obrigatorio') return 'NAO_OBRIGATORIO';
  return null;
}

/** Interpreta uma linha crua. `vazia` = nenhum campo preenchido. */
function normalizarLinha(bruta, indice) {
  const linhaBruta = bruta !== null && typeof bruta === 'object' ? bruta : {};
  const ghe = limparTexto(linhaBruta.ghe);
  const descricao = limparTexto(linhaBruta.descricao);
  const epi = limparTexto(linhaBruta.epi);
  const classificacao = limparTexto(linhaBruta.classificacao);
  const numero = Number.isInteger(linhaBruta.linha) ? linhaBruta.linha : indice + 2;

  const vazia = ghe === '' && descricao === '' && epi === '' && classificacao === '';
  const problemas = [];

  const codigo = ghe === '' ? null : normalizarCodigoGhe(ghe);
  if (ghe === '') problemas.push({ campo: 'ghe', codigo: 'GHE_CODIGO_OBRIGATORIO' });
  else if (codigo === null) problemas.push({ campo: 'ghe', codigo: 'GHE_CODIGO_INVALIDO' });

  if (descricao === '') problemas.push({ campo: 'descricao', codigo: 'DESCRICAO_OBRIGATORIA' });
  else if (Array.from(descricao).length > DESCRICAO_MAXIMA || CONTROLE.test(descricao)) problemas.push({ campo: 'descricao', codigo: 'DESCRICAO_INVALIDA' });

  if (epi === '') problemas.push({ campo: 'epi', codigo: 'EPI_OBRIGATORIO' });
  else if (CONTROLE.test(epi)) problemas.push({ campo: 'epi', codigo: 'EPI_INVALIDO' });

  const classificacaoNormalizada = classificacao === '' ? null : normalizarClassificacao(classificacao);
  if (classificacao === '') problemas.push({ campo: 'classificacao', codigo: 'CLASSIFICACAO_OBRIGATORIA' });
  else if (classificacaoNormalizada === null) problemas.push({ campo: 'classificacao', codigo: 'CLASSIFICACAO_INVALIDA' });

  return {
    vazia,
    linha: numero,
    ghe: codigo,
    descricao: descricao !== '' && !problemas.some((p) => p.campo === 'descricao') ? descricao : null,
    epi: epi !== '' && !problemas.some((p) => p.campo === 'epi') ? epi : null,
    classificacao: classificacaoNormalizada,
    problemas,
  };
}

const novoRegistro = (n) => ({
  linha: n.linha,
  ghe: n.ghe,
  descricao: n.descricao,
  epi: n.epi,
  classificacao: n.classificacao,
  situacaoGhe: null,
  gheId: null,
  gheInativo: false,
  tipoMaterialId: null,
  tipoInativo: false,
  situacao: S.INVALIDA,
  motivo: null,
  duplicadaDe: null,
  aplicavel: false,
  problemas: n.problemas,
});

function agrupar(itens, chave) {
  const mapa = new Map();
  for (const item of itens) {
    const k = chave(item);
    if (!mapa.has(k)) mapa.set(k, []);
    mapa.get(k).push(item);
  }
  return mapa;
}

/** Resolve cada GHE do arquivo (por código) contra os GHEs da empresa. */
function resolverGhes(validas, ghes) {
  const porCodigo = new Map(ghes.filter((x) => x.codigo !== null && x.codigo !== undefined).map((x) => [x.codigo, x]));
  const porDescricao = agrupar(ghes, (x) => chaveCanonica(x.nome));

  const descricoesDoCodigo = new Map();
  const codigosDaDescricao = new Map();
  for (const n of validas) {
    const chave = chaveCanonica(n.descricao);
    if (!descricoesDoCodigo.has(n.ghe)) descricoesDoCodigo.set(n.ghe, new Set());
    descricoesDoCodigo.get(n.ghe).add(chave);
    if (!codigosDaDescricao.has(chave)) codigosDaDescricao.set(chave, new Set());
    codigosDaDescricao.get(chave).add(n.ghe);
  }

  const resolucao = new Map();
  for (const [codigo, descricoes] of descricoesDoCodigo) {
    if (descricoes.size > 1) {
      resolucao.set(codigo, { situacao: SITUACAO_GHE.CONFLITO, motivo: MOTIVO.DESCRICAO_DIVERGENTE, ghe: null });
      continue;
    }
    const [chave] = descricoes;
    if (codigosDaDescricao.get(chave).size > 1) {
      resolucao.set(codigo, { situacao: SITUACAO_GHE.CONFLITO, motivo: MOTIVO.DESCRICAO_REPETIDA, ghe: null });
      continue;
    }
    const existente = porCodigo.get(codigo);
    if (existente !== undefined) {
      resolucao.set(codigo, chaveCanonica(existente.nome) === chave
        ? { situacao: SITUACAO_GHE.EXISTENTE, motivo: null, ghe: existente }
        : { situacao: SITUACAO_GHE.CONFLITO, motivo: MOTIVO.CODIGO_DESCRICAO_DIFERENTE, ghe: null });
      continue;
    }
    const iguais = porDescricao.get(chave) || [];
    if (iguais.some((x) => x.codigo !== null && x.codigo !== undefined)) {
      resolucao.set(codigo, { situacao: SITUACAO_GHE.CONFLITO, motivo: MOTIVO.DESCRICAO_OUTRO_CODIGO, ghe: null });
    } else if (iguais.length === 0) {
      resolucao.set(codigo, { situacao: SITUACAO_GHE.NOVO, motivo: null, ghe: null });
    } else if (iguais.length === 1) {
      resolucao.set(codigo, { situacao: SITUACAO_GHE.LEGADO, motivo: null, ghe: iguais[0] });
    } else {
      resolucao.set(codigo, { situacao: SITUACAO_GHE.AMBIGUO, motivo: null, ghe: null });
    }
  }
  return resolucao;
}

/** Situação do vínculo de uma linha cujo GHE foi resolvido (novo, existente ou legado). */
function resolverVinculo(registro, resolucao, tiposPorChave, vinculoDe) {
  const candidatos = tiposPorChave.get(chaveCanonica(registro.epi)) || [];
  if (candidatos.length === 0) return { situacao: S.EPI_NAO_ENCONTRADO };
  if (candidatos.length > 1) return { situacao: S.EPI_AMBIGUO };
  const [tipo] = candidatos;
  const base = { tipoMaterialId: tipo.id, tipoInativo: tipo.ativo === false };
  const gheInativo = resolucao.ghe !== null && resolucao.ghe.ativo === false;
  const existente = resolucao.ghe === null ? undefined : vinculoDe(resolucao.ghe.id, tipo.id);

  if (existente !== undefined) {
    if (existente === registro.classificacao) return { ...base, situacao: S.EXISTENTE };
    return { ...base, situacao: gheInativo ? S.GHE_INATIVO : S.ALTERADA };
  }
  if (gheInativo) return { ...base, situacao: S.GHE_INATIVO };
  if (base.tipoInativo) return { ...base, situacao: S.EPI_INATIVO };
  return { ...base, situacao: S.NOVO_VINCULO };
}

/** Duplicatas e conflitos de classificação dentro do arquivo, sobre as linhas já resolvidas. */
function aplicarRegrasDoArquivo(registros) {
  const participantes = registros.filter((r) => r.tipoMaterialId !== null && [SITUACAO_GHE.NOVO, SITUACAO_GHE.EXISTENTE, SITUACAO_GHE.LEGADO].includes(r.situacaoGhe));
  for (const grupo of agrupar(participantes, (r) => `${r.ghe}|${r.tipoMaterialId}`).values()) {
    if (grupo.length < 2) continue;
    if (new Set(grupo.map((r) => r.classificacao)).size > 1) {
      for (const r of grupo) { r.situacao = S.CONFLITO_ARQUIVO; r.aplicavel = false; }
      continue;
    }
    for (const r of grupo.slice(1)) { r.situacao = S.DUPLICADA; r.duplicadaDe = grupo[0].linha; r.aplicavel = false; }
  }
}

function montarGhesDoArquivo(registros, resolucoes) {
  const resultado = [];
  for (const [codigo, linhas] of agrupar(registros.filter((r) => r.situacaoGhe !== null), (r) => r.ghe)) {
    const { situacao, ghe } = resolucoes.get(codigo);
    const algumaLinhaLivre = linhas.some((r) => NAO_BLOQUEADAS.has(r.situacao));
    let operacao = null;
    if (algumaLinhaLivre && situacao === SITUACAO_GHE.NOVO) operacao = 'CRIAR';
    if (algumaLinhaLivre && situacao === SITUACAO_GHE.LEGADO) operacao = 'ATRIBUIR_CODIGO';
    resultado.push({
      codigo,
      descricao: linhas[0].descricao,
      situacao,
      gheId: ghe === null ? null : ghe.id,
      ativo: ghe === null ? null : ghe.ativo,
      operacao,
      linhas: linhas.map((r) => r.linha),
    });
  }
  return resultado;
}

function contar(itens, chave) {
  const total = {};
  for (const item of itens) total[chave(item)] = (total[chave(item)] || 0) + 1;
  return total;
}

/**
 * @param {{ linhas: object[], ghes: object[], tipos: object[], vinculos: object[] }} entrada
 * @returns {{ resumo: object, ghes: object[], linhas: object[] }}
 */
function analisarLote({
  linhas, ghes, tipos, vinculos,
}) {
  const normalizadas = linhas.map((bruta, i) => normalizarLinha(bruta, i));
  const preenchidas = normalizadas.filter((n) => !n.vazia);
  const validas = preenchidas.filter((n) => n.problemas.length === 0);

  const resolucoes = resolverGhes(validas, ghes);
  const tiposPorChave = agrupar(tipos, (t) => chaveCanonica(t.nome));
  const vinculosPorPar = new Map(vinculos.map((x) => [`${x.gheId}:${x.tipoId}`, x.classificacao]));
  const vinculoDe = (gheId, tipoId) => vinculosPorPar.get(`${gheId}:${tipoId}`);

  const registros = preenchidas.map((n) => {
    const registro = novoRegistro(n);
    if (n.problemas.length > 0) return registro;
    const resolucao = resolucoes.get(n.ghe);
    registro.situacaoGhe = resolucao.situacao;
    registro.motivo = resolucao.motivo;
    if (resolucao.situacao === SITUACAO_GHE.CONFLITO) { registro.situacao = S.CONFLITO_GHE; return registro; }
    if (resolucao.situacao === SITUACAO_GHE.AMBIGUO) { registro.situacao = S.GHE_AMBIGUO; return registro; }
    registro.gheId = resolucao.ghe === null ? null : resolucao.ghe.id;
    registro.gheInativo = resolucao.ghe !== null && resolucao.ghe.ativo === false;
    Object.assign(registro, resolverVinculo(n, resolucao, tiposPorChave, vinculoDe));
    return registro;
  });

  for (const r of registros) r.aplicavel = APLICAVEIS.has(r.situacao);
  aplicarRegrasDoArquivo(registros);

  const ghesDoArquivo = montarGhesDoArquivo(registros, resolucoes);
  return {
    resumo: {
      linhasRecebidas: linhas.length,
      linhasIgnoradas: normalizadas.length - preenchidas.length,
      aplicaveis: registros.filter((r) => r.aplicavel).length,
      porSituacao: contar(registros, (r) => r.situacao),
      ghes: contar(ghesDoArquivo, (x) => x.situacao),
    },
    ghes: ghesDoArquivo,
    linhas: registros,
  };
}

module.exports = {
  chaveCanonica, limparTexto, normalizarClassificacao, normalizarLinha, analisarLote, DESCRICAO_MAXIMA, SITUACAO_GHE,
};
