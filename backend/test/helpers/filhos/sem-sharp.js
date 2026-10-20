'use strict';
// Filho de teste: finge que o sharp não carregou (código de saída 3 é o combinado com o processador).
process.stdin.on('data', () => {});
process.stdin.on('end', () => process.exit(3));
