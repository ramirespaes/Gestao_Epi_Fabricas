'use strict';
// Filho de teste: escreve um "segredo" na saída de erro e sai com código 9. Nada disso pode chegar a quem chamou.
process.stdin.on('data', () => {});
process.stdin.on('end', () => { process.stderr.write('SEGREDO-NO-STDERR-123 caminho=/home/usuario/x', () => process.exit(9)); });
