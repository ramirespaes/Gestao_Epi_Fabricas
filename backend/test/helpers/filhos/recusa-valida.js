'use strict';
// Filho de teste: quadro de recusa bem formado (IMAGEM_INVALIDA), para provar o caminho feliz da recusa sem decodificar nada.
process.stdin.on('data', () => {});
process.stdin.on('end', () => {
  const json = Buffer.from(JSON.stringify({ ok: false, codigo: 'IMAGEM_INVALIDA' }));
  const tam = Buffer.alloc(4);
  tam.writeUInt32BE(json.length);
  process.stdout.write(Buffer.concat([Buffer.from('GIMG', 'ascii'), Buffer.from([1]), tam, json]), () => process.exit(0));
});
