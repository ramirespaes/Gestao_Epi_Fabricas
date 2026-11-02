'use strict';

// Filho de teste: deixa sobras na pasta atual (arquivo, subpasta com arquivo e um link simbólico para a vítima indicada nos bytes de entrada,
// entre "VITIMA:" e um byte nulo) e responde com uma recusa bem formada. Prova que a área exclusiva inventaria e remove as sobras sem seguir o link.
const fs = require('node:fs');
const path = require('node:path');
const { serializarRecusa } = require('../../../src/utils/imagem-quadro');

const partes = [];
process.stdin.on('data', (bloco) => partes.push(bloco));
process.stdin.on('end', () => {
  const vitima = /VITIMA:([^\0]+)\0/.exec(Buffer.concat(partes).toString('latin1'));
  fs.writeFileSync(path.join(process.cwd(), 'sobra.bin'), Buffer.alloc(1024, 1));
  fs.mkdirSync(path.join(process.cwd(), 'sub'));
  fs.writeFileSync(path.join(process.cwd(), 'sub', 'interna.tmp'), 'x');
  if (vitima) fs.symlinkSync(vitima[1], path.join(process.cwd(), 'ligacao'));
  process.stdout.write(serializarRecusa('IMAGEM_INVALIDA'), () => process.exit(0));
});
