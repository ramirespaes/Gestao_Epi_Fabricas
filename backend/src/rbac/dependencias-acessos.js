'use strict';

const { TOGGLES } = require('./toggles');
const { ROTULOS_RECURSOS } = require('./recursos');

/**
 * Identidade e rótulo legível de uma DEPENDÊNCIA de toggle (o que ligar um acesso garante), para a auditoria e para o aviso
 * ao MASTER. Não decide autorização: quem define o que cada toggle garante continua sendo `dependencias` em toggles.js.
 *
 * `chave`   : identificador estável da permissão (recurso.operação ou código da ação).
 * `toggleId`: toggle do catálogo cuja regra é exatamente essa dependência, ou null (ex.: a leitura de materiais não tem toggle).
 * `rotulo`  : texto para a pessoa; com o módulo na frente, porque "Consultar" sozinho é ambíguo.
 */
const mesmasOperacoes = (a, b) => a.length === b.length && a.every((op) => b.includes(op));

function descreverDependencia(dependencia) {
  if (dependencia === null || typeof dependencia !== 'object') throw new TypeError('dependência inválida');
  if (dependencia.tipo === 'RECURSO') {
    const { recurso, operacoes } = dependencia;
    const modulo = ROTULOS_RECURSOS[recurso] ?? recurso;
    const toggle = TOGGLES.find((t) => t.regra.tipo === 'RECURSO' && t.regra.recurso === recurso && mesmasOperacoes(t.regra.operacoes, operacoes));
    const leitura = operacoes.length === 1 && operacoes[0] === 'visualizar';
    return {
      chave: `${recurso}.${operacoes.join('+')}`,
      toggleId: toggle?.id ?? null,
      rotulo: toggle !== undefined ? `${modulo}: ${toggle.rotulo}` : `${modulo} (${leitura ? 'leitura' : operacoes.join(', ')})`,
    };
  }
  if (dependencia.tipo === 'ACAO') {
    const toggle = TOGGLES.find((t) => t.regra.tipo === 'ACAO' && t.regra.codigo === dependencia.codigo);
    return { chave: dependencia.codigo, toggleId: toggle?.id ?? null, rotulo: toggle?.rotulo ?? dependencia.codigo };
  }
  throw new TypeError('tipo de dependência inválido');
}

module.exports = { descreverDependencia };
