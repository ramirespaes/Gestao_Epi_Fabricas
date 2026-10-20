'use strict';
// Filho de teste: nunca responde. Prova o prazo externo (SIGKILL) e a liberação dos recursos.
process.stdin.resume();
setInterval(() => {}, 1 << 30);
