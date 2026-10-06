'use strict';

/**
 * Domínio das preferências de aparência da identidade (migration 072). A
 * mesma lista vale no schema, no repositório e no frontend (js/tema.js), que
 * a confere por teste. Só valores de negócio: nada de nome de atributo CSS.
 */

const TEMAS = Object.freeze(['sistema', 'claro', 'escuro']);
const MODOS_VISUAIS = Object.freeze(['padrao', 'alto_contraste', 'deuteranopia', 'protanopia', 'tritanopia', 'baixa_visao', 'monocromatico']);
const PADRAO = Object.freeze({ tema: 'sistema', modoVisual: 'padrao' });

const temaValido = (valor) => TEMAS.includes(valor);
const modoVisualValido = (valor) => MODOS_VISUAIS.includes(valor);

module.exports = { TEMAS, MODOS_VISUAIS, PADRAO, temaValido, modoVisualValido };
