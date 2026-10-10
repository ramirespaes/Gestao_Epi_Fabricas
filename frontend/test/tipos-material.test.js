'use strict';

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const EpiHttp = require('../js/api-http');
const { GRUPOS_PROTECAO } = require('../../backend/test/integracao/helpers/classificacao-v2');

/**
 * RED — módulo js/tipos-material.js (catálogo de tipos de EPI/Vestimenta: consulta, cadastro manual, inativação e
 * reativação), dentro de Materiais / Gestão de Estoque. Importação CSV/XLSX ficou FORA do escopo (decisão de 08/10/2026).
 * "Outros" nunca é linha do catálogo: é opção da interface do material.
 */

const BASE = 'http://localhost:3000/api';
const resposta = (status, corpo) => ({ status, ok: status >= 200 && status < 300, text: async () => (corpo === undefined ? '' : JSON.stringify(corpo)) });
let chamadas;
function servidor(...respostas) {
  chamadas = [];
  let i = 0;
  EpiHttp.configurar({
    baseUrl: BASE,
    fetch: async (url, opcoes) => {
      chamadas.push({ metodo: opcoes.method, caminho: new URL(url).pathname + new URL(url).search, corpo: opcoes && opcoes.body ? JSON.parse(opcoes.body) : undefined });
      const r = typeof respostas[0] === 'function' ? respostas[0](chamadas[chamadas.length - 1]) : respostas[Math.min(i, respostas.length - 1)];
      i += 1;
      return r;
    },
  });
}
beforeEach(() => servidor(resposta(200, { status: 'ok' })));

/** O módulo ainda não existe: cada teste falha dizendo isso, nunca o arquivo inteiro. */
function carregar() {
  try {
    // eslint-disable-next-line global-require
    return require('../js/tipos-material');
  } catch (erro) {
    if (erro.code === 'MODULE_NOT_FOUND' && /tipos-material/.test(erro.message)) return assert.fail('js/tipos-material.js ainda não existe');
    throw erro;
  }
}

describe('tipos-material — vocabulário e ações HTTP', () => {
  test('vocabulário: grupos EPI/Vestimenta e os 12 grupos de proteção; limites; "Outros" reservado', () => {
    const T = carregar();
    assert.deepEqual(T.VOCABULARIO.grupos, ['EPI', 'Vestimenta']);
    assert.deepEqual(T.VOCABULARIO.gruposProtecao, [...GRUPOS_PROTECAO]);
    assert.equal(T.LIMITES.nome, 100);
    assert.equal(T.OUTROS, 'Outros');
  });

  test('acoes: listar (filtros na query, sem empresa), criar, inativar e reativar nos caminhos do contrato', async () => {
    const T = carregar();
    await T.acoes.listar({ grupo: 'EPI', grupoProtecao: 'Proteção ocular', ativo: true, busca: 'Óc', pagina: 2, limite: 50 });
    await T.acoes.criar({ grupo: 'EPI', grupoProtecao: 'Proteção ocular', nome: 'Visor' });
    await T.acoes.inativar(15);
    await T.acoes.reativar(15);
    assert.deepEqual(chamadas.map((c) => [c.metodo, c.caminho]), [
      ['GET', '/api/tipos-material?grupo=EPI&grupoProtecao=Prote%C3%A7%C3%A3o%20ocular&ativo=true&busca=%C3%93c&pagina=2&limite=50'],
      ['POST', '/api/tipos-material'], ['POST', '/api/tipos-material/15/inativar'], ['POST', '/api/tipos-material/15/reativar'],
    ]);
    assert.deepEqual(chamadas[1].corpo, { grupo: 'EPI', grupoProtecao: 'Proteção ocular', nome: 'Visor' });
    assert.throws(() => T.acoes.listar({ empresaId: 9 }), TypeError, 'a empresa nunca vai na consulta');
    assert.throws(() => T.acoes.inativar('abc'), TypeError);
  });
});
