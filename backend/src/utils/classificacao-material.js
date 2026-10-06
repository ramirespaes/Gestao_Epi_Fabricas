'use strict';

/**
 * Categoria → Tipo do material (12G-8). As listas oficiais são as mesmas de
 * frontend/js/materiais.js, conferidas por teste. "Outros" vale em toda
 * categoria e leva a descrição em coluna própria (migration 071); categoria
 * sem lista própria (Ferramenta, sem categoria, desconhecida) só aceita
 * "Outros". Os dois tipos de óculos são distintos no dado gravado; o nome
 * histórico só vale para o que já está gravado.
 */

const OUTROS = 'Outros';
const TIPOS_OCULOS = Object.freeze(['Óculos de Proteção Incolor', 'Óculos de Proteção Ampla Visão']);
const TIPO_OCULOS_LEGADO = 'Óculos de proteção';

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

function ehOculos(tipo) {
  return TIPOS_OCULOS.includes(tipo) || tipo === TIPO_OCULOS_LEGADO;
}

module.exports = { OUTROS, TIPOS_POR_CATEGORIA, TIPOS_OCULOS, TIPO_OCULOS_LEGADO, tiposDe, tipoPermitido, ehOculos };
