'use strict';

const crypto = require('node:crypto');
const { ehSumario, TIPOS_RELACIONAIS } = require('./backup-fontes-postgres-sumario.service');
const { RELKINDS } = require('../repositories/backup-fontes-postgres-inventario.repository');

/**
 * D-ORF-6, P4a (R2 seção 6, adendo P0-R2 seção 5): CONTRATO DE SAÍDA da cobertura PostgreSQL — bloco `cobertura.postgres` do manifesto layout 2.
 *
 * Funções puras: comparador inventário × sumário com MAPA EXPLÍCITO categoria → entradas do TOC (relação sem entrada = `RELACAO_AUSENTE_NO_DUMP`;
 * categoria fora do mapa = `CATEGORIA_NAO_MAPEADA`; entrada sem inventário é só informativa); impressão digital do esquema (migrations aplicadas:
 * quantidade, última, SHA-256 da lista ordenada) e regra de compatibilidade por PREFIXO (banco à frente do código = `ESQUEMA_A_FRENTE_DO_CODIGO`);
 * declaração do que o dump NÃO cobre (objetos globais, privilégios na restauração, propriedades do banco, outros bancos, dados externos).
 *
 * NÍVEL: `nivelCalculado` é o que as verificações puras alcançaram; `nivelAtingido` NUNCA passa de N0 enquanto o mapa não for OBSERVADO num banco
 * sintético (P4b): o mapa v1 é conhecimento geral [NV], e um nível declarado a partir dele seria cobertura presumida. Não há parâmetro que contorne
 * isso. N2a (contagens e sequências) depende de D-F17 e não existe aqui.
 *
 * O bloco tem conjunto FIXO de chaves; `relacoes`, `esquema` e `dependenciasExternas` só podem ser null com `nivelAtingido = N0`, e null conta como
 * não verificado. Chave desconhecida é falha fechada (`validarBlocoPostgres`).
 */

const VERSAO_CONTRATO_POSTGRES = 1;
const NIVEIS = Object.freeze(['N0', 'N1', 'N2a', 'N2b', 'N3']);
const CHAVES_DO_BLOCO = Object.freeze(['versaoContratoPostgres', 'nivelAtingido', 'nivelCalculado', 'relacoes', 'esquema', 'dependenciasExternas', 'motivos']);

/**
 * Mapa v1 (R2 6.3). `obrigatorias`: entradas do TOC que toda relação da categoria precisa ter; `opcionais`: entradas cuja presença é observada e
 * contada, nunca exigida. `null` = categoria conhecida mas NÃO mapeada (inexistente no projeto): sua presença no inventário é falha fechada.
 * `observadoEm` registra a observação real do P4b (CI 41693689221, 03/11/2026, PostgreSQL 16.15, 417 relações, zero contradições): só a partir dela o
 * `nivelAtingido` pode igualar o `nivelCalculado`. Observação contradita em execução futura => nova versão do contrato e `observadoEm` de novo nulo.
 */
const MAPA_DE_CORRESPONDENCIA = Object.freeze({
  versao: 1,
  observadoEm: '2026-11-03',
  observacao: Object.freeze({
    ci: 'github-actions:41693689221', commit: 'c862a7232e20679fd6ab92e039306ee6f9129837', servidor: '16.15', dumpSha256: '244f54752665bd3792390ab32b05e638fdb71ce67eb7eb32bb2812f33b739459',
    relacoes: 417, contradicoes: 0, entradasOcultas: Object.freeze(['ENCODING', 'STDSTRINGS', 'SEARCHPATH', 'DATABASE', 'COMMENT']),
  }),
  categorias: Object.freeze({
    r: Object.freeze({ obrigatorias: Object.freeze(['TABLE']), opcionais: Object.freeze(['TABLE DATA']) }),
    S: Object.freeze({ obrigatorias: Object.freeze(['SEQUENCE']), opcionais: Object.freeze(['SEQUENCE SET', 'SEQUENCE OWNED BY']) }),
    i: Object.freeze({ obrigatorias: Object.freeze(['INDEX']), opcionais: Object.freeze([]) }),
    'i:restricao': Object.freeze({ obrigatorias: Object.freeze(['CONSTRAINT']), opcionais: Object.freeze([]) }),
    p: null, I: null, v: null, m: null, f: null, c: null, t: null,
  }),
});

const NAO_COBERTOS_PELO_DUMP = Object.freeze([
  'PAPEIS_E_OBJETOS_GLOBAIS', // roles, tablespaces, configuração do cluster: fora do pg_dump de um banco
  'PRIVILEGIOS_NAO_REPRODUZIDOS_NA_RESTAURACAO', // a restauração usa --no-privileges --no-owner
  'PROPRIEDADES_DO_BANCO', // encoding, collation e ALTER DATABASE ... SET do original
  'OUTROS_BANCOS_DO_CLUSTER',
  'DADOS_DE_TABELAS_ESTRANGEIRAS',
  'ARQUIVOS_FORA_DO_BANCO', // cobertos (ou não) pelas fontes ARQUIVOS, nunca inferidos do dump
]);

const RE_IDENTIFICADOR = /^[a-z_][a-z0-9_]{0,62}$/;
const NOME_DE_MIGRATION = /^[0-9]{3}_[a-z0-9_]+$/;
const TETO_DE_LISTAS = 50;

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const sha256 = (texto) => crypto.createHash('sha256').update(texto).digest('hex');
function invalido(codigo) {
  const e = new Error('entrada de cobertura inválida');
  e.code = codigo;
  return e;
}

function validarInventario(inventario) {
  if (!ehObjeto(inventario) || !Array.isArray(inventario.relacoes) || !ehObjeto(inventario.outros) || !Array.isArray(inventario.extensoes)
    || !ehObjeto(inventario.servidor) || !Array.isArray(inventario.migrations)) throw invalido('INVENTARIO_INVALIDO');
  for (const r of inventario.relacoes) {
    if (!ehObjeto(r) || !RE_IDENTIFICADOR.test(r.esquema) || !RE_IDENTIFICADOR.test(r.nome) || !RELKINDS.includes(r.relkind)
      || typeof r.sustentaRestricao !== 'boolean' || typeof r.sequenciaImplicita !== 'boolean') throw invalido('INVENTARIO_INVALIDO');
  }
  for (const m of inventario.migrations) if (typeof m !== 'string' || !NOME_DE_MIGRATION.test(m)) throw invalido('INVENTARIO_INVALIDO');
  for (const e of inventario.extensoes) if (!ehObjeto(e) || !RE_IDENTIFICADOR.test(e.nome) || typeof e.versao !== 'string') throw invalido('INVENTARIO_INVALIDO');
  for (const c of ['versao', 'encoding', 'collate', 'ctype']) if (typeof inventario.servidor[c] !== 'string') throw invalido('INVENTARIO_INVALIDO');
}

const categoriaDe = (relacao) => (relacao.relkind === 'i' && relacao.sustentaRestricao ? 'i:restricao' : relacao.relkind);
const limitar = (lista) => Object.freeze(lista.slice(0, TETO_DE_LISTAS));

/** Compara o inventário (snapshot) com o sumário (`pg_restore --list` do dump). Puro; nunca lança por conteúdo, só por forma. */
function compararInventarioComSumario(entrada) {
  if (!ehObjeto(entrada) || !Reflect.ownKeys(entrada).every((c) => c === 'inventario' || c === 'sumario')) throw invalido('ENTRADA_INVALIDA');
  const { inventario, sumario } = entrada;
  validarInventario(inventario);
  if (!ehSumario(sumario)) throw invalido('SUMARIO_INVALIDO');

  const motivos = new Set(sumario.motivos);
  if (sumario.truncado) motivos.add('SUMARIO_TRUNCADO');
  if (sumario.cabecalho.formato !== 'CUSTOM') motivos.add('FORMATO_NAO_CUSTOM');

  // Índice do sumário: "tipo|esquema|nome" -> contagem. Para CONSTRAINT o nome da restrição é o do índice que a sustenta.
  const noSumario = new Map();
  const relacionais = new Set([...TIPOS_RELACIONAIS, 'CONSTRAINT']);
  for (const e of sumario.entradas) {
    if (!relacionais.has(e.tipo) || e.nome === null) continue;
    const chave = `${e.tipo}|${e.esquema}|${e.nome}`;
    noSumario.set(chave, (noSumario.get(chave) ?? 0) + 1);
  }
  const usadas = new Set();
  const ausentes = [];
  const naoMapeadas = [];
  const opcionaisAusentes = {};
  let correspondidas = 0;
  for (const r of inventario.relacoes) {
    const categoria = categoriaDe(r);
    const regra = Object.hasOwn(MAPA_DE_CORRESPONDENCIA.categorias, categoria) ? MAPA_DE_CORRESPONDENCIA.categorias[categoria] : undefined;
    if (regra === null || regra === undefined) { naoMapeadas.push(`${r.esquema}.${r.nome}:${categoria}`); continue; }
    let completa = true;
    for (const tipo of regra.obrigatorias) {
      const chave = `${tipo}|${r.esquema}|${r.nome}`;
      if (noSumario.has(chave)) usadas.add(chave); else { completa = false; ausentes.push(`${r.esquema}.${r.nome}:${tipo}`); }
    }
    for (const tipo of regra.opcionais) {
      const chave = `${tipo}|${r.esquema}|${r.nome}`;
      if (noSumario.has(chave)) usadas.add(chave); else opcionaisAusentes[tipo] = (opcionaisAusentes[tipo] ?? 0) + 1;
    }
    if (completa) correspondidas += 1;
  }
  if (ausentes.length > 0) motivos.add('RELACAO_AUSENTE_NO_DUMP');
  if (naoMapeadas.length > 0) motivos.add('CATEGORIA_NAO_MAPEADA');
  let semInventario = 0;
  for (const chave of noSumario.keys()) if (!usadas.has(chave)) semInventario += 1;

  const tuplas = inventario.relacoes.map((r) => [r.esquema, r.nome, r.relkind, r.sustentaRestricao, r.sequenciaImplicita])
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : (a[0] < b[0] ? -1 : 1)));
  return Object.freeze({
    ok: motivos.size === 0,
    mapa: Object.freeze({ versao: MAPA_DE_CORRESPONDENCIA.versao, observado: MAPA_DE_CORRESPONDENCIA.observadoEm !== null }),
    relacoes: Object.freeze({
      inventariadas: inventario.relacoes.length,
      correspondidas,
      ausentes: limitar(ausentes.sort()),
      categoriasNaoMapeadas: limitar(naoMapeadas.sort()),
      entradasSemInventario: semInventario,
      opcionaisAusentes: Object.freeze(opcionaisAusentes),
      sha256: sha256(JSON.stringify(tuplas)),
    }),
    sumario: Object.freeze({ sha256: sumario.sha256, entradas: sumario.contagem.total, naoInterpretadas: sumario.contagem.naoInterpretadas }),
    motivos: Object.freeze([...motivos].sort()),
  });
}

function normalizarMigrations(lista, codigo) {
  if (!Array.isArray(lista)) throw invalido(codigo);
  const nomes = lista.map((n) => (typeof n === 'string' ? n.replace(/\.sql$/, '') : n));
  if (!nomes.every((n) => typeof n === 'string' && NOME_DE_MIGRATION.test(n))) throw invalido(codigo);
  if (new Set(nomes).size !== nomes.length) throw invalido(codigo);
  return nomes;
}

/** Impressão digital do esquema a partir das migrations aplicadas (ordem de aplicação preservada). */
function impressaoDigitalDoEsquema(entrada) {
  if (!ehObjeto(entrada) || !Reflect.ownKeys(entrada).every((c) => c === 'migrationsDoBanco')) throw invalido('ENTRADA_INVALIDA');
  const nomes = normalizarMigrations(entrada.migrationsDoBanco, 'MIGRATIONS_INVALIDAS');
  return Object.freeze({ quantidade: nomes.length, ultima: nomes.length === 0 ? null : nomes[nomes.length - 1], sha256: sha256(nomes.join('\n')) });
}

/** Regra de compatibilidade: o conjunto do banco deve ser PREFIXO do conjunto do código (código >= banco). */
function compatibilidadeDeEsquema(entrada) {
  if (!ehObjeto(entrada) || !Reflect.ownKeys(entrada).every((c) => c === 'migrationsDoBanco' || c === 'migrationsDoCodigo')) throw invalido('ENTRADA_INVALIDA');
  const banco = normalizarMigrations(entrada.migrationsDoBanco, 'MIGRATIONS_INVALIDAS');
  const codigo = normalizarMigrations(entrada.migrationsDoCodigo, 'MIGRATIONS_DO_CODIGO_INVALIDAS');
  const comum = Math.min(banco.length, codigo.length);
  let prefixo = 0;
  while (prefixo < comum && banco[prefixo] === codigo[prefixo]) prefixo += 1;
  let relacao;
  let codigoDeFalha = null;
  if (prefixo < comum) { relacao = 'DIVERGENTE'; codigoDeFalha = 'ESQUEMA_DIVERGENTE'; }
  else if (banco.length === codigo.length) relacao = 'IGUAL';
  else if (banco.length < codigo.length) relacao = 'BANCO_ATRAS_DO_CODIGO';
  else { relacao = 'BANCO_A_FRENTE_DO_CODIGO'; codigoDeFalha = 'ESQUEMA_A_FRENTE_DO_CODIGO'; }
  return Object.freeze({
    relacao, compativel: codigoDeFalha === null, codigo: codigoDeFalha, prefixoComum: prefixo,
    faltamNoBanco: codigo.length - prefixo, sobramNoBanco: banco.length - prefixo, migracaoPendente: relacao === 'BANCO_ATRAS_DO_CODIGO',
  });
}

/** Declaração (N3 declarativo) das dependências externas: o que o ambiente de restauração precisa ter e o que o dump não leva. Nada é verificado aqui. */
function declararDependenciasExternas(entrada) {
  if (!ehObjeto(entrada) || !Reflect.ownKeys(entrada).every((c) => c === 'inventario')) throw invalido('ENTRADA_INVALIDA');
  validarInventario(entrada.inventario);
  const { servidor, extensoes } = entrada.inventario;
  return Object.freeze({
    servidor: Object.freeze({ versao: servidor.versao, encoding: servidor.encoding, collate: servidor.collate, ctype: servidor.ctype }),
    extensoes: Object.freeze(extensoes.map((e) => Object.freeze({ nome: e.nome, versao: e.versao }))),
    naoCobertosPeloDump: NAO_COBERTOS_PELO_DUMP,
    verificadas: false,
  });
}

/** Bloco de um backup que NÃO executou as verificações do P4 (pacotes antigos, N0): blocos nulos = não verificado. */
function blocoN0(motivo = 'NAO_EXECUTADO') {
  return Object.freeze({
    versaoContratoPostgres: VERSAO_CONTRATO_POSTGRES, nivelAtingido: 'N0', nivelCalculado: 'N0', relacoes: null, esquema: null, dependenciasExternas: null,
    motivos: Object.freeze([motivo]),
  });
}

/** Produz o bloco `cobertura.postgres` a partir do inventário do snapshot, do sumário do dump e das migrations do código que fez o backup. */
function avaliarCoberturaPostgres(entrada) {
  if (!ehObjeto(entrada) || !Reflect.ownKeys(entrada).every((c) => ['inventario', 'sumario', 'migrationsDoCodigo'].includes(c))) throw invalido('ENTRADA_INVALIDA');
  const { inventario, sumario, migrationsDoCodigo } = entrada;
  const comparacao = compararInventarioComSumario({ inventario, sumario });
  const impressao = impressaoDigitalDoEsquema({ migrationsDoBanco: inventario.migrations });
  const compatibilidade = compatibilidadeDeEsquema({ migrationsDoBanco: inventario.migrations, migrationsDoCodigo });
  const dependencias = declararDependenciasExternas({ inventario });
  const motivos = new Set(comparacao.motivos);
  // Banco atrás do código não invalida o backup (a migração pendente é registrada); divergência ou banco à frente, sim.
  if (!compatibilidade.compativel) motivos.add(compatibilidade.codigo);
  if (inventario.migrations.length === 0) motivos.add('SEM_MIGRATIONS_APLICADAS');
  const nivelCalculado = motivos.size === 0 ? 'N1' : 'N0';
  if (!comparacao.mapa.observado) motivos.add('MAPA_NAO_OBSERVADO');
  const nivelAtingido = comparacao.mapa.observado ? nivelCalculado : 'N0';
  return Object.freeze({
    versaoContratoPostgres: VERSAO_CONTRATO_POSTGRES,
    nivelAtingido,
    nivelCalculado,
    relacoes: Object.freeze({ ...comparacao.relacoes, mapa: comparacao.mapa, sumario: comparacao.sumario }),
    esquema: Object.freeze({ ...impressao, compatibilidade }),
    dependenciasExternas: dependencias,
    motivos: Object.freeze([...motivos].sort()),
  });
}

/** Validação fechada do bloco (leitura de manifesto): chaves exatas, nível conhecido, null só em N0, versão do contrato conhecida. */
function validarBlocoPostgres(bloco) {
  const erros = [];
  if (!ehObjeto(bloco)) return Object.freeze({ valido: false, erros: Object.freeze(['BLOCO_AUSENTE']) });
  const chaves = Reflect.ownKeys(bloco);
  if (chaves.length !== CHAVES_DO_BLOCO.length || !chaves.every((c) => CHAVES_DO_BLOCO.includes(c))) erros.push('CHAVES_DO_BLOCO_INVALIDAS');
  if (bloco.versaoContratoPostgres !== VERSAO_CONTRATO_POSTGRES) erros.push('VERSAO_DO_CONTRATO_DESCONHECIDA');
  if (!NIVEIS.includes(bloco.nivelAtingido)) erros.push('NIVEL_INVALIDO');
  if (!NIVEIS.includes(bloco.nivelCalculado)) erros.push('NIVEL_CALCULADO_INVALIDO');
  if (bloco.nivelAtingido !== 'N0' && NIVEIS.indexOf(bloco.nivelAtingido) > NIVEIS.indexOf(bloco.nivelCalculado)) erros.push('NIVEL_ACIMA_DO_CALCULADO');
  const nulos = ['relacoes', 'esquema', 'dependenciasExternas'].filter((c) => bloco[c] === null);
  const invalidos = ['relacoes', 'esquema', 'dependenciasExternas'].filter((c) => bloco[c] !== null && !ehObjeto(bloco[c]));
  if (invalidos.length > 0) erros.push('SUBBLOCO_INVALIDO');
  if (nulos.length > 0 && bloco.nivelAtingido !== 'N0') erros.push('NULO_FORA_DO_N0');
  if (!Array.isArray(bloco.motivos) || !bloco.motivos.every((m) => typeof m === 'string' && /^[A-Z][A-Z0-9_:.-]{1,80}$/.test(m))) erros.push('MOTIVOS_INVALIDOS');
  return Object.freeze({ valido: erros.length === 0, erros: Object.freeze(erros) });
}

module.exports = {
  VERSAO_CONTRATO_POSTGRES, NIVEIS, CHAVES_DO_BLOCO, MAPA_DE_CORRESPONDENCIA, NAO_COBERTOS_PELO_DUMP,
  compararInventarioComSumario, impressaoDigitalDoEsquema, compatibilidadeDeEsquema, declararDependenciasExternas, blocoN0, avaliarCoberturaPostgres, validarBlocoPostgres,
};
