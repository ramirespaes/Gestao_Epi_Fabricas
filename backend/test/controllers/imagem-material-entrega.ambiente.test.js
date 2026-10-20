'use strict';

// Em branco ANTES de carregar o controller: o módulo cria o controller de produção na carga, e sem diretório nada é criado em disco.
process.env.IMAGENS_ARMAZENAMENTO_DIRETORIO = '';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { criarRaizTemporaria, removerTemporarioSeguro } = require('../storage/helpers/tmp-seguro');
const { criarImagemMaterialController } = require('../../src/controllers/imagem-material.controller');
const { criarEntregaDoAmbiente } = require('../../src/services/imagem-material-entrega.ambiente');
const { lerConfiguracao } = require('../../src/config/imagens');

/**
 * A fábrica do controller, sem entrega nem armazenamento injetados, resolve o armazenamento pelo AMBIENTE (como em produção) e deve FALHAR ao
 * montar quando o diretório configurado é inutilizável: a API não pode subir com a entrega de imagens indisponível em silêncio (503 em todo pedido).
 */

const POOL = Object.freeze({ marca: 'pool-de-teste' });
const raizes = [];
const novaRaiz = () => { const raiz = criarRaizTemporaria(); raizes.push(raiz); return raiz; };
after(() => { for (const raiz of raizes) removerTemporarioSeguro(raiz); });

function comDiretorio(valor, fn) {
  const anterior = process.env.IMAGENS_ARMAZENAMENTO_DIRETORIO;
  process.env.IMAGENS_ARMAZENAMENTO_DIRETORIO = valor;
  try { return fn(); } finally { process.env.IMAGENS_ARMAZENAMENTO_DIRETORIO = anterior; }
}

describe('[CTL-ENT] fábrica do controller — entrega pelo AMBIENTE (ajuste da Unidade 5A-1)', () => {
  test('CTL-ENT-12 (controle) — sem diretório configurado, ou com um diretório utilizável, a fábrica monta sem erro', () => {
    assert.doesNotThrow(() => criarImagemMaterialController({ pool: POOL }));
    const utilizavel = path.join(novaRaiz(), 'imagens');
    comDiretorio(utilizavel, () => assert.doesNotThrow(() => criarImagemMaterialController({ pool: POOL })));
    assert.equal(fs.statSync(utilizavel).isDirectory(), true, 'o diretório utilizável foi criado');
  });

  test('CTL-ENT-13 — diretório de formato VÁLIDO porém inutilizável (um arquivo comum no lugar da pasta): a fábrica FALHA ao montar, em vez de deixar a API subir com a entrega indisponível', () => {
    const arquivoComum = path.join(novaRaiz(), 'nao-e-diretorio');
    fs.writeFileSync(arquivoComum, 'x');
    const ambiente = { IMAGENS_ARMAZENAMENTO_DIRETORIO: arquivoComum };
    const erroDeSistemaDeArquivos = (falha) => ['EEXIST', 'ENOTDIR'].includes(falha.code);

    assert.doesNotThrow(() => lerConfiguracao(ambiente), 'o formato é válido: a configuração aceita o valor (é por isso que só o armazenamento falha)');
    assert.throws(() => criarEntregaDoAmbiente(ambiente), erroDeSistemaDeArquivos);
    comDiretorio(arquivoComum, () => assert.throws(() => criarImagemMaterialController({ pool: POOL }), erroDeSistemaDeArquivos));
  });
});
