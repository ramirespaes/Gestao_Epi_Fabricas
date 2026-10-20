'use strict';
// Filho de teste: depois de receber a entrada morre por SIGKILL (como o encerramento por falta de memória do sistema).
process.stdin.on('data', () => {});
process.stdin.on('end', () => process.kill(process.pid, 'SIGKILL'));
