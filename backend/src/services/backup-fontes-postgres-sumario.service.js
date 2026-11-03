'use strict';

const crypto = require('node:crypto');

/**
 * D-ORF-6, P4a (cobertura PostgreSQL, R2 seção 6.3, regra 2): LEITOR EM FLUXO do sumário de `pg_restore --list`.
 *
 * Recebe o stdout do processo em blocos (`alimentar`) e retém SÓ o que o comparador precisa: por entrada do TOC, `tipo`, `esquema`, `nome` e, para
 * objetos dependentes de uma relação, `relacao`. Dono, OIDs, comentários, nome do banco (`dbname:`, `DATABASE`) e o texto bruto NUNCA são retidos.
 * Tetos de memória (bytes, entradas, tamanho de linha); excesso marca `truncado` e o motivo `SUMARIO_TRUNCADO` (nunca silencioso).
 *
 * Interpretação FECHADA: o tipo de entrada vem de uma lista explícita; tipo desconhecido, nome fora do padrão de identificador sem aspas ou linha fora do
 * formato viram `naoInterpretadas` (contadas, nunca descartadas em silêncio). O formato das linhas é conhecimento geral do PostgreSQL 16 e permanece
 * [NV] até a observação real do P4b; por isso o comparador não declara nível com entradas não interpretadas.
 *
 * Não executa processo, não lê arquivo, não escreve nada.
 */

const LIMITES_PADRAO = Object.freeze({ maxBytes: 8 * 1024 * 1024, maxEntradas: 20000, maxBytesDaLinha: 4096 });
// OBSERVADO no P4b (CI 41683852389, PostgreSQL 16.15): `TOC Entries` conta TODAS as entradas do arquivo, mas `pg_restore --list` (sem --verbose) omite
// as que a restauração não usa: ENCODING, STDSTRINGS, SEARCHPATH, DATABASE (sem --create) e seus dependentes (COMMENT do banco) — 5 num dump real.
// Declaradas - listadas = "ocultas"; só é divergência se for negativo ou passar deste teto (nunca silencioso).
const TETO_DE_ENTRADAS_OCULTAS = 8;

// Tipos cujo rótulo é um identificador de relação ou tipo (tag = nome).
const TIPOS_RELACIONAIS = Object.freeze(['TABLE', 'TABLE DATA', 'TABLE ATTACH', 'SEQUENCE', 'SEQUENCE SET', 'SEQUENCE OWNED BY', 'INDEX', 'INDEX ATTACH',
  'VIEW', 'MATERIALIZED VIEW', 'MATERIALIZED VIEW DATA', 'FOREIGN TABLE', 'TYPE', 'DOMAIN']);
// Tipos cujo rótulo é "<relacao> <nome>".
const TIPOS_DEPENDENTES = Object.freeze(['CONSTRAINT', 'FK CONSTRAINT', 'CHECK CONSTRAINT', 'TRIGGER', 'RULE', 'POLICY', 'DEFAULT', 'ROW SECURITY']);
// Tipos cujo rótulo é "<nome>(<argumentos>)".
const TIPOS_DE_ROTINA = Object.freeze(['FUNCTION', 'PROCEDURE', 'AGGREGATE']);
// Tipos só contados: nada do rótulo é retido.
const TIPOS_CONTADOS = Object.freeze(['SCHEMA', 'EXTENSION', 'COMMENT', 'ACL', 'DEFAULT ACL', 'ENCODING', 'STDSTRINGS', 'SEARCHPATH', 'DATABASE',
  'DATABASE PROPERTIES', 'EVENT TRIGGER', 'PUBLICATION', 'PUBLICATION TABLE', 'PUBLICATION TABLES IN SCHEMA', 'SUBSCRIPTION', 'LARGE OBJECT', 'BLOB',
  'BLOBS', 'BLOB METADATA', 'COLLATION', 'CONVERSION', 'OPERATOR', 'OPERATOR CLASS', 'OPERATOR FAMILY', 'CAST', 'TRANSFORM', 'SERVER',
  'FOREIGN DATA WRAPPER', 'USER MAPPING', 'STATISTICS', 'TEXT SEARCH CONFIGURATION', 'TEXT SEARCH DICTIONARY', 'TEXT SEARCH PARSER',
  'TEXT SEARCH TEMPLATE', 'ACCESS METHOD', 'PROCEDURAL LANGUAGE', 'SHELL TYPE', 'SECURITY LABEL']);
const TIPOS_DE_ENTRADA = Object.freeze([...TIPOS_RELACIONAIS, ...TIPOS_DEPENDENTES, ...TIPOS_DE_ROTINA, ...TIPOS_CONTADOS]);
// Mais longo primeiro: "TABLE DATA" tem de vencer "TABLE".
const TIPOS_POR_TAMANHO = Object.freeze([...TIPOS_DE_ENTRADA].sort((a, b) => b.length - a.length || (a < b ? -1 : 1)));

const RE_LINHA = /^(\d{1,9}); (\d{1,10}) (\d{1,10}) (.+)$/;
const RE_IDENTIFICADOR = /^[a-z_][a-z0-9_]{0,62}$/;
const RE_FORMATO = /^;\s+Format:\s+([A-Za-z]{1,16})\s*$/;
const RE_ENTRADAS = /^;\s+TOC Entries:\s+(\d{1,9})\s*$/;
const RE_VERSAO_SERVIDOR = /^;\s+Dumped from database version:\s+(\d{1,3}(?:\.\d{1,3}){0,2})/;
const RE_VERSAO_PGDUMP = /^;\s+Dumped by pg_dump version:\s+(\d{1,3}(?:\.\d{1,3}){0,2})/;

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const inteiroPositivo = (v) => Number.isSafeInteger(v) && v > 0;

function normalizarLimites(limites) {
  if (limites === undefined) return LIMITES_PADRAO;
  if (!ehObjeto(limites)) throw new TypeError('limites do sumário inválidos');
  const chaves = Reflect.ownKeys(limites);
  if (!chaves.every((c) => typeof c === 'string' && Object.hasOwn(LIMITES_PADRAO, c))) throw new TypeError('limites do sumário inválidos');
  const saida = { ...LIMITES_PADRAO };
  for (const c of chaves) {
    if (!inteiroPositivo(limites[c])) throw new TypeError('limites do sumário inválidos');
    saida[c] = limites[c];
  }
  return Object.freeze(saida);
}

/** Separa o tipo (lista fechada) do restante da linha. */
function separarTipo(resto) {
  for (const tipo of TIPOS_POR_TAMANHO) {
    if (resto === tipo) return { tipo, resto: '' };
    if (resto.startsWith(`${tipo} `)) return { tipo, resto: resto.slice(tipo.length + 1) };
  }
  return null;
}

/** Interpreta uma linha de entrada do TOC. Devolve a entrada retida ou null quando não interpretável. */
function interpretarEntrada(linha) {
  const m = RE_LINHA.exec(linha);
  if (m === null) return null;
  const separado = separarTipo(m[4]);
  if (separado === null) return null;
  const { tipo } = separado;
  const espaco = separado.resto.indexOf(' ');
  const esquemaBruto = espaco === -1 ? separado.resto : separado.resto.slice(0, espaco);
  const rotulo = espaco === -1 ? '' : separado.resto.slice(espaco + 1);
  let esquema = null;
  if (esquemaBruto !== '-') {
    if (!RE_IDENTIFICADOR.test(esquemaBruto)) return null;
    esquema = esquemaBruto;
  }
  if (TIPOS_CONTADOS.includes(tipo)) return { tipo, esquema, nome: null, relacao: null };
  // Rótulo = "<...> <dono>": o dono é o último token e não é retido.
  const ultimoEspaco = rotulo.lastIndexOf(' ');
  if (ultimoEspaco <= 0) return null;
  const semDono = rotulo.slice(0, ultimoEspaco);
  if (TIPOS_RELACIONAIS.includes(tipo)) {
    if (!RE_IDENTIFICADOR.test(semDono)) return null;
    return { tipo, esquema, nome: semDono, relacao: null };
  }
  if (TIPOS_DEPENDENTES.includes(tipo)) {
    const partes = semDono.split(' ');
    if (partes.length !== 2 || !partes.every((p) => RE_IDENTIFICADOR.test(p))) return null;
    return { tipo, esquema, nome: partes[1], relacao: partes[0] };
  }
  const parentese = semDono.indexOf('(');
  if (parentese <= 0 || !semDono.endsWith(')')) return null;
  const nome = semDono.slice(0, parentese);
  if (!RE_IDENTIFICADOR.test(nome)) return null;
  return { tipo, esquema, nome, relacao: null };
}

function criarLeitorDeSumario(opcoes) {
  if (opcoes !== undefined && !ehObjeto(opcoes)) throw new TypeError('opções do leitor inválidas');
  if (opcoes !== undefined && !Reflect.ownKeys(opcoes).every((c) => c === 'limites')) throw new TypeError('opções do leitor inválidas');
  const limites = normalizarLimites(opcoes === undefined ? undefined : opcoes.limites);

  const cabecalho = { formato: null, entradasDeclaradas: null, versaoServidor: null, versaoPgDump: null };
  const entradas = [];
  const porTipo = new Map();
  const motivos = new Set();
  let parcial = '';
  let bytesLidos = 0;
  let total = 0;
  let naoInterpretadas = 0;
  let truncado = false;
  let concluido = false;

  const truncar = () => { truncado = true; motivos.add('SUMARIO_TRUNCADO'); };

  function processarLinha(linha) {
    if (linha === '' || linha === '\r') return;
    if (linha.endsWith('\r')) linha = linha.slice(0, -1);
    if (linha[0] === ';') {
      let m;
      if ((m = RE_FORMATO.exec(linha)) !== null) cabecalho.formato = m[1].toUpperCase();
      else if ((m = RE_ENTRADAS.exec(linha)) !== null) cabecalho.entradasDeclaradas = Number(m[1]);
      else if ((m = RE_VERSAO_SERVIDOR.exec(linha)) !== null) cabecalho.versaoServidor = m[1];
      else if ((m = RE_VERSAO_PGDUMP.exec(linha)) !== null) cabecalho.versaoPgDump = m[1];
      return; // demais cabeçalhos (inclusive dbname) são descartados
    }
    total += 1;
    if (truncado) return;
    if (entradas.length >= limites.maxEntradas) { truncar(); return; }
    const entrada = interpretarEntrada(linha);
    if (entrada === null) { naoInterpretadas += 1; return; }
    entradas.push(Object.freeze(entrada));
    porTipo.set(entrada.tipo, (porTipo.get(entrada.tipo) ?? 0) + 1);
  }

  function alimentar(bloco) {
    if (concluido) throw new TypeError('leitor já concluído');
    const texto = Buffer.isBuffer(bloco) ? bloco.toString('latin1') : bloco;
    if (typeof texto !== 'string') throw new TypeError('bloco inválido');
    if (truncado) return;
    bytesLidos += texto.length;
    if (bytesLidos > limites.maxBytes) { truncar(); parcial = ''; return; }
    let dados = parcial + texto;
    let quebra;
    while ((quebra = dados.indexOf('\n')) !== -1) {
      const linha = dados.slice(0, quebra);
      dados = dados.slice(quebra + 1);
      if (linha.length > limites.maxBytesDaLinha) { truncar(); parcial = ''; return; }
      processarLinha(linha);
      if (truncado) { parcial = ''; return; }
    }
    if (dados.length > limites.maxBytesDaLinha) { truncar(); parcial = ''; return; }
    parcial = dados;
  }

  function concluir() {
    if (concluido) throw new TypeError('leitor já concluído');
    concluido = true;
    if (parcial !== '' && !truncado) processarLinha(parcial);
    parcial = '';
    if (cabecalho.formato === null) motivos.add('FORMATO_AUSENTE');
    else if (cabecalho.formato !== 'CUSTOM') motivos.add('FORMATO_NAO_CUSTOM');
    let ocultas = null;
    if (cabecalho.entradasDeclaradas === null) motivos.add('CONTAGEM_AUSENTE');
    else if (!truncado) {
      ocultas = cabecalho.entradasDeclaradas - total;
      if (ocultas < 0 || ocultas > TETO_DE_ENTRADAS_OCULTAS) motivos.add('CONTAGEM_DIVERGENTE');
    }
    if (naoInterpretadas > 0) motivos.add('ENTRADAS_NAO_INTERPRETADAS');
    if (total === 0) motivos.add('SUMARIO_VAZIO');
    const contagemPorTipo = Object.freeze(Object.fromEntries([...porTipo.entries()].sort(([a], [b]) => (a < b ? -1 : 1))));
    const tuplas = entradas.map((e) => [e.tipo, e.esquema, e.nome, e.relacao]);
    const sha256 = crypto.createHash('sha256').update(JSON.stringify(tuplas)).digest('hex');
    return Object.freeze({
      ok: motivos.size === 0,
      cabecalho: Object.freeze({ ...cabecalho }),
      entradas: Object.freeze(entradas),
      contagem: Object.freeze({ total, interpretadas: entradas.length, naoInterpretadas, ocultas, porTipo: contagemPorTipo }),
      truncado,
      bytesLidos,
      sha256,
      motivos: Object.freeze([...motivos].sort()),
    });
  }

  return Object.freeze({ alimentar, concluir });
}

/** Conveniência para texto completo em memória (testes e sumários pequenos). */
function lerSumario(texto, opcoes) {
  const leitor = criarLeitorDeSumario(opcoes);
  leitor.alimentar(texto);
  return leitor.concluir();
}

const ehSumario = (v) => ehObjeto(v) && Object.isFrozen(v) && typeof v.ok === 'boolean' && ehObjeto(v.cabecalho) && Array.isArray(v.entradas)
  && ehObjeto(v.contagem) && typeof v.truncado === 'boolean' && Array.isArray(v.motivos) && typeof v.sha256 === 'string';

module.exports = {
  criarLeitorDeSumario, lerSumario, interpretarEntrada, ehSumario,
  LIMITES_PADRAO, TETO_DE_ENTRADAS_OCULTAS, TIPOS_DE_ENTRADA, TIPOS_RELACIONAIS, TIPOS_DEPENDENTES, TIPOS_DE_ROTINA, TIPOS_CONTADOS,
};
