'use strict';
// Filho de teste: lê a entrada e sai com código 7, sem responder.
process.stdin.on('data', () => {});
process.stdin.on('end', () => process.exit(7));
