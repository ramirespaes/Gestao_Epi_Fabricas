'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { exigirModulo } = require('../helpers/exigir-modulo');
const { criarRaizTemporaria, removerTemporarioSeguro } = require('../storage/helpers/tmp-seguro');

/**
 * Biblioteca de Imagens, Unidade 5A-1 (RED) — fiação da entrega pelo ambiente, no molde de fiscalizacao-pacote.ambiente.js.
 * Módulo previsto: src/services/imagem-material-entrega.ambiente.js, com `criarEntregaDoAmbiente(origem = process.env)`:
 *   - sem IMAGENS_ARMAZENAMENTO_DIRETORIO (ausente ou em branco) -> null (recurso indisponível; a rota responde 503), sem tocar o disco;
 *   - com um diretório válido -> o serviço de entrega (`obter`) sobre o armazenamento da Unidade 1 (o diretório nasce 0700);
 *   - diretório inválido -> IMAGENS_DIRETORIO_INVALIDO, sem ecoar o valor;
 *   - função pura da origem informada: não lê process.env quando recebe um objeto.
 */

const M = () => exigirModulo('src/services/imagem-material-entrega.ambiente');
const raizes = [];
const novaRaiz = () => { const raiz = criarRaizTemporaria(); raizes.push(raiz); return raiz; };
after(() => { for (const raiz of raizes) removerTemporarioSeguro(raiz); });

describe('[AMB-ENT] entrega de imagens montada pelo ambiente', () => {
  test('AMB-ENT-01 — sem diretório configurado (ausente ou em branco) o recurso fica indisponível: null', () => {
    const { criarEntregaDoAmbiente } = M();
    assert.equal(typeof criarEntregaDoAmbiente, 'function');
    for (const origem of [{}, { IMAGENS_ARMAZENAMENTO_DIRETORIO: '' }, { IMAGENS_ARMAZENAMENTO_DIRETORIO: '   ' }]) {
      assert.equal(criarEntregaDoAmbiente(origem), null, JSON.stringify(origem));
    }
  });

  test('AMB-ENT-02 — com um diretório válido devolve a entrega (obter) e o diretório nasce privado (0700)', () => {
    const { criarEntregaDoAmbiente } = M();
    const diretorio = path.join(novaRaiz(), 'imagens');
    const entrega = criarEntregaDoAmbiente({ IMAGENS_ARMAZENAMENTO_DIRETORIO: diretorio });
    assert.notEqual(entrega, null);
    assert.equal(typeof entrega.obter, 'function');
    assert.equal(fs.statSync(diretorio).isDirectory(), true);
    assert.equal(fs.statSync(diretorio).mode & 0o777, 0o700);
  });

  test('AMB-ENT-03 — diretório inválido (relativo, não canônico) falha com IMAGENS_DIRETORIO_INVALIDO e a mensagem não ecoa o valor', () => {
    const { criarEntregaDoAmbiente } = M();
    for (const ruim of ['relativo/imagens-xyz-417', '/tmp/../imagens-xyz-417']) {
      assert.throws(
        () => criarEntregaDoAmbiente({ IMAGENS_ARMAZENAMENTO_DIRETORIO: ruim }),
        (falha) => falha.codigo === 'IMAGENS_DIRETORIO_INVALIDO' && !falha.message.includes('imagens-xyz-417'),
        ruim,
      );
    }
  });

  test('AMB-ENT-04 — é função pura da origem informada: o process.env não entra quando se passa um objeto', () => {
    const { criarEntregaDoAmbiente } = M();
    const anterior = process.env.IMAGENS_ARMAZENAMENTO_DIRETORIO;
    process.env.IMAGENS_ARMAZENAMENTO_DIRETORIO = path.join(novaRaiz(), 'do-ambiente');
    try {
      assert.equal(criarEntregaDoAmbiente({}), null);
      assert.equal(fs.existsSync(process.env.IMAGENS_ARMAZENAMENTO_DIRETORIO), false, 'nada foi criado no disco');
    } finally {
      if (anterior === undefined) delete process.env.IMAGENS_ARMAZENAMENTO_DIRETORIO; else process.env.IMAGENS_ARMAZENAMENTO_DIRETORIO = anterior;
    }
  });
});
