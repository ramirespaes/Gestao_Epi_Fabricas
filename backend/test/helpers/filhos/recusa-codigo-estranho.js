'use strict';
// Filho de teste: quadro bem formado, mas recusando com um código que não é nenhum dos combinados.
process.stdin.on('data', () => {});
process.stdin.on('end', () => {
  const json = Buffer.from(JSON.stringify({ ok: false, codigo: 'ERRO_QUALQUER_DO_FILHO' }));
  const tam = Buffer.alloc(4);
  tam.writeUInt32BE(json.length);
  process.stdout.write(Buffer.concat([Buffer.from('GIMG', 'ascii'), Buffer.from([1]), tam, json]), () => process.exit(0));
});
