'use strict';
// Filho de teste: despeja 40 MiB na saída e depois trava. O processador tem de cortar no teto, matar o filho e recusar.
process.stdin.on('data', () => {});
process.stdin.on('end', () => {
  const bloco = Buffer.alloc(1024 * 1024, 0x41);
  let n = 0;
  const bombear = () => { while (n < 40) { n += 1; if (!process.stdout.write(bloco)) { process.stdout.once('drain', bombear); return; } } setInterval(() => {}, 1 << 30); };
  bombear();
});
process.stdout.on('error', () => process.exit(0));
