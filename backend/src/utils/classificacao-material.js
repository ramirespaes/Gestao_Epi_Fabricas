'use strict';

/**
 * Classificação do material.
 *
 * V2 (07/10/2026 — migration 082): Grupo (EPI | Vestimenta | Outros) → Grupo de Proteção (12 fechados | Outros) →
 * Tipo (catálogo por empresa, tabela tipos_material | Outros). "Outros" em qualquer nível é opção da interface e do
 * contrato do material, nunca linha do catálogo; o texto de cada "Especifique…" pertence ao material.
 *
 * LEGADO (12G-8): categoria livre + tipo das listas antigas, preservado para o que já existe. As listas e `ehOculos`
 * continuam aqui só para o legado; o cadastro novo não as usa.
 *
 * Valor efetivo de exibição (decisão 1 de 07/10/2026): UMA regra, aqui e em SQL, reutilizada por filtros, telas e
 * relatórios — nunca COALESCE solto por consulta. A mesma função existe em frontend/js/materiais.js (conferida por teste).
 */

const OUTROS = 'Outros';
const TIPOS_OCULOS = Object.freeze(['Óculos de Proteção Incolor', 'Óculos de Proteção Ampla Visão']);
const TIPO_OCULOS_LEGADO = 'Óculos de proteção';

// ── Legado (12G-8) ──
const TIPOS_POR_CATEGORIA = Object.freeze({
  EPI: Object.freeze([
    'Botina de Segurança', 'Capacete', 'Creme de Proteção', 'Luva', 'Mangote', 'Óculos de Proteção Ampla Visão',
    'Óculos de Proteção Incolor', OUTROS, 'Palmilha', 'Proteção Auricular Concha', 'Proteção Auricular Descartável',
    'Respirador PFF2', 'Sapato de Segurança', 'Viseira Película Ouro',
  ]),
  Uniforme: Object.freeze(['Calça', 'Calça de Forneiro', 'Calça Eletricista', 'Camisa', 'Camisa de Forneiro', 'Camisa Eletricista', 'Camiseta', OUTROS]),
  Ferramenta: Object.freeze([OUTROS]),
  'Material de consumo': Object.freeze([OUTROS]),
});

function tiposDe(categoria) {
  return typeof categoria === 'string' && Object.hasOwn(TIPOS_POR_CATEGORIA, categoria)
    ? [...TIPOS_POR_CATEGORIA[categoria]]
    : [OUTROS];
}

function tipoPermitido(categoria, tipo) {
  return typeof tipo === 'string' && tiposDe(categoria).includes(tipo);
}

/** Predicado por NOME, só para o legado (os dois tipos oficiais da 12G-8 e o histórico). */
function ehOculos(tipo) {
  return TIPOS_OCULOS.includes(tipo) || tipo === TIPO_OCULOS_LEGADO;
}

// ── V2 ──
const MODELOS = Object.freeze({ LEGADO: 'LEGADO', V2: 'V2' });
const GRUPOS_CATALOGO = Object.freeze(['EPI', 'Vestimenta']);
const GRUPOS = Object.freeze([...GRUPOS_CATALOGO, OUTROS]);
const GRUPOS_PROTECAO = Object.freeze([
  'Proteção auditiva', 'Proteção contra quedas', 'Proteção da cabeça', 'Proteção das mãos', 'Proteção das pernas', 'Proteção dos braços',
  'Proteção dos pés', 'Proteção facial', 'Proteção ocular', 'Proteção da pele (membros superiores)', 'Proteção respiratória', 'Proteção do tronco',
]);
const PROTECAO_OCULAR = 'Proteção ocular';

// Catálogo base aprovado (26): fonte única do seed da 082 e do provisionamento da empresa nova.
const CATALOGO_BASE = Object.freeze([
  ['EPI', 'Proteção auditiva', 'Protetor Auricular Concha'],
  ['EPI', 'Proteção auditiva', 'Protetor Auricular Plug'],
  ['EPI', 'Proteção contra quedas', 'Cinturão de Segurança com Talabarte/Trava-Quedas'],
  ['EPI', 'Proteção da cabeça', 'Capacete de Segurança'],
  ['EPI', 'Proteção da cabeça', 'Capuz de Segurança'],
  ['EPI', 'Proteção das mãos', 'Luva Isolante de Borracha'],
  ['EPI', 'Proteção das mãos', 'Luva de Segurança'],
  ['EPI', 'Proteção das mãos', 'Luva de Segurança Nitrila'],
  ['EPI', 'Proteção das mãos', 'Luva para Proteção contra Agentes Térmicos'],
  ['EPI', 'Proteção das pernas', 'Perneira de Proteção Aluminizada'],
  ['EPI', 'Proteção dos braços', 'Manga de Segurança'],
  ['EPI', 'Proteção dos braços', 'Manga de Segurança para Corte'],
  ['EPI', 'Proteção dos braços', 'Mangote de Segurança'],
  ['EPI', 'Proteção dos pés', 'Sapato de Segurança'],
  ['EPI', 'Proteção facial', 'Protetor Facial'],
  ['EPI', 'Proteção ocular', 'Óculos de Proteção Fumê'],
  ['EPI', 'Proteção ocular', 'Óculos de Proteção Incolor'],
  ['EPI', 'Proteção ocular', 'Óculos de Proteção Sobrepor'],
  ['EPI', 'Proteção da pele (membros superiores)', 'Creme Protetor de Segurança'],
  ['EPI', 'Proteção respiratória', 'Respirador PFF2'],
  ['Vestimenta', 'Proteção das pernas', 'Calça de Segurança'],
  ['Vestimenta', 'Proteção do tronco', 'Avental de Segurança'],
  ['Vestimenta', 'Proteção do tronco', 'Vestimenta para Proteção do Tronco - Agente Térmico'],
  ['Vestimenta', 'Proteção do tronco', 'Vestimenta para Proteção do Tronco - Camisa'],
  ['Vestimenta', 'Proteção do tronco', 'Vestimenta para Proteção do Tronco - Raspa'],
  ['Vestimenta', 'Proteção do tronco', 'Vestimenta para Proteção do Tronco Aluminizada'],
].map(([grupo, grupoProtecao, nome]) => Object.freeze({ grupo, grupoProtecao, nome })));

/** Nome de tipo: sequências de espaço, tab, CR e LF viram um espaço; pontas aparadas; caixa, acentos e pontuação intactos. */
function normalizarNomeTipo(texto) {
  return typeof texto === 'string' ? texto.replace(/[ \t\r\n]+/g, ' ').replace(/^ | $/g, '') : '';
}

/** Chave da unicidade lógica (a mesma do índice da 082). */
function chaveDoTipo(texto) {
  return normalizarNomeTipo(texto).toLowerCase();
}

/** V2: EPI + Proteção ocular, qualquer tipo. LEGADO (ou sem modelo): os três nomes históricos. */
function exigeOculosComGrau(material) {
  const m = material || {};
  if (m.modeloClassificacao === MODELOS.V2) {
    return m.categoria === 'EPI' && m.grupoProtecao === PROTECAO_OCULAR;
  }
  return ehOculos(m.tipo);
}

const presente = (v) => typeof v === 'string' && v.length > 0;
function efetivo(valor, descricao) {
  if (!presente(valor)) return null;
  return valor === OUTROS && presente(descricao) ? descricao : valor;
}

/** Grupo efetivo: a categoria, ou a descrição quando o grupo é "Outros". */
function grupoEfetivo(material) {
  const m = material || {};
  return efetivo(m.categoria, m.categoriaDescricao);
}

function grupoProtecaoEfetivo(material) {
  const m = material || {};
  return efetivo(m.grupoProtecao, m.grupoProtecaoDescricao);
}

function tipoEfetivo(material) {
  const m = material || {};
  return efetivo(m.tipo, m.tipoDescricao);
}

// A MESMA regra em SQL, para os repositórios (o alias é o da tabela materiais na consulta).
const SQL = Object.freeze({
  grupoEfetivo: (m) => `COALESCE(CASE WHEN ${m}.categoria = 'Outros' THEN ${m}.categoria_descricao ELSE ${m}.categoria END, ${m}.categoria)`,
  grupoProtecaoEfetivo: (m) => `COALESCE(CASE WHEN ${m}.grupo_protecao = 'Outros' THEN ${m}.grupo_protecao_descricao ELSE ${m}.grupo_protecao END, ${m}.grupo_protecao)`,
  tipoEfetivo: (m) => `COALESCE(CASE WHEN ${m}.tipo = 'Outros' THEN ${m}.tipo_descricao ELSE ${m}.tipo END, ${m}.tipo)`,
});

module.exports = {
  OUTROS, TIPOS_POR_CATEGORIA, TIPOS_OCULOS, TIPO_OCULOS_LEGADO, tiposDe, tipoPermitido, ehOculos,
  MODELOS, GRUPOS, GRUPOS_CATALOGO, GRUPOS_PROTECAO, PROTECAO_OCULAR, CATALOGO_BASE,
  normalizarNomeTipo, chaveDoTipo, exigeOculosComGrau, grupoEfetivo, grupoProtecaoEfetivo, tipoEfetivo, SQL,
};
