'use strict';

const { MAPA_DE_CORRESPONDENCIA, compatibilidadeDeEsquema } = require('../../src/services/backup-fontes-postgres-cobertura.service');
const { TIPOS_RELACIONAIS } = require('../../src/services/backup-fontes-postgres-sumario.service');

/**
 * D-ORF-6, P4b — CARACTERIZAÇÃO PURA da observação real (R2 6.3, regra 3: "o mapa nasce de observação"). Vive só em test/: nada em src/ depende daqui.
 *
 * `caracterizarObservacao({ inventario, sumario, esquema })`: para cada relação do esquema observado, quais tipos de entrada do TOC apareceram com o
 * mesmo (esquema, nome); agrega por categoria do mapa (`r`, `S`, `i`, `i:restricao`, …) e confronta com o mapa v1: toda `obrigatoria` precisa aparecer
 * em TODAS as relações da categoria; tipo observado fora de obrigatórias+opcionais é `TIPO_NAO_PREVISTO`; categoria `null` com relação observada é
 * `CATEGORIA_NAO_MAPEADA_OBSERVADA`. Opcionais são contadas (presentes/ausentes), nunca exigidas.
 *
 * `compararRestauracao({ origem, restaurado, esquema })`: as tuplas de relações do esquema e as migrations aplicadas precisam ser idênticas nos dois
 * inventários (C3 — esquema restaurado). Nada aqui declara nível: só produz os dados que o P4b registra e as contradições que ele precisa apontar.
 *
 * `motivoDeRecusaCi(env)` / `marcadorEsperadoCi(env)`: cópia textual das regras do helper J2a (`test/integracao/helpers/token-j.js`) para provar a
 * instância efêmera do GitHub Actions sem carregar o ambiente HTTP daquele helper.
 */

const RELACIONAIS = new Set([...TIPOS_RELACIONAIS, 'CONSTRAINT']);
const TETO = 50;
const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const IDENTIFICADOR = /^[a-z_][a-z0-9_]{0,62}$/;
const categoriaDe = (r) => (r.relkind === 'i' && r.sustentaRestricao ? 'i:restricao' : r.relkind);

function exigirEntrada(entrada, chaves) {
  if (!ehObjeto(entrada) || !Reflect.ownKeys(entrada).every((c) => chaves.includes(c)) || !chaves.every((c) => Object.hasOwn(entrada, c))) throw new TypeError('entrada inválida');
}

function caracterizarObservacao(entrada) {
  exigirEntrada(entrada, ['inventario', 'sumario', 'esquema']);
  const { inventario, sumario, esquema } = entrada;
  if (!ehObjeto(inventario) || !Array.isArray(inventario.relacoes) || !ehObjeto(sumario) || !Array.isArray(sumario.entradas) || !IDENTIFICADOR.test(esquema)) throw new TypeError('entrada inválida');

  const tiposPorNome = new Map();
  for (const e of sumario.entradas) {
    if (e.esquema !== esquema || e.nome === null || !RELACIONAIS.has(e.tipo)) continue;
    if (!tiposPorNome.has(e.nome)) tiposPorNome.set(e.nome, new Set());
    tiposPorNome.get(e.nome).add(e.tipo);
  }
  const relacoes = inventario.relacoes.filter((r) => r.esquema === esquema);
  const porCategoria = {};
  for (const r of relacoes) {
    const cat = categoriaDe(r);
    if (!porCategoria[cat]) porCategoria[cat] = { relacoes: 0, tipos: {}, semEntrada: [] };
    const agregado = porCategoria[cat];
    agregado.relacoes += 1;
    const tipos = tiposPorNome.get(r.nome) ?? new Set();
    if (tipos.size === 0 && agregado.semEntrada.length < TETO) agregado.semEntrada.push(r.nome);
    for (const t of tipos) agregado.tipos[t] = (agregado.tipos[t] ?? 0) + 1;
  }

  const contradicoes = [];
  const opcionais = {};
  for (const [cat, agregado] of Object.entries(porCategoria).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const regra = Object.hasOwn(MAPA_DE_CORRESPONDENCIA.categorias, cat) ? MAPA_DE_CORRESPONDENCIA.categorias[cat] : undefined;
    if (regra === null || regra === undefined) { contradicoes.push(`CATEGORIA_NAO_MAPEADA_OBSERVADA:${cat}`); continue; }
    for (const t of regra.obrigatorias) if ((agregado.tipos[t] ?? 0) !== agregado.relacoes) contradicoes.push(`OBRIGATORIA_NAO_UNIVERSAL:${cat}:${t}`);
    for (const t of regra.opcionais) opcionais[`${cat}:${t}`] = { presentes: agregado.tipos[t] ?? 0, ausentes: agregado.relacoes - (agregado.tipos[t] ?? 0) };
    for (const t of Object.keys(agregado.tipos)) if (!regra.obrigatorias.includes(t) && !regra.opcionais.includes(t)) contradicoes.push(`TIPO_NAO_PREVISTO:${cat}:${t}`);
  }

  return Object.freeze({
    esquema,
    mapa: Object.freeze({ versao: MAPA_DE_CORRESPONDENCIA.versao, observadoEm: MAPA_DE_CORRESPONDENCIA.observadoEm }),
    relacoesDoEsquema: relacoes.length,
    porCategoria: Object.freeze(Object.fromEntries(Object.entries(porCategoria).map(([k, v]) => [k, Object.freeze({ ...v, tipos: Object.freeze(v.tipos), semEntrada: Object.freeze(v.semEntrada) })]))),
    opcionais: Object.freeze(opcionais),
    contradicoes: Object.freeze(contradicoes.sort()),
    sumario: Object.freeze({
      formato: sumario.cabecalho?.formato ?? null,
      versaoServidor: sumario.cabecalho?.versaoServidor ?? null,
      versaoPgDump: sumario.cabecalho?.versaoPgDump ?? null,
      entradasDeclaradas: sumario.cabecalho?.entradasDeclaradas ?? null,
      linhasLidas: sumario.contagem?.total ?? null,
      declaradasIgualLidas: (sumario.cabecalho?.entradasDeclaradas ?? null) === (sumario.contagem?.total ?? null),
      naoInterpretadas: sumario.contagem?.naoInterpretadas ?? null,
      truncado: sumario.truncado === true,
      porTipo: sumario.contagem?.porTipo ?? null,
    }),
  });
}

const tupla = (r) => `${r.esquema}|${r.nome}|${r.relkind}|${r.sustentaRestricao}|${r.sequenciaImplicita}`;

function compararRestauracao(entrada) {
  exigirEntrada(entrada, ['origem', 'restaurado', 'esquema']);
  const { origem, restaurado, esquema } = entrada;
  for (const inv of [origem, restaurado]) if (!ehObjeto(inv) || !Array.isArray(inv.relacoes) || !Array.isArray(inv.migrations)) throw new TypeError('entrada inválida');
  if (!IDENTIFICADOR.test(esquema)) throw new TypeError('entrada inválida');
  const a = new Set(origem.relacoes.filter((r) => r.esquema === esquema).map(tupla));
  const b = new Set(restaurado.relacoes.filter((r) => r.esquema === esquema).map(tupla));
  const faltamNoRestaurado = [...a].filter((t) => !b.has(t)).sort().slice(0, TETO);
  const sobramNoRestaurado = [...b].filter((t) => !a.has(t)).sort().slice(0, TETO);
  const migrations = compatibilidadeDeEsquema({ migrationsDoBanco: restaurado.migrations, migrationsDoCodigo: origem.migrations });
  const divergencias = [];
  if (faltamNoRestaurado.length > 0) divergencias.push('RELACOES_FALTAM_NO_RESTAURADO');
  if (sobramNoRestaurado.length > 0) divergencias.push('RELACOES_SOBRAM_NO_RESTAURADO');
  if (migrations.relacao !== 'IGUAL') divergencias.push(`MIGRATIONS_${migrations.relacao}`);
  if (a.size === 0) divergencias.push('ESQUEMA_SEM_RELACOES');
  return Object.freeze({
    ok: divergencias.length === 0,
    relacoes: Object.freeze({ origem: a.size, restaurado: b.size, faltamNoRestaurado: Object.freeze(faltamNoRestaurado), sobramNoRestaurado: Object.freeze(sobramNoRestaurado) }),
    migrations,
    divergencias: Object.freeze(divergencias),
  });
}

const CI_ENV_ESPERADO = Object.freeze({
  GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', DB_HOST: '127.0.0.1', DB_PORT: '5432', DB_NAME: 'gestao_epi_teste_local', DB_USER: 'postgres',
});
const CI_ENV_PROIBIDAS = /^(PG.*|DATABASE_URL|NODE_OPTIONS|NODE_PG_FORCE_NATIVE|DOTENV_.*)$/i;
const CI_RUN_ID = /^[0-9]{1,20}$/;
const CI_TENTATIVA = /^[0-9]{1,6}$/;
const CI_NONCE = /^[0-9a-f]{32}$/;

function marcadorEsperadoCi(env) {
  if (!CI_RUN_ID.test(env.GITHUB_RUN_ID ?? '') || !CI_TENTATIVA.test(env.GITHUB_RUN_ATTEMPT ?? '') || !CI_NONCE.test(env.GEPI_CI_NONCE ?? '')) return null;
  return `GEPI_CI_EFEMERO:${env.GITHUB_RUN_ID}:${env.GITHUB_RUN_ATTEMPT}:${env.GEPI_CI_NONCE}`;
}

function motivoDeRecusaCi(env) {
  for (const [nome, valor] of Object.entries(CI_ENV_ESPERADO)) if (env[nome] !== valor) return `${nome} divergente`;
  for (const nome of Object.keys(env)) if (CI_ENV_PROIBIDAS.test(nome)) return `variável proibida presente: ${nome}`;
  if (marcadorEsperadoCi(env) === null) return 'identificadores da execução ausentes ou inválidos';
  return null;
}

const marcadorDoBancoConfere = (lido, esperado) => typeof lido === 'string' && typeof esperado === 'string' && esperado.length > 0 && lido === esperado;
const SQL_MARCADOR_DO_BANCO = "SELECT shobj_description(oid, 'pg_database') AS marcador FROM pg_database WHERE datname = current_database()";

module.exports = { caracterizarObservacao, compararRestauracao, motivoDeRecusaCi, marcadorEsperadoCi, marcadorDoBancoConfere, SQL_MARCADOR_DO_BANCO };
