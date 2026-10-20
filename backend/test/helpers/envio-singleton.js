'use strict';

const fs = require('node:fs');
const childProcess = require('node:child_process');

/**
 * Auxiliar de teste (Biblioteca de Imagens, Unidade 5C-6): roda em PROCESSO PRÓPRIO, com o ambiente que o teste montou, e exercita o envio do controller de
 * PRODUÇÃO (o singleton construído na carga do módulo a partir de process.env). Conta as chamadas a child_process.spawn e nunca chega ao banco: só vai até
 * onde o envio recusa antes do registro. Imprime uma linha JSON { desfecho, status, codigo, spawns }.
 *   node envio-singleton.js [arquivo-com-os-bytes]
 */

let spawns = 0;
const spawnOriginal = childProcess.spawn;
childProcess.spawn = (...argumentos) => {
  spawns += 1;
  return spawnOriginal(...argumentos);
};

// Depois do contador: o serviço do processador captura o spawn (já contado) quando é carregado.
const { imagemMaterialController } = require('../../src/controllers/imagem-material.controller');

const bytes = process.argv[2] ? fs.readFileSync(process.argv[2]) : Buffer.alloc(0);
const req = { empresa: { id: 1 }, usuario: { id: 1 }, ip: '127.0.0.1', headers: {}, validado: { query: { nome: 'Teste' } }, body: bytes };
const res = { status() { return this; }, json() { return this; } };

(async () => {
  let resultado;
  try {
    await imagemMaterialController.enviar(req, res);
    resultado = { desfecho: 'respondeu', status: null, codigo: null };
  } catch (erro) {
    resultado = { desfecho: 'recusou', status: erro.status ?? null, codigo: erro.codigo ?? null };
  }
  process.stdout.write(`${JSON.stringify({ ...resultado, spawns })}\n`, () => process.exit(0));
})();
