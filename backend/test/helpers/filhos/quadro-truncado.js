'use strict';
// Filho de teste: cabeçalho de quadro válido que promete um JSON de 500 bytes e entrega 10.
process.stdin.on('data', () => {});
process.stdin.on('end', () => {
  const cab = Buffer.concat([Buffer.from('GIMG', 'ascii'), Buffer.from([1]), Buffer.from([0, 0, 1, 0xf4]), Buffer.from('{"ok":fals')]);
  process.stdout.write(cab, () => process.exit(0));
});
