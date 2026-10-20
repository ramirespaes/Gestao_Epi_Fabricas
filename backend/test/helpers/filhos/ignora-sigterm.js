'use strict';
// Filho de teste: ignora SIGTERM e nunca responde. Só SIGKILL o encerra: prova que o encerramento do processador não depende de cooperação do filho.
process.on('SIGTERM', () => {});
process.on('SIGINT', () => {});
process.stdin.resume();
setInterval(() => {}, 1 << 30);
